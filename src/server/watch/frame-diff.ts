import { CELL_DELTA, CHANGE_FRACTION, GRID_HEIGHT, GRID_WIDTH } from "./limits";

/** A frame reduced to grey levels, `GRID_WIDTH * GRID_HEIGHT` of them, row by row. */
export type Grid = Uint8Array;

export const GRID_CELLS = GRID_WIDTH * GRID_HEIGHT;

/**
 * The fraction of cells (0..1) whose grey level moved by at least `cellDelta` between two frames. Frames of different
 * sizes are wholly different (1): that is a resolution change, which is a change.
 */
export function changedFraction(a: Grid, b: Grid, cellDelta: number = CELL_DELTA): number {
    if (a.length !== b.length || a.length === 0) return 1;
    let changed = 0;
    for (let i = 0; i < a.length; i++) {
        if (Math.abs(a[i]! - b[i]!) >= cellDelta) changed++;
    }
    return changed / a.length;
}

export interface SettlerOptions {
    /** How long the screen must stay put after it changed before the change counts. */
    settleMs: number;
    /** The fraction of cells that makes a change. Default `CHANGE_FRACTION`. */
    changeFraction?: number;
    cellDelta?: number;
}

export type Look =
    /** Nothing differs from the last settled frame, beyond noise. */
    | { state: "idle" }
    /** The screen differs and is still moving or has not yet been still for long enough. */
    | { state: "changing" }
    /** It moved and moved back to the last settled frame before it settled: nothing to report. */
    | { state: "reverted" }
    /** The screen changed and has settled. `score` is the fraction of cells that differ from the previous settled frame. */
    | { state: "settled"; score: number; grid: Grid };

export interface Settler {
    /** One look at the screen, at `now` (ms). */
    look(grid: Grid, now: number): Look;
    /**
     * Forget the last settled frame. `adopt` takes the next frame as the new baseline silently (a watch starting);
     * `changed` makes the next frame count as a change once it settles (the signal came back).
     */
    reset(mode: "adopt" | "changed"): void;
    /** A change has been seen and has not settled or reverted yet. */
    readonly pending: boolean;
}

export function createSettler(options: SettlerOptions): Settler {
    const threshold = options.changeFraction ?? CHANGE_FRACTION;
    const delta = options.cellDelta ?? CELL_DELTA;
    let baseline: Grid | null = null;
    let adopt = true;
    let pending: { latest: Grid; stableSince: number } | null = null;

    return {
        get pending() {
            return pending !== null;
        },
        reset(mode) {
            baseline = null;
            pending = null;
            adopt = mode === "adopt";
        },
        look(grid, now) {
            if (pending) {
                // Back to what was there, however it got back: nothing happened.
                if (baseline && changedFraction(baseline, grid, delta) < threshold) {
                    pending = null;
                    return { state: "reverted" };
                }
                if (changedFraction(pending.latest, grid, delta) >= threshold) {
                    pending = { latest: grid, stableSince: now };
                    return { state: "changing" };
                }
                if (now - pending.stableSince < options.settleMs) return { state: "changing" };
                const settled = pending.latest;
                const score = baseline ? changedFraction(baseline, settled, delta) : 1;
                baseline = settled;
                pending = null;
                return { state: "settled", score, grid: settled };
            }
            if (!baseline) {
                if (adopt) {
                    baseline = grid;
                    return { state: "idle" };
                }
                pending = { latest: grid, stableSince: now };
                return { state: "changing" };
            }
            if (changedFraction(baseline, grid, delta) >= threshold) {
                pending = { latest: grid, stableSince: now };
                return { state: "changing" };
            }
            return { state: "idle" };
        },
    };
}
