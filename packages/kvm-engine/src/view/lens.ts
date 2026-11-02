// The trackpad magnifier: a lens round the cursor showing what is under it.
//
// It is an aid for precision, not a pointer decoration. While the finger is travelling
// it stays out of the way (hidden, no growing). Only after about a second of sustained,
// slow, small movements (fine adjustment, the finger is homing in on a small target)
// does it appear, starting small and growing smoothly to its full size. Any fast move
// hides it again at once and restarts the wait.
//
// The picture's own zoom counts towards the same total magnification, so the lens
// magnifies less the further the picture has been pinched in, and once the picture alone
// is that close the lens has nothing to add and goes away.
//
// Speeds are finger px per ms, smoothed with a 140 ms time constant.

import type { Box, NaturalSize, Point } from "./geometry";

/** Smoothed speed at or above which the finger is travelling: 0.45 px/ms = 450 px/s. */
export const LENS_FAST_SPEED = 0.45;
/** One event at or above this is a flick (1.2 px/ms = 1200 px/s), even though the average has not caught up. */
export const LENS_FLICK_SPEED = 1.2;
/** Smoothed speed below which movement counts as a fine adjustment: 0.25 px/ms = 250 px/s. */
export const LENS_FINE_SPEED = 0.25;
/** Sustained fine movement needed before the lens appears. */
export const LENS_DWELL_MS = 1000;
/** A pause longer than this breaks the run before the lens has appeared. */
export const LENS_RUN_GAP_MS = 400;
/** A run that travels further than this is a slow glide, not an adjustment: the timer restarts. */
export const LENS_FINE_PATH_MAX = 160;
export const LENS_START = 40; // CSS px when it first appears
export const LENS_FULL = 96; // CSS px once grown (was 168: too big for small adjustments)
export const LENS_GROW_MS = 450;
export const LENS_SPEED_TAU_MS = 140; // time constant of the speed average
export const LENS_TOTAL = 5; // total magnification aimed for: lens x picture zoom
export const LENS_MIN_MAG = 1.2; // below this the lens adds nothing and hides
export const LENS_LINGER_MS = 1400;
const LENS_FIRST_DT_MS = 16;
const LENS_IDLE_MS = 60;

export interface LensSizeState {
    /** Smoothed finger speed, px/ms. */
    readonly speed: number;
    /** When `speed` was last updated; 0 before the first sample. */
    readonly speedAt: number;
    /** When the current run of fine movement began, or null. */
    readonly fineSince: number | null;
    /** When the last move was seen. */
    readonly lastMoveAt: number;
    /** Finger path length since the run began, px. */
    readonly path: number;
    /** When the lens started appearing, or null while hidden. */
    readonly shownAt: number | null;
}

export function createLensSize(): LensSizeState {
    return { speed: 0, speedAt: 0, fineSince: null, lastMoveAt: 0, path: 0, shownAt: null };
}

/** A new touch starts from nothing: whatever the last gesture earned is dropped. */
export function beginLensGesture(s: LensSizeState): LensSizeState {
    return { ...s, fineSince: null, path: 0, shownAt: null, speed: 0, speedAt: 0 };
}

function smooth(s: LensSizeState, distance: number | null, now: number): { state: LensSizeState; sample: number } {
    const dt = s.speedAt ? Math.max(1, now - s.speedAt) : LENS_FIRST_DT_MS;
    const a = 1 - Math.exp(-dt / LENS_SPEED_TAU_MS);
    const sample = distance === null ? 0 : distance / dt;
    return { state: { ...s, speedAt: now, speed: s.speed + (sample - s.speed) * a }, sample };
}

/** Fold one finger-speed sample (distance in px; null = "stopped") into the average. */
export function smoothLensSpeed(s: LensSizeState, distance: number | null, now: number): LensSizeState {
    return smooth(s, distance, now).state;
}

/** One finger move of `distance` px: update the speed, and decide whether it hides, restarts or advances the dwell. */
export function noteLensSpeed(prev: LensSizeState, distance: number, now: number): LensSizeState {
    const { state: s, sample } = smooth(prev, distance, now);
    if (sample >= LENS_FLICK_SPEED || s.speed >= LENS_FAST_SPEED) {
        // Travelling: hidden, no growing, and the wait starts over.
        return { ...s, fineSince: null, path: 0, shownAt: null, lastMoveAt: now };
    }
    // Once up it stays up through in-between speeds; only a fast move takes it away.
    if (s.shownAt !== null) return { ...s, lastMoveAt: now };
    if (s.speed >= LENS_FINE_SPEED) return { ...s, fineSince: null, path: 0, lastMoveAt: now };
    const broken = s.fineSince === null || now - s.lastMoveAt > LENS_RUN_GAP_MS;
    if (broken) return { ...s, fineSince: now, path: distance, lastMoveAt: now };
    const path = s.path + distance;
    // A long slow glide is travelling, not adjusting: start the wait again from here.
    if (path > LENS_FINE_PATH_MAX) return { ...s, fineSince: now, path: distance, lastMoveAt: now };
    return { ...s, path, lastMoveAt: now };
}

export interface LensFrame {
    readonly state: LensSizeState;
    /** The finger has earned the lens (the context conditions in lensVisible still apply). */
    readonly visible: boolean;
    /** Whole CSS px to draw at; meaningful only when visible. */
    readonly size: number;
}

function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

/** Advance one frame. */
export function updateLensSize(prev: LensSizeState, now: number): LensFrame {
    // A finger that has stopped sends no moves; let the speed fall away.
    let s = now - prev.speedAt > LENS_IDLE_MS && prev.speedAt ? smoothLensSpeed(prev, null, now) : prev;
    if (s.shownAt === null && s.fineSince !== null) {
        if (now - s.lastMoveAt > LENS_RUN_GAP_MS) {
            // The finger stopped adjusting before the wait was up.
            s = { ...s, fineSince: null, path: 0 };
        } else if (now - s.fineSince >= LENS_DWELL_MS) {
            s = { ...s, shownAt: now };
        }
    }
    if (s.shownAt === null) return { state: s, visible: false, size: 0 };
    const t = Math.max(0, Math.min(1, (now - s.shownAt) / LENS_GROW_MS));
    return { state: s, visible: true, size: Math.round(LENS_START + (LENS_FULL - LENS_START) * easeOutCubic(t)) };
}

/** Lens magnification at a picture zoom: the lens makes up what the picture lacks. */
export function lensMag(scale: number): number {
    return Math.max(1, LENS_TOTAL / scale);
}

export interface LensVisibilityInput {
    readonly trackpadActive: boolean;
    /** The target's mouse is relative: the cursor position is a guess, so no lens. */
    readonly relative: boolean;
    readonly hidOpen: boolean;
    readonly modalOpen: boolean;
    /** Cursor in client pixels, or null with no picture. */
    readonly at: Point | null;
    readonly scale: number;
    readonly now: number;
    /** Time until which the lens lingers after the last trackpad activity. */
    readonly until: number;
    readonly box: Box | null;
    readonly nat: NaturalSize;
}

/** Whether the lens should be on screen this frame. */
export function lensVisible(i: LensVisibilityInput): boolean {
    if (!(i.trackpadActive && !i.relative && i.hidOpen && !i.modalOpen) || !i.at) return false;
    if (lensMag(i.scale) < LENS_MIN_MAG || i.now > i.until) return false;
    // A stream that has not delivered a real frame yet has nothing to magnify.
    return !!i.box && i.nat.w >= 32 && i.nat.h >= 32;
}

export interface LensSource {
    /** Source rectangle inside the picture, in the stream's own pixels (already clipped to the picture). */
    readonly sx: number;
    readonly sy: number;
    readonly sw: number;
    readonly sh: number;
    /** Destination rectangle in lens canvas pixels. */
    readonly dx: number;
    readonly dy: number;
    readonly dw: number;
    readonly dh: number;
    /** Draw smoothed when the blow-up is modest, pixelated when large. */
    readonly smoothing: boolean;
    /** False when the lens is wholly off the picture: only the black fill and the hotspot are drawn. */
    readonly visible: boolean;
}

/**
 * The square of the picture the lens covers. Same magnification at any lens size:
 * a bigger lens shows more around the cursor, not a bigger blow-up of the same spot.
 * `px` is the canvas size in device pixels.
 */
export function lensSource(size: number, px: number, mag: number, box: Box, nat: NaturalSize, at: Point): LensSource {
    const perClient = nat.w / box.w; // stream px per client px at the current zoom
    const side = (size / mag) * perClient;
    const cx = ((at.x - box.left) / box.w) * nat.w;
    const cy = ((at.y - box.top) / box.h) * nat.h;
    const x0 = cx - side / 2;
    const y0 = cy - side / 2;
    // Only the part inside the picture is drawn; beyond its edge stays black.
    const ix = Math.max(0, x0);
    const iy = Math.max(0, y0);
    const iw = Math.min(nat.w, x0 + side) - ix;
    const ih = Math.min(nat.h, y0 + side) - iy;
    const k = px / side;
    return {
        sx: ix,
        sy: iy,
        sw: iw,
        sh: ih,
        dx: (ix - x0) * k,
        dy: (iy - y0) * k,
        dw: iw * k,
        dh: ih * k,
        smoothing: mag < 2.5,
        visible: iw > 0 && ih > 0,
    };
}
