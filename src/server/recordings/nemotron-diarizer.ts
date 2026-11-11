/**
 * The opt-in speaker diarizer: NVIDIA's Nemotron-3-Diarization, run by NeMo-Speech.cpp's CPU engine (`nemo-speech diarize`), in
 * place of sherpa's pyannote + 3D-Speaker pipeline (`PIKVM_ASR_DIARIZER=nemotron`). The image fetches the engine and the q8_0 GGUF
 * model at build time (scripts/fetch-nemotron.mjs, deploy/nemotron.lock) into PIKVM_NEMOTRON_DIR; the host downloads nothing.
 *
 * It is a child process, not a library. The engine reads a 16 kHz mono PCM16 WAV and prints JSON; the JSON is checked here, and any
 * span that does not fit the shape is an error, so the worker falls back to sherpa rather than guess.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { SpeakerSpan } from "./transcript";

export type Diarizer = "sherpa" | "nemotron";

/** The diarizer's name, as the page shows it when the Nemotron engine runs. */
export const NEMOTRON_NAME = "NVIDIA Nemotron-3-Diarization (q8_0 GGUF, NeMo-Speech.cpp CPU engine)";

export const NEMOTRON_MODEL_FILE = "Nemotron-3-Diarization.q8_0.gguf";
const ENGINE = join("bin", "nemo-speech");
/** One second of 16 kHz samples per write, so a long recording is never converted into a second full-size buffer. */
const CHUNK_SAMPLES = 16_000;

/** `PIKVM_ASR_DIARIZER`: unset or "sherpa" keeps the sherpa diarizer; "nemotron" opts in. Anything else is a configuration error. */
export function parseDiarizer(value: string | undefined): Diarizer {
    if (value === undefined || value === "" || value === "sherpa") return "sherpa";
    if (value === "nemotron") return "nemotron";
    throw new Error(`PIKVM_ASR_DIARIZER must be "sherpa" or "nemotron", not "${value}".`);
}

/** Why the Nemotron diarizer cannot run from this directory, or null when it can. */
export function nemotronProblem(dir: string): string | null {
    if (!existsSync(join(dir, NEMOTRON_MODEL_FILE))) return `The Nemotron model ${NEMOTRON_MODEL_FILE} is not in ${dir}.`;
    const engine = join(dir, ENGINE);
    try {
        accessSync(engine, constants.X_OK);
    } catch {
        return `The Nemotron engine ${engine} is not installed or not executable.`;
    }
    return null;
}

/** Writes float samples in [-1, 1] as a mono PCM16 WAV, a chunk at a time. */
export function writePcm16Wav(file: string, samples: Float32Array, sampleRate: number): void {
    const dataBytes = samples.length * 2;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(dataBytes, 40);

    const fd = openSync(file, "w", 0o600);
    try {
        writeAll(fd, header, header.length);
        const chunk = Buffer.alloc(Math.min(samples.length, CHUNK_SAMPLES) * 2);
        for (let at = 0; at < samples.length; at += CHUNK_SAMPLES) {
            const end = Math.min(samples.length, at + CHUNK_SAMPLES);
            for (let i = at; i < end; i++) {
                const v = Math.max(-1, Math.min(1, samples[i]!));
                chunk.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), (i - at) * 2);
            }
            writeAll(fd, chunk, (end - at) * 2);
        }
    } finally {
        closeSync(fd);
    }
}

function writeAll(fd: number, buffer: Buffer, length: number): void {
    let written = 0;
    while (written < length) written += writeSync(fd, buffer, written, length - written);
}

/**
 * The engine's JSON, `{ segments: [{ start, end, speaker }] }` with speakers numbered from 1, as sherpa-style spans (speaker from 0).
 * Throws on any segment that is not a finite, ordered span with a whole speaker number.
 */
export function parseNemotronSpans(json: string): SpeakerSpan[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new Error("The Nemotron diarizer printed output that is not JSON.");
    }
    const segments = (parsed as { segments?: unknown } | null)?.segments;
    if (!Array.isArray(segments)) throw new Error("The Nemotron diarizer's output has no segments list.");
    const spans: SpeakerSpan[] = [];
    for (const segment of segments as unknown[]) {
        const { start, end, speaker } = (segment ?? {}) as { start?: unknown; end?: unknown; speaker?: unknown };
        if (typeof start !== "number" || typeof end !== "number" || typeof speaker !== "number") {
            throw new Error("The Nemotron diarizer printed a segment without numeric start, end and speaker.");
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !Number.isInteger(speaker) || speaker < 1) {
            throw new Error(`The Nemotron diarizer printed an invalid segment (${start} to ${end}, speaker ${speaker}).`);
        }
        spans.push({ start, end, speaker: speaker - 1 });
    }
    return spans.sort((a, b) => a.start - b.start);
}

/**
 * Diarizes one WAV with the engine and resolves its spans. `track` receives the engine's child process so the caller can kill it with
 * the worker. Rejects with the engine's last stderr line when it fails, and when its output does not parse.
 */
export function diarizeWithNemotron(dir: string, wavFile: string, outFile: string, threads: number, timeoutMs: number, track: (child: ChildProcess) => void): Promise<SpeakerSpan[]> {
    const problem = nemotronProblem(dir);
    if (problem !== null) return Promise.reject(new Error(problem));
    const args = ["diarize", wavFile, "--model", join(dir, NEMOTRON_MODEL_FILE), "--device", "cpu", "--format", "json", "--quiet", "-o", outFile, "--force"];
    const child = spawn(join(dir, ENGINE), args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, OMP_NUM_THREADS: String(threads) } });
    track(child);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    const { promise, resolve, reject } = Promise.withResolvers<SpeakerSpan[]>();
    // A hung or starved engine must not hold the transcription: kill it and let the worker fall back to sherpa.
    const timer = setTimeout(() => {
        reject(new Error(`The Nemotron engine did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped.`));
        child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`The Nemotron engine could not start: ${error.message}`));
    });
    child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
            reject(new Error(`The Nemotron engine failed: ${stderr.trim().split("\n").pop() ?? `exit ${code}`}`));
            return;
        }
        try {
            resolve(parseNemotronSpans(readFileSync(outFile, "utf8")));
        } catch (error) {
            reject(error);
        }
    });
    return promise;
}
