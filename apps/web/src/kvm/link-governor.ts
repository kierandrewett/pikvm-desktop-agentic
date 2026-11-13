// The link governor (K119-K122): decides from what WebRTC measures when a session that is still playing should give way
// to the reduced picture, and for how long.
//
// Pure: samples and times go in, a verdict comes out. The controller turns a verdict into `holdWebrtc`.
//
// A hold is the only action. While held the host's per-device picture carries the screen (V12) and WebRTC is not tried;
// when the hold ends one normal attempt follows. If that attempt is bad again soon, the next hold is twice as long, up to a
// ceiling, so a link that stays bad is tried rarely and a link that was only bad for a minute is back on WebRTC in a minute.

import type { RtcStats } from "./rtc-health";

/** One sample is bad at this share of lost video packets or more. */
export const BAD_LOSS = 0.05;
/** One sample is bad at this round trip or more, ms. */
export const BAD_RTT_MS = 800;
/** One sample is bad at this jitter or more, ms. */
export const BAD_JITTER_MS = 150;
/** The verdict looks at this many of the latest samples (2 s apart: 10 s) and needs this many of them bad. */
export const WINDOW = 5;
export const BAD_NEEDED = 4;
/** Two drops of a session that had played within this long make the link flapping, whatever the samples say. */
export const DROPS_WINDOW_MS = 120_000;
export const DROPS_NEEDED = 2;
/** One drop is enough when this many of the last few samples before it were bad. */
export const RECENT_BEFORE_DROP = 3;
export const BAD_BEFORE_DROP = 2;
export const HOLD_FIRST_MS = 60_000;
export const HOLD_MAX_MS = 10 * 60_000;
/** A session that is bad again this soon after a hold ended doubles the next hold. */
export const REPEAT_WITHIN_MS = 5 * 60_000;
/** A session that has been good this long forgets the doubling. */
export const GOOD_FOR_MS = 10 * 60_000;

export type Reason = "samples" | "drops";
export interface Verdict {
    /** Hold WebRTC off for this long, ms. */
    readonly holdMs: number;
    readonly reason: Reason;
}

/** True for one sample of a playing session. A quiet screen sends few frames, so frames and bitrate are not judged. */
export function isBadSample(stats: RtcStats): boolean {
    return stats.lossFraction >= BAD_LOSS || (stats.rttMs ?? 0) >= BAD_RTT_MS || stats.jitterMs >= BAD_JITTER_MS;
}

export interface Governor {
    /** A stats sample of the session that is playing. */
    sample(stats: RtcStats, now: number): Verdict | null;
    /** A session that had played was lost. */
    drop(now: number): Verdict | null;
    /** A hold was started (by this governor or a person): the samples before it say nothing about the next session. */
    held(now: number): void;
    /** The next hold's length, for a test or the status. */
    nextHoldMs(): number;
}

export function createGovernor(): Governor {
    let recent: boolean[] = [];
    let drops: number[] = [];
    let holdMs = HOLD_FIRST_MS;
    let lastVerdictAt = Number.NEGATIVE_INFINITY;
    let goodSince: number | null = null;

    const verdict = (reason: Reason, now: number): Verdict => {
        // Bad again soon after the last verdict: the link has not got better, so the wait doubles.
        if (now - lastVerdictAt < REPEAT_WITHIN_MS + holdMs) holdMs = Math.min(holdMs * 2, HOLD_MAX_MS);
        else holdMs = HOLD_FIRST_MS;
        lastVerdictAt = now;
        recent = [];
        drops = [];
        goodSince = null;
        return { holdMs, reason };
    };

    return {
        sample(stats, now) {
            const bad = isBadSample(stats);
            recent.push(bad);
            if (recent.length > WINDOW) recent.shift();
            if (bad) goodSince = null;
            else goodSince ??= now;
            if (goodSince !== null && now - goodSince >= GOOD_FOR_MS) holdMs = HOLD_FIRST_MS;
            if (recent.length === WINDOW && recent.filter(Boolean).length >= BAD_NEEDED) return verdict("samples", now);
            return null;
        },
        drop(now) {
            drops = drops.filter((at) => now - at < DROPS_WINDOW_MS);
            drops.push(now);
            goodSince = null;
            // A drop straight after bad samples is the collapse those samples were showing: stall detection (W11) often ends the
            // session before the samples alone could make a verdict, and a retry that never plays again is not a second drop.
            const collapsing = recent.slice(-RECENT_BEFORE_DROP).filter(Boolean).length >= BAD_BEFORE_DROP;
            if (collapsing || drops.length >= DROPS_NEEDED) return verdict("drops", now);
            return null;
        },
        held() {
            recent = [];
        },
        nextHoldMs: () => holdMs,
    };
}
