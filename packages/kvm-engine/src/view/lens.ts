// The trackpad magnifier: a lens showing what is under the cursor.
//
// It is deliberately plain. One fixed size and one fixed zoom (LENS_ZOOM counts the picture's own
// zoom, so the lens magnifies by max(1, LENS_ZOOM / pictureScale)), a short fade in and out and
// nothing else inside it but the magnified picture and the cursor point.
//
// It is on while ONE finger is down on the trackpad and moving slowly, and off when the finger speeds up or
// lifts. Speed decides only that: one threshold to show (LENS_SHOW_SPEED) and a higher one to hide
// (LENS_HIDE_SPEED), so a finger hovering on the threshold does not flicker. A change then waits: the finger
// must have been slow for LENS_SHOW_DELAY_MS before the lens comes up, and the hide condition must have held for
// LENS_HIDE_DELAY_MS before it goes, so a passing slow stretch or speed hiccup does not make it blink. The
// delays sit before the CSS fade. The wait needs a clock, not only moves (a finger that goes slow and stops
// sends none): settleLens(state, now) lands a change that is due and the painter calls it until none is left.
//
// It sits at a fixed offset above the cursor, clear of the finger, and goes below it only when
// there is no room above (lensPlace).
//
// Every number is in the block below; nothing else in the app has a lens number.

import type { Box, NaturalSize, Point } from "./geometry";

/* ---- tuning ---- */

/** Finger speed (px/s) under which the lens shows. */
export const LENS_SHOW_SPEED = 300;
/** Finger speed (px/s) over which it hides again. Above LENS_SHOW_SPEED: the gap is the hysteresis. */
export const LENS_HIDE_SPEED = 420;
/** Time the finger must have stayed slow before the lens comes up: a flick that slows at its end, or a slow pass inside a quick gesture, is not a look. */
export const LENS_SHOW_DELAY_MS = 180;
/** Time the hide condition (too fast, lifted, a second finger) must have held before the lens goes: rides out a speed hiccup or the finger re-landing, yet does not hang about after a lift. */
export const LENS_HIDE_DELAY_MS = 250;
/** The lens's size on screen, CSS px. */
export const LENS_SIZE = 96;
/** Total magnification, the picture's own zoom included. */
export const LENS_ZOOM = 3;
/** Under this the lens would add next to nothing (the picture alone is near LENS_ZOOM) and it stays away. */
export const LENS_MIN_MAG = 1.2;
/** The finger must have left its touch point by this much (px, well inside the 16 px tap slop): a tap's jitter is under it. */
export const LENS_ENGAGE_PX = 4;
/** Moves needed before the speed means anything: the first has nothing before it. */
export const LENS_MIN_MOVES = 2;
/** Gap between the lens's edge and the cursor, CSS px. */
export const LENS_GAP = 24;
/** Once flipped below the cursor it comes back above only when it would clear the pane's edge by this much. */
export const LENS_FLIP_BACK_PX = 40;
/**
 * Time constant of the speed filter. Distance and time are each summed with an exponential decay of this
 * constant and the speed is their ratio: the average speed over roughly the last LENS_SPEED_TAU_MS,
 * weighted by time, so events that arrive late or in a burst do not make it jitter.
 */
export const LENS_SPEED_TAU_MS = 70;
/**
 * A gap between moves longer than this counts as this long: a finger that paused and set off again is not "slow
 * for 2 s". The first move of a gesture has nothing before it (some browsers hold the first move back until the
 * finger has left its touch slop), so it counts as this long too.
 */
export const LENS_MAX_DT_MS = 50;

export interface LensSizeState {
    /** Smoothed finger speed, px/s. */
    readonly speed: number;
    /** Decayed sums behind `speed`: finger px and ms. */
    readonly dist: number;
    readonly time: number;
    /** When `speed` was last updated (the events' own clock); null before the first move of the gesture. */
    readonly speedAt: number | null;
    /** Moves seen in this gesture. */
    readonly moves: number;
    /** Exactly one finger is down. A lift or a second finger is a hide like any other: it waits out LENS_HIDE_DELAY_MS. */
    readonly fingers: boolean;
    /** What the finger asks for now: slow enough (with the hysteresis, from what is on screen) and alone. It lands in `shown` after its delay. */
    readonly want: boolean;
    /** When `want` last changed (same clock as `speedAt`): the start of the wait while `want` differs from `shown`. */
    readonly since: number | null;
    /** The lens is up (past its delay). */
    readonly shown: boolean;
}

/** A fresh touch with no lens up: nothing until the finger has moved. */
export function createLensSize(): LensSizeState {
    return { speed: 0, dist: 0, time: 0, speedAt: null, moves: 0, fingers: true, want: false, since: null, shown: false };
}

/** A new touch. A lens still up (even one on its way out) stays and the hide is cancelled; the new finger decides from its own speed. Otherwise as createLensSize. */
export function beginLensTouch(prev: LensSizeState, now: number): LensSizeState {
    const { shown } = settleLens(prev, now);
    return { ...createLensSize(), want: shown, shown };
}

/** What the finger asks for: with the lens on, anything short of LENS_HIDE_SPEED; with it off, under LENS_SHOW_SPEED. Before the speed means anything, what is on screen stays. */
function wanted(s: LensSizeState): boolean {
    if (!s.fingers) return false;
    if (s.moves < LENS_MIN_MOVES) return s.shown;
    return s.speed < (s.shown ? LENS_HIDE_SPEED : LENS_SHOW_SPEED);
}

/** `want` re-read after something it depends on changed at `now`: a change of mind restarts the wait. */
function retarget(s: LensSizeState, now: number): LensSizeState {
    const want = wanted(s);
    return settleLens(want === s.want ? s : { ...s, want, since: now }, now);
}

/**
 * Lands a change that is due: when `want` has differed from `shown` for its delay (LENS_SHOW_DELAY_MS to come up,
 * LENS_HIDE_DELAY_MS to go) at `now` (the same clock as the moves). Pure and idempotent; needs no move, so a
 * finger that goes slow and stops still gets its lens.
 */
export function settleLens(s: LensSizeState, now: number): LensSizeState {
    if (s.want === s.shown || s.since === null) return s;
    if (now - s.since < (s.want ? LENS_SHOW_DELAY_MS : LENS_HIDE_DELAY_MS)) return s;
    return { ...s, shown: s.want, since: null };
}

/** The lens is up or a change to it is waiting: the painter must keep calling settleLens. */
export function lensActive(s: LensSizeState): boolean {
    return s.shown || s.want;
}

/** Whether exactly one finger is down, as the painter sees it at `now` (the machine's own count, polled: a lift sends no move). */
export function noteLensFingers(s: LensSizeState, one: boolean, now: number): LensSizeState {
    const settled = settleLens(s, now);
    return one === settled.fingers ? settled : retarget({ ...settled, fingers: one }, now);
}

/** A hard limit (see lensVisible) holds: the lens is gone at once and nothing is waiting; slow for the show delay again brings it back. */
export function quenchLens(s: LensSizeState): LensSizeState {
    return s.shown || s.want || s.since !== null ? { ...s, shown: false, want: false, since: null } : s;
}

/**
 * One finger move of `distance` px at time `now` (ms, any clock as long as it is the same one every call).
 * Folds it into the smoothed speed and decides what the lens should be doing; the lens follows after its delay
 * (settleLens). A finger that stops sends no moves and the decision stands: a swipe that ends with the finger
 * resting never has the lens creep in, and a nudge that ends resting keeps it.
 */
export function noteLensSpeed(s0: LensSizeState, distance: number, now: number): LensSizeState {
    const s = settleLens(s0, now);
    // The first sample is the speed itself (nothing before it to average against); after that old data decays by real elapsed time.
    const elapsed = s.speedAt === null ? LENS_MAX_DT_MS : Math.max(1, now - s.speedAt);
    const keep = s.speedAt === null ? 0 : Math.exp(-elapsed / LENS_SPEED_TAU_MS);
    const dist = s.dist * keep + distance;
    const time = s.time * keep + Math.min(elapsed, LENS_MAX_DT_MS);
    return retarget({ ...s, speed: (dist / time) * 1000, dist, time, speedAt: now, moves: s.moves + 1 }, now);
}

/** What the lens magnifies by at a picture zoom: it makes up what the picture lacks. */
export function lensMag(scale: number): number {
    return Math.max(1, LENS_ZOOM / scale);
}

/** The lens can appear at all at this picture zoom. */
export function lensReachable(scale: number): boolean {
    return lensMag(scale) >= LENS_MIN_MAG;
}

export interface LensPlace {
    /** The lens's centre, client px. */
    readonly x: number;
    readonly y: number;
    /** It is below the cursor (no room above). Pass it back in next time: it is the hysteresis. */
    readonly below: boolean;
}

/**
 * Where the lens goes: LENS_GAP above the cursor, so the finger and the hand stay clear of it and the cursor
 * stays in view. Only when it would not fit above the pane does it go below (or, in a pane too short for either,
 * to whichever side has more room), and it comes back above only with LENS_FLIP_BACK_PX to spare, so it does not
 * hop at the edge. Sideways it is held inside the pane.
 */
export function lensPlace(at: Point, pane: { left: number; top: number; width: number; height: number }, below: boolean): LensPlace {
    const half = LENS_SIZE / 2;
    const offset = half + LENS_GAP;
    const need = offset + half; // room a side needs
    const spaceAbove = at.y - pane.top;
    const spaceBelow = pane.top + pane.height - at.y;
    const flipped = below
        ? !(spaceAbove >= need + LENS_FLIP_BACK_PX || spaceAbove > spaceBelow + LENS_FLIP_BACK_PX)
        : spaceAbove < need && spaceBelow > spaceAbove;
    const x = Math.max(pane.left + half, Math.min(pane.left + pane.width - half, at.x));
    return { x, y: flipped ? at.y + offset : at.y - offset, below: flipped };
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
    readonly box: Box | null;
    readonly nat: NaturalSize;
}

/**
 * The hard limits: where any fails the lens is gone this frame, with no delay. The finger's own say (its speed, a
 * lift, a second finger) is LensSizeState, and waits out its delay.
 */
export function lensVisible(i: LensVisibilityInput): boolean {
    if (!(i.trackpadActive && !i.relative && i.hidOpen && !i.modalOpen) || !i.at) return false;
    if (!lensReachable(i.scale)) return false;
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
