/**
 * Local speech-to-text for meetings, via whisper.cpp (nodejs-whisper).
 *
 * The renderer taps the PiKVM audio element and ships complete ~10s WebM blobs;
 * each is converted to 16kHz mono WAV with ffmpeg, then transcribed locally —
 * nothing leaves the machine. Segments accumulate into a rolling transcript the
 * agent and meeting assistant can read. Everything degrades gracefully: if the
 * model/binary isn't present yet, it just produces no text (no crashes).
 */

import { spawn } from "child_process";
import { writeFile, mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { EventEmitter } from "events";

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

export class Transcriber extends EventEmitter {
    private segments: string[] = [];
    private queue: Promise<void> = Promise.resolve();
    private active = false;
    private readonly model: string;
    private whisperFn: ((file: string, opts: any) => Promise<string>) | null | undefined;

    constructor(opts: { model?: string } = {}) {
        super();
        this.model = opts.model ?? "base.en";
    }

    start(): void {
        this.active = true;
    }
    stop(): void {
        this.active = false;
    }
    isActive(): boolean {
        return this.active;
    }
    clear(): void {
        this.segments = [];
    }
    /** Rolling transcript (most recent ~8k chars). */
    getTranscript(): string {
        return this.segments.join(" ").slice(-8000);
    }

    /** Feed one complete audio blob (WebM/Opus from the renderer). */
    pushAudio(buf: Buffer): void {
        if (!this.active || !buf?.length) return;
        this.queue = this.queue.then(() => this.process(buf)).catch(() => {});
    }

    private async ensureWhisper(): Promise<((file: string, opts: any) => Promise<string>) | null> {
        if (this.whisperFn !== undefined) return this.whisperFn;
        let fn: ((file: string, opts: any) => Promise<string>) | null = null;
        try {
            const mod: any = await import("nodejs-whisper");
            fn = mod.nodewhisper ?? mod.default?.nodewhisper ?? null;
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
            await ffmpeg(["-y", "-i", webm, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
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
                this.segments.push(text);
                this.emit("segment", text);
            }
        } finally {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }
}
