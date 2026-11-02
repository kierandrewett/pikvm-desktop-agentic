// Failure modes T1-T8: see FAILURE_MODES.md.

import { describe, expect, it } from "vitest";
import {
    IDENTITY_VIEW,
    ZMAX,
    clampPan,
    cssTransform,
    cssWillChange,
    followCursor,
    panBy,
    reclampForResize,
    viewEquals,
    zoomAround,
    zoomResetVisible,
} from "./transform";

const PANE = { left: 0, top: 0, width: 800, height: 450 };
const NAT = { w: 1600, h: 900 }; // same aspect as the pane: no bars
const SQUARE = { w: 900, h: 900 }; // letterboxed into the pane: bars left and right

describe("clampPan", () => {
    it("T1: pins a stale pan to the origin at scale <= 1", () => {
        expect(clampPan({ scale: 1, tx: -50, ty: 30 }, PANE, NAT)).toEqual({ scale: 1, tx: 0, ty: 0 });
        expect(clampPan({ scale: 0.5, tx: 9, ty: 9 }, PANE, NAT)).toEqual({ scale: 0.5, tx: 0, ty: 0 });
    });

    it("keeps a zoomed picture covering the pane edge to edge", () => {
        expect(clampPan({ scale: 2, tx: 100, ty: 40 }, PANE, NAT)).toEqual({ scale: 2, tx: 0, ty: 0 });
        expect(clampPan({ scale: 2, tx: -5000, ty: -5000 }, PANE, NAT)).toEqual({ scale: 2, tx: -800, ty: -450 });
        const inside = { scale: 2, tx: -300, ty: -200 };
        expect(clampPan(inside, PANE, NAT)).toBe(inside);
    });

    it("T2/T3: bounds the picture not the element, deciding each axis alone", () => {
        // 1.5x of a 450x450 picture: 675 wide still fits the 800 pane (centred), 675 tall covers 450.
        const free = clampPan({ scale: 1.5, tx: 0, ty: 0 }, PANE, SQUARE);
        expect(free.tx).toBeCloseTo(-200, 6); // picture's left edge at (800-675)/2 = 62.5 on screen
        expect(free.tx + 1.5 * 175).toBeCloseTo(62.5, 6);
        expect(free.ty).toBe(0);
        // Dragging the picture past its own edge on the covering axis stops at the edge, bars never revealed.
        expect(clampPan({ scale: 1.5, tx: 0, ty: -300 }, PANE, SQUARE).ty).toBe(-225);
        expect(clampPan({ scale: 1.5, tx: 0, ty: 300 }, PANE, SQUARE).ty).toBe(0);
        // The centred axis ignores whatever tx was asked for.
        expect(clampPan({ scale: 1.5, tx: 400, ty: 0 }, PANE, SQUARE).tx).toBeCloseTo(-200, 6);
    });

    it("once the letterboxed picture outgrows the pane on both axes no bar can show", () => {
        const v = clampPan({ scale: 3, tx: 500, ty: 500 }, PANE, SQUARE);
        // picture left/right edges on screen: tx + 3*175 and tx + 3*625
        expect(v.tx + 3 * 175).toBeLessThanOrEqual(0 + 1e-9);
        const v2 = clampPan({ scale: 3, tx: -9999, ty: -9999 }, PANE, SQUARE);
        expect(v2.tx + 3 * 625).toBeGreaterThanOrEqual(800 - 1e-9);
    });

    it("T5: leaves the view alone for an unmeasured pane and never makes NaN", () => {
        const v = { scale: 2, tx: -10, ty: -10 };
        expect(clampPan(v, { width: 0, height: 0 }, NAT)).toBe(v);
        expect(clampPan(v, { width: 800, height: 0 }, NAT)).toBe(v);
    });
});

describe("zoomAround", () => {
    it("T4: keeps the anchor over the same content", () => {
        const px = 300;
        const py = 120;
        const z = zoomAround(IDENTITY_VIEW, px, py, 2.5, PANE, NAT);
        expect(z.scale).toBe(2.5);
        // content under the anchor before and after
        expect((px - z.tx) / z.scale).toBeCloseTo(px, 6);
        expect((py - z.ty) / z.scale).toBeCloseTo(py, 6);
    });

    it("zooms about the centre to the expected pan", () => {
        expect(zoomAround(IDENTITY_VIEW, 400, 225, 2, PANE, NAT)).toEqual({ scale: 2, tx: -400, ty: -225 });
    });

    it("accounts for the pane's own offset on the page", () => {
        const offset = { left: 100, top: 60, width: 800, height: 450 };
        const z = zoomAround(IDENTITY_VIEW, 500, 285, 2, offset, NAT);
        expect(z).toEqual({ scale: 2, tx: -400, ty: -225 });
    });

    it("T4: clamps the scale to 1..ZMAX and a no-op returns the same object", () => {
        expect(zoomAround(IDENTITY_VIEW, 400, 225, 100, PANE, NAT).scale).toBe(ZMAX);
        expect(zoomAround({ scale: 3, tx: 0, ty: 0 }, 400, 225, 0.1, PANE, NAT)).toEqual(IDENTITY_VIEW);
        expect(zoomAround(IDENTITY_VIEW, 1, 1, 1, PANE, NAT)).toBe(IDENTITY_VIEW);
        const atMax = { scale: ZMAX, tx: -100, ty: -100 };
        expect(zoomAround(atMax, 1, 1, 50, PANE, NAT)).toBe(atMax);
    });

    it("zooming back out to 1 recentres", () => {
        const z = zoomAround({ scale: 3, tx: -700, ty: -300 }, 400, 225, 1, PANE, NAT);
        expect(z).toEqual(IDENTITY_VIEW);
    });
});

describe("panBy / resize", () => {
    it("panBy moves and clamps", () => {
        const v = { scale: 2, tx: -400, ty: -225 };
        expect(panBy(v, 50, -30, PANE, NAT)).toEqual({ scale: 2, tx: -350, ty: -255 });
        expect(panBy(v, 9000, 9000, PANE, NAT)).toEqual({ scale: 2, tx: 0, ty: 0 });
    });

    it("T6: re-clamps a view panned into a corner when the pane narrows", () => {
        const scale = 3.13;
        const corner = { scale, tx: 800 - scale * 800, ty: 450 - scale * 450 };
        expect(clampPan(corner, PANE, NAT)).toBe(corner); // legal in the big pane
        const small = { width: 400, height: 225 };
        const fixed = reclampForResize(corner, small, NAT);
        expect(fixed).not.toBe(corner);
        // The picture covers the whole small pane again.
        expect(fixed.tx).toBeLessThanOrEqual(0);
        expect(fixed.tx + scale * 400).toBeGreaterThanOrEqual(400 - 1e-9);
        expect(fixed.ty).toBeLessThanOrEqual(0);
        expect(fixed.ty + scale * 225).toBeGreaterThanOrEqual(225 - 1e-9);
    });
});

describe("followCursor", () => {
    it("T7: centres the cursor in the pane", () => {
        const v = { scale: 2, tx: 0, ty: 0 };
        // HID (0,0) is the picture's centre: client (800, 450) under 2x.
        expect(followCursor(v, 0, 0, PANE, NAT)).toEqual({ scale: 2, tx: -400, ty: -225 });
    });

    it("T7: stops at the picture's edge rather than showing background", () => {
        const v = { scale: 2, tx: -400, ty: -225 };
        const f = followCursor(v, -32768, -32768, PANE, NAT);
        expect(f).toEqual({ scale: 2, tx: 0, ty: 0 });
        const g = followCursor(v, 32767, 32767, PANE, NAT);
        expect(g).toEqual({ scale: 2, tx: -800, ty: -450 });
    });

    it("does nothing with no picture", () => {
        const v = { scale: 2, tx: -10, ty: -10 };
        expect(followCursor(v, 0, 0, { left: 0, top: 0, width: 0, height: 0 }, NAT)).toBe(v);
    });
});

describe("css", () => {
    it("T8: formats one transform string for every picture element", () => {
        expect(cssTransform({ scale: 2, tx: -400, ty: -225.04 })).toBe("translate(-400.0px,-225.0px) scale(2.0000)");
        expect(cssWillChange(IDENTITY_VIEW)).toBe("auto");
        expect(cssWillChange({ scale: 1.01, tx: 0, ty: 0 })).toBe("transform");
        expect(zoomResetVisible(IDENTITY_VIEW)).toBe(false);
        expect(zoomResetVisible({ scale: 2, tx: 0, ty: 0 })).toBe(true);
        expect(viewEquals(IDENTITY_VIEW, { scale: 1, tx: 0, ty: 0 })).toBe(true);
    });
});
