import { CELL_DELTA, GRID_HEIGHT, GRID_WIDTH } from "./limits";

/** A frame reduced to grey levels, `GRID_WIDTH * GRID_HEIGHT` of them, row by row. */
export type Grid = Uint8Array;

export const GRID_CELLS = GRID_WIDTH * GRID_HEIGHT;

/** One look at the screen: the grey grid, and the snapshot the PiKVM sent. */
export interface Frame {
    grid: Grid;
    /** The snapshot as the PiKVM sent it. */
    jpeg: Buffer;
    /** Epoch ms at which the snapshot was requested: the frame cannot be older than this look. Absent in tests that do not time it. */
    capturedAt?: number;
}

// ---- Pop-ups: the grid, looked at inside one rectangle ---------------------------------------------------------

/** A zone as whole cells of the grid: `x0..x1` and `y0..y1`, the end exclusive. Never empty. */
export interface ZoneCells {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** The zone's fractions as cells: the start rounds down and the end up, so a cell the zone touches is in it. */
export function zoneCells(zone: { x0: number; y0: number; x1: number; y1: number }): ZoneCells {
    const x0 = Math.min(GRID_WIDTH - 1, Math.max(0, Math.floor(zone.x0 * GRID_WIDTH)));
    const y0 = Math.min(GRID_HEIGHT - 1, Math.max(0, Math.floor(zone.y0 * GRID_HEIGHT)));
    const x1 = Math.min(GRID_WIDTH, Math.max(x0 + 1, Math.ceil(zone.x1 * GRID_WIDTH)));
    const y1 = Math.min(GRID_HEIGHT, Math.max(y0 + 1, Math.ceil(zone.y1 * GRID_HEIGHT)));
    return { x0, y0, x1, y1 };
}

/** The fraction of the zone's cells that moved by at least `cellDelta`. Grids of another size are wholly different (1). */
export function zoneChangedFraction(a: Grid, b: Grid, cells: ZoneCells, cellDelta: number = CELL_DELTA): number {
    if (a.length !== GRID_CELLS || b.length !== GRID_CELLS) return 1;
    let changed = 0;
    for (let y = cells.y0; y < cells.y1; y++) {
        const row = y * GRID_WIDTH;
        for (let x = cells.x0; x < cells.x1; x++) {
            if (Math.abs(a[row + x]! - b[row + x]!) >= cellDelta) changed++;
        }
    }
    return changed / ((cells.x1 - cells.x0) * (cells.y1 - cells.y0));
}

export interface ZoneSettlerOptions {
    /** How long the zone must hold after it changed before the change counts. */
    settleMs: number;
    /** The fraction of the zone's cells that makes a change. */
    changeFraction: number;
    cellDelta?: number;
}

export type ZoneLook =
    | { state: "idle" }
    /** The zone differs from what it showed and has not yet held for `settleMs`. */
    | { state: "changing" }
    /** It changed and came back to what it showed before it held long enough: a blink, a flash, a pop-up gone too soon. */
    | { state: "reverted" }
    /**
     * Something appeared in the zone and held. `firstSeenAt` is the look that first saw it; `score` the fraction of zone cells
     * that differ from before; `quiet` is the zone as it was before. `source` says which look to read the pop-up from:
     * "confirmed" is this look (the zone still differs from before), "detected" is the last look at which it changed (the pop-up
     * had gone again by this look, which is the first one at which it could have counted), and `grid` is that look's grid.
     */
    | { state: "appeared"; score: number; grid: Grid; quiet: Grid; firstSeenAt: number; source: "confirmed" | "detected" };

export interface ZoneSettler {
    look(grid: Grid, cells: ZoneCells, now: number): ZoneLook;
    /** Forget everything: the next look is adopted as the quiet zone. A zone that moved, or fast alerts switched on. */
    reset(): void;
    /** When the pending change will have held `settleMs`, if one is pending: the moment worth an extra look. */
    readonly wakeAt: number | null;
}

/** How many earlier pictures of the zone are remembered to tell "back to what was there" from a new pop-up. */
const TRAIL = 4;

/**
 * Tells a pop-up from the zone's ordinary flicker. The zone has a *current picture* (the last look that was within the change
 * fraction of it: a caret or a clock digit moves nothing) and a short trail of the pictures before it. A look that differs from the
 * current picture starts a pending change, a further change of that size restarts its hold, and once it has held `settleMs` the
 * pop-up has *appeared* (and is not undone if it later goes: the caller keeps the frame): the picture it appeared over is `quiet`,
 * and it becomes the current one. Nothing fires while the same pop-up stays. A look that is back to any picture in the trail (the
 * pop-up went; a window that was under it is showing again) is not an appearance, however many pop-ups came and went on the way:
 * a toast over a page of text must not fire again when it leaves, and the page is not compared with a desktop from before it opened.
 * A different pop-up over the first (a new message while the last is still up) is a new appearance, measured against the first.
 */
export function createZoneSettler(options: ZoneSettlerOptions): ZoneSettler {
    const delta = options.cellDelta ?? CELL_DELTA;
    /** Oldest first; the last is the current picture. Empty until the first look. */
    let trail: Grid[] = [];
    let pending: { latest: Grid; stableSince: number; firstSeenAt: number } | null = null;

    return {
        get wakeAt() {
            return pending ? pending.stableSince + options.settleMs : null;
        },
        reset() {
            trail = [];
            pending = null;
        },
        look(grid, cells, now) {
            const differs = (from: Grid): boolean => zoneChangedFraction(from, grid, cells, delta) >= options.changeFraction;
            if (trail.length === 0) {
                trail = [grid];
                return { state: "idle" };
            }
            const current = trail[trail.length - 1]!;
            /** The newest picture in the trail this look is back to, or -1 when it is a picture not seen before. */
            const returnedTo = ((): number => {
                for (let k = trail.length - 1; k >= 0; k--) if (!differs(trail[k]!)) return k;
                return -1;
            })();
            const settle = (k: number): void => {
                trail = [...trail.slice(0, k), grid];
            };

            if (pending) {
                const held = now - pending.stableSince >= options.settleMs;
                if (returnedTo >= 0) {
                    const gone = pending;
                    pending = null;
                    // It has gone. If this is the first look at which it could have counted, it held for the whole settle time (it was still there
                    // at the look before): a pop-up that left, not a flash. Read it from the look that saw it.
                    if (!held) {
                        settle(returnedTo);
                        return { state: "reverted" };
                    }
                    const score = zoneChangedFraction(current, gone.latest, cells, delta);
                    settle(returnedTo);
                    return { state: "appeared", score, grid: gone.latest, quiet: current, firstSeenAt: gone.firstSeenAt, source: "detected" };
                }
                if (differs(pending.latest)) {
                    pending = { ...pending, latest: grid, stableSince: now };
                    return { state: "changing" };
                }
                if (!held) return { state: "changing" };
                const firstSeenAt = pending.firstSeenAt;
                pending = null;
                trail = [...trail, grid].slice(-TRAIL);
                return { state: "appeared", score: zoneChangedFraction(current, grid, cells, delta), grid, quiet: current, firstSeenAt, source: "confirmed" };
            }

            if (returnedTo >= 0) {
                // Within the change fraction of a picture seen before: follow slow drift (a clock, a wallpaper slideshow) so only a jump
                // between looks counts, and forget the pictures after it.
                settle(returnedTo);
                return { state: "idle" };
            }
            pending = { latest: grid, stableSince: now, firstSeenAt: now };
            return { state: "changing" };
        },
    };
}

/**
 * The cells around what changed inside the zone, from `before` to `after`: the smallest rectangle that holds every changed cell,
 * `pad` cells wider on every side and kept inside the zone. A pop-up is a rectangle of changed cells, so this is the pop-up and
 * a margin; reading it instead of the whole zone is several times fewer pixels for the OCR, and leaves out the taskbar clock.
 * When nothing in the zone differs it is the whole zone.
 */
export function changedBox(before: Grid, after: Grid, zone: ZoneCells, pad: number, cellDelta: number = CELL_DELTA): ZoneCells {
    if (before.length !== GRID_CELLS || after.length !== GRID_CELLS) return zone;
    let minX = GRID_WIDTH;
    let minY = GRID_HEIGHT;
    let maxX = -1;
    let maxY = -1;
    for (let y = zone.y0; y < zone.y1; y++) {
        for (let x = zone.x0; x < zone.x1; x++) {
            if (Math.abs(before[y * GRID_WIDTH + x]! - after[y * GRID_WIDTH + x]!) < cellDelta) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < 0) return zone;
    return {
        x0: Math.max(zone.x0, minX - pad),
        y0: Math.max(zone.y0, minY - pad),
        x1: Math.min(zone.x1, maxX + 1 + pad),
        y1: Math.min(zone.y1, maxY + 1 + pad),
    };
}
