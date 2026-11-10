import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { TranscriptSegment, TranscriptionStatus } from "@pikvm/contracts/recordings";
import { ASR_MODEL_NAMES, missingAsrModels } from "./asr-models";
import { ffmpegProblem } from "./media";

/**
 * Runs the transcription: one job at a time, each in a process of its own (transcribe-worker.ts) started under `nice -n 19`, so a
 * transcription never competes with the page for the CPU and its memory goes back to the system when it ends. Jobs wait in a queue;
 * a job can be cancelled (a delete) and every job is killed when the host stops. Nothing is ever sent anywhere.
 */

export interface TranscribeJob {
    id: string;
    file: string;
    workDir: string;
    /** What the browser said the recording lasted; the first guess for the time limit, replaced by what the decoder finds. */
    durationMs: number | null;
}

export interface TranscribeResult {
    durationMs: number;
    segments: TranscriptSegment[];
    speakers: string[];
    text: string;
    tookSeconds: number;
}

export interface TranscriberOptions {
    modelsDir: string;
    workerPath: string;
    threads: number;
    /** The diarizer's clustering threshold: larger joins more voices into one speaker. */
    clusterThreshold: number;
    maxSeconds: number;
    log: (line: string) => void;
    onProgress: (id: string, value: number) => void;
    onDone: (id: string, result: TranscribeResult) => void;
    onFail: (id: string, message: string) => void;
}

export interface Transcriber {
    status(): Promise<TranscriptionStatus>;
    enqueue(job: TranscribeJob): void;
    /** Takes a job out of the queue or stops it, and resolves once its process is gone. */
    cancel(id: string): Promise<void>;
    /** Stops everything: queued jobs are dropped, the running one is killed. */
    stop(): Promise<void>;
}

/** What a job may take: this many times the audio's length, plus this long. */
const TIME_FACTOR = 4;
const TIME_EXTRA_MS = 60_000;
/** The limit while the audio's length is only the browser's word, or not known at all. */
const UNKNOWN_DURATION_MS = 30 * 60_000;

interface Running {
    job: TranscribeJob;
    child: ChildProcess;
    startedAt: number;
    timer: NodeJS.Timeout | undefined;
    /** Set when the job was ended on purpose, so its exit is not reported as a failure. */
    ended: boolean;
    exited: Promise<void>;
}

function onPath(name: string): string | null {
    for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
        if (dir === "") continue;
        try {
            accessSync(join(dir, name), constants.X_OK);
            return join(dir, name);
        } catch {
            // not here
        }
    }
    return null;
}

export function createTranscriber(options: TranscriberOptions): Transcriber {
    const { log } = options;
    const queue: TranscribeJob[] = [];
    let current: Running | null = null;
    let stopped = false;
    const nice = onPath("nice");
    if (nice === null) log("[recordings] `nice` is not installed: transcription runs at the normal priority");

    function kill(run: Running): void {
        run.ended = true;
        clearTimeout(run.timer);
        run.timer = undefined;
        // The worker leads its own process group (detached), so its ffmpeg dies with it.
        try {
            if (run.child.pid !== undefined) process.kill(-run.child.pid, "SIGKILL");
        } catch {
            run.child.kill("SIGKILL");
        }
    }

    function limitMs(durationMs: number | null): number {
        return TIME_FACTOR * (durationMs ?? UNKNOWN_DURATION_MS) + TIME_EXTRA_MS;
    }

    function arm(run: Running, durationMs: number | null): void {
        clearTimeout(run.timer);
        const left = Math.max(10_000, run.startedAt + limitMs(durationMs) - Date.now());
        run.timer = setTimeout(() => {
            if (run.ended) return;
            kill(run);
            options.log(`[recordings] ${run.job.id}: the transcription passed its time limit and was stopped`);
            options.onFail(run.job.id, "The transcription took too long and was stopped.");
        }, left);
        run.timer.unref();
    }

    function start(job: TranscribeJob): void {
        const args = [process.execPath, options.workerPath];
        const child = nice ? spawn(nice, ["-n", "19", ...args], spawnOptions()) : spawn(args[0]!, args.slice(1), spawnOptions());
        const { promise: exited, resolve: exitedResolve } = Promise.withResolvers<void>();
        const run: Running = { job, child, startedAt: Date.now(), timer: undefined, ended: false, exited };
        current = run;
        arm(run, job.durationMs);
        const finish = (settle: () => void): void => {
            if (run.ended) return;
            kill(run);
            settle();
        };
        child.on("message", (message: { type?: string; value?: number; durationSeconds?: number; message?: string } & Partial<TranscribeResult>) => {
            if (run.ended) return;
            if (message.type === "progress" && typeof message.value === "number") options.onProgress(job.id, message.value);
            else if (message.type === "decoded" && typeof message.durationSeconds === "number") arm(run, message.durationSeconds * 1000);
            else if (message.type === "done") finish(() => options.onDone(job.id, message as TranscribeResult));
            else if (message.type === "error") finish(() => options.onFail(job.id, String(message.message ?? "The transcription failed.")));
        });
        child.on("error", (error) => finish(() => options.onFail(job.id, `The transcriber could not start: ${error.message}`)));
        child.on("exit", (code, signal) => {
            finish(() => options.onFail(job.id, `The transcriber stopped unexpectedly (${signal ?? `exit ${code}`}).`));
            clearTimeout(run.timer);
            exitedResolve();
            if (current === run) current = null;
            pump();
        });
        child.send({ file: job.file, workDir: job.workDir, modelsDir: options.modelsDir, threads: options.threads, clusterThreshold: options.clusterThreshold, maxSeconds: options.maxSeconds });
    }

    function spawnOptions(): SpawnOptions {
        return {
            detached: true,
            stdio: ["ignore", "inherit", "inherit", "ipc"],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ORT_DISABLE_TELEMETRY: "1" },
        };
    }

    function pump(): void {
        if (stopped || current) return;
        const next = queue.shift();
        if (next) start(next);
    }

    return {
        async status(): Promise<TranscriptionStatus> {
            const reason = await problem();
            return reason === null ? { available: true, reason: null, models: { ...ASR_MODEL_NAMES } } : { available: false, reason, models: null };
        },
        enqueue(job) {
            if (stopped) return;
            queue.push(job);
            pump();
        },
        async cancel(id) {
            const at = queue.findIndex((j) => j.id === id);
            if (at >= 0) queue.splice(at, 1);
            if (current?.job.id === id) {
                kill(current);
                await current.exited;
            }
        },
        async stop() {
            stopped = true;
            queue.length = 0;
            if (current) {
                kill(current);
                await current.exited;
            }
        },
    };

    async function problem(): Promise<string | null> {
        const tools = await ffmpegProblem();
        if (tools) return `${tools} It decodes the audio for transcription.`;
        const missing = missingAsrModels(options.modelsDir);
        if (missing.length > 0) {
            return `The speech models are not installed: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""} missing from ${options.modelsDir}.`;
        }
        try {
            require.resolve("sherpa-onnx-node");
        } catch {
            return "The sherpa-onnx-node package is not installed.";
        }
        if (!existsSync(options.workerPath)) return `The transcription worker ${options.workerPath} is not built.`;
        return null;
    }
}
