import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { rename, rm, stat } from "node:fs/promises";
import os from "node:os";

export type AudioRole = "target" | "mic";

/**
 * The background re-encode: a raw 1080p60 passthrough segment becomes a compact stored segment, once.
 *
 * ffmpeg with libx264 is not in the live path. Jobs run ONE at a time, at `nice -n 19` (set with setPriority right after spawn; the
 * E2E reads it back from /proc), and the running job is stopped (SIGSTOP) and resumed (SIGCONT) while `shouldPause()` says something
 * more important runs (the transcriber) or `pause()` was called. A job can be cancelled at any time and removes its partial output.
 *
 * Size budget. The stored recording must come to 1 to 2 MB per minute ALL IN: video plus every audio track plus container overhead.
 * The default settings below are the measured choice (see STORED_SETTINGS and the measurement notes in the E2E report):
 * 720p at 10 fps, x264 slow with a capped CRF so an active screen cannot exceed the video ceiling, a keyframe every 10 s, and AAC
 * at 32 kbit/s for the target and 24 kbit/s for the microphone. A CRF alone cannot promise a ceiling; `-maxrate`/`-bufsize` does.
 */

export interface StoredSettings {
    height: number;
    fps: number;
    crf: number;
    /** Video ceiling, kbit/s, enforced by the VBV (`-maxrate`). */
    maxrateKbps: number;
    /** VBV buffer, kbit. About two seconds of the ceiling. */
    bufsizeKbit: number;
    preset: string;
    tune: string | null;
    /** Seconds between keyframes. */
    keyframeSeconds: number;
    /** AAC rate per audio role, kbit/s. */
    audioKbps: Record<AudioRole, number>;
    /** Channels per audio role. */
    audioChannels: Record<AudioRole, number>;
    audioSampleRate: number;
    scaleFlags: string;
    threads: number;
}

/**
 * The numbers the measurements chose (report: "Stored-file settings"). Budget, all in, per minute:
 *   video <= 180 kbit/s (the VBV ceiling) + audio 32 + 24 kbit/s + about 2 to 3 % container = at most 1.85 MB/min, whatever is on screen;
 *   typical screens land at 1.0 to 1.1 MB/min because the CRF, not the ceiling, decides there.
 * `tune: null` on purpose: x264's stillimage tune lost 10 to 15 points of OCR word recovery on dense text at the same bitrate.
 */
export const STORED_SETTINGS: StoredSettings = {
    height: 720,
    fps: 10,
    crf: 31,
    maxrateKbps: 180,
    bufsizeKbit: 360,
    preset: "slow",
    tune: null,
    keyframeSeconds: 10,
    audioKbps: { target: 32, mic: 24 },
    audioChannels: { target: 2, mic: 1 },
    audioSampleRate: 24_000,
    scaleFlags: "lanczos",
    threads: 2,
};

export interface ReencodeJob {
    id: string;
    input: string;
    /** The finished file. It is written beside this name and renamed into place, so it never exists half-written. */
    output: string;
    /** Length of the input, when known, for the progress ratio. */
    durationMs?: number;
    /** What each audio track of the input is, in order: the Pi's audio is "target", the browser microphone "mic". Read from the file (all "target") when absent. */
    audioRoles?: AudioRole[];
}

export interface ReencodeProgress {
    id: string;
    /** 0..1, or null when the duration is unknown. */
    ratio: number | null;
    outTimeMs: number;
    /** Encoding speed relative to the media's own clock (2 = twice as fast as real time). */
    speed: number | null;
}

export interface ReencodeResult {
    id: string;
    output: string;
    bytes: number;
    durationMs: number;
    /** Wall time the job took, paused time included. */
    elapsedMs: number;
}

export interface ReencodeHandle {
    readonly done: Promise<ReencodeResult>;
    cancel(): void;
}

export interface ReencoderOptions {
    ffmpegPath?: string;
    ffprobePath?: string;
    settings?: Partial<StoredSettings>;
    /** True while something more important is running (a transcription): the job is held. Polled every `pollMs`. */
    shouldPause?: () => boolean;
    pollMs?: number;
    niceness?: number;
    log?: (line: string) => void;
    onProgress?: (progress: ReencodeProgress) => void;
}

export interface Reencoder {
    submit(job: ReencodeJob): ReencodeHandle;
    /** Holds the running job (SIGSTOP) and starts no new one until `resume()`. */
    pause(): void;
    resume(): void;
    /** Cancels a queued or running job by id. */
    cancel(id: string): void;
    readonly state: { running: string | null; queued: number; paused: boolean; pid: number | null };
    /** Resolves when nothing is running or queued. */
    idle(): Promise<void>;
    /** Cancels everything and refuses new jobs. */
    dispose(): Promise<void>;
}

export class ReencodeCancelled extends Error {
    constructor(id: string) {
        super(`re-encode ${id} was cancelled`);
        this.name = "ReencodeCancelled";
    }
}

function probe(ffprobe: string, file: string): Promise<{ durationMs: number; audioTracks: number; hasVideo: boolean }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ durationMs: number; audioTracks: number; hasVideo: boolean }>();
    execFile(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type:format=duration,start_time", "-of", "json", file], { maxBuffer: 1 << 20, timeout: 60_000 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(String(stderr).trim().split("\n").pop() || error.message));
        const parsed = JSON.parse(stdout) as { streams?: { codec_type?: string }[]; format?: { duration?: string; start_time?: string } };
        const streams = parsed.streams ?? [];
        // A Matroska segment cut from a longer stream keeps its absolute timestamps: its duration is counted from 0, not from its start.
        const seconds = Number(parsed.format?.duration) - Math.max(0, Number(parsed.format?.start_time) || 0);
        resolve({
            durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0,
            audioTracks: streams.filter((s) => s.codec_type === "audio").length,
            hasVideo: streams.some((s) => s.codec_type === "video"),
        });
    });
    return promise;
}

/** The ffmpeg arguments of one stored encode. Exported so the measurements and the job use the same command. */
export function storedArgs(settings: StoredSettings, input: string, output: string, roles: AudioRole[], extraInput: string[] = []): string[] {
    const s = settings;
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", ...extraInput, "-i", input, "-map", "0:v:0"];
    for (let i = 0; i < roles.length; i += 1) args.push("-map", `0:a:${i}`);
    args.push("-vf", `fps=${s.fps},scale=-2:${s.height}:flags=${s.scaleFlags},format=yuv420p`);
    args.push("-c:v", "libx264", "-preset", s.preset);
    if (s.tune) args.push("-tune", s.tune);
    const gop = Math.round(s.keyframeSeconds * s.fps);
    args.push(
        "-crf", String(s.crf),
        "-maxrate", `${s.maxrateKbps}k`,
        "-bufsize", `${s.bufsizeKbit}k`,
        "-g", String(gop),
        "-keyint_min", String(gop),
        "-sc_threshold", "0",
        "-threads", String(s.threads),
    );
    if (roles.length > 0) {
        // Holes (a reconnect) leave a jump in the audio clock: fill it with silence so audio and video stay the same length.
        args.push("-af", "aresample=async=1000:first_pts=0", "-c:a", "aac", "-ar", String(s.audioSampleRate));
        for (let i = 0; i < roles.length; i += 1) {
            const role = roles[i]!;
            args.push(`-b:a:${i}`, `${s.audioKbps[role]}k`, `-ac:a:${i}`, String(s.audioChannels[role]));
            // MP4 keeps a track's name as its handler name; the transcriber selects by position (`0:a:0` target, `0:a:1` mic).
            args.push(`-metadata:s:a:${i}`, `title=${role}`, `-metadata:s:a:${i}`, `handler_name=${role}`);
        }
    }
    args.push("-movflags", "+faststart", "-f", "mp4", output);
    return args;
}

interface Pending {
    job: ReencodeJob;
    resolve: (result: ReencodeResult) => void;
    reject: (error: Error) => void;
    cancelled: boolean;
}

export function createReencoder(options: ReencoderOptions = {}): Reencoder {
    const ffmpeg = options.ffmpegPath ?? "ffmpeg";
    const ffprobe = options.ffprobePath ?? "ffprobe";
    const settings: StoredSettings = { ...STORED_SETTINGS, ...options.settings };
    const log = options.log ?? (() => undefined);
    const pollMs = options.pollMs ?? 1000;
    const niceness = options.niceness ?? 19;
    const queue: Pending[] = [];
    let current: { pending: Pending; child: ChildProcess; stopped: boolean } | null = null;
    let working = false;
    let paused = false;
    let disposed = false;
    let idleWaiters: (() => void)[] = [];

    const held = (): boolean => paused || (options.shouldPause?.() ?? false);

    const syncStop = (): void => {
        if (!current) return;
        const want = held();
        if (want && !current.stopped && current.child.pid !== undefined) {
            current.child.kill("SIGSTOP");
            current.stopped = true;
        } else if (!want && current.stopped) {
            current.child.kill("SIGCONT");
            current.stopped = false;
        }
    };
    const poller = setInterval(() => {
        syncStop();
        void pump();
    }, pollMs);
    poller.unref();

    const runJob = async (pending: Pending): Promise<void> => {
        const { job } = pending;
        const startedAt = Date.now();
        const info = await probe(ffprobe, job.input).catch((error: unknown) => {
            // An unfinalised Matroska (a crashed ffmpeg) has no duration; ffprobe still reads its streams.
            log(`[recorder reencode] ${job.id}: probe failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        });
        if (pending.cancelled) throw new ReencodeCancelled(job.id);
        if (info && !info.hasVideo) throw new Error(`${job.input} has no video stream`);
        const roles: AudioRole[] = job.audioRoles ?? Array.from({ length: info?.audioTracks ?? 0 }, (_, i): AudioRole => (i === 0 ? "target" : "mic"));
        const durationMs = job.durationMs ?? info?.durationMs ?? 0;
        const partial = `${job.output}.partial`;
        const args = storedArgs(settings, job.input, partial, roles);
        // Through nice(1) (coreutils; present in the runtime image) so the process is niced from its first instruction: it would
        // otherwise inherit this process's priority until a later setPriority. nice(1) ADDS to the caller's niceness, so ask for enough
        // to reach the ceiling of 19 whatever the caller's own value is (it clamps); setPriority below then sets exactly `niceness`.
        const child = spawn("nice", ["-n", String(niceness >= 19 ? 39 : niceness), ffmpeg, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        if (child.pid !== undefined) {
            try {
                os.setPriority(child.pid, niceness);
            } catch (error) {
                log(`[recorder reencode] could not set nice ${niceness}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        current = { pending, child, stopped: false };
        syncStop();
        let errText = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            errText = (errText + chunk).slice(-2000);
        });
        let progressBuf = "";
        let outTimeMs = 0;
        let speed: number | null = null;
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
            progressBuf += chunk;
            let nl: number;
            while ((nl = progressBuf.indexOf("\n")) >= 0) {
                const line = progressBuf.slice(0, nl).trim();
                progressBuf = progressBuf.slice(nl + 1);
                const eq = line.indexOf("=");
                if (eq < 0) continue;
                const key = line.slice(0, eq);
                const value = line.slice(eq + 1);
                if (key === "out_time_us" || key === "out_time_ms") {
                    const n = Number(value);
                    if (Number.isFinite(n) && n >= 0) outTimeMs = n / 1000;
                } else if (key === "speed") {
                    const n = Number.parseFloat(value);
                    speed = Number.isFinite(n) ? n : null;
                } else if (key === "progress") {
                    options.onProgress?.({ id: job.id, outTimeMs, speed, ratio: durationMs > 0 ? Math.min(1, outTimeMs / durationMs) : null });
                }
            }
        });
        const exitWait = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
        child.once("error", () => exitWait.resolve({ code: null, signal: null }));
        child.once("close", (code, signal) => exitWait.resolve({ code, signal }));
        const exit = await exitWait.promise;
        current = null;
        if (pending.cancelled) {
            await rm(partial, { force: true });
            throw new ReencodeCancelled(job.id);
        }
        if (exit.code !== 0) {
            await rm(partial, { force: true });
            throw new Error(`ffmpeg exited ${exit.code ?? exit.signal}: ${errText.trim().split("\n").slice(-3).join(" | ")}`);
        }
        const made = await probe(ffprobe, partial);
        if (!made.hasVideo) {
            await rm(partial, { force: true });
            throw new Error("the stored file has no video stream");
        }
        if (durationMs > 0 && Math.abs(made.durationMs - durationMs) > Math.max(3000, durationMs * 0.05)) {
            await rm(partial, { force: true });
            throw new Error(`the stored file is ${made.durationMs} ms long, the input ${durationMs} ms`);
        }
        await rename(partial, job.output);
        const { size } = await stat(job.output);
        pending.resolve({ id: job.id, output: job.output, bytes: size, durationMs: made.durationMs, elapsedMs: Date.now() - startedAt });
    };

    const notifyIdle = (): void => {
        if (!working && queue.length === 0) {
            const waiters = idleWaiters;
            idleWaiters = [];
            for (const w of waiters) w();
        }
    };

    async function pump(): Promise<void> {
        if (working || disposed || queue.length === 0 || held()) return;
        working = true;
        try {
            while (queue.length > 0 && !disposed) {
                if (held()) break;
                const pending = queue.shift()!;
                if (pending.cancelled) {
                    pending.reject(new ReencodeCancelled(pending.job.id));
                    continue;
                }
                try {
                    await runJob(pending);
                } catch (error) {
                    pending.reject(error instanceof Error ? error : new Error(String(error)));
                }
            }
        } finally {
            working = false;
            notifyIdle();
        }
    }

    return {
        submit(job) {
            const { promise, resolve, reject } = Promise.withResolvers<ReencodeResult>();
            if (disposed) {
                reject(new Error("the re-encoder is shut down"));
                return { done: promise, cancel: () => undefined };
            }
            const pending: Pending = { job, resolve, reject, cancelled: false };
            queue.push(pending);
            void pump();
            return {
                done: promise,
                cancel: () => {
                    pending.cancelled = true;
                    if (current?.pending === pending) current.child.kill(current.stopped ? "SIGCONT" : "SIGTERM");
                    if (current?.pending === pending && current.stopped) current.child.kill("SIGTERM");
                    const at = queue.indexOf(pending);
                    if (at >= 0) {
                        queue.splice(at, 1);
                        reject(new ReencodeCancelled(job.id));
                        notifyIdle();
                    }
                },
            };
        },
        pause() {
            paused = true;
            syncStop();
        },
        resume() {
            paused = false;
            syncStop();
            void pump();
        },
        cancel(id) {
            if (current?.pending.job.id === id) {
                current.pending.cancelled = true;
                if (current.stopped) current.child.kill("SIGCONT");
                current.child.kill("SIGTERM");
            }
            for (const pending of queue.filter((p) => p.job.id === id)) {
                pending.cancelled = true;
                queue.splice(queue.indexOf(pending), 1);
                pending.reject(new ReencodeCancelled(id));
            }
            notifyIdle();
        },
        get state() {
            return { running: current?.pending.job.id ?? null, queued: queue.length, paused: held(), pid: current?.child.pid ?? null };
        },
        idle() {
            if (!working && queue.length === 0) return Promise.resolve();
            const { promise, resolve } = Promise.withResolvers<void>();
            idleWaiters.push(resolve);
            return promise;
        },
        async dispose() {
            disposed = true;
            clearInterval(poller);
            for (const pending of queue.splice(0)) pending.reject(new ReencodeCancelled(pending.job.id));
            if (current) {
                current.pending.cancelled = true;
                if (current.stopped) current.child.kill("SIGCONT");
                current.child.kill("SIGTERM");
            }
            await this.idle();
        },
    };
}
