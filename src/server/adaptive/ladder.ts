/**
 * The rungs of the adaptive picture, the profiles that pick where a device may start, and the rule that moves a device
 * between rungs (FAILURE_MODES.md A3, A4, I5). Pure: the clock is passed in, nothing here touches a socket.
 */

import type { AdaptiveLimits } from "./limits";

export interface Rung {
    name: string;
    /** Fraction of the Pi's width and height; 1 with `quality` 0 means the Pi's JPEG is sent as it is (P6). */
    scale: number;
    /** JPEG quality of the re-encode; 0 = pass through. */
    quality: number;
    /** Frames a second at most (the rest are dropped). */
    maxFps: number;
}

/** Best first. Chosen by eye on a 1080p desktop, sizes in REPORT.md: each step roughly halves the bytes a second. */
export const RUNGS: readonly Rung[] = [
    { name: "full", scale: 1, quality: 0, maxFps: 15 },
    { name: "two-thirds", scale: 0.66, quality: 60, maxFps: 12 },
    { name: "half", scale: 0.5, quality: 50, maxFps: 8 },
    { name: "third", scale: 0.33, quality: 40, maxFps: 5 },
    { name: "quarter", scale: 0.25, quality: 35, maxFps: 2 },
];

export const BOTTOM = RUNGS.length - 1;

export type Profile = "auto" | "medium" | "low";

export const PROFILES: Readonly<Record<Profile, { ceiling: number; start: number }>> = {
    auto: { ceiling: 0, start: 1 },
    medium: { ceiling: 2, start: 2 },
    low: { ceiling: 3, start: 3 },
};

export function isProfile(value: string): value is Profile {
    return value === "auto" || value === "medium" || value === "low";
}

/** What the controller last did, for the status. */
export interface Steps {
    down: number;
    up: number;
}

/**
 * One device's rung. The pump tells it what it sees (a frame it had to drop for backlog, a clean stretch) and reads
 * `rung`. It moves at most one step per `stepHoldMs` and backs off its up-steps after a failed probe.
 */
export class RungController {
    rung: number;
    ceiling: number;
    readonly steps: Steps = { down: 0, up: 0 };
    private upAfterMs: number;
    private lastStepAt: number;
    private lastUpAt = Number.NEGATIVE_INFINITY;
    /** The last time the link showed backlog (or the controller was made): clean time counts from here. */
    private lastBacklogAt: number;

    constructor(
        private readonly limits: AdaptiveLimits,
        profile: Profile,
        now: number,
        remembered?: number,
    ) {
        const p = PROFILES[profile];
        this.ceiling = p.ceiling;
        this.rung = clamp(remembered ?? p.start, p.ceiling, BOTTOM);
        this.upAfterMs = limits.upAfterMs;
        this.lastStepAt = now;
        this.lastBacklogAt = now;
    }

    /** A new connection with another profile: the ceiling follows it, a worse rung than the ceiling is kept. */
    setProfile(profile: Profile): void {
        const p = PROFILES[profile];
        this.ceiling = p.ceiling;
        if (this.rung < p.ceiling) this.rung = p.ceiling;
    }

    /** A frame was due and the client could not take it. */
    backlog(now: number): void {
        this.lastBacklogAt = now;
        if (now - this.lastStepAt < this.limits.stepHoldMs || this.rung >= BOTTOM) return;
        this.rung++;
        this.steps.down++;
        this.lastStepAt = now;
        // A probe upward that failed this soon: wait longer before the next (A4).
        if (now - this.lastUpAt < this.limits.failedProbeMs) {
            this.upAfterMs = Math.min(this.upAfterMs * 2, this.limits.upAfterMaxMs);
        }
    }

    /** Called with every due frame the client did take (and every tick): time with no backlog earns an up-step. */
    ok(now: number): void {
        if (now - this.lastBacklogAt >= this.limits.cleanResetMs) this.upAfterMs = this.limits.upAfterMs;
        if (this.rung <= this.ceiling) return;
        // Each step starts the wait again: one rung per upAfterMs, never a cascade.
        if (now - Math.max(this.lastBacklogAt, this.lastStepAt) < this.upAfterMs) return;
        this.rung--;
        this.steps.up++;
        this.lastStepAt = now;
        this.lastUpAt = now;
    }
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(Math.max(value, low), high);
}
