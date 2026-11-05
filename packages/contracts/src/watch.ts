/**
 * The screen watch's wire types, shared by the server (src/server/watch) and the Settings page. Plain TypeScript: the
 * routes are `/app/api/v1/watch/*`, answered by hand-written handlers, not part of the HttpApi in api.ts.
 */

export const WATCH_PATH = "/app/api/v1/watch";

/**
 * A rectangle of the frame as fractions (0..1) of its width and height, from the top-left: `x0 < x1`, `y0 < y1`. The zone
 * fast alerts watch is stored in this shape so a custom rectangle can be offered later; today the Settings page picks one of
 * `ALERT_ZONES`.
 */
export interface WatchZone {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** Where a pop-up appears on each system: Windows bottom right (the default), macOS and many Linux desktops top right. */
export const ALERT_ZONES = [
    { id: "bottom-right", label: "Bottom right", zone: { x0: 0.62, y0: 0.55, x1: 1, y1: 1 } },
    { id: "top-right", label: "Top right", zone: { x0: 0.62, y0: 0, x1: 1, y1: 0.45 } },
    { id: "bottom-left", label: "Bottom left", zone: { x0: 0, y0: 0.55, x1: 0.38, y1: 1 } },
    { id: "top-left", label: "Top left", zone: { x0: 0, y0: 0, x1: 0.38, y1: 0.45 } },
] as const satisfies ReadonlyArray<{ id: string; label: string; zone: WatchZone }>;

export type AlertZoneId = (typeof ALERT_ZONES)[number]["id"];

export const DEFAULT_ALERT_ZONE: WatchZone = ALERT_ZONES[0].zone;

/** The preset a stored zone is, or undefined for a rectangle that is none of them. */
export function alertZoneId(zone: WatchZone): AlertZoneId | undefined {
    return ALERT_ZONES.find((preset) => preset.zone.x0 === zone.x0 && preset.zone.y0 === zone.y0 && preset.zone.x1 === zone.x1 && preset.zone.y1 === zone.y1)?.id;
}

/** What a person sets: on or off, what to be told about in their own words, which image model reads the screen, and fast alerts. */
export interface WatchSettings {
    enabled: boolean;
    /** Empty means: anything important. */
    rule: string;
    /** An OpenRouter model id. */
    visionModel: string;
    /** Also watch one corner for pop-ups and notify within seconds. Needs `enabled`. */
    fastAlerts: boolean;
    /** Write a fast alert's notification as one short sentence: the OCR text of the pop-up (never the picture) goes to `summaryModel` through the OpenRouter key. Needs a key and `fastAlerts`. */
    fastSummary: boolean;
    /** An OpenRouter text model id, for the summary. */
    summaryModel: string;
    /** The corner fast alerts watch. */
    alertZone: WatchZone;
}

export type WatchSettingsPatch = Partial<WatchSettings>;

export interface WatchView extends WatchSettings {
    defaultVisionModel: string;
    defaultSummaryModel: string;
    /** Whether the watch can be switched on now, and if not, why. */
    canEnable: { ok: true } | { ok: false; reason: string };
    /** An OpenRouter key is stored, so a change can be judged against the rule. Without one the watch (if this host can read the screen itself) tells about every change that settles. */
    canJudge: boolean;
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
    limits: {
        intervalSec: number;
        settleSec: number;
        minCheckGapSec: number;
        dailyCap: number;
        askedToday: number;
        /** Fast alerts: how often the corner is looked at, how long a pop-up must hold, the gap between checks, the cap. */
        fast: { intervalSec: number; settleSec: number; minCheckGapSec: number; dailyCap: number; askedToday: number };
    };
}

export type CheckOutcome =
    /** Jev said yes and a notification went out. */
    | "pushed"
    /** Jev said no. */
    | "no"
    /** Jev's answer was in between; nothing was sent. */
    | "undecided"
    /** A change was seen but nothing was sent and no yes/no was asked for, for the reason in `reason`. */
    | "skipped"
    /** A model call or the push failed, for the reason in `reason`. */
    | "error";

/** One line of the check log (`users/<id>/watch/checks.jsonl`). */
export interface CheckEntry {
    /** Epoch ms. */
    t: number;
    at: string;
    /** `alert` is a fast alert: a pop-up in the corner zone. */
    kind: "change" | "signal-lost" | "test" | "alert";
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
    /** The summary of a fast alert: whether it became the body, how long it took, and why not when it did not (a reason, never text). */
    summary?: { used: boolean; ms: number; skipped?: string };
    /** A fast alert's timestamps (epoch ms), so the delay from the screen to the phone can be read off the log. */
    latency?: CheckLatency;
    /** How a fast alert's text was read, and how much. Never the text itself: see `notified`. */
    read?: { by: "ocr" | "vision"; ms: number; chars: number; words: number; lines: number; fallback?: string };
    /**
     * What the person was shown, for a notification that went out. The title and body are the screen's own words, so they are
     * logged only when the host runs with `PIKVM_WATCH_LOG_TEXT=1`; otherwise how long they were and what kind of pop-up it was.
     */
    notified?: {
        kind: "call" | "teams" | "email" | "other";
        tag: string;
        urgency: "normal" | "high";
        ttlSec: number;
        titleChars: number;
        bodyChars: number;
        title?: string;
        body?: string;
    };
}

/**
 * One fast alert's path. `capturedAt` is when the snapshot of the frame that was read was requested (the Pi's own capture
 * and JPEG encode are inside it); `firstSeenAt` is the look that first saw the zone change, `detectedAt` the look at which it
 * had held long enough. `readAt` is when the text was ready (the OCR, or the vision model on the fallback), `decidedAt` when it
 * was settled that it is sent (the same moment with no rule: there is nothing to decide). `totalMs` is `pushedAt - capturedAt`;
 * `sinceFirstSeenMs` is `pushedAt - firstSeenAt`, which is the one that includes the wait to be sure the pop-up has settled.
 */
export interface CheckLatency {
    firstSeenAt: number;
    capturedAt: number;
    detectedAt: number;
    readAt?: number;
    /** When the summary was ready (or was given up on), if one was asked for. */
    summarisedAt?: number;
    decidedAt?: number;
    pushedAt?: number;
    totalMs?: number;
    sinceFirstSeenMs?: number;
}

export interface WatchTestResult {
    sent: number;
    removed: number;
    failed: { host: string; status: number | null; message: string }[];
}
