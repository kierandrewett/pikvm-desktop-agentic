import { stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import {
    MAX_SEARCH_QUERY_CHARS,
    MAX_TITLE_CHARS,
    RECORDING_SORTS,
    SEARCH_DEFAULT_LIMIT,
    SEARCH_MAX_LIMIT,
    type RecordingLive,
    type RecordingMime,
    type RecordingSearchResult,
    type RecordingSort,
    type RecordingStatus,
    type RecordingView,
    type Transcript,
    type TranscriptionStatus,
} from "@pikvm/contracts/recordings";
import { ASR_MODEL_NAMES, DEFAULT_CLUSTER_THRESHOLD } from "./asr-models";
import type { JanusTarget } from "./capture";
import { createHostRecorder } from "./host-recorder";
import { limitsFromEnv, type RecordingLimits } from "./limits";
import { probeMedia } from "./media";
import { buildMatch, indexedSegments, RecordingIndex } from "./search-index";
import { RecordingRefusal, RecordingStore } from "./store";
import { createTranscriber, type TranscribeResult, type Transcriber } from "./transcriber";

/**
 * Session recordings: the store (store.ts), the host's recorder (host-recorder.ts) and the transcriber (transcriber.ts) behind one
 * object, which the routes (routes.ts) call. It checks every body, and decides what happens to a recording that was being made,
 * finished, expired, or transcribed when the host stopped.
 */

export interface RecordingServiceOptions {
    dataDir: string;
    limits?: RecordingLimits;
    /** Where the PiKVM is, as `control.proxyTarget()` says. Absent on a host with none: it can play recordings but not make them. */
    target?: () => Promise<JanusTarget>;
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
    /** `status` (a comma list) and `sort` are the query parameters of the same names, as text; both optional. */
    list(query?: { status?: string | null; sort?: string | null }): Promise<{ recordings: RecordingView[]; transcription: TranscriptionStatus }>;
    /** Full-text search over transcripts and titles; `params` are the query parameters, as text. */
    search(params: URLSearchParams): RecordingSearchResult;
    /** Renames: `body` is `{ title }`. */
    rename(id: string, body: unknown): Promise<RecordingView>;
    /** Starts the host recording the PiKVM's stream: `body` is `{ target?, mic, title?, transcribe? }`. One at a time (409). */
    startRecording(body: unknown): Promise<RecordingView>;
    /** Stops it cleanly; the recording goes on to "finishing". */
    stopRecording(id: string): Promise<RecordingView>;
    /** The capture in progress and the recordings being finished. */
    live(): RecordingLive;
    /** Told whenever `live()` changes. Returns the way to stop being told. */
    onLive(listener: () => void): () => void;
    /** The microphone socket of a recording in progress, after the router has judged the upgrade. */
    attachMic(req: IncomingMessage, socket: Duplex, head: Buffer, id: string): void;
    view(id: string): RecordingView;
    /** The file to serve, with its size; 409 until it exists. */
    media(id: string): Promise<{ path: string; size: number; mime: RecordingMime }>;
    transcript(id: string): Promise<string>;
    transcribe(id: string): Promise<RecordingView>;
    remove(id: string): Promise<void>;
    sweep(): Promise<void>;
}

const STATUSES: readonly RecordingStatus[] = ["recording", "finishing", "ready", "transcribing", "done", "failed"];
const DAY_MS = 86_400_000;

/** The `from` or `to` of a search: an ISO time, or a date alone (UTC), which for `to` means to the end of that day. */
function searchTime(raw: string | null, name: "from" | "to"): number | null {
    if (raw === null || raw.trim() === "") return null;
    const text = raw.trim();
    const at = Date.parse(text);
    if (!Number.isFinite(at)) throw new RecordingRefusal(`${name} must be an ISO date or time.`, 400);
    return name === "to" && /^\d{4}-\d{2}-\d{2}$/.test(text) ? at + DAY_MS : at;
}

function wholeNumber(raw: string | null, name: string, fallback: number, min: number, max: number): number {
    if (raw === null || raw === "") return fallback;
    const value = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(value) || value < min || value > max) throw new RecordingRefusal(`${name} must be a whole number from ${min} to ${max}.`, 400);
    return value;
}

const SWEEP_EVERY_MS = 60 * 60 * 1000;

function asObject(body: unknown): Record<string, unknown> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RecordingRefusal("The request body must be a JSON object.", 400);
    return body as Record<string, unknown>;
}

export function createRecordingService(options: RecordingServiceOptions): RecordingService {
    const log = options.log ?? ((line: string) => console.log(line));
    const limits = options.limits ?? limitsFromEnv();
    const store = new RecordingStore({ dataDir: options.dataDir, limits, log });
    // Opened at start, once the recordings directory exists. Until then (and for a host that cannot open one) it is unavailable.
    let index: RecordingIndex | null = null;
    let sweeper: NodeJS.Timeout | undefined;
    let stopping = false;
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
        const signature = await store.transcriptSignature(id);
        const view = await store.update(id, { status: "done", error: null, speakers: result.speakers.length, ...(store.durationMsOf(id) === null ? { durationMs: result.durationMs } : {}) });
        // Synchronous from the check to the write: a delete cannot land between them.
        if (store.has(id)) indexing(id, (db) => db.putTranscript(id, Date.parse(view.startedAt), signature, indexedSegments(result.segments)));
        await store.clearWork(id);
        log(`[recordings] ${id} transcribed: ${(result.durationMs / 1000).toFixed(0)} s of audio in ${result.tookSeconds} s, ${result.speakers.length} speaker(s), ${result.segments.length} segment(s)`);
    }

    /** A change to the search index. It is a copy: a failure is logged and the next start rebuilds it, never a failed recording. */
    function indexing(id: string, change: (db: RecordingIndex) => void): void {
        if (!index?.available) return;
        try {
            change(index);
        } catch (error) {
            log(`[recordings] ${id}: the search index could not be updated: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** Brings the index level with the recordings: rows of recordings that are gone out, transcripts and titles that changed in. */
    async function reconcile(db: RecordingIndex): Promise<void> {
        const known = new Set(store.ids());
        for (const id of db.ids()) if (!known.has(id)) db.remove(id);
        let rebuilt = 0;
        for (const view of store.views()) {
            const id = view.id;
            const startedMs = Date.parse(view.startedAt);
            const signature = view.status === "done" ? await store.transcriptSignature(id) : "";
            // A recording with nothing to index (no transcript, no title) has no rows, so it is not "stale" for lacking them.
            if ((db.signatureOf(id) ?? "") !== signature) {
                let segments: ReturnType<typeof indexedSegments> = [];
                if (signature !== "") {
                    try {
                        const parsed = JSON.parse((await store.readTranscript(id)) ?? "{}") as Partial<Transcript>;
                        segments = indexedSegments(Array.isArray(parsed.segments) ? parsed.segments : []);
                    } catch (error) {
                        log(`[recordings] ${id} has a transcript that cannot be read for the search index: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                db.putTranscript(id, startedMs, signature, segments);
                rebuilt += 1;
            }
            if (db.titleOf(id) !== view.title) db.putTitle(id, startedMs, view.title);
        }
        const stats = db.stats();
        log(`[recordings] search index: ${stats.recordings} recording(s), ${stats.segments} segment(s), ${stats.titles} title(s); ${rebuilt} transcript(s) indexed at start`);
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

    /** An older version's browser was uploading this recording when the host stopped: close it with what it holds. */
    async function closeUpload(id: string): Promise<void> {
        await store.update(id, { status: "ready", endedAt: Date.now() });
        if ((await store.measureFile(id)) === 0) {
            await store.update(id, { status: "failed", error: "The recording is empty: the host received no data." });
            return;
        }
        try {
            const facts = await probeMedia(store.mediaPath(id));
            if (facts?.durationSeconds && store.durationMsOf(id) === null) await store.update(id, { durationMs: Math.round(facts.durationSeconds * 1000) });
        } catch (error) {
            const why = error instanceof Error ? error.message : String(error);
            log(`[recordings] ${id} does not probe as media: ${why}`);
            await store.update(id, { status: "failed", error: `The recording could not be read as video or audio (${why}).` });
        }
    }

    /** A host recording's file exists: transcribe it when the start asked for that and this host can. */
    async function onReady(id: string): Promise<void> {
        if (!store.has(id) || !store.wantsTranscript(id) || store.bytesOf(id) === 0) return;
        if (!(await transcriber.status()).available) return;
        await store.update(id, { status: "transcribing" });
        await queue(id);
    }

    const recorder = createHostRecorder({
        store,
        limits,
        target: options.target,
        transcriberBusy: () => transcriber.busy(),
        onReady: (id) => onReady(id).catch((error: unknown) => logIgnoringGone(error, id)),
        log,
    });

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
            indexing(id, (db) => db.remove(id));
        }
    }

    async function boot(): Promise<void> {
        const loaded = await store.load();
        const db = RecordingIndex.open(store.root, log);
        index = db;
        if (db.available) await db.restrict(store.root);
        for (const id of loaded.openUploads) {
            log(`[recordings] ${id} was still being uploaded when the host stopped; closing it with what it holds`);
            await closeUpload(id);
        }
        for (const view of store.views()) if (view.status !== "transcribing") await store.clearWork(view.id);
        // Host recordings the last run left unfinished are finished in the background, from what their capture directories hold.
        recorder.recover([...loaded.capturing, ...loaded.finishing]);
        const status = await transcriber.status();
        for (const id of loaded.transcribing) {
            if (status.available) await queue(id);
            else await store.update(id, { status: "ready", error: null });
        }
        // A host stopped while it was starting (a test, a quick restart) has closed the index and has nothing left to start.
        if (stopping) return;
        if (db.available) await reconcile(db);
        await sweep();
        if (stopping) return;
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
            stopping = true;
            clearInterval(sweeper);
            // A recording in progress is closed cleanly first; its re-encode is finished at the next start.
            await recorder.shutdown();
            // Closed first and at once: a host that is stopping may exit before the transcriber has finished stopping, and an open
            // index would be left with its write-ahead log. A transcription that ends after this is indexed at the next start.
            index?.close();
            index = null;
            await transcriber.stop();
        },

        async list(query = {}) {
            let recordings = store.views();
            const wanted = (query.status ?? "").split(",").map((v) => v.trim()).filter((v) => v !== "");
            if (wanted.length > 0) {
                const unknown = wanted.find((v) => !STATUSES.some((status) => status === v));
                if (unknown !== undefined) throw new RecordingRefusal(`status must be a comma list of ${STATUSES.join(", ")}; "${unknown.slice(0, 40)}" is not one.`, 400);
                recordings = recordings.filter((r) => wanted.includes(r.status));
            }
            const sort = query.sort ?? "newest";
            if (sort !== "") {
                const by: RecordingSort | undefined = RECORDING_SORTS.find((s) => s === sort);
                if (!by) throw new RecordingRefusal(`sort must be one of ${RECORDING_SORTS.join(", ")}.`, 400);
                const started = (r: RecordingView): number => Date.parse(r.startedAt);
                // Stable on the start time, newest first, so equal lengths and sizes keep a sensible order.
                const order: Record<RecordingSort, (a: RecordingView, b: RecordingView) => number> = {
                    newest: (a, b) => started(b) - started(a),
                    oldest: (a, b) => started(a) - started(b),
                    longest: (a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1) || started(b) - started(a),
                    largest: (a, b) => b.bytes - a.bytes || started(b) - started(a),
                };
                recordings = [...recordings].sort(order[by]);
            }
            return { recordings, transcription: await transcriber.status() };
        },

        search(params) {
            if (!index?.available) throw new RecordingRefusal(index?.reason ?? "Search is not ready on this host yet.", 503);
            // Trailing white space is how a person says "that last word is finished": it ends the prefix match, so it is kept for the match.
            const raw = params.get("q") ?? "";
            const query = raw.trim();
            if (query === "") throw new RecordingRefusal("Type something to search for.", 400);
            if (query.length > MAX_SEARCH_QUERY_CHARS) throw new RecordingRefusal(`A search is at most ${MAX_SEARCH_QUERY_CHARS} characters.`, 400);
            const match = buildMatch(raw);
            if (match === null) throw new RecordingRefusal("There is nothing to search for in that: use words or numbers.", 400);
            const limit = wholeNumber(params.get("limit"), "limit", SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
            const offset = wholeNumber(params.get("offset"), "offset", 0, 0, 1_000_000);
            const speaker = (params.get("speaker") ?? "").trim();
            if (speaker.length > 100) throw new RecordingRefusal("speaker is at most 100 characters.", 400);
            const page = index.search({ match, limit, offset, speaker: speaker === "" ? null : speaker, fromMs: searchTime(params.get("from"), "from"), toMs: searchTime(params.get("to"), "to") });
            const hits = page.hits.flatMap((hit) => (store.has(hit.id) ? [{ recording: store.view(hit.id), kind: hit.kind, startMs: hit.startMs, endMs: hit.endMs, speaker: hit.speaker, text: hit.text, ranges: hit.ranges, rank: hit.rank }] : []));
            return { query, hits, total: page.total, recordings: page.recordings, offset, limit };
        },

        async rename(id, body) {
            const input = asObject(body);
            const raw = input["title"];
            if (raw !== null && typeof raw !== "string") throw new RecordingRefusal("title must be text, or null for the default name.", 400);
            // Control characters and runs of white space are one space: a title is one line.
            const title = raw === null ? "" : raw.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
            if (title.length > MAX_TITLE_CHARS) throw new RecordingRefusal(`A title is at most ${MAX_TITLE_CHARS} characters.`, 400);
            const view = await store.update(id, { title: title === "" ? null : title });
            indexing(id, (db) => db.putTitle(id, Date.parse(view.startedAt), view.title));
            return view;
        },

        async startRecording(body) {
            const view = await recorder.start(recorder.parseStart(body));
            indexing(view.id, (db) => db.putTitle(view.id, Date.parse(view.startedAt), view.title));
            return view;
        },

        stopRecording: (id) => recorder.stop(id),

        live: () => recorder.live(),

        onLive: (listener) => recorder.subscribe(listener),

        attachMic: (req, socket, head, id) => recorder.attachMic(req, socket, head, id),

        view: (id) => store.view(id),

        async media(id) {
            const status = store.status(id);
            if (status === "recording") throw new RecordingRefusal("This recording is still being recorded.", 409);
            if (status === "finishing") throw new RecordingRefusal("This recording is still being finished: its file is not made yet.", 409);
            const path = store.mediaPath(id);
            const info = await stat(path).catch(() => null);
            if (!info) throw new RecordingRefusal("This recording has no file.", 404);
            return { path, size: info.size, mime: store.mimeOf(id) };
        },

        async transcript(id) {
            const text = store.status(id) === "done" ? await store.readTranscript(id) : null;
            if (text === null) throw new RecordingRefusal("There is no transcript for this recording yet.", 404);
            return text;
        },

        async transcribe(id) {
            const status = store.status(id);
            if (status === "recording") throw new RecordingRefusal("This recording is still being recorded.", 409);
            if (status === "finishing") throw new RecordingRefusal("This recording is still being finished.", 409);
            if (status === "transcribing") return store.view(id);
            const available = await transcriber.status();
            if (!available.available) throw new RecordingRefusal(available.reason ?? "Transcription is not available on this host.", 503);
            if (store.bytesOf(id) === 0) throw new RecordingRefusal("This recording is empty.", 409);
            await store.clearTranscript(id);
            indexing(id, (db) => db.clearTranscript(id));
            const view = await store.update(id, { status: "transcribing", error: null, speakers: null });
            await queue(id);
            return view;
        },

        async remove(id) {
            store.view(id);
            // A capture in progress (or one being re-encoded) is stopped and lets go of its files first.
            await recorder.release(id);
            await transcriber.cancel(id);
            await store.remove(id);
            indexing(id, (db) => db.remove(id));
        },

        sweep,
    };
}
