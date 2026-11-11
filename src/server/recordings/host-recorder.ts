import { readdir, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
    MAX_MIC_FRAME_BYTES,
    MAX_MIC_FRAMES_PER_SECOND,
    MAX_TITLE_CHARS,
    MIC_FRAME_HEADER_BYTES,
    type RecordingConnection,
    type RecordingEndReason,
    type RecordingHole,
    type RecordingLive,
    type RecordingView,
} from "@pikvm/contracts/recordings";
import {
    captureTuningFromEnv,
    createReencoder,
    diskUsageOf,
    recoverCapture,
    startCapture,
    type CaptureEvent,
    type CaptureHandle,
    type CaptureResult,
    type JanusTarget,
    type ReencodeProgress,
    type Reencoder,
} from "./capture";
import type { RecordingLimits } from "./limits";
import { probeMedia } from "./media";
import { RecordingRefusal, type RecordingStore } from "./store";

/**
 * The host's own recorder: it owns the one capture in progress (capture/session.ts joins the PiKVM's Janus stream and writes it), the
 * background re-encoder every capture shares, the microphone socket a page feeds, and the work of finishing a recording (waiting for
 * the re-encode, checking the file, handing it on to be transcribed). The service (service.ts) wraps it with the store and the
 * transcriber; the routes (routes.ts) speak to the service.
 *
 * What happens to one recording, in `status` words of the contract:
 *   start()    "recording": capture/session.ts runs, raw segments (about 5 minutes each) land in `<recording>/capture/raw`; each closed
 *              one goes to the re-encoder (nice 19, one job at a time, held while a transcription runs) and comes out in `capture/stored`.
 *   stop(), a limit, the PiKVM gone for 15 minutes, or the host stopping: "finishing": the capture is closed; the re-encode of what is left
 *              runs; `progress` says how far.
 *   the file   "ready": the stored segments are joined into `<recording>/<id>.mp4`, the capture directory is gone; the service then
 *              starts the transcription if the start asked for it.
 *
 * After a host restart (or crash) every recording left "recording" or "finishing" is finished from its capture directory by
 * `recoverCapture`: raw segments that were never re-encoded are re-encoded, stored ones kept, all joined.
 */

/** A pong is awaited this long; a microphone socket that answers none in two of these is dropped. */
const MIC_PING_MS = 15_000;
/** A microphone frame whose time is more than this off the host's clock (after the hello's correction) is dropped. */
const MIC_CLOCK_WINDOW_MS = 15_000;
/** How often the disk is read for what each unfinished recording takes (the capture reads it by itself for its own limits). */
const DISK_TICK_MS = 2000;
/** The longest a delete waits for a capture it has stopped to let go of its files. */
const RELEASE_WAIT_MS = 20_000;

export interface HostRecorderOptions {
    store: RecordingStore;
    limits: RecordingLimits;
    /** Where the PiKVM is; absent on a host with none (a start is then 503). */
    target: (() => Promise<JanusTarget>) | undefined;
    /** True while a transcription runs or waits: the re-encoder holds its job then. */
    transcriberBusy: () => boolean;
    /** Called once a recording's file exists and has been checked ("ready"); the service decides whether to transcribe. */
    onReady: (id: string) => Promise<void>;
    env?: NodeJS.ProcessEnv;
    log: (line: string) => void;
}

/** The longest a click is counted from: a microphone prompt can hold a start up for a while. */
const MAX_CLICK_AGO_MS = 600_000;

export interface StartInput {
    target: string | null;
    title: string | null;
    mic: boolean;
    transcribe: boolean;
    /** How long before the request the person clicked Record, in ms: the count starts from the click, not the first picture. */
    clickedAgoMs: number;
}

export interface HostRecorder {
    /** Body of `POST /start`, checked. */
    parseStart(body: unknown): StartInput;
    start(input: StartInput): Promise<RecordingView>;
    stop(id: string): Promise<RecordingView>;
    /** Stops a capture or a recovery of this recording and lets go of its files, for a delete. Does nothing for another recording. */
    release(id: string): Promise<void>;
    live(): RecordingLive;
    /** Told when the live state changes (not on a timer). Returns the way to stop being told. */
    subscribe(listener: () => void): () => void;
    /** The microphone socket of `/:id/mic`, after the router has judged the request. */
    attachMic(req: IncomingMessage, socket: Duplex, head: Buffer, id: string): void;
    /** Finishes recordings the last run left unfinished, in the background. */
    recover(ids: readonly string[]): void;
    /** Stops the capture in progress cleanly, for the host stopping. Leaves the re-encode to the next start. */
    shutdown(): Promise<void>;
}

/** What the recorder knows about one recording that is being captured, finished or recovered. */
interface Cap {
    id: string;
    /** Null for a recovery. */
    handle: CaptureHandle | null;
    micRequested: boolean;
    mic: WebSocket | null;
    startedWall: number | null;
    connection: RecordingConnection;
    note: string | null;
    holes: RecordingHole[];
    rawBacklog: number;
    segments: Set<number>;
    ratios: Map<number, number>;
    /** Which of the two limits `maxBytes` last expressed. */
    bound: "quota" | "recording_cap";
    interrupted: boolean;
    /** The capture has ended (a recovery has none: true from the start). */
    ended: boolean;
    /** The whole thing is over: the file exists or the recording failed. */
    done: boolean;
    removing: boolean;
    /** Resolves when the end has been written to meta. */
    endHandled: Promise<void>;
    /** Resolves when `done`. */
    finished: Promise<void>;
    finish: () => void;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The sender's clock from the microphone socket's first message, or null when it is not the hello. */
function clientNow(message: string): number | null {
    try {
        const hello: unknown = JSON.parse(message);
        if (typeof hello !== "object" || hello === null || !("hello" in hello) || !("now" in hello)) return null;
        return hello.hello === 1 && typeof hello.now === "number" && Number.isFinite(hello.now) ? hello.now : null;
    } catch {
        return null;
    }
}

function hostName(origin: URL): string {
    return origin.host || origin.href;
}

export function createHostRecorder(options: HostRecorderOptions): HostRecorder {
    const { store, limits, log } = options;
    const { maxRawBacklogBytes, ...captureTuning } = captureTuningFromEnv(options.env ?? process.env);
    const caps = new Map<string, Cap>();
    const listeners = new Set<() => void>();
    const wss = new WebSocketServer({ noServer: true, maxPayload: MIC_FRAME_HEADER_BYTES + MAX_MIC_FRAME_BYTES + 64 });
    let starting = false;
    let disk: NodeJS.Timeout | undefined;
    let stopped = false;

    const changed = (): void => {
        for (const listener of listeners) {
            try {
                listener();
            } catch (error) {
                log(`[recordings] a live-state listener threw: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    };

    const reencoder: Reencoder = createReencoder({
        shouldPause: () => options.transcriberBusy(),
        log,
        onProgress: (p) => noteProgress(p),
    });

    /** A re-encode job's id is `<recording id>:<segment>` for a capture and `recover:<capture dir>:<segment>` for a recovery. */
    function noteProgress(p: ReencodeProgress): void {
        const id = /^([0-9a-f]{32}):/.exec(p.id)?.[1] ?? /recordings\/([0-9a-f]{32})\//.exec(p.id)?.[1];
        const index = /:(\d+)$/.exec(p.id)?.[1];
        const cap = id ? caps.get(id) : undefined;
        if (!cap || index === undefined || p.ratio === null) return;
        cap.ratios.set(Number(index), Math.min(1, p.ratio));
        reportProgress(cap);
    }

    function reportProgress(cap: Cap): void {
        if (!cap.ended || cap.done) return;
        const known = new Set<number>([...cap.segments, ...cap.ratios.keys()]);
        if (known.size === 0) return;
        let sum = 0;
        for (const index of known) sum += cap.ratios.get(index) ?? 0;
        store.setProgress(cap.id, sum / known.size);
    }

    function active(): Cap | undefined {
        for (const cap of caps.values()) if (!cap.ended) return cap;
        return undefined;
    }

    function newCap(id: string, handle: CaptureHandle | null, micRequested: boolean): Cap {
        const finished = Promise.withResolvers<void>();
        const cap: Cap = {
            id,
            handle,
            micRequested,
            mic: null,
            startedWall: null,
            connection: "connecting",
            note: null,
            holes: [],
            rawBacklog: 0,
            segments: new Set(),
            ratios: new Map(),
            bound: "quota",
            interrupted: false,
            ended: handle === null,
            done: false,
            removing: false,
            endHandled: Promise.resolve(),
            finished: finished.promise,
            finish: finished.resolve,
        };
        caps.set(id, cap);
        ensureDiskTick();
        return cap;
    }

    function ensureDiskTick(): void {
        if (disk || stopped) return;
        disk = setInterval(() => void tickDisk(), DISK_TICK_MS);
        disk.unref();
    }

    async function tickDisk(): Promise<void> {
        let busy = false;
        for (const cap of caps.values()) {
            if (cap.done) continue;
            busy = true;
            if (!store.has(cap.id)) continue;
            try {
                const usage = await diskUsageOf(store.captureDir(cap.id));
                store.setBytes(cap.id, usage.totalBytes);
                if (cap.ended) reportProgress(cap);
            } catch {
                // The directory is going away (a delete) or not there yet.
            }
        }
        if (!busy) {
            clearInterval(disk);
            disk = undefined;
        } else changed();
    }

    // -- the capture's events ------------------------------------------------------------------------------------
    function onEvent(cap: Cap, event: CaptureEvent): void {
        switch (event.type) {
            case "connecting":
                cap.connection = "connecting";
                break;
            case "connected":
                cap.connection = "live";
                cap.note = null;
                break;
            case "reconnecting":
                cap.connection = "reconnecting";
                cap.note = event.reason;
                break;
            case "keyframe":
                cap.connection = "live";
                cap.note = null;
                break;
            case "bytes":
                cap.rawBacklog = event.backlogBytes;
                store.setBytes(cap.id, event.rawBytes + event.storedBytes, event.elapsedMs);
                break;
            case "segment":
                cap.segments.add(event.index);
                break;
            case "stored":
                cap.ratios.set(event.index, 1);
                reportProgress(cap);
                break;
            case "hole": {
                cap.holes.push({ fromMs: event.fromMs, toMs: event.toMs });
                const holes = cap.holes.map((h) => ({ ...h }));
                void store.update(cap.id, { holes }).catch(() => undefined);
                break;
            }
            case "limit":
                log(`[recordings] ${cap.id} closed at a limit (${event.reason}): ${event.detail}`);
                break;
            case "ffmpeg-restart":
                log(`[recordings] ${cap.id} restarted its ffmpeg (${event.reason}, attempt ${event.attempt})`);
                break;
            case "warning":
                log(`[recordings] ${cap.id}: ${event.message}`);
                break;
            case "error":
                log(`[recordings] ${cap.id}: ${event.message}${event.fatal ? " (the capture ends)" : ""}`);
                break;
            default:
                return;
        }
        changed();
    }

    // -- the end of a capture, and the file ------------------------------------------------------------------------
    async function onEnded(cap: Cap, result: CaptureResult): Promise<void> {
        cap.ended = true;
        cap.connection = "connecting";
        const mic = cap.mic;
        cap.mic = null;
        mic?.close(1000, "the recording ended");
        if (cap.removing || !store.has(cap.id)) return;
        const reason: RecordingEndReason = cap.interrupted ? "interrupted" : result.reason === "quota" ? cap.bound : result.reason;
        log(`[recordings] ${cap.id} ended (${reason}): ${(result.durationMs / 1000).toFixed(0)} s, ${result.holes.length} hole(s), ${(result.bytes / 1048576).toFixed(0)} MB raw`);
        await store.update(cap.id, {
            status: "finishing",
            endedAt: Date.now(),
            durationMs: result.durationMs,
            reason,
            holes: result.holes,
            hasMic: result.hasMicTrack,
            error: result.reason === "error" ? (result.error ?? "The recording stopped because of an error.") : null,
        });
        changed();
    }

    /** The file exists, or could not be made: check it and hand it on, or fail the recording. */
    async function settle(cap: Cap, outcome: { ok: true; durationMs: number } | { ok: false; error: string }): Promise<void> {
        try {
            if (cap.removing || !store.has(cap.id)) return;
            if (!outcome.ok) {
                log(`[recordings] ${cap.id} could not be finished: ${outcome.error}`);
                await store.update(cap.id, { status: "failed", error: `The recording could not be finished: ${outcome.error}` });
                return;
            }
            const file = store.outputPath(cap.id);
            let durationMs = outcome.durationMs;
            let hasMic = store.view(cap.id).hasMic;
            try {
                const facts = await probeMedia(file);
                if (facts) {
                    if (facts.durationSeconds) durationMs = Math.round(facts.durationSeconds * 1000);
                    hasMic = facts.audioStreams.some((s) => s.name === "mic");
                }
            } catch (error) {
                const why = error instanceof Error ? error.message : String(error);
                await store.update(cap.id, { status: "failed", error: `The recording could not be read as video or audio (${why}).` });
                return;
            }
            // A capture directory that is still there holds segments that could not be re-encoded: they still take disk.
            const left = await diskUsageOf(store.captureDir(cap.id)).then((u) => u.totalBytes, () => 0);
            await store.measureFile(cap.id);
            store.setBytes(cap.id, store.bytesOf(cap.id) + left);
            await store.update(cap.id, { status: "ready", durationMs, hasMic });
            log(`[recordings] ${cap.id} is ready: ${(durationMs / 1000).toFixed(0)} s, ${(store.bytesOf(cap.id) / 1048576).toFixed(1)} MB`);
            await options.onReady(cap.id);
        } catch (error) {
            if (!(error instanceof RecordingRefusal && error.status === 404)) {
                log(`[recordings] ${cap.id}: could not record the end of its finishing: ${error instanceof Error ? error.message : String(error)}`);
            }
        } finally {
            cap.done = true;
            cap.finish();
            changed();
        }
    }

    async function supervise(cap: Cap): Promise<void> {
        const handle = cap.handle;
        if (!handle) return;
        const ended = handle.ended.then((result) => onEnded(cap, result));
        cap.endHandled = ended.catch(() => undefined);
        try {
            await ended;
        } catch (error) {
            log(`[recordings] ${cap.id}: could not record the end of the capture: ${error instanceof Error ? error.message : String(error)}`);
        }
        const outcome = await handle.compacted;
        await settle(cap, outcome.ok ? { ok: true, durationMs: outcome.value.durationMs } : { ok: false, error: outcome.error });
    }

    // -- starting and stopping -----------------------------------------------------------------------------------
    function parseStart(body: unknown): StartInput {
        if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RecordingRefusal("The request body must be a JSON object.", 400);
        const input = body as Record<string, unknown>;
        if (typeof input["mic"] !== "boolean") throw new RecordingRefusal("mic must be true or false.", 400);
        const target = input["target"];
        if (target !== undefined && target !== null && typeof target !== "string") throw new RecordingRefusal("target must be text.", 400);
        const rawTitle = input["title"];
        if (rawTitle !== undefined && rawTitle !== null && typeof rawTitle !== "string") throw new RecordingRefusal("title must be text.", 400);
        const title = text(rawTitle).replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
        if (title.length > MAX_TITLE_CHARS) throw new RecordingRefusal(`A title is at most ${MAX_TITLE_CHARS} characters.`, 400);
        const transcribe = input["transcribe"];
        if (transcribe !== undefined && typeof transcribe !== "boolean") throw new RecordingRefusal("transcribe must be true or false.", 400);
        const clicked = input["clickedAgoMs"];
        if (clicked !== undefined && clicked !== null && (typeof clicked !== "number" || !Number.isFinite(clicked) || clicked < 0)) {
            throw new RecordingRefusal("clickedAgoMs must be zero or more milliseconds.", 400);
        }
        const clickedAgoMs = Math.min(typeof clicked === "number" ? clicked : 0, MAX_CLICK_AGO_MS);
        const name = text(target).trim().slice(0, 200);
        return { target: name === "" ? null : name, title: title === "" ? null : title, mic: input["mic"], transcribe: transcribe ?? true, clickedAgoMs };
    }

    async function start(input: StartInput): Promise<RecordingView> {
        if (!options.target) throw new RecordingRefusal("This host has no PiKVM to record.", 503);
        const running = active();
        if (running || starting) {
            throw new RecordingRefusal("A recording is already in progress.", 409, running && store.has(running.id) ? { recording: store.view(running.id) } : {});
        }
        starting = true;
        try {
            let janus: JanusTarget;
            try {
                janus = await options.target();
            } catch (error) {
                throw new RecordingRefusal(`This host cannot tell where the PiKVM is: ${error instanceof Error ? error.message : String(error)}`, 503);
            }
            const view = await store.createHost({
                startedAt: new Date().toISOString(),
                target: input.target ?? hostName(janus.origin),
                title: input.title,
                mic: input.mic,
                transcribe: input.transcribe,
            });
            const id = view.id;
            const cap = newCap(id, null, input.mic);
            // The count starts from the click: the page has shown it running since then, and the first picture comes later.
            cap.startedWall = Date.now() - input.clickedAgoMs;
            try {
                const handle = startCapture({
                    target: janus,
                    outputPath: store.outputPath(id),
                    workDir: store.captureDir(id),
                    mic: input.mic,
                    reencoder,
                    ...captureTuning,
                    limits: {
                        maxBytes: () => {
                            // What this recording may still take: its own cap, or what is left of the total after the others.
                            const left = limits.maxTotalBytes - (store.totalBytes() - store.bytesOf(id));
                            cap.bound = limits.maxRecordingBytes <= left ? "recording_cap" : "quota";
                            return Math.max(0, Math.min(limits.maxRecordingBytes, left));
                        },
                        maxBytesReason: "quota",
                        maxRawBacklogBytes,
                    },
                    log,
                    onEvent: (event) => onEvent(cap, event),
                });
                cap.handle = handle;
                cap.ended = false;
                void supervise(cap);
            } catch (error) {
                caps.delete(id);
                await store.update(id, { status: "failed", error: `The recording could not start: ${error instanceof Error ? error.message : String(error)}`, reason: "error" }).catch(() => undefined);
                throw error;
            }
            log(`[recordings] ${id} started on ${store.view(id).target ?? "the PiKVM"}${input.mic ? " with a microphone track" : ""}`);
            changed();
            return store.view(id);
        } finally {
            starting = false;
        }
    }

    async function stop(id: string): Promise<RecordingView> {
        const view = store.view(id);
        const cap = caps.get(id);
        if (!cap || cap.ended || !cap.handle) {
            throw new RecordingRefusal("This recording is already stopped.", 409, { recording: view });
        }
        await cap.handle.stop();
        await cap.endHandled;
        changed();
        return store.view(id);
    }

    async function release(id: string): Promise<void> {
        const cap = caps.get(id);
        if (!cap) return;
        cap.removing = true;
        cap.mic?.close(1000, "the recording was deleted");
        cap.mic = null;
        const settled = async (): Promise<void> => {
            if (cap.handle) {
                if (!cap.ended) await cap.handle.stop();
                // Nothing of it is wanted: cancel what the re-encoder holds for it, so the capture's own end comes quickly.
                for (const index of cap.segments) reencoder.cancel(`${id}:${index}`);
                await cap.handle.ended;
                for (const index of cap.segments) reencoder.cancel(`${id}:${index}`);
                await cap.handle.compacted;
            } else {
                const dir = store.captureDir(id);
                const names = await readdir(join(dir, "raw")).catch(() => [] as string[]);
                for (const name of names) {
                    const index = /^seg-(\d+)\./.exec(name)?.[1];
                    if (index !== undefined) reencoder.cancel(`recover:${dir}:${Number(index)}`);
                }
                await cap.finished;
            }
        };
        await Promise.race([settled().catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, RELEASE_WAIT_MS).unref())]);
        cap.done = true;
        caps.delete(id);
        changed();
    }

    // -- recovery ------------------------------------------------------------------------------------------------
    async function recoverOne(id: string): Promise<void> {
        const view = store.view(id);
        if (view.status === "recording") {
            log(`[recordings] ${id} was still recording when the host stopped; finishing it with what it holds`);
            await store.update(id, { status: "finishing", endedAt: Date.now(), reason: "interrupted" });
        } else {
            log(`[recordings] ${id} was being finished when the host stopped; finishing it again`);
        }
        const cap = newCap(id, null, false);
        cap.ended = true;
        changed();
        const dir = store.captureDir(id);
        const file = store.outputPath(id);
        const hasDir = await stat(dir).then(() => true, () => false);
        const hasFile = await stat(file).then(() => true, () => false);
        if (!hasDir && !hasFile) {
            await settle(cap, { ok: false, error: "nothing was recorded." });
            return;
        }
        if (!hasDir) {
            await settle(cap, { ok: true, durationMs: store.durationMsOf(id) ?? 0 });
            return;
        }
        const outcome = await recoverCapture({ workDir: dir, outputPath: file, reencoder, log });
        await settle(cap, outcome.ok ? { ok: true, durationMs: outcome.value.durationMs } : { ok: false, error: outcome.error });
    }

    // -- the microphone ---------------------------------------------------------------------------------------------
    function attachMic(req: IncomingMessage, socket: Duplex, head: Buffer, id: string): void {
        wss.handleUpgrade(req, socket, head, (ws) => feedMic(ws, id));
    }

    function feedMic(ws: WebSocket, id: string): void {
        const cap = caps.get(id);
        if (!cap || cap.ended || !cap.handle) return void ws.close(4404, "no such recording in progress");
        if (!cap.micRequested) return void ws.close(4409, "this recording takes no microphone");
        cap.mic?.close(4000, "another page took over the microphone");
        cap.mic = ws;
        const handle = cap.handle;
        let offsetMs: number | null = null;
        let frames = 0;
        let dropped = 0;
        // A token bucket: MAX_MIC_FRAMES_PER_SECOND on average, twice that in a burst.
        let tokens = MAX_MIC_FRAMES_PER_SECOND * 2;
        let refilled = Date.now();
        let alive = true;
        const ping = setInterval(() => {
            if (!alive) return ws.terminate();
            alive = false;
            ws.ping();
        }, MIC_PING_MS);
        ping.unref();
        ws.on("pong", () => (alive = true));
        changed();
        ws.on("message", (data: RawData, isBinary: boolean) => {
            alive = true;
            if (!isBinary) {
                const sent = clientNow(String(data));
                if (sent === null) return void ws.close(1002, "the first message must be the hello");
                offsetMs = Date.now() - sent;
                ws.send(JSON.stringify({ ready: 1 }));
                return;
            }
            const now = Date.now();
            tokens = Math.min(MAX_MIC_FRAMES_PER_SECOND * 2, tokens + ((now - refilled) * MAX_MIC_FRAMES_PER_SECOND) / 1000);
            refilled = now;
            if (tokens < 1) return void ws.close(1008, "too many frames");
            tokens -= 1;
            const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
            if (offsetMs === null || buffer.length <= MIC_FRAME_HEADER_BYTES || buffer.length > MIC_FRAME_HEADER_BYTES + MAX_MIC_FRAME_BYTES) {
                dropped += 1;
                return;
            }
            const ptsMs = buffer.readDoubleBE(0) + offsetMs;
            if (!Number.isFinite(ptsMs) || Math.abs(ptsMs - now) > MIC_CLOCK_WINDOW_MS) {
                dropped += 1;
                return;
            }
            frames += 1;
            handle.pushMic({ ptsMs, data: buffer.subarray(MIC_FRAME_HEADER_BYTES) });
        });
        ws.on("close", () => {
            clearInterval(ping);
            if (cap.mic === ws) cap.mic = null;
            log(`[recordings] ${id}: the microphone socket closed after ${frames} frame(s), ${dropped} dropped`);
            changed();
        });
        ws.on("error", () => ws.terminate());
    }

    // -- reading ----------------------------------------------------------------------------------------------------
    function live(): RecordingLive {
        const cap = active();
        const now = Date.now();
        const finishing: RecordingLive["finishing"] = [];
        for (const other of caps.values()) {
            if (other.ended && !other.done && store.has(other.id)) finishing.push({ id: other.id, progress: store.view(other.id).progress });
        }
        if (!cap || !store.has(cap.id)) {
            return { at: now, recording: null, elapsedMs: 0, rawBacklogBytes: 0, bytes: 0, connection: null, connectionNote: null, holes: [], mic: "off", finishing };
        }
        return {
            at: now,
            recording: store.view(cap.id),
            elapsedMs: cap.startedWall === null ? 0 : Math.max(0, now - cap.startedWall),
            rawBacklogBytes: cap.rawBacklog,
            bytes: store.bytesOf(cap.id),
            connection: cap.connection,
            connectionNote: cap.note,
            holes: cap.holes.map((h) => ({ ...h })),
            mic: !cap.micRequested ? "off" : cap.mic ? "connected" : "waiting",
            finishing,
        };
    }

    return {
        parseStart,
        start,
        stop,
        release,
        live,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        attachMic,
        recover(ids) {
            for (const id of ids) {
                void recoverOne(id).catch((error: unknown) => {
                    log(`[recordings] ${id} could not be recovered: ${error instanceof Error ? error.message : String(error)}`);
                    void store.update(id, { status: "failed", error: `The recording could not be recovered: ${error instanceof Error ? error.message : String(error)}` }).catch(() => undefined);
                });
            }
        },
        async shutdown() {
            stopped = true;
            clearInterval(disk);
            disk = undefined;
            const cap = active();
            if (cap?.handle) {
                cap.interrupted = true;
                log(`[recordings] the host is stopping: ${cap.id} is closed cleanly and will be finished at the next start`);
                await Promise.race([cap.handle.stop().then(() => cap.endHandled), new Promise<void>((resolve) => setTimeout(resolve, 6000).unref())]);
            }
            // The re-encoder is NOT disposed: a capture that still waits for it would treat the cancelled jobs as failed and join or delete
            // what is left. The re-encode that is running ends with this process; the next start re-queues it from the capture directory.
            for (const other of caps.values()) other.mic?.close(1001, "the host is stopping");
            wss.close();
            changed();
        },
    };
}
