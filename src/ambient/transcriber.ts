/**
 * Local speech-to-text controller for meetings.
 *
 * The renderer records speech-gated WebM chunks. This main-process controller
 * owns transcript state and UI status, while the expensive ffmpeg/whisper work
 * runs in `transcriber-worker.ts` so Electron stays responsive.
 */

import { EventEmitter } from "events";
import { join } from "path";
import { Worker } from "worker_threads";

/** Coarse high-level state for the UI; never just "listening" when it's actually broken. */
export type TranscriberState =
    | "idle" // not in a meeting / not started
    | "no-whisper" // nodejs-whisper couldn't be loaded
    | "no-node" // no node binary for nodejs-whisper to shell out to (Electron)
    | "no-ffmpeg" // ffmpeg isn't on PATH
    | "downloading-model" // first run: whisper model still being fetched
    | "no-audio" // started, but the renderer found no mic/remote stream to record
    | "listening" // capturing audio, waiting for the next chunk
    | "transcribing"; // a chunk is being decoded right now

export interface TranscriptSegment {
    ts: number;
    text: string;
}

export interface TranscriptStatus {
    state: TranscriberState;
    /** Human-readable one-liner for the UI banner. */
    detail: string;
    /** Whether the renderer is currently capturing each source. */
    mic: boolean;
    remote: boolean;
    /** A capture-side error (e.g. mic permission denied), if any. */
    captureError: string | null;
    segmentCount: number;
    lastSegmentAt: number;
    startedAt: number;
}

type EngineStatus = {
    whisper: "unknown" | "ready" | "unavailable";
    ffmpegMissing: boolean;
    nodeMissing: boolean;
    modelReady: boolean;
    workerError: string | null;
};

type WorkerOut =
    | { type: "status"; ffmpegMissing: boolean; nodeMissing: boolean; modelReady: boolean; whisperReady?: boolean }
    | { type: "segment"; sessionId: number; text: string }
    | { type: "done"; id: number };

export class Transcriber extends EventEmitter {
    private segments: TranscriptSegment[] = [];
    private active = false;
    private startedAt = 0;
    private lastSegmentAt = 0;
    private readonly model: string;
    private capture: { mic: boolean; remote: boolean; error: string | null } = { mic: false, remote: false, error: null };
    private nowFn: () => number;
    private worker: Worker | null = null;
    private sessionId = 0;
    private nextJobId = 1;
    private pendingJobs = new Set<number>();
    private engine: EngineStatus = {
        whisper: "unknown",
        ffmpegMissing: false,
        nodeMissing: false,
        modelReady: true,
        workerError: null,
    };

    constructor(opts: { model?: string; now?: () => number } = {}) {
        super();
        this.model = opts.model ?? "base.en";
        this.nowFn = opts.now ?? (() => Date.now());
    }

    start(): void {
        this.active = true;
        this.startedAt = this.nowFn();
        this.capture = { mic: false, remote: false, error: null };
        this.sessionId++;
        this.engine.workerError = null;
        this.postToWorker({ type: "start", sessionId: this.sessionId, model: this.model });
    }

    stop(): void {
        this.active = false;
        this.capture = { mic: false, remote: false, error: null };
        this.sessionId++;
        this.pendingJobs.clear();
        this.worker?.postMessage({ type: "stop", sessionId: this.sessionId });
    }

    /**
     * Start/stop capture from a manual UI toggle. Emits "capture" so the window
     * layer can tell the renderer to begin/end recording (the server can't reach
     * the KVM webContents directly).
     */
    setCapturing(on: boolean): void {
        if (on) this.start();
        else this.stop();
        this.emit("capture", on);
    }

    isActive(): boolean {
        return this.active;
    }

    clear(): void {
        this.segments = [];
        this.lastSegmentAt = 0;
    }

    /** Rolling transcript (most recent ~8k chars), clean text for the agent + log. */
    getTranscript(): string {
        return this.segments
            .map((s) => s.text)
            .join(" ")
            .slice(-8000);
    }

    /** The renderer reports which sources it managed to tap (and any capture error). */
    setCaptureStatus(s: { mic?: boolean; remote?: boolean; error?: string | null }): void {
        this.capture = {
            mic: !!s.mic,
            remote: !!s.remote,
            error: s.error ?? null,
        };
    }

    getStatus(): TranscriptStatus {
        const base = {
            mic: this.capture.mic,
            remote: this.capture.remote,
            captureError: this.capture.error,
            segmentCount: this.segments.length,
            lastSegmentAt: this.lastSegmentAt,
            startedAt: this.startedAt,
        };
        const mk = (state: TranscriberState, detail: string): TranscriptStatus => ({ state, detail, ...base });

        if (!this.active) return mk("idle", "Not in a meeting.");
        if (this.engine.workerError) return mk("no-whisper", this.engine.workerError);
        if (this.engine.whisper === "unavailable") return mk("no-whisper", "Speech-to-text engine unavailable (nodejs-whisper failed to load).");
        if (this.engine.nodeMissing)
            return mk("no-node", "Speech-to-text needs a Node.js binary on PATH (whisper.cpp shells out to it). Install Node or set NODEJS_WHISPER_NODE.");
        if (this.engine.ffmpegMissing) return mk("no-ffmpeg", "ffmpeg isn't installed - can't decode meeting audio.");
        if (this.capture.error) return mk("no-audio", this.capture.error);
        if (!this.capture.mic && !this.capture.remote)
            return mk("no-audio", "No audio to record - enable PiKVM audio/mic, or check mic permission.");
        if (this.engine.whisper === "ready" && !this.engine.modelReady)
            return mk("downloading-model", `Downloading the "${this.model}" speech model (first run, ~150 MB)...`);
        if (this.pendingJobs.size > 0) return mk("transcribing", "Transcribing the latest audio...");
        return mk("listening", this.captureLabel());
    }

    private captureLabel(): string {
        const src = [this.capture.mic && "your mic", this.capture.remote && "remote audio"].filter(Boolean).join(" + ");
        return `Listening to ${src}...`;
    }

    /** Feed one complete audio blob (WebM/Opus from the renderer). */
    pushAudio(buf: Buffer): void {
        if (!this.active || !buf?.length) return;
        const id = this.nextJobId++;
        this.pendingJobs.add(id);
        if (!this.postToWorker({ type: "audio", id, sessionId: this.sessionId, buffer: buf })) {
            this.pendingJobs.delete(id);
        }
    }

    /** Recent timestamped segments for the UI (most recent `n`). */
    getSegments(n = 80): TranscriptSegment[] {
        return this.segments.slice(-n);
    }

    private workerPath(): string {
        return join(__dirname, "ambient", "transcriber-worker.js");
    }

    private ensureWorker(): Worker | null {
        if (this.worker) return this.worker;
        try {
            const worker = new Worker(this.workerPath());
            this.worker = worker;
            this.engine.workerError = null;
            worker.on("message", (msg: WorkerOut) => this.onWorkerMessage(msg));
            worker.on("error", (err: Error) => {
                if (this.worker === worker) this.worker = null;
                this.pendingJobs.clear();
                this.engine.workerError = err?.message || "Speech-to-text worker failed.";
            });
            worker.on("exit", (code) => {
                if (this.worker === worker) this.worker = null;
                this.pendingJobs.clear();
                if (code !== 0) this.engine.workerError = `Speech-to-text worker exited (${code}).`;
            });
            return worker;
        } catch (e: any) {
            this.engine.workerError = e?.message || "Speech-to-text worker could not start.";
            return null;
        }
    }

    private postToWorker(msg: { type: "start"; sessionId: number; model: string } | { type: "stop"; sessionId: number } | { type: "audio"; id: number; sessionId: number; buffer: Buffer }): boolean {
        const worker = this.ensureWorker();
        if (!worker) return false;
        worker.postMessage(msg);
        return true;
    }

    private onWorkerMessage(msg: WorkerOut): void {
        if (!msg || typeof msg.type !== "string") return;
        if (msg.type === "status") {
            this.engine.ffmpegMissing = msg.ffmpegMissing;
            this.engine.nodeMissing = msg.nodeMissing;
            this.engine.modelReady = msg.modelReady;
            if (typeof msg.whisperReady === "boolean") this.engine.whisper = msg.whisperReady ? "ready" : "unavailable";
        } else if (msg.type === "done") {
            this.pendingJobs.delete(msg.id);
        } else if (msg.type === "segment") {
            if (!this.active || msg.sessionId !== this.sessionId || !msg.text.trim()) return;
            const ts = this.nowFn();
            this.segments.push({ ts, text: msg.text });
            this.lastSegmentAt = ts;
            this.emit("segment", msg.text);
        }
    }
}
