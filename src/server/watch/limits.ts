/**
 * The numbers the screen watch runs on, in one place. docs/deploy-web.md ("Screen watch") explains each one and what it
 * costs; a value here that changes must change there.
 */

/** The watch looks at the screen this often. Never less than `MIN_INTERVAL_MS`: a snapshot is a JPEG the Pi encodes. */
export const DEFAULT_INTERVAL_MS = 3000;
export const MIN_INTERVAL_MS = 2000;

/** The grey grid every frame is reduced to before comparing: 64 x 36 keeps the 16:9 shape and is 2304 cells. */
export const GRID_WIDTH = 64;
export const GRID_HEIGHT = 36;

/**
 * A cell counts as changed when its grey level moves by at least this much (of 255). JPEG noise, a dithered
 * gradient and the colour a codec shifts from one frame to the next stay well under it; text appearing on a plain
 * background or a window opening is far over it.
 */
export const CELL_DELTA = 24;

/**
 * A screen has changed when at least this fraction of the cells did: 1.5% is 35 cells, about the size of a small
 * dialog's text or a menu opening at this grid. A cursor, a blinking caret or a clock digit changes a handful.
 */
export const CHANGE_FRACTION = 0.015;

/**
 * A change counts only once the screen has stayed put (no further change of CHANGE_FRACTION between two looks) for this
 * long, so a window sliding open, a page painting or a spinner never fires on its way.
 */
export const DEFAULT_SETTLE_MS = 6000;

/** The most the vision model is asked about: the frame is scaled so its long edge is at most this. */
export const MODEL_FRAME_EDGE = 1280;

/** At most one model check (a description and a decision) per watch within this window. A change inside it waits, newest wins. */
export const DEFAULT_MIN_CHECK_GAP_MS = 60_000;

/** At most this many model checks per watch in any 24 hours. Past it the diff still runs and the log says why nothing was asked. */
export const DEFAULT_DAILY_CAP = 200;

/** Two consecutive looks with no signal before "signal lost" counts; one miss is a hiccup. */
export const NO_SIGNAL_LOOKS = 2;

/** A Jev answer at or above this is a yes, at or below `1 - DECISIVE` a no, between them it is undecided and nothing is pushed. */
export const DECISIVE = 0.85;

/** The default image model. See docs/deploy-web.md for why this one and what it costs. */
export const DEFAULT_VISION_MODEL = "google/gemma-3-12b-it";

export const JEV_MODEL = "typesafe/jev-1.14";

/** The rule text is for a sentence or two; a larger one only makes every decision call dearer. */
export const MAX_RULE_CHARS = 500;

export interface WatchLimits {
    intervalMs: number;
    settleMs: number;
    minCheckGapMs: number;
    dailyCap: number;
}

function positive(raw: string | undefined): number | undefined {
    if (raw === undefined || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The limits for this host. `PIKVM_WATCH_INTERVAL_MS` (floored at `MIN_INTERVAL_MS`), `PIKVM_WATCH_SETTLE_MS`,
 * `PIKVM_WATCH_MIN_GAP_SEC` and `PIKVM_WATCH_DAILY_CAP` override the defaults; a value that is not a positive number is ignored.
 */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): WatchLimits {
    const interval = positive(env["PIKVM_WATCH_INTERVAL_MS"]);
    const settle = positive(env["PIKVM_WATCH_SETTLE_MS"]);
    const gap = positive(env["PIKVM_WATCH_MIN_GAP_SEC"]);
    const cap = positive(env["PIKVM_WATCH_DAILY_CAP"]);
    return {
        intervalMs: Math.max(MIN_INTERVAL_MS, interval ?? DEFAULT_INTERVAL_MS),
        settleMs: settle ?? DEFAULT_SETTLE_MS,
        minCheckGapMs: gap !== undefined ? gap * 1000 : DEFAULT_MIN_CHECK_GAP_MS,
        dailyCap: cap !== undefined ? Math.floor(cap) : DEFAULT_DAILY_CAP,
    };
}
