// What the on-screen cursor blob and the host pointer should look like.
//
// The blob is meant to show where the TARGET's cursor is, so every situation in
// which the target is not being driven (dialog open, background window, input
// socket down, pointer off the picture) either hides it or hands the real pointer
// back. The rules were each learned from a visible bug; they live in one pure
// function so the DOM adapter only has to apply the answer.

import type { Box, Point } from "./geometry";
import { clampToBox, insideBox } from "./geometry";

export type PointerCursorStyle = "" | "default" | "not-allowed";

export type CursorPaint =
    | { readonly show: false; readonly style: PointerCursorStyle }
    | { readonly show: true; readonly style: ""; readonly x: number; readonly y: number };

export interface CursorPaintInput {
    /** A dialog owns the pointer; the blob would sit under it as a ghost. */
    readonly modalOpen: boolean;
    /** Desktop window in the background: a passing pointer must not leave a ghost cursor. */
    readonly backgrounded: boolean;
    /** The HID socket is open. Down = the blob claims a remote cursor that has stopped. */
    readonly hidOpen: boolean;
    readonly box: Box | null;
    readonly x: number;
    readonly y: number;
    readonly dragging: boolean;
}

/** Placement of the desktop mouse's blob, in client pixels (the adapter subtracts the pane origin). */
export function paintMouseCursor(i: CursorPaintInput): CursorPaint {
    if (i.modalOpen || i.backgrounded) return { show: false, style: "" };
    // Not-allowed rather than "": the pointer is over the target picture and can do
    // nothing, which is worth saying at the pointer, not only in the status chip.
    if (!i.hidOpen) return { show: false, style: "not-allowed" };
    // Off the picture and not dragging: the blob is not the pointer here, so the real
    // one comes back. Clamping instead would be its own lie: nothing was sent.
    if (!i.dragging && i.box && !insideBox(i.box, i.x, i.y)) return { show: false, style: "default" };
    // Pinned to the picture while dragging, so the blob sits where the target's
    // cursor actually is rather than following the host pointer out into the bars.
    let at: Point = { x: i.x, y: i.y };
    if (i.dragging && i.box) at = clampToBox(i.box, i.x, i.y);
    return { show: true, style: "", x: at.x, y: at.y };
}

export interface TrackpadCursorInput {
    readonly trackpadActive: boolean;
    readonly relative: boolean;
    readonly hidOpen: boolean;
    readonly modalOpen: boolean;
    /** The virtual cursor in client pixels, or null with no picture. */
    readonly at: Point | null;
}

/**
 * The trackpad's own cursor blob, drawn at once rather than waiting a video frame
 * for the target's. Only when the Pi is absolute: in relative mode the position is
 * an estimate, and the target's real pointer in the picture is the honest one.
 * `null` means "leave the blob alone" (a mouse owns it); `{show:false}` hides it.
 */
export function paintTrackpadCursor(i: TrackpadCursorInput): { readonly show: false } | { readonly show: true; readonly x: number; readonly y: number } | null {
    const at = i.trackpadActive && !i.relative && i.hidOpen && !i.modalOpen ? i.at : null;
    if (!at) return i.trackpadActive ? { show: false } : null;
    return { show: true, x: at.x, y: at.y };
}
