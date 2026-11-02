// DOM adapter for the view maths: measure the pane, apply the transform, watch resizes.
// No decisions live here; they are all in the pure modules next to it.

import type { NaturalSize, Rect, Size } from "./geometry";
import { naturalSize } from "./geometry";
import type { ViewTransform } from "./transform";
import { cssTransform, cssWillChange, zoomResetVisible } from "./transform";

/** The pane's rectangle in client pixels (untransformed: the pane itself is never scaled). */
export function measurePane(pane: HTMLElement): Rect {
    const r = pane.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** Intrinsic size of whichever source is showing: a <video> or an <img>. */
export function measureNatural(el: HTMLImageElement | HTMLVideoElement): NaturalSize {
    if ("videoWidth" in el) return naturalSize(el.videoWidth, el.videoHeight);
    return naturalSize(el.naturalWidth, el.naturalHeight);
}

/**
 * Drive every picture element with the SAME transform, so zoom/pan is identical
 * whichever source is visible, and a held (frozen) frame zooms and pans with the
 * live picture instead of snapping back when it thaws.
 */
export function applyViewTransform(
    targets: readonly (HTMLElement | null | undefined)[],
    view: ViewTransform,
    zoomReset?: HTMLElement | null,
): void {
    const t = cssTransform(view);
    const wc = cssWillChange(view);
    for (const el of targets) {
        if (!el) continue;
        el.style.transform = t;
        el.style.willChange = wc;
    }
    if (zoomReset) zoomReset.hidden = !zoomResetVisible(view);
}

/** Calls back with the pane's size whenever it changes; returns the unsubscribe. */
export function observePaneSize(pane: HTMLElement, onSize: (size: Size) => void): () => void {
    if (typeof ResizeObserver === "undefined") return () => {};
    const ro = new ResizeObserver(() => onSize({ width: pane.clientWidth, height: pane.clientHeight }));
    ro.observe(pane);
    return () => ro.disconnect();
}
