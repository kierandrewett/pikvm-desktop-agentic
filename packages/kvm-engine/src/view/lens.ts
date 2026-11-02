// The trackpad magnifier: a lens round the cursor showing what is under it.
//
// The picture's own zoom counts towards the same total, so the lens magnifies
// less the further the picture has been pinched in, and once the picture alone is
// that close the lens has nothing to add and goes away.
//
// The lens grows when the finger slows (you are aiming) and shrinks when it speeds
// up (you are travelling and it would only be in the way). Speed is smoothed, and
// the size only moves to a new target once that target has held for a moment and
// differs by a clear step, then eases there, so it does not pulse with every
// jitter of the finger.

import type { Box, NaturalSize, Point } from "./geometry";

export const LENS_MIN = 64; // CSS px, travelling fast
export const LENS_MAX = 168; // CSS px, aiming slowly or holding still
export const LENS_SLOW = 0.12; // finger px/ms at or below which the lens is largest
export const LENS_FAST = 1.4; // finger px/ms at or above which it is smallest
export const LENS_STEP = 18; // px a new size has to differ by to be taken
export const LENS_SETTLE_MS = 160; // how long a new size has to hold before it is taken
export const LENS_SPEED_TAU_MS = 140; // time constant of the speed average
export const LENS_TOTAL = 4; // total magnification aimed for: lens x picture zoom
export const LENS_MIN_MAG = 1.2; // below this the lens adds nothing and hides
export const LENS_LINGER_MS = 1400;
export const LENS_EASE = 0.2; // share of the remaining distance covered per frame
const LENS_INITIAL = 104;
const LENS_FIRST_DT_MS = 16;
const LENS_IDLE_MS = 60;

export interface LensSizeState {
    /** Smoothed finger speed, px/ms. */
    readonly speed: number;
    /** When `speed` was last updated; 0 before the first sample. */
    readonly speedAt: number;
    /** The size being eased towards. */
    readonly target: number;
    /** The size currently drawn (fractional while easing). */
    readonly shown: number;
    /** A candidate size waiting to hold for LENS_SETTLE_MS. */
    readonly pending: { readonly size: number; readonly since: number } | null;
}

export function createLensSize(): LensSizeState {
    return { speed: 0, speedAt: 0, target: LENS_INITIAL, shown: LENS_INITIAL, pending: null };
}

/** Fold one finger-speed sample (distance in px; null = "stopped") into the average. */
export function smoothLensSpeed(s: LensSizeState, distance: number | null, now: number): LensSizeState {
    const dt = s.speedAt ? Math.max(1, now - s.speedAt) : LENS_FIRST_DT_MS;
    const a = 1 - Math.exp(-dt / LENS_SPEED_TAU_MS);
    const sample = distance === null ? 0 : distance / dt;
    return { ...s, speedAt: now, speed: s.speed + (sample - s.speed) * a };
}

export function noteLensSpeed(s: LensSizeState, distance: number, now: number): LensSizeState {
    return smoothLensSpeed(s, distance, now);
}

export function lensSizeForSpeed(speed: number): number {
    const t = Math.max(0, Math.min(1, (speed - LENS_SLOW) / (LENS_FAST - LENS_SLOW)));
    return Math.round(LENS_MAX - t * (LENS_MAX - LENS_MIN));
}

/** Advance the size one frame; returns the size to draw (whole CSS px). */
export function updateLensSize(prev: LensSizeState, now: number): { state: LensSizeState; size: number } {
    // A finger that has stopped sends no moves; let the speed fall away.
    let s = now - prev.speedAt > LENS_IDLE_MS ? smoothLensSpeed(prev, null, now) : prev;
    const want = lensSizeForSpeed(s.speed);
    let target = s.target;
    let pending = s.pending;
    if (Math.abs(want - target) < LENS_STEP) pending = null;
    else if (!pending || Math.abs(want - pending.size) >= LENS_STEP) pending = { size: want, since: now };
    else if (now - pending.since >= LENS_SETTLE_MS) {
        target = pending.size;
        pending = null;
    }
    let shown = s.shown + (target - s.shown) * LENS_EASE;
    if (Math.abs(target - shown) < 0.5) shown = target;
    s = { ...s, target, pending, shown };
    return { state: s, size: Math.round(shown) };
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
