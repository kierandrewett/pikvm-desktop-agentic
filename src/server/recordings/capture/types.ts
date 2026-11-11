import type { Reencoder } from "./transcode";

/** Shared shapes of the host-side capture module. Everything the service passes in or receives is declared here. */

/**
 * Where the PiKVM is and how to reach its Janus socket. Structurally the same as the agent's `DeskTarget`
 * (src/server/agent/desk.ts), so `await control.proxyTarget()` can be passed straight in: the module never reads the environment.
 */
export interface JanusTarget {
    readonly origin: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly rejectUnauthorized: boolean;
}

/** A stretch of the recording's timeline (milliseconds from its first video frame) in which no video was captured. */
export interface CaptureHole {
    fromMs: number;
    toMs: number;
}

export type CaptureEndReason =
    /** `stop()` was called. */
    | "stopped"
    /** The total quota (see `CaptureLimits.maxBytes`) was reached, so the recording was closed cleanly. */
    | "quota"
    /** The per-recording byte cap was reached (the same `maxBytes` callback; the service names which one bound). */
    | "recording_cap"
    /** The raw 1080p backlog waiting for the re-encoder reached `maxRawBacklogBytes`. */
    | "backlog_cap"
    /** `maxDurationMs` was reached. */
    | "duration"
    /** The Pi could not be reached for `giveUpAfterMs`, or ffmpeg kept crashing. */
    | "error";

export interface CaptureResult {
    /** The final, compact file. It exists only once `handle.compacted` resolved; until then the segments sit in `workDir`. */
    path: string;
    /** Length of the recording's timeline, holes included. */
    durationMs: number;
    /** Raw (1080p passthrough) bytes written in total, before re-encoding. The compact file's size is in `CompactResult`. */
    bytes: number;
    /** Whether a second audio track (the browser microphone) was recorded. */
    hasMicTrack: boolean;
    holes: CaptureHole[];
    reason: CaptureEndReason;
    /** Set when `reason` is "error". */
    error?: string;
    /** The directory that holds the raw and stored segments until the compact file is assembled. */
    workDir: string;
    /** Whether the recording ends with a clean ffmpeg shutdown (false after a kill: the last fragment may be short). */
    clean: boolean;
}

export interface CompactResult {
    path: string;
    bytes: number;
    durationMs: number;
    /** Bytes of raw segments deleted. */
    rawBytesFreed: number;
}

export type CaptureEvent =
    | { type: "connecting"; session: number }
    | { type: "connected"; session: number; udpReceiveBufferBytes: number | null }
    | { type: "reconnecting"; session: number; reason: string; retryInMs: number }
    | { type: "keyframe"; atMs: number; requested: boolean }
    | { type: "bytes"; rawBytes: number; storedBytes: number; backlogBytes: number; elapsedMs: number }
    | { type: "stats"; keyframes: number; duplicatesDropped: number; keyframeRequests: number; unsolicitedKeyframes: number; lostPackets: number; damagedKeyframes: number; micFramesOut: number; micSilenceFrames: number; micDroppedLate: number; srDriftVideoMs: number; srDriftAudioMs: number; hostClockReports: boolean }
    | { type: "segment"; index: number; startMs: number; endMs: number; rawBytes: number }
    | { type: "stored"; index: number; storedBytes: number }
    | { type: "hole"; fromMs: number; toMs: number }
    | { type: "ffmpeg-restart"; reason: string; attempt: number }
    | { type: "limit"; reason: CaptureEndReason; detail: string }
    | { type: "warning"; message: string }
    | { type: "error"; message: string; fatal: boolean };

export interface CaptureLimits {
    /**
     * The most bytes (raw backlog + stored segments of this recording) it may take, read about once a second. The service answers
     * with the smaller of the per-recording cap and what is left of the total quota. At it the capture closes cleanly.
     */
    maxBytes?: () => number;
    /** Which limit `maxBytes` expresses when it is reached, for the result and the event. Default "quota". */
    maxBytesReason?: "quota" | "recording_cap";
    maxDurationMs?: number;
    /** The raw 1080p backlog that may wait for the re-encoder. Default 2 GiB. At it the capture closes cleanly (it never stalls). */
    maxRawBacklogBytes?: number;
}

export interface CaptureOptions {
    target: JanusTarget;
    /** The compact file the recording ends as, e.g. `<dir>/<id>.mp4`. */
    outputPath: string;
    /**
     * REQUIRED. Where raw and stored segments live until the final file exists. The raw 1080p backlog can reach `maxRawBacklogBytes`
     * (2 GiB by default) here, so it MUST be a directory on the data volume, never /tmp (the live container's /tmp is tmpfs: RAM).
     * Same filesystem as `outputPath` (the final file is renamed into place). Created if missing; removed when the recording is done.
     */
    workDir: string;
    /** Record the browser's microphone as a second audio track (fed by `pushMic`). Needs Matroska raw segments. Default false. */
    mic?: boolean;
    /** Record the target's audio. Default true. */
    audio?: boolean;
    /** Seconds between keyframes in the raw master. Default 30. */
    keyframeIntervalMs?: number;
    /** Raw segment length, rounded to a whole number of keyframe intervals. Default 5 minutes. */
    segmentMs?: number;
    limits?: CaptureLimits;
    /** The shared background re-encoder. Required: raw segments are handed to it as they close. */
    reencoder: Reencoder;
    /** Microphone timestamps are in the sender's clock: add this to bring them to the host's `Date.now()` domain. Default 0. */
    micClockOffsetMs?: number;
    /** How long the mic track waits for late frames before silence takes their place. Default 1500. */
    micJitterMs?: number;
    /** UDP receive buffer requested for the Pi's media sockets. Default 4 MiB (the kernel may cap it at net.core.rmem_max). */
    udpReceiveBufferBytes?: number;
    /** Give up when the Pi has been unreachable this long. Default 15 minutes. */
    giveUpAfterMs?: number;
    ffmpegPath?: string;
    ffprobePath?: string;
    log?: (line: string) => void;
    onEvent?: (event: CaptureEvent) => void;
}

export interface MicFrame {
    /** Capture time of the first sample, in milliseconds on the sender's `Date.now()` clock (see `micClockOffsetMs`). */
    ptsMs: number;
    /** One Opus packet (RFC 6716), 2.5 to 60 ms. */
    data: Uint8Array;
}

export interface DiskUsage {
    rawBytes: number;
    storedBytes: number;
    totalBytes: number;
}

export interface CaptureHandle {
    /** Ends the capture cleanly (SIGINT to ffmpeg while packets still flow) and resolves with the one result. Idempotent. */
    stop(): Promise<CaptureResult>;
    /** Resolves when the capture ended by any cause (stop, a limit, a fatal error). Never rejects. */
    readonly ended: Promise<CaptureResult>;
    /** Resolves when the compact file exists and the raw segments are gone (it may be long after `ended`). Never rejects: failure is `ok: false`. */
    readonly compacted: Promise<{ ok: true; value: CompactResult } | { ok: false; error: string }>;
    pushMic(frame: MicFrame): void;
    onEvent(listener: (event: CaptureEvent) => void): () => void;
    /** Raw backlog plus stored segments, read from the disk now. */
    diskUsage(): Promise<DiskUsage>;
}
