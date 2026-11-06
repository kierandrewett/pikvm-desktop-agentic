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

/**
 * Why the chat model judged a pop-up the way it did: a fixed set, so the log can say it without saying what the pop-up was. The first
 * seven are the reasons to interrupt the person, the next four the reasons not to, `rule` is the person's own rule, `other` the rest.
 */
export const JUDGE_REASONS = ["call", "person_waiting", "time_critical", "security", "failure", "money_legal", "real_world", "routine", "marketing_social", "chatter", "duplicate", "rule", "other"] as const;

export type JudgeReason = (typeof JUDGE_REASONS)[number];

/** Why one of the chat model's two steps gave nothing usable: it did not answer at all (the long hang guard), failed, answered something that is not the JSON asked for, or answered with nothing in it. A slow answer is waited for and is none of these. */
export type ModelFailure = "timeout" | "error" | "invalid" | "empty";

/** What a person sets: on or off, what to be told about in their own words (empty: every pop-up), and where on the screen pop-ups appear. */
export interface WatchSettings {
    enabled: boolean;
    /** Empty means: nothing extra. Otherwise extra instructions for the chat model's judgement of a pop-up (what else to notify about, what never to); without a chat model they cannot be applied. */
    rule: string;
    /** The corner to watch. */
    alertZone: WatchZone;
    /** Notify the person's devices when the agent waits for an approval, an answer or a form, unless they are at the app. On unless switched off. */
    notifyAgent: boolean;
}

export type WatchSettingsPatch = Partial<WatchSettings>;

export interface WatchView extends WatchSettings {
    /** Whether the watch can be switched on now, and if not, why. */
    canEnable: { ok: true } | { ok: false; reason: string };
    /** A chat model is configured, so it reads each pop-up and decides whether it is worth interrupting the person for (and applies the rule). Without one every pop-up is sent as read. */
    chatModel: boolean;
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
    /** How often the corner is looked at, how long a pop-up must hold, the gap between checks, the daily cap and how much of it is used. */
    limits: { intervalSec: number; settleSec: number; minCheckGapSec: number; dailyCap: number; askedToday: number };
}

/**
 * What a page of the app tells the host about the person: whether this page has focus and how long ago it last saw a real key press and a
 * significant pointer movement (ages in ms, never timestamps, so the clocks of the page and the host need not agree). `clientId` is a
 * random id per page. Nothing else: no key, no coordinate, no text. `POST /app/api/v1/watch/presence`.
 */
export interface WatchPresence {
    clientId: string;
    focused: boolean;
    keyboardAgoMs: number | null;
    pointerAgoMs: number | null;
}

export type CheckOutcome =
    /** A notification went out. */
    | "pushed"
    /** The Decisions model, or else the chat model's judge, found the pop-up not worth interrupting the person for (`decided` or `judged` says how). Nothing was sent. */
    | "no"
    /** The person was using the app's window, so nothing was asked of any model and nothing was sent. */
    | "held"
    /** Something was seen but nothing was sent, for the reason in `reason`. */
    | "skipped"
    /** Reading or the push failed, for the reason in `reason`. */
    | "error";

/** One line of the check log (`users/<id>/watch/checks.jsonl`). */
export interface CheckEntry {
    /** Epoch ms. */
    t: number;
    at: string;
    kind: "alert" | "test";
    /** The fraction of the zone's cells that changed. */
    score: number | null;
    outcome: CheckOutcome;
    reason?: string;
    /** True when the pop-up was read, which is what the daily cap counts. */
    asked: boolean;
    /** The words of the pop-up, only when the host runs with `PIKVM_WATCH_LOG_TEXT=1`. */
    description?: string;
    rule?: string;
    push?: { sent: number; removed: number; failed: number };
    /**
     * How the chat model's two steps went (only when a chat model judged the pop-up): how long each took and, when one gave nothing usable,
     * why (`readSkipped`: the judge got the pop-up's lines as read instead of the facts; `judgeSkipped`: the notification went out anyway).
     * `notify` and `reason` are the judge's verdict. Fixed values and numbers only, never the model's words.
     */
    judged?: { readMs: number; readSkipped?: ModelFailure; judgeMs: number; judgeSkipped?: ModelFailure; notify?: boolean; reason?: JudgeReason };
    /**
     * The Decisions model's answer, when one is set: how long it took, P(yes) and which kind of model answered (`decisions`: a native
     * decisions model such as Jev, `chat`: a chat model asked for JSON). `failed` when it gave nothing usable; the pop-up then goes on to
     * the chat model's steps as if no decisions model were set. Numbers and fixed words only.
     */
    decided?: { ms: number; probability?: number; backend?: "decisions" | "chat"; failed?: true };
    /** The timestamps (epoch ms), so the delay from the screen to the phone can be read off the log. */
    latency?: CheckLatency;
    /** How the text was read, and how much. Never the text itself: see `notified`. */
    read?: { ms: number; chars: number; words: number; lines: number };
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
 * One pop-up's path. `capturedAt` is when the snapshot of the frame that was read was requested (the Pi's own capture
 * and JPEG encode are inside it); `firstSeenAt` is the look that first saw the zone change, `detectedAt` the look at which it
 * had held long enough. `readAt` is when the OCR had the text, `factsAt` when the chat model's first step had the facts (or was given
 * up on) and `judgedAt` when its second step had the verdict (or was given up on).
 * `totalMs` is `pushedAt - capturedAt`;
 * `sinceFirstSeenMs` is `pushedAt - firstSeenAt`, which is the one that includes the wait to be sure the pop-up has settled.
 */
export interface CheckLatency {
    firstSeenAt: number;
    capturedAt: number;
    detectedAt: number;
    readAt?: number;
    /** When the chat model's first step (reading the facts) was done or given up on, if a chat model was asked. */
    factsAt?: number;
    /** When its second step (the verdict) was done or given up on. */
    judgedAt?: number;
    pushedAt?: number;
    totalMs?: number;
    sinceFirstSeenMs?: number;
}

export interface WatchTestResult {
    sent: number;
    removed: number;
    failed: { host: string; status: number | null; message: string }[];
}
