/** The host-side session recorder's public surface. See the header of session.ts for how the service calls it. */
export { startCapture, captureTuningFromEnv, DEFAULT_KEYFRAME_INTERVAL_MS, DEFAULT_SEGMENT_MS, DEFAULT_MAX_RAW_BACKLOG_BYTES } from "./session";
export { createReencoder, STORED_SETTINGS, ReencodeCancelled } from "./transcode";
export type { Reencoder, ReencoderOptions, ReencodeJob, ReencodeProgress, ReencodeResult, StoredSettings, AudioRole } from "./transcode";
export { recoverCapture, killOrphanFfmpeg } from "./recover";
export { diskUsageOf } from "./segments";
export { installUdpReceiveBuffer, grantedReceiveBufferBytes } from "./udp-buffer";
export type {
    CaptureEndReason,
    CaptureEvent,
    CaptureHandle,
    CaptureHole,
    CaptureLimits,
    CaptureOptions,
    CaptureResult,
    CompactResult,
    DiskUsage,
    JanusTarget,
    MicFrame,
} from "./types";
