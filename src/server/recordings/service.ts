import { join } from "node:path";
import type { Readable } from "node:stream";
import { RECORDING_MIMES, type RecordingMime, type RecordingView, type Transcript, type TranscriptionStatus } from "@pikvm/contracts/recordings";
import { ASR_MODEL_NAMES, DEFAULT_CLUSTER_THRESHOLD } from "./asr-models";
import { limitsFromEnv, type RecordingLimits } from "./limits";
import { probeMedia } from "./media";
import { RecordingRefusal, RecordingStore } from "./store";
import { createTranscriber, type TranscribeResult, type Transcriber } from "./transcriber";

/**
 * Session recordings: the store (store.ts) and the transcriber (transcriber.ts) behind one object, which the routes
 * (routes.ts) call. It checks every body, probes a recording when it is closed, and decides what happens to a recording that
 * was left open, expired, or being transcribed when the host stopped.
 */

export interface RecordingServiceOptions {
    dataDir: string;
    limits?: RecordingLimits;
    /** Default `PIKVM_ASR_MODELS`, else /opt/asr/models. */
    modelsDir?: string;
    /** Default `PIKVM_ASR_WORKER`, else `transcribe-worker.js` beside this bundle. */
    workerPath?: string;
    /** onnxruntime's threads in the worker. Default `PIKVM_ASR_THREADS`, else 2. */
    threads?: number;
    /** The diarizer's clustering threshold. Default `PIKVM_ASR_SPEAKER_THRESHOLD`, else DEFAULT_CLUSTER_THRESHOLD. */
    clusterThreshold?: number;
    log?: (line: string) => void;
}

export interface RecordingService {
    /** Resolves once the recordings on disk are loaded; rejects if they could not be. Requests wait for it. */
    ready: Promise<void>;
    /** Loads what is on disk, closes what was left open, resumes what was being transcribed, sweeps, and keeps sweeping. */
    start(): Promise<void>;
    stop(): Promise<void>;
    list(): Promise<{ recordings: RecordingView[]; transcription: TranscriptionStatus }>;
    create(body: unknown): Promise<RecordingView>;
    chunk(id: string, n: number, body: Readable, declaredLength: number | null): Promise<{ received: number }>;
    finish(id: string, body: unknown): Promise<RecordingView>;
    view(id: string): RecordingView;
    media(id: string): { path: string; size: number; mime: RecordingMime };
    transcript(id: string): Promise<string>;
    transcribe(id: string): Promise<RecordingView>;
    remove(id: string): Promise<void>;
    sweep(): Promise<void>;
}

const SWEEP_EVERY_MS = 60 * 60 * 1000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function asObject(body: unknown): Record<string, unknown> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RecordingRefusal("The request body must be a JSON object.", 400);
    return body as Record<string, unknown>;
}

export function createRecordingService(options: RecordingServiceOptions): RecordingService {
    const log = options.log ?? ((line: string) => console.log(line));
    const limits = options.limits ?? limitsFromEnv();
    const store = new RecordingStore({ dataDir: options.dataDir, limits, log });
    let sweeper: NodeJS.Timeout | undefined;
    const ready = Promise.withResolvers<void>();
    // A start that fails is reported where start() was called; a request then answers 503 instead of waiting for ever.
    ready.promise.catch(() => undefined);

    async function onDone(id: string, result: TranscribeResult): Promise<void> {
        if (!store.has(id)) return;
        const transcript: Transcript = {
            id,
            durationMs: result.durationMs,
            speakers: result.speakers,
            segments: result.segments,
            text: result.text,
            models: { ...ASR_MODEL_NAMES },
            tookSeconds: result.tookSeconds,
        };
        await store.saveTranscript(id, transcript);
        await store.update(id, { status: "done", error: null, speakers: result.speakers.length, ...(store.durationMsOf(id) === null ? { durationMs: result.durationMs } : {}) });
        await store.clearWork(id);
        log(`[recordings] ${id} transcribed: ${(result.durationMs / 1000).toFixed(0)} s of audio in ${result.tookSeconds} s, ${result.speakers.length} speaker(s), ${result.segments.length} segment(s)`);
    }

    async function onFail(id: string, message: string): Promise<void> {
        if (!store.has(id)) return;
        log(`[recordings] ${id} transcription failed: ${message}`);
        await store.update(id, { status: "failed", error: `The transcription failed: ${message}` });
        await store.clearWork(id);
    }

    const transcriber: Transcriber = createTranscriber({
        modelsDir: options.modelsDir ?? process.env["PIKVM_ASR_MODELS"] ?? "/opt/asr/models",
        workerPath: options.workerPath ?? process.env["PIKVM_ASR_WORKER"] ?? join(__dirname, "transcribe-worker.js"),
        threads: options.threads ?? (Number(process.env["PIKVM_ASR_THREADS"]) || 2),
        clusterThreshold: options.clusterThreshold ?? (Number(process.env["PIKVM_ASR_SPEAKER_THRESHOLD"]) || DEFAULT_CLUSTER_THRESHOLD),
        maxSeconds: limits.maxTranscribeSeconds,
        log,
        onProgress: (id, value) => {
            if (store.has(id)) store.setProgress(id, value);
        },
        // A recording deleted while its job ended is not an error; anything else is logged.
        onDone: (id, result) => void onDone(id, result).catch((error: unknown) => logIgnoringGone(error, id)),
        onFail: (id, message) => void onFail(id, message).catch((error: unknown) => logIgnoringGone(error, id)),
    });

    function logIgnoringGone(error: unknown, id: string): void {
        if (error instanceof RecordingRefusal && error.status === 404) return;
        log(`[recordings] ${id}: could not record the end of its transcription: ${error instanceof Error ? error.message : String(error)}`);
    }

    /** Closes a recording with what it holds, and fails it if what it holds cannot be read as media. */
    async function closeRecording(id: string, durationMs: number | null): Promise<RecordingView> {
        const closed = await store.close(id, durationMs);
        if (closed.status !== "ready") return closed;
        if (closed.bytes === 0) return store.update(id, { status: "failed", error: "The recording is empty: the host received no data." });
        try {
            const facts = await probeMedia(store.mediaPath(id));
            if (facts?.durationSeconds && closed.durationMs === null) return store.update(id, { durationMs: Math.round(facts.durationSeconds * 1000) });
            return closed;
        } catch (error) {
            const why = error instanceof Error ? error.message : String(error);
            log(`[recordings] ${id} does not probe as media: ${why}`);
            return store.update(id, { status: "failed", error: `The recording could not be read as video or audio (${why}).` });
        }
    }

    async function queue(id: string): Promise<void> {
        await store.clearWork(id);
        transcriber.enqueue({ id, file: store.mediaPath(id), workDir: store.workDir(id), durationMs: store.durationMsOf(id) });
    }

    async function sweep(): Promise<void> {
        for (const id of store.expired()) {
            if (!store.has(id)) continue;
            log(`[recordings] ${id} passed its retention and is deleted`);
            await transcriber.cancel(id);
            await store.remove(id).catch((error: unknown) => logIgnoringGone(error, id));
        }
        for (const id of store.idle()) {
            log(`[recordings] ${id} received no chunk for ${Math.round(limits.idleCloseMs / 60000)} minutes and is closed`);
            await closeRecording(id, null).catch((error: unknown) => logIgnoringGone(error, id));
        }
    }

    async function boot(): Promise<void> {
        const loaded = await store.load();
        for (const id of loaded.open) {
            log(`[recordings] ${id} was still recording when the host stopped; closing it with what it holds`);
            await closeRecording(id, null);
        }
        for (const view of store.views()) if (view.status !== "transcribing") await store.clearWork(view.id);
        const status = await transcriber.status();
        for (const id of loaded.transcribing) {
            if (status.available) await queue(id);
            else await store.update(id, { status: "ready", error: null });
        }
        await sweep();
        sweeper = setInterval(() => void sweep().catch((error: unknown) => log(`[recordings] sweep failed: ${String(error)}`)), SWEEP_EVERY_MS);
        sweeper.unref();
        log(`[recordings] ${store.views().length} recording(s), ${(store.totalBytes() / 1048576).toFixed(1)} MB; transcription ${status.available ? "available" : `unavailable: ${status.reason}`}`);
    }

    return {
        ready: ready.promise,

        async start() {
            try {
                await boot();
                ready.resolve();
            } catch (error) {
                ready.reject(error);
                throw error;
            }
        },

        async stop() {
            clearInterval(sweeper);
            await transcriber.stop();
        },

        async list() {
            return { recordings: store.views(), transcription: await transcriber.status() };
        },

        async create(body) {
            const input = asObject(body);
            const rawMime = typeof input["mime"] === "string" ? (input["mime"].split(";")[0] ?? "").trim().toLowerCase() : "";
            const mime = RECORDING_MIMES.find((m) => m === rawMime);
            if (!mime) throw new RecordingRefusal(`mime must be one of ${RECORDING_MIMES.join(", ")}.`, 400);
            const startedMs = typeof input["startedAt"] === "string" ? Date.parse(input["startedAt"]) : NaN;
            if (!Number.isFinite(startedMs)) throw new RecordingRefusal("startedAt must be an ISO time.", 400);
            const target = input["target"];
            if (target !== undefined && target !== null && typeof target !== "string") throw new RecordingRefusal("target must be text.", 400);
            const name = typeof target === "string" ? target.trim().slice(0, 200) : "";
            return store.create({ mime, startedAt: new Date(startedMs).toISOString(), target: name === "" ? null : name });
        },

        async chunk(id, n, body, declaredLength) {
            const { received } = await store.append(id, n, body, declaredLength);
            return { received };
        },

        async finish(id, body) {
            const input = asObject(body);
            const durationMs = input["durationMs"];
            if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_DURATION_MS) {
                throw new RecordingRefusal("durationMs must be a number of milliseconds, 0 up to seven days.", 400);
            }
            if (typeof input["transcribe"] !== "boolean") throw new RecordingRefusal("transcribe must be true or false.", 400);
            // A recording is finished once: a second finish (or one after the host closed it at a limit) is a 409.
            const view = await closeRecording(id, Math.round(durationMs));
            if (input["transcribe"] && view.status === "ready" && (await transcriber.status()).available) {
                await store.update(id, { status: "transcribing", error: null });
                await queue(id);
                return store.view(id);
            }
            return view;
        },

        view: (id) => store.view(id),

        media(id) {
            if (store.status(id) === "recording") throw new RecordingRefusal("This recording is still being recorded.", 409);
            return { path: store.mediaPath(id), size: store.bytesOf(id), mime: store.mimeOf(id) };
        },

        async transcript(id) {
            const text = store.status(id) === "done" ? await store.readTranscript(id) : null;
            if (text === null) throw new RecordingRefusal("There is no transcript for this recording yet.", 404);
            return text;
        },

        async transcribe(id) {
            const status = store.status(id);
            if (status === "recording") throw new RecordingRefusal("This recording is still being recorded.", 409);
            if (status === "transcribing") return store.view(id);
            const available = await transcriber.status();
            if (!available.available) throw new RecordingRefusal(available.reason ?? "Transcription is not available on this host.", 503);
            if (store.bytesOf(id) === 0) throw new RecordingRefusal("This recording is empty.", 409);
            await store.clearTranscript(id);
            const view = await store.update(id, { status: "transcribing", error: null, speakers: null });
            await queue(id);
            return view;
        },

        async remove(id) {
            store.view(id);
            await transcriber.cancel(id);
            await store.remove(id);
        },

        sweep,
    };
}
