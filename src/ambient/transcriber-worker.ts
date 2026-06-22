/**
 * Worker-thread side of local speech-to-text.
 *
 * Keep ffmpeg, nodejs-whisper loading, model download checks, temp files, and
 * whisper.cpp execution out of Electron's main process. The main process owns
 * UI-visible transcript state; this worker only turns audio blobs into text.
 */

import { spawn, execSync } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { parentPort } from "worker_threads";

// eslint-disable-next-line no-eval
const nodeRequire: NodeRequire = eval("require");

type WorkerIn =
    | { type: "start"; sessionId: number; model: string }
    | { type: "stop"; sessionId: number }
    | { type: "audio"; id: number; sessionId: number; buffer: Uint8Array };

type WorkerOut =
    | { type: "status"; ffmpegMissing: boolean; nodeMissing: boolean; modelReady: boolean; whisperReady?: boolean }
    | { type: "segment"; sessionId: number; text: string }
    | { type: "done"; id: number };

let active = false;
let sessionId = 0;
let model = "base.en";
let queue: Promise<void> = Promise.resolve();
let whisperFn: ((file: string, opts: any) => Promise<string>) | null | undefined;
let ffmpegMissing = false;
let nodeMissing = false;
let shellConfigured = false;

function post(msg: WorkerOut): void {
    parentPort?.postMessage(msg);
}

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

function configureShellForWhisper(): boolean {
    if (shellConfigured) return true;
    const node = resolveNodePath();
    if (!node) return false;
    try {
        const sh: any = nodeRequire("shelljs");
        if (sh?.config) {
            sh.config.execPath = node;
            sh.config.fatal = false;
            shellConfigured = true;
            return true;
        }
    } catch {
        /* shelljs unavailable */
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

function cleanWhisperText(raw: string): string {
    return raw
        .split("\n")
        .map((l) => l.replace(/^\s*\[[^\]]*\]\s*/, "").trim())
        .filter(Boolean)
        .filter((l) => !/^\(.*\)$/.test(l))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
}

function modelReady(): boolean {
    try {
        const pkg = nodeRequire.resolve("nodejs-whisper/package.json");
        const file = join(dirname(pkg), "cpp", "whisper.cpp", "models", `ggml-${model}.bin`);
        return existsSync(file);
    } catch {
        return true;
    }
}

function postStatus(): void {
    const msg: WorkerOut = {
        type: "status",
        ffmpegMissing,
        nodeMissing,
        modelReady: modelReady(),
    };
    if (whisperFn !== undefined) msg.whisperReady = !!whisperFn;
    post(msg);
}

async function checkFfmpeg(): Promise<void> {
    try {
        await ffmpeg(["-version"]);
        ffmpegMissing = false;
    } catch {
        ffmpegMissing = true;
    }
}

async function ensureWhisper(): Promise<((file: string, opts: any) => Promise<string>) | null> {
    if (whisperFn !== undefined) return whisperFn;
    let fn: ((file: string, opts: any) => Promise<string>) | null = null;
    try {
        const mod: any = await import("nodejs-whisper");
        fn = mod.nodewhisper ?? mod.default?.nodewhisper ?? null;
        if (fn && !configureShellForWhisper()) nodeMissing = true;
    } catch {
        fn = null;
    }
    whisperFn = fn;
    postStatus();
    return fn;
}

async function warmup(): Promise<void> {
    await checkFfmpeg();
    postStatus();
    await ensureWhisper();
}

async function processAudio(msg: Extract<WorkerIn, { type: "audio" }>): Promise<void> {
    if (!active || msg.sessionId !== sessionId || !msg.buffer?.byteLength) return;
    const whisper = await ensureWhisper();
    if (!whisper || ffmpegMissing || nodeMissing) return;

    const dir = await mkdtemp(join(tmpdir(), "pikvm-stt-"));
    const webm = join(dir, "chunk.webm");
    const wav = join(dir, "chunk.wav");
    try {
        await writeFile(webm, Buffer.from(msg.buffer));
        try {
            await ffmpeg(["-y", "-i", webm, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
            ffmpegMissing = false;
        } catch (e: any) {
            if (e?.code === "ENOENT") {
                ffmpegMissing = true;
                postStatus();
            }
            throw e;
        }

        let out = "";
        try {
            out = await whisper(wav, {
                modelName: model,
                autoDownloadModelName: model,
                whisperOptions: { outputInText: false, outputInSrt: false, outputInVtt: false },
            });
        } catch {
            out = "";
        }
        if (!out || !out.trim()) out = await readFile(`${wav}.txt`, "utf-8").catch(() => "");

        const text = cleanWhisperText(out);
        if (text && active && msg.sessionId === sessionId) {
            post({ type: "segment", sessionId: msg.sessionId, text });
        }
        postStatus();
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

function enqueueAudio(msg: Extract<WorkerIn, { type: "audio" }>): void {
    const run = async () => {
        try {
            await processAudio(msg);
        } catch {
            /* failed chunks are dropped; status carries missing dependency state */
        } finally {
            post({ type: "done", id: msg.id });
        }
    };
    queue = queue.then(run, run);
}

parentPort?.on("message", (msg: WorkerIn) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "start") {
        active = true;
        sessionId = msg.sessionId;
        model = msg.model || model;
        void warmup();
    } else if (msg.type === "stop") {
        active = false;
        sessionId = msg.sessionId;
    } else if (msg.type === "audio") {
        enqueueAudio(msg);
    }
});

void checkFfmpeg().then(postStatus);
