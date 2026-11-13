/**
 * What the page can tell about a WebRTC session from the browser's own stats, and the one small loop that reads them.
 *
 * Two jobs share one reading, once a second: finding a SILENT drop (the media path is gone, the signalling socket is
 * fine, so Janus says nothing and the <video> just freezes) and keeping the numbers a later adaptive phase will need.
 * Nothing here decides what happens next: a dead session is reported once, and the engine's video machine owns the retry
 * (packages/kvm-engine/src/video/FAILURE_MODES.md, W6 to W12, W18; K110 and K112 in this folder's FAILURE_MODES.md).
 */

import { WEBRTC_STALL_MS } from "@pikvm/kvm-engine";

/** The sample kept for the adaptive phase: a plain object of numbers and a time. Nothing sends it anywhere yet. */
export interface RtcStats {
    /** When it was taken, ms since the epoch. */
    readonly at: number;
    /** Received video, kbit/s, over the last interval. */
    readonly bitrateKbps: number;
    /** Share of the video packets that were lost over the interval, 0 to 1. */
    readonly lossFraction: number;
    readonly jitterMs: number;
    /** Round trip of the selected path, or null until one has been measured. */
    readonly rttMs: number | null;
    /** Frames decoded per second over the interval. */
    readonly fps: number;
    /** The decoded picture's size. */
    readonly width: number;
    readonly height: number;
}

/** The counters read from one stats report. A field the browser does not give is null, never a guess. */
export interface RtcCounters {
    /** When this was read, ms. */
    readonly at: number;
    readonly video: {
        readonly bytes: number | null;
        readonly packets: number | null;
        readonly lost: number | null;
        readonly frames: number | null;
        readonly width: number | null;
        readonly height: number | null;
        readonly jitterS: number | null;
    } | null;
    readonly audio: { readonly bytes: number | null; readonly packets: number | null } | null;
    /** The selected candidate pair: the transport's own counters, which move on every STUN consent check, picture or no picture. */
    readonly transport: { readonly bytes: number | null; readonly responses: number | null; readonly rttS: number | null } | null;
}

type Stat = Record<string, unknown>;

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function readCounters(report: RTCStatsReport, at: number): RtcCounters {
    let video: RtcCounters["video"] = null;
    let audio: RtcCounters["audio"] = null;
    const pairs = new Map<string, Stat>();
    let selectedPairId: string | null = null;
    report.forEach((raw: unknown) => {
        const stat = raw as Stat;
        const type = stat["type"];
        const kind = stat["kind"] ?? stat["mediaType"];
        if (type === "inbound-rtp" && kind === "video") {
            video = {
                bytes: num(stat["bytesReceived"]),
                packets: num(stat["packetsReceived"]),
                lost: num(stat["packetsLost"]),
                frames: num(stat["framesDecoded"]),
                width: num(stat["frameWidth"]),
                height: num(stat["frameHeight"]),
                jitterS: num(stat["jitter"]),
            };
        } else if (type === "inbound-rtp" && kind === "audio") {
            audio = { bytes: num(stat["bytesReceived"]), packets: num(stat["packetsReceived"]) };
        } else if (type === "candidate-pair" && typeof stat["id"] === "string") {
            pairs.set(stat["id"], stat);
        } else if (type === "transport" && typeof stat["selectedCandidatePairId"] === "string") {
            selectedPairId = stat["selectedCandidatePairId"];
        }
    });
    let pair: Stat | undefined = selectedPairId !== null ? pairs.get(selectedPairId) : undefined;
    // Firefox has no selectedCandidatePairId on its transport: it marks the pair itself.
    pair ??= [...pairs.values()].find((candidate) => candidate["selected"] === true || (candidate["nominated"] === true && candidate["state"] === "succeeded"));
    const transport = pair
        ? { bytes: num(pair["bytesReceived"]), responses: num(pair["responsesReceived"]), rttS: num(pair["currentRoundTripTime"]) }
        : null;
    return { at, video, audio, transport };
}

/** Whether any of the two readings' counters differ. A counter that went backwards (a new session) counts: something happened. */
function moved(before: RtcCounters, after: RtcCounters): boolean {
    const pairs: ReadonlyArray<readonly [number | null | undefined, number | null | undefined]> = [
        [before.video?.bytes, after.video?.bytes],
        [before.video?.packets, after.video?.packets],
        [before.video?.frames, after.video?.frames],
        [before.audio?.bytes, after.audio?.bytes],
        [before.audio?.packets, after.audio?.packets],
        [before.transport?.bytes, after.transport?.bytes],
        [before.transport?.responses, after.transport?.responses],
    ];
    return pairs.some(([a, b]) => a != null && b != null && a !== b);
}

export type Verdict = "alive" | "dead" | "unknown";

export interface Liveness {
    /** Feed one reading. `visible`: the page can be seen; a hidden one is not judged and starts its count again when shown. */
    observe(counters: RtcCounters, visible: boolean): Verdict;
}

/**
 * Dead means nothing has moved for `stallMs`: not the media, and not the transport's heartbeat. A static desktop sends no
 * frames, but the browser's STUN consent checks and the Pi's answers go on, so something always moves while the path
 * lives (W11). It says "unknown", never "dead", before media has flowed once (the machine's connect time-outs own that
 * phase) and on a browser whose report has no transport counter (W12).
 */
export function createLiveness(stallMs: number = WEBRTC_STALL_MS): Liveness {
    let last: RtcCounters | null = null;
    let movedAt = 0;
    let flowed = false;
    let heartbeat = false;
    return {
        observe(counters, visible) {
            const mediaBytes = (counters.video?.bytes ?? 0) + (counters.audio?.bytes ?? 0);
            if (mediaBytes > 0) flowed = true;
            // A transport counter is what tells a quiet stream from a dead one.
            if (counters.transport && (counters.transport.bytes !== null || counters.transport.responses !== null)) heartbeat = true;
            if (!visible || !last || moved(last, counters)) movedAt = counters.at;
            last = counters;
            if (!flowed || !heartbeat) return "unknown";
            return counters.at - movedAt >= stallMs ? "dead" : "alive";
        },
    };
}

/**
 * The numbers between two readings, or null when they cannot be compared: no video in one of them, no time between them,
 * or a counter that went backwards (a new session started, a reset). A negative bitrate would be worse than none.
 */
export function computeStats(before: RtcCounters, after: RtcCounters): RtcStats | null {
    const seconds = (after.at - before.at) / 1000;
    const a = before.video;
    const b = after.video;
    if (seconds <= 0 || !a || !b) return null;
    if (a.bytes === null || b.bytes === null || a.packets === null || b.packets === null) return null;
    const bytes = b.bytes - a.bytes;
    const packets = b.packets - a.packets;
    if (bytes < 0 || packets < 0) return null;
    const frames = a.frames !== null && b.frames !== null && b.frames >= a.frames ? b.frames - a.frames : 0;
    // packetsLost can go DOWN (a late packet turns up), and is signed in the spec: only a rise is a loss.
    const lost = a.lost !== null && b.lost !== null ? Math.max(0, b.lost - a.lost) : 0;
    const expected = packets + lost;
    const rttS = after.transport?.rttS ?? null;
    return {
        at: after.at,
        bitrateKbps: round((bytes * 8) / seconds / 1000, 1),
        lossFraction: expected > 0 ? round(Math.min(1, lost / expected), 4) : 0,
        jitterMs: round((b.jitterS ?? 0) * 1000, 1),
        rttMs: rttS === null ? null : round(rttS * 1000, 1),
        fps: round(frames / seconds, 1),
        width: b.width ?? 0,
        height: b.height ?? 0,
    };
}

const round = (value: number, places: number): number => {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
};

export const LIVENESS_POLL_MS = 1000;
/** A sample is published every this often (the poll is faster so a stall is found in seconds). */
export const STATS_EVERY_MS = 2000;

export interface RtcMonitorOptions {
    /** The session's peer connection, or null while there is none. */
    readonly peer: () => RTCPeerConnection | null;
    readonly visible: () => boolean;
    /** The stream has been silent for `stallMs`. Called once; the monitor has stopped. */
    readonly onDead: () => void;
    /** A sample every `STATS_EVERY_MS`, and null when the monitor stops. */
    readonly onStats: (stats: RtcStats | null) => void;
    readonly now?: () => number;
}

export interface RtcMonitor {
    start(): void;
    stop(): void;
}

export function createRtcMonitor(opts: RtcMonitorOptions): RtcMonitor {
    const now = opts.now ?? Date.now;
    const liveness = createLiveness();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let published: RtcCounters | null = null;

    const handle = (counters: RtcCounters): void => {
        if (liveness.observe(counters, opts.visible()) === "dead") {
            stop();
            opts.onDead();
            return;
        }
        if (!published) published = counters;
        else if (counters.at - published.at >= STATS_EVERY_MS - LIVENESS_POLL_MS / 2) {
            const stats = computeStats(published, counters);
            published = counters;
            if (stats) opts.onStats(stats);
        }
    };

    const tick = async (): Promise<void> => {
        timer = null;
        const peer = opts.peer();
        if (peer && typeof peer.getStats === "function") {
            try {
                const report = await peer.getStats();
                if (!running) return;
                handle(readCounters(report, now()));
            } catch {
                // A failed read is "unknown" (W12), never "dead".
            }
        }
        // `handle` may have stopped us (dead), and a read that took long must not leave two timers.
        if (running && !timer) timer = setTimeout(() => void tick(), LIVENESS_POLL_MS);
    };

    function stop(): void {
        if (!running) return;
        running = false;
        clearTimeout(timer ?? undefined);
        timer = null;
        published = null;
        opts.onStats(null);
    }

    return {
        start() {
            if (running) return;
            running = true;
            timer = setTimeout(() => void tick(), LIVENESS_POLL_MS);
        },
        stop,
    };
}
