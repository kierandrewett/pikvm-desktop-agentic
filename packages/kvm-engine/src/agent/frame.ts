import { clientToNorm, normToClient, pictureBox, type Box, type Frac, type Point, type Size } from "../view/geometry";

/**
 * The agent's coordinate system.
 *
 * The model sees a downscaled picture of the whole screen, the REFERENCE frame, and every
 * coordinate it sends is a pixel in that picture. The target and kvmd know the NATIVE
 * resolution and the absolute-mouse range. This file is the only place the three meet, and it
 * goes through the same picture-box maths the KVM screen uses (`view/geometry`), so a click
 * the agent aims at a pixel lands where a person's finger on that pixel would.
 */

/** The long edge of a reference frame: the size vision models ground coordinates best at. */
export const DEFAULT_MAX_EDGE = 1280;

export interface Region {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export function sameSize(a: Size, b: Size): boolean {
    return a.width === b.width && a.height === b.height;
}

/** The reference frame for a native resolution: aspect kept, long edge at most `maxEdge`, never enlarged. */
export function referenceSize(native: Size, maxEdge: number = DEFAULT_MAX_EDGE): Size {
    const longEdge = Math.max(native.width, native.height);
    if (longEdge <= maxEdge) return { width: native.width, height: native.height };
    const scale = maxEdge / longEdge;
    return {
        width: Math.max(1, Math.round(native.width * scale)),
        height: Math.max(1, Math.round(native.height * scale)),
    };
}

function boxOf(size: Size): Box {
    // A frame fills its own box exactly, so the box is the frame; no letterbox exists here.
    const box = pictureBox({ left: 0, top: 0, width: size.width, height: size.height }, { w: size.width, h: size.height });
    if (!box) throw new RangeError(`a ${size.width}x${size.height} frame has no area`);
    return box;
}

/** Whether a reference pixel is inside the frame. */
export function insideFrame(size: Size, p: Point): boolean {
    return Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x < size.width && p.y < size.height;
}

/** The middle of a reference pixel as a fraction of the picture. */
export function pixelFrac(size: Size, p: Point): Frac {
    return { fx: (p.x + 0.5) / size.width, fy: (p.y + 0.5) / size.height };
}

/** A reference pixel to kvmd's absolute-mouse units. */
export function pixelToNorm(size: Size, p: Point): Point {
    const norm = clientToNorm(boxOf(size), p.x + 0.5, p.y + 0.5, true);
    if (!norm) throw new RangeError("unreachable: a clamped point is always on the picture");
    return norm;
}

/** kvmd's absolute-mouse units back to the reference pixel under them. */
export function normToPixel(size: Size, norm: Point): Point {
    const client = normToClient(boxOf(size), norm.x, norm.y);
    if (!client) throw new RangeError("unreachable: a frame always has a box");
    return {
        x: Math.max(0, Math.min(size.width - 1, Math.floor(client.x))),
        y: Math.max(0, Math.min(size.height - 1, Math.floor(client.y))),
    };
}

/**
 * A region of the reference frame as a rectangle of whole native pixels, clamped to the screen.
 * Null when it has no area inside the frame.
 */
export function regionToNative(reference: Size, native: Size, region: Region): Region | null {
    const sx = native.width / reference.width;
    const sy = native.height / reference.height;
    const left = Math.max(0, Math.min(reference.width, region.x));
    const top = Math.max(0, Math.min(reference.height, region.y));
    const right = Math.max(0, Math.min(reference.width, region.x + region.width));
    const bottom = Math.max(0, Math.min(reference.height, region.y + region.height));
    if (!(right > left) || !(bottom > top)) return null;
    const x = Math.min(native.width - 1, Math.floor(left * sx));
    const y = Math.min(native.height - 1, Math.floor(top * sy));
    const x2 = Math.max(x + 1, Math.min(native.width, Math.ceil(right * sx)));
    const y2 = Math.max(y + 1, Math.min(native.height, Math.ceil(bottom * sy)));
    return { x, y, width: x2 - x, height: y2 - y };
}
