// Coordinate maths between client pixels, the picture, and kvmd's HID units.
//
// Everything here is a pure function of numbers. The DOM adapter measures the
// (possibly transformed) element once and passes the rectangle in, so the cursor
// blob, the lens and the HID coordinates are all derived from the SAME box and
// cannot drift apart.

/** A rectangle in client pixels. */
export interface Rect {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

/** The picture's box in client pixels: the element minus its letterbox bars. */
export interface Box {
    readonly left: number;
    readonly top: number;
    readonly w: number;
    readonly h: number;
}

export interface Size {
    readonly width: number;
    readonly height: number;
}

/** A point as 0..1 fractions of the picture. */
export interface Frac {
    readonly fx: number;
    readonly fy: number;
}

export interface Point {
    readonly x: number;
    readonly y: number;
}

/** kvmd's absolute mouse range, and its span (the old console used 65534 for both axes). */
export const NORM_MIN = -32768;
export const NORM_MAX = 32767;
export const NORM_SPAN = 65534;

/** Intrinsic size of the picture; a 16:9 guess stands in before the first frame. */
export interface NaturalSize {
    readonly w: number;
    readonly h: number;
}

export function naturalSize(width: number | undefined, height: number | undefined): NaturalSize {
    return { w: width || 16, h: height || 9 };
}

/**
 * The picture's box inside an element rectangle, letterboxed by object-fit: contain.
 * `rect` is the element's box AFTER the zoom/pan transform (getBoundingClientRect).
 * Null when the element has no area.
 */
export function pictureBox(rect: Rect, nat: NaturalSize): Box | null {
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    const natAspect = nat.w / nat.h;
    let cw: number;
    let ch: number;
    let ox: number;
    let oy: number;
    if (rect.width / rect.height > natAspect) {
        ch = rect.height;
        cw = ch * natAspect;
        ox = (rect.width - cw) / 2;
        oy = 0;
    } else {
        cw = rect.width;
        ch = cw / natAspect;
        ox = 0;
        oy = (rect.height - ch) / 2;
    }
    return { left: rect.left + ox, top: rect.top + oy, w: cw, h: ch };
}

/**
 * Where a point sits inside a box, as 0..1 fractions.
 *
 * `clamp` is the drag case: a button is held, so a pointer that has left the
 * picture is still part of the same gesture and pins to the nearest edge. Without
 * it an outside point is not a KVM point at all and returns null.
 */
export function fracInBox(box: Box | null, x: number, y: number, clamp = false): Frac | null {
    if (!box || !(box.w > 0) || !(box.h > 0)) return null;
    const fx = (x - box.left) / box.w;
    const fy = (y - box.top) / box.h;
    if (clamp) return { fx: Math.max(0, Math.min(1, fx)), fy: Math.max(0, Math.min(1, fy)) };
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    return { fx, fy };
}

/** Fraction (0..1) within the picture to a kvmd absolute coordinate. */
export function fracToNorm(f: number): number {
    const v = Math.round(f * NORM_SPAN) - 32767;
    return Math.max(NORM_MIN, Math.min(NORM_MAX, v));
}

/** The inverse of fracToNorm, without rounding: kvmd units to a 0..1 fraction. */
export function normToFrac(n: number): number {
    return (n + 32767) / NORM_SPAN;
}

export function clampNorm(n: number): number {
    return Math.max(NORM_MIN, Math.min(NORM_MAX, n));
}

/** A client pixel to HID units, or null when it is off the picture and not clamped. */
export function clientToNorm(box: Box | null, x: number, y: number, clamp = false): Point | null {
    const f = fracInBox(box, x, y, clamp);
    if (!f) return null;
    return { x: fracToNorm(f.fx), y: fracToNorm(f.fy) };
}

/** HID units to a client pixel, or null with no picture. */
export function normToClient(box: Box | null, nx: number, ny: number): Point | null {
    if (!box) return null;
    return { x: box.left + normToFrac(nx) * box.w, y: box.top + normToFrac(ny) * box.h };
}

/** Pin a client point inside a box (the blob follows a drag to the picture's edge, not past it). */
export function clampToBox(box: Box, x: number, y: number): Point {
    return {
        x: Math.max(box.left, Math.min(box.left + box.w, x)),
        y: Math.max(box.top, Math.min(box.top + box.h, y)),
    };
}

/** True when the point is inside the picture's box (edges inclusive). */
export function insideBox(box: Box, x: number, y: number): boolean {
    return x >= box.left && x <= box.left + box.w && y >= box.top && y <= box.top + box.h;
}
