// Visual "no signal" detection.
//
// The streamer can report a source as online while the target is putting out a
// completely blank picture (a solid colour / black). A tiny grid sampled off the
// live frame is checked for variance: if it stays uniform for a moment the console
// shows "No signal" anyway. The grid is the same one the screen-change alert reads,
// so a frame is drawn and read back once for both.

export const BLANK_GRID_W = 40;
export const BLANK_GRID_H = 24;
export const BLANK_GRID_CELLS = BLANK_GRID_W * BLANK_GRID_H;
/** Luminance variance below this is "one solid colour". */
export const BLANK_VARIANCE = 6;
/** The picture must stay uniform this long before it counts as blank. */
export const BLANK_AFTER_MS = 2500;

export interface LumaResult {
    readonly lum: Float32Array;
    readonly mean: number;
    readonly variance: number;
    readonly uniform: boolean;
}

/**
 * Luminance grid from RGBA pixels (0..255): the mean of R, G, B per cell. `out`
 * lets the caller ping-pong two buffers so a sample never allocates and the previous
 * one stays intact for diffing.
 */
export function lumaGrid(rgba: ArrayLike<number>, out?: Float32Array): LumaResult {
    const n = BLANK_GRID_CELLS;
    const lum = out && out.length === n ? out : new Float32Array(n);
    let sum = 0;
    let sumsq = 0;
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        const l = ((rgba[o] ?? 0) + (rgba[o + 1] ?? 0) + (rgba[o + 2] ?? 0)) / 3;
        lum[i] = l;
        sum += l;
        sumsq += l * l;
    }
    const mean = sum / n;
    const variance = sumsq / n - mean * mean;
    return { lum, mean, variance, uniform: variance < BLANK_VARIANCE };
}

/** Tracks how long the picture has been uniform. Pure: returns the next state and whether blank now. */
export interface BlankTracker {
    /** When the current uniform run began, or null while the picture is varied. */
    readonly since: number | null;
    readonly blank: boolean;
}

export const INITIAL_BLANK: BlankTracker = { since: null, blank: false };

export function stepBlank(prev: BlankTracker, uniform: boolean, now: number): BlankTracker {
    if (!uniform) return INITIAL_BLANK;
    const since = prev.since ?? now;
    return { since, blank: prev.blank || now - since > BLANK_AFTER_MS };
}
