// Background screen-change alerts (desktop only).
//
// While the desktop window sits behind something else the picture is still watched:
// when a big enough part of it changes (a dialog opens, the target reboots, a long
// install finishes) the OS is asked to pulse the taskbar icon. The detector reuses
// the 40x24 luminance grid the blank sampler already reads back, so it costs one
// diff over 960 cells.
//
// That coarse grid is the whole trick for "meaningful": a moving mouse pointer, a
// blinking caret or a clock ticking over averages away to almost nothing across a
// cell, while anything dialog-sized moves a couple of percent of the cells at once.
// Measured on simulated 1080p frames, share of cells over ALERT_CELL_DELTA:
//
//   mouse cursor moving 0.10%    caret blink 0.21%    clock digits 0.21%
//   all of those plus tray widgets 1.04%
//   notification toast 1.67%     modal dialog 9.06%   wake from black 100%
//
// So 2% sits at about twice the worst compound idle noise. A small toast lands just
// under it, which is the trade we want: a cue you never learn to ignore beats one
// that catches everything.

/** Per-cell luminance change (0-255) that counts as movement. */
export const ALERT_CELL_DELTA = 10;
/** Share of cells that must move to be "meaningful". */
export const ALERT_CHANGED_FRACTION = 0.02;
/** The screen must settle this long before the next alert. */
export const ALERT_QUIET_MS = 20000;

export interface ScreenActivityState {
    /** The previous grid, or null while not watching (so the next sample only re-baselines). */
    readonly prev: Float32Array | null;
    /** When the last meaningful change was seen, or null. */
    readonly lastMeaningfulAt: number | null;
}

export const INITIAL_SCREEN_ACTIVITY: ScreenActivityState = { prev: null, lastMeaningfulAt: null };

export interface ScreenActivityResult {
    readonly state: ScreenActivityState;
    /** Pulse the taskbar now. */
    readonly alert: boolean;
}

export function noteScreenSample(state: ScreenActivityState, lum: Float32Array, watching: boolean, now: number): ScreenActivityResult {
    if (!watching) {
        // Re-baseline, and start a fresh episode, on the first sample after watching begins
        // again, so nothing that happened while the window was focused fires an alert the
        // moment it loses focus.
        return { state: INITIAL_SCREEN_ACTIVITY, alert: false };
    }
    const prev = state.prev;
    const next: ScreenActivityState = { prev: lum, lastMeaningfulAt: state.lastMeaningfulAt };
    if (!prev || prev.length !== lum.length) return { state: next, alert: false }; // first sample, or the grid was resized
    let changed = 0;
    for (let i = 0; i < lum.length; i++) {
        if (Math.abs((lum[i] ?? 0) - (prev[i] ?? 0)) > ALERT_CELL_DELTA) changed++;
    }
    if (changed / lum.length < ALERT_CHANGED_FRACTION) return { state: next, alert: false };
    // One alert per episode of activity: an install churns the screen for minutes and
    // should pulse the icon once, not on every tick.
    const newEpisode = state.lastMeaningfulAt === null || now - state.lastMeaningfulAt >= ALERT_QUIET_MS;
    return { state: { prev: lum, lastMeaningfulAt: now }, alert: newEpisode };
}
