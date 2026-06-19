/**
 * Local speech-to-text for meetings, via whisper.cpp (nodejs-whisper).
 *
 * The renderer mixes the user's local mic with the PiKVM playback audio and ships
 * complete ~10s WebM blobs; each is converted to 16kHz mono WAV with ffmpeg, then
 * transcribed locally — nothing leaves the machine. Segments accumulate into a
 * rolling transcript the agent and meeting assistant can read.
 *
 * Everything degrades gracefully, but — unlike before — it is no longer SILENT
 * about it: getStatus() reports exactly why there's no text yet (no audio stream,
 * model still downloading, ffmpeg/whisper missing, …) so the UI can stop lying
 * with a permanent "Listening…".
 */

import { spawn, execSync } from "child_process";
import { writeFile, mkdtemp, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { EventEmitter } from "events";

// Resolve at runtime from the CJS bundle (nodejs-whisper is kept external by the
// build). Direct eval so it captures the module-scoped `require`, and stays valid
// whether tsc treats this file as ESM or CJS. modelReady() tolerates failure.
// eslint-disable-next-line no-eval
const nodeRequire: NodeRequire = eval("require");

/**
 * Find a real `node` binary. nodejs-whisper shells out via shelljs to download
 * the model and run whisper.cpp, but under Electron `process.execPath` is the
 * Electron binary, so shelljs can't find node ("Unable to find a path to the
 * node binary") and every exec fails. We locate a system node and point shelljs
 * at it. Best-effort; returns null if node truly isn't installed.
 */
function resolveNodePath(): string | null {
    for (const c of [process.env.NODEJS_WHISPER_NODE, process.env.NODE]) {
        if (c && existsSync(c)) return c;
    }
    try {
        const cmd = process.platform === "win32" ? "where node" : "command -v node 2>/dev/null";
        const out = execSync(cmd, { encoding: "utf8", shell: process.platform === "win32" ? undefined : "/bin/sh" })
            .split(/\r?\n/)[0]
            ?.trim();
        if (out && existsSync(out)) return out;
    } catch {
        /* not on PATH */
    }
    for (const c of ["/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node"]) {
        if (existsSync(c)) return c;
    }
    return null;
}

let shellConfigured = false;
/** Point shelljs (used by nodejs-whisper) at a real node binary, once. */
function configureShellForWhisper(): boolean {
    if (shellConfigured) return true;
    const node = resolveNodePath();
    if (!node) return false;
    try {
        const sh: any = nodeRequire("shelljs");
        if (sh?.config) {
            sh.config.execPath = node;
            sh.config.fatal = false; // a failed exec must reject, not hard-exit
            shellConfigured = true;
            return true;
        }
    } catch {
        /* shelljs (a nodejs-whisper dep) not resolvable — feature unavailable */
    }
    return false;
}

function ffmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const p = spawn("ffmpeg", args, { stdio: "ignore" });
        p.on("error", reject);
        p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });
}

/** whisper.cpp output is "[00:00:00.000 --> 00:00:02.000]  text" lines. */
function cleanWhisperText(raw: string): string {
    return raw
        .split("\n")
        .map((l) => l.replace(/^\s*\[[^\]]*\]\s*/, "").trim())
        .filter(Boolean)
        .filter((l) => !/^\(.*\)$/.test(l)) // drop "(silence)" / "(music)" markers
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
}

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

export class Transcriber extends EventEmitter {
    private segments: TranscriptSegment[] = [];
    private queue: Promise<void> = Promise.resolve();
    private inFlight = 0;
    private active = false;
    private startedAt = 0;
    private lastSegmentAt = 0;
    private readonly model: string;
    private whisperFn: ((file: string, opts: any) => Promise<string>) | null | undefined;
    private ffmpegMissing = false;
    private nodeMissing = false;
    private capture: { mic: boolean; remote: boolean; error: string | null } = { mic: false, remote: false, error: null };
    private nowFn: () => number;

    constructor(opts: { model?: string; now?: () => number } = {}) {
        super();
        this.model = opts.model ?? "base.en";
        this.nowFn = opts.now ?? (() => Date.now());
        void this.checkFfmpeg();
    }

    start(): void {
        this.active = true;
        this.startedAt = this.nowFn();
        this.capture = { mic: false, remote: false, error: null };
        // Warm whisper up front so the first chunk isn't blocked on a cold import
        // (and so getStatus() can report "downloading-model" before audio arrives).
        void this.ensureWhisper();
    }
    stop(): void {
        this.active = false;
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

    /** Whether the whisper model is present on disk yet (else first run downloads it). */
    private modelReady(): boolean {
        try {
            const pkg = nodeRequire.resolve("nodejs-whisper/package.json");
            const file = join(dirname(pkg), "cpp", "whisper.cpp", "models", `ggml-${this.model}.bin`);
            return existsSync(file);
        } catch {
            // Can't locate the package layout — don't claim it's downloading.
            return true;
        }
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
        if (this.whisperFn === null) return mk("no-whisper", "Speech-to-text engine unavailable (nodejs-whisper failed to load).");
        if (this.nodeMissing)
            return mk("no-node", "Speech-to-text needs a Node.js binary on PATH (whisper.cpp shells out to it). Install Node or set NODEJS_WHISPER_NODE.");
        if (this.ffmpegMissing) return mk("no-ffmpeg", "ffmpeg isn't installed — can't decode meeting audio.");
        // No point claiming the model is downloading if there's no audio to feed it —
        // the download is triggered by the first chunk, so surface the audio gap first.
        if (this.capture.error) return mk("no-audio", this.capture.error);
        if (!this.capture.mic && !this.capture.remote)
            return mk("no-audio", "No audio to record — enable PiKVM audio/mic, or check mic permission.");
        if (this.whisperFn !== undefined && !this.modelReady())
            return mk("downloading-model", `Downloading the “${this.model}” speech model (first run, ~150 MB)…`);
        if (this.inFlight > 0) return mk("transcribing", "Transcribing the latest audio…");
        return mk("listening", this.captureLabel());
    }

    private captureLabel(): string {
        const src = [this.capture.mic && "your mic", this.capture.remote && "remote audio"].filter(Boolean).join(" + ");
        return `Listening to ${src}…`;
    }

    /** Feed one complete audio blob (WebM/Opus from the renderer). */
    pushAudio(buf: Buffer): void {
        if (!this.active || !buf?.length) return;
        this.inFlight++;
        this.queue = this.queue
            .then(() => this.process(buf))
            .catch(() => {})
            .finally(() => {
                this.inFlight--;
            });
    }

    private async checkFfmpeg(): Promise<void> {
        try {
            await ffmpeg(["-version"]);
            this.ffmpegMissing = false;
        } catch {
            this.ffmpegMissing = true;
        }
    }

    private async ensureWhisper(): Promise<((file: string, opts: any) => Promise<string>) | null> {
        if (this.whisperFn !== undefined) return this.whisperFn;
        let fn: ((file: string, opts: any) => Promise<string>) | null = null;
        try {
            const mod: any = await import("nodejs-whisper");
            fn = mod.nodewhisper ?? mod.default?.nodewhisper ?? null;
            // nodejs-whisper shells out via shelljs, which needs a real node binary
            // (Electron's process.execPath is the Electron binary). Without this the
            // model download and every transcription fail.
            if (fn && !configureShellForWhisper()) {
                this.nodeMissing = true;
            }
        } catch {
            fn = null;
        }
        this.whisperFn = fn;
        return fn;
    }

    private async process(buf: Buffer): Promise<void> {
        const whisper = await this.ensureWhisper();
        if (!whisper) return;
        const dir = await mkdtemp(join(tmpdir(), "pikvm-stt-"));
        const webm = join(dir, "chunk.webm");
        const wav = join(dir, "chunk.wav");
        try {
            await writeFile(webm, buf);
            try {
                await ffmpeg(["-y", "-i", webm, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
            } catch (e: any) {
                if (e?.code === "ENOENT") this.ffmpegMissing = true;
                throw e;
            }
            let out = "";
            try {
                out = await whisper(wav, {
                    modelName: this.model,
                    autoDownloadModelName: this.model,
                    whisperOptions: { outputInText: false, outputInSrt: false, outputInVtt: false },
                });
            } catch {
                out = "";
            }
            // Some versions write a .wav.txt rather than returning the text.
            if (!out || !out.trim()) {
                out = await readFile(`${wav}.txt`, "utf-8").catch(() => "");
            }
            const text = cleanWhisperText(out);
            if (text) {
                const ts = this.nowFn();
                this.segments.push({ ts, text });
                this.lastSegmentAt = ts;
                this.emit("segment", text);
            }
        } finally {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }

    /** Recent timestamped segments for the UI (most recent `n`). */
    getSegments(n = 80): TranscriptSegment[] {
        return this.segments.slice(-n);
    }
}
