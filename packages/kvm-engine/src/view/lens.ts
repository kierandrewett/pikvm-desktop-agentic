// The trackpad magnifier: a lens round the cursor showing what is under it.
//
// Its zoom is a continuous function of how fast the finger is moving. Slow, precise
// movement zooms in; fast movement zooms out to nothing; nothing in between is a step.
// There is no hold time: the lens is there as soon as the finger starts moving slowly in
// trackpad mode (see LENS_ENGAGE_PX), and a finger that only rests, or taps, never shows it.
//
//   speed (px/s of the finger, smoothed)  ->  zoom (total magnification)
//
//        zoom
//   MAX  |‾‾‾‾‾‾‾╲
//        |        ╲        smoothstep between SLOW and FAST:
//        |         ╲       flat at both ends, so no kink, and monotonic
//    1x  |          ╲_______
//        +------+------+----> speed
//             SLOW   FAST
//
// The picture's own zoom counts towards the same total, so the lens magnifies by
// max(1, zoom / pictureScale): the further the picture has been pinched in, the less the
// lens adds, and once it adds nothing (mag < LENS_MAG_OFF) it goes away.
//
// Every tuning constant is in the block below; nothing else in the app has a lens number.

import type { Box, NaturalSize, Point } from "./geometry";

/* ---- tuning ---- */

/** Finger speed at or below which the lens is at full zoom: 60 px/s (a careful nudge). */
export const LENS_SLOW_SPEED = 60;
/** Finger speed at or above which there is no zoom (1x, lens hidden): 360 px/s (travelling). */
export const LENS_FAST_SPEED = 360;
/** Total magnification at or below LENS_SLOW_SPEED (lens x picture zoom). */
export const LENS_ZOOM_MAX = 5;
/**
 * Time constant of the speed filter. Distance and time are each summed with an exponential
 * decay of this constant and the speed is their ratio: the average speed over roughly the
 * last LENS_SPEED_TAU_MS, weighted by time, so events that arrive late or in a burst
 * (touch delivery is never even) do not make the zoom jitter.
 */
export const LENS_SPEED_TAU_MS = 70;
/**
 * A gap between moves longer than this counts as this long: a finger that paused and set off again is not "slow
 * for 2 s". The first move of a gesture has nothing before it (and some browsers hold the first move back until
 * the finger has left its touch slop), so it counts as this long too.
 */
export const LENS_MAX_DT_MS = 50;
/**
 * Hysteresis on the lens magnification, so it does not flicker at the threshold: it appears
 * once the magnification reaches LENS_MAG_ON and goes away only when it falls below LENS_MAG_OFF.
 */
export const LENS_MAG_ON = 1.3;
export const LENS_MAG_OFF = 1.12;
/**
 * The finger must have travelled this far from where it touched (px, well under the 16 px tap
 * slop) before the lens is allowed: a tap or a resting finger jitters less than this.
 */
export const LENS_ENGAGE_PX = 4;
/** The lens's frame (CSS px): it opens at LENS_START and eases to LENS_FULL over LENS_GROW_MS. */
export const LENS_START = 56;
export const LENS_FULL = 96;
export const LENS_GROW_MS = 160;
/** After the finger lifts the lens stays this long. */
export const LENS_LINGER_MS = 1400;

export interface LensSizeState {
    /** Smoothed finger speed, px/s. */
    readonly speed: number;
    /** Decayed sums behind `speed`: finger px and ms. */
    readonly dist: number;
    readonly time: number;
    /** When `speed` was last updated; null before the first sample of the gesture. */
    readonly speedAt: number | null;
    /** The finger has moved past LENS_ENGAGE_PX in this gesture: the lens may appear. */
    readonly engaged: boolean;
    /** When the lens started appearing, or null while hidden. */
    readonly shownAt: number | null;
}

export function createLensSize(): LensSizeState {
    return { speed: 0, dist: 0, time: 0, speedAt: null, engaged: false, shownAt: null };
}

/**
 * Total magnification for a smoothed finger speed (px/s): LENS_ZOOM_MAX at or below
 * LENS_SLOW_SPEED, 1 at or above LENS_FAST_SPEED, a smoothstep between. Monotonic
 * non-increasing and continuous.
 */
export function lensZoomForSpeed(speed: number): number {
    const f = Math.max(0, Math.min(1, (speed - LENS_SLOW_SPEED) / (LENS_FAST_SPEED - LENS_SLOW_SPEED)));
    return LENS_ZOOM_MAX - (LENS_ZOOM_MAX - 1) * (f * f * (3 - 2 * f));
}

/** Fold one finger move of `distance` px at time `now` (ms) into the smoothed speed. */
export function smoothLensSpeed(s: LensSizeState, distance: number, now: number): LensSizeState {
    // The first sample is the speed itself (nothing before it to average against); after that old data decays by real elapsed time.
    const elapsed = s.speedAt === null ? LENS_MAX_DT_MS : Math.max(1, now - s.speedAt);
    const keep = s.speedAt === null ? 0 : Math.exp(-elapsed / LENS_SPEED_TAU_MS);
    const dist = s.dist * keep + distance;
    const time = s.time * keep + Math.min(elapsed, LENS_MAX_DT_MS);
    return { ...s, dist, time, speed: (dist / time) * 1000, speedAt: now };
}

/** One finger move of `distance` px: the speed average moves and the gesture is engaged. */
export function noteLensSpeed(prev: LensSizeState, distance: number, now: number): LensSizeState {
    return { ...smoothLensSpeed(prev, distance, now), engaged: true };
}

export interface LensFrame {
    readonly state: LensSizeState;
    /** The finger has earned the lens (the context conditions in lensVisible still apply). */
    readonly visible: boolean;
    /** Whole CSS px to draw at; meaningful only when visible. */
    readonly size: number;
    /** Total magnification the speed asks for (1..LENS_ZOOM_MAX), before the picture's own zoom is taken off. */
    readonly zoom: number;
    /** What the lens itself magnifies by: max(1, zoom / scale). */
    readonly mag: number;
}

function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

/**
 * Advance one frame at picture zoom `scale`. A finger that has stopped sends no moves and
 * the speed is HELD, not decayed: a swipe that ends with the finger resting must not have
 * the lens creep in, and a nudge that ends resting keeps its zoom.
 */
export function updateLensSize(prev: LensSizeState, now: number, scale = 1): LensFrame {
    const zoom = lensZoomForSpeed(prev.speed);
    const mag = Math.max(1, zoom / scale);
    let shownAt = prev.shownAt;
    if (!prev.engaged) shownAt = null;
    else if (shownAt === null) {
        if (mag >= LENS_MAG_ON) shownAt = now;
    } else if (mag < LENS_MAG_OFF) shownAt = null;
    const state = shownAt === prev.shownAt ? prev : { ...prev, shownAt };
    if (shownAt === null) return { state, visible: false, size: 0, zoom, mag };
    const t = Math.max(0, Math.min(1, (now - shownAt) / LENS_GROW_MS));
    return { state, visible: true, size: Math.round(LENS_START + (LENS_FULL - LENS_START) * easeOutCubic(t)), zoom, mag };
}

/** Largest lens magnification reachable at a picture zoom: the lens makes up what the picture lacks. */
export function lensMag(scale: number): number {
    return Math.max(1, LENS_ZOOM_MAX / scale);
}

/** The lens can appear at all at this picture zoom (it still adds at least LENS_MAG_ON). */
export function lensReachable(scale: number): boolean {
    return lensMag(scale) >= LENS_MAG_ON;
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
    if (!lensReachable(i.scale) || i.now > i.until) return false;
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
