import { MAX_CHUNK_BYTES, MAX_RECORDING_BYTES, RECORDING_RETENTION_DAYS, RECORDINGS_MAX_TOTAL_BYTES } from "@pikvm/contracts/recordings";

/** Every bound the recordings host applies. The defaults are the contract's; the environment can only change them as below. */
export interface RecordingLimits {
    /** The most one chunk may carry. */
    maxChunkBytes: number;
    /** The most one recording may hold: it is closed at this size. `PIKVM_RECORDINGS_MAX_RECORDING_BYTES`. */
    maxRecordingBytes: number;
    /** The most all recordings together may take: a new one is refused (507) at this size. `PIKVM_RECORDINGS_MAX_BYTES`. */
    maxTotalBytes: number;
    /** Days a recording is kept after it ended; 0 keeps them for ever. `PIKVM_RECORDINGS_RETENTION_DAYS`. */
    retentionDays: number;
    /** A recording that has received no chunk for this long, and was never finished, is closed with the bytes it has. */
    idleCloseMs: number;
    /** The longest audio the transcriber will take, in seconds: its decoded channels are held in memory (230 MB an hour each). */
    maxTranscribeSeconds: number;
}

export const IDLE_CLOSE_MS = 60 * 60 * 1000;
/** Four hours of 16 kHz float samples is 920 MB per channel. */
export const MAX_TRANSCRIBE_SECONDS = 4 * 60 * 60;

function number(env: NodeJS.ProcessEnv, name: string, fallback: number, accept: (value: number) => boolean, log: (line: string) => void): number {
    const raw = (env[name] ?? "").trim();
    if (raw === "") return fallback;
    const value = Number(raw);
    if (Number.isFinite(value) && accept(value)) return value;
    log(`[recordings] ${name}=${raw} is not a valid value; using ${fallback}`);
    return fallback;
}

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (line) => console.warn(line)): RecordingLimits {
    return {
        maxChunkBytes: MAX_CHUNK_BYTES,
        maxRecordingBytes: number(env, "PIKVM_RECORDINGS_MAX_RECORDING_BYTES", MAX_RECORDING_BYTES, (v) => Number.isInteger(v) && v > 0, log),
        maxTotalBytes: number(env, "PIKVM_RECORDINGS_MAX_BYTES", RECORDINGS_MAX_TOTAL_BYTES, (v) => Number.isInteger(v) && v > 0, log),
        retentionDays: number(env, "PIKVM_RECORDINGS_RETENTION_DAYS", RECORDING_RETENTION_DAYS, (v) => v >= 0, log),
        idleCloseMs: IDLE_CLOSE_MS,
        maxTranscribeSeconds: MAX_TRANSCRIBE_SECONDS,
    };
}
