/**
 * Every number of the adaptive picture and its reason (see FAILURE_MODES.md for the letters). Measured values are in
 * ~/.cache/pikvm-e2e/adaptive-server/REPORT.md; the rest are choices, said so.
 */

export interface AdaptiveLimits {
    /** I4: connections at once. Each costs up to one re-encode per frame; the host also runs chat, OCR and the recorder. */
    maxClients: number;
    /** I4: devices remembered (a rung per device key). */
    maxDevices: number;
    /** I4: a device with no connection is forgotten after this long. */
    deviceIdleMs: number;
    /** P3: no first frame within this long of a client asking is a 503. */
    firstFrameMs: number;
    /** P3: the Pi silent this long after the stream started ends the client's response. */
    upstreamGoneMs: number;
    /** P2: nothing at all from the Pi's socket for this long is a dead connection. */
    upstreamStallMs: number;
    /** P2: reconnect backoff, first and last wait. */
    backoffFirstMs: number;
    backoffMaxMs: number;
    /** P2: this long of frames in a row resets the backoff. */
    backoffResetMs: number;
    /** P4: the largest JPEG accepted from the Pi (a 4K frame is about 2 MiB). */
    maxFrameBytes: number;
    /** P4: the largest part header. */
    maxHeaderBytes: number;
    /** P6: re-encodes running at once, process-wide. */
    maxEncodes: number;
    /** A1: how often the kernel's queue and the delivered bytes are read. */
    tickMs: number;
    /** A1: queued bytes that are always fine, whatever the measured rate. */
    queueFloorBytes: number;
    /** A1: seconds of data at the measured rate that may be queued. */
    queueSeconds: number;
    /** A3: least time between two steps. */
    stepHoldMs: number;
    /** A3: backlog-free time before an up-step. */
    upAfterMs: number;
    /** A4: the up-wait ceiling, and the window in which a down-step after an up-step counts as a failed probe. */
    upAfterMaxMs: number;
    failedProbeMs: number;
    /** A4: backlog-free time that forgets the backoff. */
    cleanResetMs: number;
    /** A5: no delivery for this long with data queued is a dead link. */
    deadLinkMs: number;
}

export const DEFAULT_LIMITS: AdaptiveLimits = {
    maxClients: 6,
    maxDevices: 64,
    deviceIdleMs: 10 * 60_000,
    firstFrameMs: 10_000,
    upstreamGoneMs: 30_000,
    upstreamStallMs: 8_000,
    backoffFirstMs: 1_000,
    backoffMaxMs: 15_000,
    backoffResetMs: 5_000,
    maxFrameBytes: 16 * 1024 * 1024,
    maxHeaderBytes: 4096,
    maxEncodes: 2,
    tickMs: 250,
    queueFloorBytes: 24 * 1024,
    queueSeconds: 0.8,
    stepHoldMs: 1_500,
    upAfterMs: 6_000,
    upAfterMaxMs: 48_000,
    failedProbeMs: 15_000,
    cleanResetMs: 60_000,
    deadLinkMs: 30_000,
};

/** `PIKVM_ADAPTIVE_MAX_CLIENTS`: the one number worth changing per host. A bad value keeps the default. */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): AdaptiveLimits {
    const raw = Number(env["PIKVM_ADAPTIVE_MAX_CLIENTS"]);
    return Number.isInteger(raw) && raw >= 1 && raw <= 64 ? { ...DEFAULT_LIMITS, maxClients: raw } : DEFAULT_LIMITS;
}
