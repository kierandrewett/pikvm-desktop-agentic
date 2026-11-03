/**
 * The screen watch's wire types, shared by the server (src/server/watch) and the Settings page. Plain TypeScript: the
 * routes are `/app/api/v1/watch/*`, answered by hand-written handlers, not part of the HttpApi in api.ts.
 */

export const WATCH_PATH = "/app/api/v1/watch";

/** What a person sets: on or off, what to be told about in their own words, and which image model reads the screen. */
export interface WatchSettings {
    enabled: boolean;
    /** Empty means: anything important. */
    rule: string;
    /** An OpenRouter model id. */
    visionModel: string;
}

export type WatchSettingsPatch = Partial<WatchSettings>;

export interface WatchView extends WatchSettings {
    defaultVisionModel: string;
    /** Whether the watch can be switched on now, and if not, why. */
    canEnable: { ok: true } | { ok: false; reason: string };
    /** Looking at the screen right now. */
    running: boolean;
    /** What the last looks found: the picture, no signal, or not looked yet. */
    signal: "unknown" | "signal" | "no-signal";
    push: {
        /** The server can sign pushes (its key file is usable). */
        available: boolean;
        reason?: string;
        /** The application server key a browser subscribes with. */
        publicKey?: string;
        /** Devices that asked for notifications. */
        subscriptions: number;
    };
    limits: { intervalSec: number; settleSec: number; minCheckGapSec: number; dailyCap: number; askedToday: number };
}

export type CheckOutcome =
    /** Jev said yes and a notification went out. */
    | "pushed"
    /** Jev said no. */
    | "no"
    /** Jev's answer was in between; nothing was sent. */
    | "undecided"
    /** A change was seen but no model was asked, for the reason in `reason`. */
    | "skipped"
    /** A model call or the push failed, for the reason in `reason`. */
    | "error";

/** One line of the check log (`users/<id>/watch/checks.jsonl`). */
export interface CheckEntry {
    /** Epoch ms. */
    t: number;
    at: string;
    kind: "change" | "signal-lost" | "test";
    /** The fraction of the screen's cells that changed, for a change. */
    score: number | null;
    outcome: CheckOutcome;
    reason?: string;
    /** True when a model was called, which is what the daily cap counts. */
    asked: boolean;
    model?: string;
    previous?: string;
    description?: string;
    rule?: string;
    /** Jev's probability of yes. */
    noul?: number;
    /** Jev's answer was the cached one for this exact request (the same two descriptions and rule), so it cost nothing. */
    fromCache?: boolean;
    costUsd?: number;
    push?: { sent: number; removed: number; failed: number };
}

export interface WatchTestResult {
    sent: number;
    removed: number;
    failed: { host: string; status: number | null; message: string }[];
}
