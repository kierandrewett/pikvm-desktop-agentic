/**
 * The numbers the screen watch runs on, in one place. docs/deploy-web.md ("Screen watch") explains each one and what it costs; a value
 * here that changes must change there. The watch is one thing: it looks at one corner of the screen for a pop-up, reads it on this
 * host and sends a notification. (The measurements are in docs/e2e/2026-11-05-fast-alerts.md and ...-ocr.md.)
 */

/**
 * The grey grid every frame is reduced to before comparing: 128 x 72 keeps the 16:9 shape; a cell is 15 px of a 1920 px frame.
 */
export const GRID_WIDTH = 128;
export const GRID_HEIGHT = 72;

/**
 * A cell counts as changed when its grey level moves by at least this much (of 255): a frame re-encoded as JPEG, or with codec-sized
 * noise, moves no cell by this much; the edge of a pop-up moves many by far more.
 */
export const CELL_DELTA = 10;

/**
 * The watch looks at the screen this often. Never less than this: every look is a snapshot the Pi serves (the JPEG its streamer already
 * encoded) and the host decodes to the grey grid.
 */
export const DEFAULT_INTERVAL_MS = 1000;
export const MIN_INTERVAL_MS = 1000;

/**
 * A pop-up counts once the zone has held still this long after it changed. A toast slides in over about 0.3 s, so 1.2 s leaves the
 * slide-in behind. A pop-up is NOT dropped if it goes away afterwards: the frame captured when it counted is what is read. When a
 * change is pending the watch makes one extra look at the moment it will have held this long, so the wait is this and not this plus most
 * of a look interval.
 */
export const DEFAULT_SETTLE_MS = 1200;

/**
 * A cell inside the zone counts as changed by the same `CELL_DELTA`; the zone has changed when at least this fraction of ITS cells did.
 * The default zone is 49 x 33 = 1617 cells of the 128 x 72 grid, so 1.5% is 25 cells. Calibrated on 1920 x 1080 frames drawn for the run
 * (docs/e2e/2026-11-05-fast-alerts.md, "threshold"; apps/web/e2e/watch-fast-frames.mjs), on a dark desktop and on a white document, as the
 * fraction of the zone's cells that changed:
 *  - must not fire: a blinking caret 0.12%, a taskbar clock changing its minute digit or the time and the date together 0%
 *    (a glyph a few pixels wide moves no 15 px cell by 10 grey levels), the mouse pointer moving into the zone 0.19 to 0.25%,
 *    a tray icon changing colour and gaining a badge 0.31%, a 40 px spinner turning a quarter 0.06 to 0.43%, JPEG re-encoding
 *    or codec-sized noise 0%. The noisiest of these is 0.43%.
 *  - must fire: a dark-card toast 8.5 to 12.7%, a light-card toast 10.3 to 17.2%, a toast with two buttons 10.6 to 15.8%, and the
 *    weakest toast tried, a one-line dark toast on a near-identical dark desktop, 7.2 to 11.0%.
 * 1.5% is 3.5 times the noisiest noise and 4.8 times below the weakest toast. A real toast with less contrast than the drawn one would
 * need a lower number; the false positive that costs is an OCR read that finds too few words and is logged.
 */
export const ZONE_CHANGE_FRACTION = 0.015;

/**
 * More than this fraction of the zone's cells changing is not a pop-up: it is a window, a page or the whole desktop changing. The biggest
 * toast drawn for the calibration is 17%; the zone going from a dark desktop to a white page is 79 to 91%. It is logged as skipped and not read.
 */
export const ZONE_MAX_FRACTION = 0.5;

/** At most one check per watch within this window. A pop-up inside it waits (newest wins) and is read from its own captured frame. */
export const DEFAULT_MIN_CHECK_GAP_MS = 4000;

/** At most this many checks per watch in any 24 hours, counted from the log. Past it the log says why nothing was read. */
export const DEFAULT_DAILY_CAP = 500;

/** The same pop-up text (same hash) inside this long is notified once. */
export const DUPLICATE_MS = 30_000;

/** How long a push service may hold an ordinary notification for a device that is offline: after this a late one is noise. */
export const ALERT_TTL_SEC = 300;

/** A call stops ringing; a push service must not deliver it later than this. */
export const CALL_TTL_SEC = 60;

/**
 * The local OCR has this long to read a pop-up. Past it the check logs "ocr timed out" and sends nothing. A crop of the pop-up takes a
 * few hundred ms on the Xeon the image runs on (docs/e2e/2026-11-05-fast-alerts-ocr.md).
 */
export const OCR_TIMEOUT_MS = 4000;

/** The OCR reads the cells that changed, widened by this many cells (about 30 px at 1080p) so a pop-up's edge text is not cut. */
export const OCR_PAD_CELLS = 2;

/** A change of at least this fraction of the zone is clearly a dialog: with fewer than `MIN_TOAST_WORDS` words read the log says so. */
export const DIALOG_SCORE = 0.05;

/**
 * The chat model reads a pop-up in two steps (docs/deploy-web.md, "Screen watch"). Step 1 (READ) turns the OCR lines into facts, step 2
 * (JUDGE) decides whether the person is worth interrupting and writes the notification. Each step runs to the end: a slow model is waited
 * for, never skipped, because a verdict that arrives late is still worth more than none.
 *
 * These two numbers are a hang guard, not a speed limit. They are the longest a step may wait for a model that has said nothing at all (a
 * dead connection, a model that never loads) before the step is abandoned and the notification goes out as it is (fail open: a model that
 * is down must not hide a pop-up). Two minutes is longer than any model that is working takes to answer a few lines of text, a local one
 * loading its weights included. `PIKVM_WATCH_READ_TIMEOUT_MS` and `PIKVM_WATCH_JUDGE_TIMEOUT_MS` override them.
 */
export const READ_TIMEOUT_MS = 120_000;
export const JUDGE_TIMEOUT_MS = 120_000;

/**
 * Pop-ups that arrive while a check is still running (a slow model) wait their turn, oldest first, and are all read. Only a pop-up that
 * arrives to a full queue is dropped. Twenty is far more than a person gets in the time one slow model takes, and bounds the frames held.
 */
export const MAX_WAITING_POPUPS = 20;

/** The most a notification's body may be. The judge is told 250 so a reply at the edge still fits; a longer one is cut at a word. */
export const MAX_BODY_CHARS = 300;

/**
 * A notification is held back while the person is already at the screen: the app window has focus AND there was real keyboard input or a
 * significant pointer movement within this long. (docs/deploy-web.md, "Screen watch".)
 */
export const USER_ACTIVE_WINDOW_MS = 20_000;

/** A page that has not reported for this long is gone (a closed tab, a crashed app): it can no longer hold a notification back. About two missed refreshes (they come every 5 s). */
export const PRESENCE_EXPIRY_MS = 12_000;

/** Two consecutive looks with no signal before "no signal" counts; one miss is a hiccup. */
export const NO_SIGNAL_LOOKS = 2;

/** The rule text is for a sentence or two; a larger one only makes every request dearer. */
export const MAX_RULE_CHARS = 500;

/**
 * The agent's screen waits (screen-wait.ts): an agent asks a yes/no question about the screen and the Decisions model is asked it
 * whenever the watched part changes and holds still. Unlike the pop-up watch there is no corner and no ceiling on how much changes: a
 * page that finished loading is as good an answer as a toast.
 */
/** A Decisions answer at or above this is a yes, and ends the wait. Below it, including a maybe, the wait goes on. Jev's own advice for a decisive answer. */
export const WAIT_MATCH_AT = 0.85;
/**
 * The fraction of the watched cells that must change for it to count. The pop-up watch uses 1.5% of its small corner; the whole screen is
 * six times larger, so a toast is 1.3% to 2.3% of it. 0.3% is 28 cells of the grid: over the noisiest noise measured (0.43% of the corner, 7
 * cells, so under 0.1% of the screen) and under the weakest toast measured (116 cells).
 */
export const WAIT_CHANGE_FRACTION = 0.003;
/** A watched region so small that the fraction is under this many cells still needs this many to change: one cell is noise. */
export const WAIT_MIN_CELLS = 8;
/** Changes that arrive while a question is being answered wait their turn, oldest first. Past this the oldest is dropped, and counted. */
export const WAIT_QUEUE = 8;
/** A wait that has asked this many times without a yes ends: something on the screen keeps changing and a model is paying for it. */
export const WAIT_MAX_ASKS = 200;
/** The Decisions model failing this many times in a row ends the wait. */
export const WAIT_MAX_FAILURES = 3;
/** Waits running at once on one host. Each one costs a look's worth of work per second only once (the poller is shared), and a question per change. */
export const WAIT_MAX_ACTIVE = 4;
/** A whole screen, or a large part of it, takes longer to read than a toast's corner. */
export const WAIT_OCR_TIMEOUT_MS = 15_000;
/** The most screen text one question carries. Jev's advice is under about 32 KB of text; this is far under it. */
export const WAIT_TEXT_CHARS = 4000;
/** How much of the matching text is handed back to the agent. */
export const WAIT_EXCERPT_CHARS = 300;
export const WAIT_QUESTION_CHARS = 500;
export const WAIT_MIN_TIMEOUT_MS = 10_000;
export const WAIT_MAX_TIMEOUT_MS = 3_600_000;
/** A wait that has ended keeps its answer this long for the agent to collect. */
export const WAIT_KEEP_MS = 30 * 60_000;

export interface WatchLimits {
    intervalMs: number;
    settleMs: number;
    minCheckGapMs: number;
    dailyCap: number;
    readTimeoutMs: number;
    judgeTimeoutMs: number;
}

function positive(raw: string | undefined): number | undefined {
    if (raw === undefined || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The limits for this host. `PIKVM_WATCH_INTERVAL_MS` (floored at `MIN_INTERVAL_MS`), `PIKVM_WATCH_SETTLE_MS`, `PIKVM_WATCH_MIN_GAP_SEC`,
 * `PIKVM_WATCH_DAILY_CAP`, `PIKVM_WATCH_READ_TIMEOUT_MS` and `PIKVM_WATCH_JUDGE_TIMEOUT_MS` override the defaults; a value that is not a
 * positive number is ignored.
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
        readTimeoutMs: positive(env["PIKVM_WATCH_READ_TIMEOUT_MS"]) ?? READ_TIMEOUT_MS,
        judgeTimeoutMs: positive(env["PIKVM_WATCH_JUDGE_TIMEOUT_MS"]) ?? JUDGE_TIMEOUT_MS,
    };
}
