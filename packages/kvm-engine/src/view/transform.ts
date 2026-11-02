// Zoom/pan transform state and its maths.
//
// The picture element fills the pane (position:absolute; inset:0) and its
// transform-origin is the pane's top-left, so every number here is in
// pane-relative pixels and stays consistent across pinch, two-finger pan and
// wheel zoom. All functions are pure: they take a view and return the next one.

import type { Box, NaturalSize, Point, Rect, Size } from "./geometry";
import { normToClient, pictureBox } from "./geometry";

/** The most the picture can be zoomed in. */
export const ZMAX = 6;

export interface ViewTransform {
    readonly scale: number;
    readonly tx: number;
    readonly ty: number;
}

export const IDENTITY_VIEW: ViewTransform = { scale: 1, tx: 0, ty: 0 };

export function viewEquals(a: ViewTransform, b: ViewTransform): boolean {
    return a.scale === b.scale && a.tx === b.tx && a.ty === b.ty;
}

/**
 * Keep the PICTURE, not the element, filling the pane.
 *
 * The element is pane-sized and the picture is letterboxed inside it, so bounding
 * the element's edges still showed the letterbox bars once zoomed. This bounds the
 * picture itself: on an axis where the zoomed picture is at least as big as the
 * pane it must cover the pane edge to edge, and on an axis where it is still
 * smaller it sits centred. So zooming never shows black past the picture's edge,
 * and the cursor-follow simply stops at the edge instead of dragging background
 * into view.
 */
export function clampPan(view: ViewTransform, pane: Size, nat: NaturalSize): ViewTransform {
    if (view.scale <= 1) return view.tx === 0 && view.ty === 0 ? view : { scale: view.scale, tx: 0, ty: 0 };
    const W = pane.width;
    const H = pane.height;
    // An unmeasured pane cannot bound anything; leave the view where it is.
    if (!W || !H) return view;
    const aspect = nat.w / nat.h;
    const wide = W / H > aspect;
    const cw = wide ? H * aspect : W;
    const ch = wide ? H : W / aspect;
    const ox = (W - cw) / 2;
    const oy = (H - ch) / 2;
    const s = view.scale;
    // "+ 0" turns a negative zero (from -s * 0) into a plain one, so equality checks stay honest.
    const axis = (t: number, size: number, c: number, o: number): number => {
        if (s * c <= size) return (size - s * c) / 2 - s * o + 0;
        return Math.min(-s * o, Math.max(size - s * (o + c), t)) + 0;
    };
    const tx = axis(view.tx, W, cw, ox);
    const ty = axis(view.ty, H, ch, oy);
    return tx === view.tx && ty === view.ty ? view : { scale: s, tx, ty };
}

/** Zoom to `ns`, keeping the client point (px, py) pinned to the same content. */
export function zoomAround(view: ViewTransform, px: number, py: number, ns: number, pane: Rect, nat: NaturalSize): ViewTransform {
    const next = Math.max(1, Math.min(ZMAX, ns));
    if (next === view.scale) return view;
    const k = next / view.scale;
    const tx = px - pane.left - (px - pane.left - view.tx) * k;
    const ty = py - pane.top - (py - pane.top - view.ty) * k;
    return clampPan({ scale: next, tx, ty }, pane, nat);
}

/** Move the view by a screen delta (one-finger pan in direct mode, two-finger pan while zoomed). */
export function panBy(view: ViewTransform, dx: number, dy: number, pane: Size, nat: NaturalSize): ViewTransform {
    return clampPan({ scale: view.scale, tx: view.tx + dx, ty: view.ty + dy }, pane, nat);
}

/** Where the transformed element sits in client pixels (what getBoundingClientRect reports). */
export function viewElementRect(pane: Rect, view: ViewTransform): Rect {
    return {
        left: pane.left + view.tx,
        top: pane.top + view.ty,
        width: pane.width * view.scale,
        height: pane.height * view.scale,
    };
}

/** The picture's box in client pixels under a view, with no DOM measurement. */
export function viewPictureBox(pane: Rect, view: ViewTransform, nat: NaturalSize): Box | null {
    return pictureBox(viewElementRect(pane, view), nat);
}

/** Where a HID-unit cursor sits in client pixels under a view. */
export function cursorClient(pane: Rect, view: ViewTransform, nat: NaturalSize, nx: number, ny: number): Point | null {
    return normToClient(viewPictureBox(pane, view, nat), nx, ny);
}

/**
 * Keep the zoomed view centred on a cursor that is known (RustDesk's mouse mode).
 * The pan clamp then stops it at the picture's edge.
 */
export function followCursor(view: ViewTransform, nx: number, ny: number, pane: Rect, nat: NaturalSize): ViewTransform {
    const at = cursorClient(pane, view, nat, nx, ny);
    if (!at) return view;
    return clampPan(
        {
            scale: view.scale,
            tx: view.tx + (pane.left + pane.width / 2 - at.x),
            ty: view.ty + (pane.top + pane.height / 2 - at.y),
        },
        pane,
        nat,
    );
}

/**
 * Re-clamp after the pane itself changed size. The bound is a function of the
 * pane, so anything that resizes it (window resize, rotation, a panel dragged)
 * can strand the picture outside it while the transform stays put.
 */
export function reclampForResize(view: ViewTransform, pane: Size, nat: NaturalSize): ViewTransform {
    return clampPan(view, pane, nat);
}

/** The CSS transform for the picture elements (<img>, <video>, freeze canvas alike). */
export function cssTransform(view: ViewTransform): string {
    return `translate(${view.tx.toFixed(1)}px,${view.ty.toFixed(1)}px) scale(${view.scale.toFixed(4)})`;
}

export function cssWillChange(view: ViewTransform): "transform" | "auto" {
    return view.scale > 1 ? "transform" : "auto";
}

/** The zoom-reset button only shows while zoomed in. */
export function zoomResetVisible(view: ViewTransform): boolean {
    return view.scale > 1;
}
