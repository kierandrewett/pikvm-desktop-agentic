/**
 * The numbers the screen watch runs on, in one place. docs/deploy-web.md ("Screen watch") explains each one and what it
 * costs; a value here that changes must change there.
 */

/** The watch looks at the screen this often. Never less than `MIN_INTERVAL_MS`: a snapshot is a JPEG the Pi encodes. */
export const DEFAULT_INTERVAL_MS = 3000;
export const MIN_INTERVAL_MS = 2000;

/**
 * The grey grid every frame is reduced to before comparing: 128 x 72 keeps the 16:9 shape; a cell is 10 px of a 1280 px frame,
 * which is about half a character of terminal text, so a line of text that changed is dozens of cells.
 */
export const GRID_WIDTH = 128;
export const GRID_HEIGHT = 72;

/**
 * A cell counts as changed when its grey level moves by at least this much (of 255). Measured on frames drawn for the run
 * (docs/e2e/2026-11-03-screen-watch.md): a frame re-encoded as JPEG, or with codec-sized noise, moves no cell by this much;
 * a line of text that changed moves dozens.
 */
export const CELL_DELTA = 10;

/**
 * A screen has changed when at least this fraction of the cells did: 0.3% is 28 of the 9216 cells. Measured on the run's frames
 * (docs/e2e/2026-11-03-screen-watch.md, "threshold"): a blinking caret is 0.11%, a progress bar ticking 0.05%, a clock digit
 * changing nothing; a new line of terminal output is 0.4%, a dialog's text changing 0.5%, a dialog opening 14%.
 */
export const CHANGE_FRACTION = 0.003;

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

/**
 * FAST ALERTS: the second path, for a pop-up in one corner of the screen (an email, a Teams message or a Teams call toast).
 * It runs beside the slow path above, on its own clock, gap and daily cap, and only when the user switched it on.
 * docs/deploy-web.md ("Fast alerts") explains it; the numbers are measured in docs/e2e/2026-11-05-fast-alerts.md.
 */

/**
 * With fast alerts on, the watch looks this often. Never less than this: every look is a snapshot the Pi serves (the JPEG
 * its streamer already encoded) and the host decodes to the grey grid. The whole screen is still compared only every
 * `DEFAULT_INTERVAL_MS`, so the slow path does not run any faster.
 */
export const DEFAULT_FAST_INTERVAL_MS = 1000;
export const MIN_FAST_INTERVAL_MS = 1000;

/**
 * A pop-up counts once the zone has held still this long after it changed. A toast slides in over about 0.3 s, so 1.2 s
 * leaves the slide-in behind and still beats the slow path's 6 s, which a 5 s toast would never reach. Unlike the slow path
 * the pop-up is NOT dropped if it goes away afterwards: the frame captured when it fired is what the model reads.
 * When a change is pending the watch makes one extra look at the moment it will have held this long, so the wait is this
 * and not this plus most of a look interval.
 */
export const DEFAULT_FAST_SETTLE_MS = 1200;

/**
 * A cell inside the zone counts as changed by the same `CELL_DELTA`; the zone has changed when at least this fraction of ITS
 * cells did. The default zone is 49 x 33 = 1617 cells of the 128 x 72 grid, so 1.5% is 25 cells. Calibrated on 1920 x 1080
 * frames drawn for the run (docs/e2e/2026-11-05-fast-alerts.md, "threshold"; apps/web/e2e/watch-fast-frames.mjs), on a dark
 * desktop and on a white document, as the fraction of the zone's cells that changed:
 *  - must not fire: a blinking caret 0.12%, a taskbar clock changing its minute digit or the time and the date together 0%
 *    (a glyph a few pixels wide moves no 15 px cell by 10 grey levels), the mouse pointer moving into the zone 0.19 to 0.25%,
 *    a tray icon changing colour and gaining a badge 0.31%, a 40 px spinner turning a quarter 0.06 to 0.43%, JPEG re-encoding
 *    or codec-sized noise 0%. The noisiest of these is 0.43%.
 *  - must fire: a Teams message toast 8.5 to 12.7%, an Outlook email toast 10.3 to 17.2%, a Teams call toast with its Accept
 *    and Decline buttons 10.6 to 15.8%, and the weakest toast tried, a one-line dark toast on a near-identical dark
 *    desktop, 7.2 to 11.0%.
 * 1.5% is 3.5 times the noisiest noise and 4.8 times below the weakest toast. A real toast with less contrast than the
 * drawn one would need a lower number; the false positives that costs are a model call that answers "No notification".
 */
export const ZONE_CHANGE_FRACTION = 0.015;

/** At most one fast check per watch within this window. A pop-up inside it waits (newest wins) and is read from its own captured frame. */
export const DEFAULT_FAST_MIN_CHECK_GAP_MS = 4000;

/** At most this many fast checks per watch in any 24 hours, counted apart from the slow path's `DEFAULT_DAILY_CAP`. */
export const DEFAULT_FAST_DAILY_CAP = 500;

/** The same pop-up text (same description hash) inside this long is notified once. */
export const FAST_DUPLICATE_MS = 30_000;

/** How long a push service may hold a message-style alert for a device that is offline: after this a late email is noise. */
export const FAST_ALERT_TTL_SEC = 300;

/** A call stops ringing; a push service must not deliver it later than this. */
export const FAST_CALL_TTL_SEC = 60;

/**
 * The local OCR has this long to read a pop-up. Past it the check logs "ocr timed out" and, only if an OpenRouter key is set, asks
 * the vision model instead. A crop of the pop-up takes a few hundred ms on the Xeon the image runs on (docs/e2e/2026-11-05-fast-alerts.md).
 */
export const OCR_TIMEOUT_MS = 4000;

/**
 * A zone change of at least this fraction of the zone's cells is "clearly a dialog" (the weakest toast drawn for the calibration
 * is 7.2%). If the OCR reads fewer than `MIN_TOAST_WORDS` words in one that big, the OCR is doubted and the vision model is asked,
 * when there is a key; a smaller change with no text is just a change.
 */
export const VISION_FALLBACK_SCORE = 0.05;

/**
 * More than this fraction of the zone's cells changing is not a pop-up: it is a window, a page or the whole desktop changing, which
 * the whole-screen path sees (its grid blanks only the zone). The biggest toast drawn for the calibration is 17%; the zone going from a dark
 * desktop to a white page is 79 to 91%. The fast path logs it as skipped and does not read it.
 */
export const ZONE_MAX_FRACTION = 0.5;

/** The OCR reads the cells that changed, widened by this many cells (about 30 px at 1080p) so a pop-up's edge text is not cut. */
export const OCR_PAD_CELLS = 2;

/**
 * With no OpenRouter key the whole-screen path reads a settled frame with the local OCR (a 1280 px frame takes seconds, not the
 * pop-up's few hundred ms) and the first `SCREEN_TEXT_CHARS` characters of its text, in reading order, are the description.
 */
export const SCREEN_OCR_TIMEOUT_MS = 20_000;
export const SCREEN_TEXT_CHARS = 600;

/** Two consecutive looks with no signal before "signal lost" counts; one miss is a hiccup. */
export const NO_SIGNAL_LOOKS = 2;

/** A Jev answer at or above this is a yes, at or below `1 - DECISIVE` a no, between them it is undecided and nothing is pushed. */
export const DECISIVE = 0.85;

/** The default image model. See docs/deploy-web.md for why this one and what it costs. */
export const DEFAULT_VISION_MODEL = "google/gemma-3-12b-it";

export const JEV_MODEL = "typesafe/jev-1.14";

/** The rule text is for a sentence or two; a larger one only makes every decision call dearer. */
export const MAX_RULE_CHARS = 500;

export interface FastLimits {
    intervalMs: number;
    settleMs: number;
    minCheckGapMs: number;
    dailyCap: number;
}

export interface WatchLimits {
    intervalMs: number;
    settleMs: number;
    minCheckGapMs: number;
    dailyCap: number;
    /** Fast alerts: the same four numbers, for the corner pop-up path. */
    fast: FastLimits;
}

function positive(raw: string | undefined): number | undefined {
    if (raw === undefined || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The limits for this host. `PIKVM_WATCH_INTERVAL_MS` (floored at `MIN_INTERVAL_MS`), `PIKVM_WATCH_SETTLE_MS`,
 * `PIKVM_WATCH_MIN_GAP_SEC` and `PIKVM_WATCH_DAILY_CAP` override the defaults; a value that is not a positive number is ignored.
 * The fast path has `PIKVM_WATCH_FAST_INTERVAL_MS` (floored at `MIN_FAST_INTERVAL_MS`), `PIKVM_WATCH_FAST_SETTLE_MS`,
 * `PIKVM_WATCH_FAST_MIN_GAP_SEC` and `PIKVM_WATCH_FAST_DAILY_CAP`.
 */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): WatchLimits {
    const interval = positive(env["PIKVM_WATCH_INTERVAL_MS"]);
    const settle = positive(env["PIKVM_WATCH_SETTLE_MS"]);
    const gap = positive(env["PIKVM_WATCH_MIN_GAP_SEC"]);
    const cap = positive(env["PIKVM_WATCH_DAILY_CAP"]);
    const fastInterval = positive(env["PIKVM_WATCH_FAST_INTERVAL_MS"]);
    const fastSettle = positive(env["PIKVM_WATCH_FAST_SETTLE_MS"]);
    const fastGap = positive(env["PIKVM_WATCH_FAST_MIN_GAP_SEC"]);
    const fastCap = positive(env["PIKVM_WATCH_FAST_DAILY_CAP"]);
    return {
        intervalMs: Math.max(MIN_INTERVAL_MS, interval ?? DEFAULT_INTERVAL_MS),
        settleMs: settle ?? DEFAULT_SETTLE_MS,
        minCheckGapMs: gap !== undefined ? gap * 1000 : DEFAULT_MIN_CHECK_GAP_MS,
        dailyCap: cap !== undefined ? Math.floor(cap) : DEFAULT_DAILY_CAP,
        fast: {
            intervalMs: Math.max(MIN_FAST_INTERVAL_MS, fastInterval ?? DEFAULT_FAST_INTERVAL_MS),
            settleMs: fastSettle ?? DEFAULT_FAST_SETTLE_MS,
            minCheckGapMs: fastGap !== undefined ? fastGap * 1000 : DEFAULT_FAST_MIN_CHECK_GAP_MS,
            dailyCap: fastCap !== undefined ? Math.floor(fastCap) : DEFAULT_FAST_DAILY_CAP,
        },
    };
}
