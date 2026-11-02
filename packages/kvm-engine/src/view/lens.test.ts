// Failure modes L1-L8: see FAILURE_MODES.md.

import { describe, expect, it } from "vitest";
import {
    LENS_MAX,
    LENS_MIN,
    LENS_SETTLE_MS,
    createLensSize,
    lensMag,
    lensSizeForSpeed,
    lensSource,
    lensVisible,
    noteLensSpeed,
    smoothLensSpeed,
    updateLensSize,
} from "./lens";
import type { LensSizeState, LensVisibilityInput } from "./lens";

/** One frame at `now` with the finger "still moving" (speed fresh), so decay does not interfere. */
function frame(s: LensSizeState, now: number): { state: LensSizeState; size: number } {
    return updateLensSize({ ...s, speedAt: now }, now);
}

describe("speed average", () => {
    it("L1: the first sample assumes one 16 ms frame", () => {
        const s = noteLensSpeed(createLensSize(), 16, 1000);
        // sample = 16/16 = 1 px/ms; a = 1 - exp(-16/140)
        expect(s.speed).toBeCloseTo(1 - Math.exp(-16 / 140), 9);
        expect(s.speedAt).toBe(1000);
    });

    it("L1: two samples at the same instant use dt = 1, not 0", () => {
        const a = noteLensSpeed(createLensSize(), 16, 1000);
        const b = noteLensSpeed(a, 5, 1000);
        expect(Number.isFinite(b.speed)).toBe(true);
        expect(b.speed).toBeCloseTo(a.speed + (5 / 1 - a.speed) * (1 - Math.exp(-1 / 140)), 9);
    });

    it("L2: decays by itself when the finger stops sending moves", () => {
        const fast: LensSizeState = { ...createLensSize(), speed: 2, speedAt: 1000 };
        expect(updateLensSize(fast, 1030).state.speed).toBe(2); // within 60 ms: still moving
        const later = updateLensSize(fast, 2000).state;
        expect(later.speed).toBeLessThan(0.01);
        expect(smoothLensSpeed(fast, null, 1140).speed).toBeCloseTo(2 * Math.exp(-1), 9);
    });
});

describe("size", () => {
    it("L3: runs from largest when slow to smallest when fast, monotonically and inside the range", () => {
        expect(lensSizeForSpeed(0)).toBe(LENS_MAX);
        expect(lensSizeForSpeed(0.12)).toBe(LENS_MAX);
        expect(lensSizeForSpeed(1.4)).toBe(LENS_MIN);
        expect(lensSizeForSpeed(9)).toBe(LENS_MIN);
        expect(lensSizeForSpeed(0.76)).toBe(116);
        let prev = Infinity;
        for (let v = 0; v < 3; v += 0.01) {
            const size = lensSizeForSpeed(v);
            expect(size).toBeLessThanOrEqual(prev);
            expect(size).toBeGreaterThanOrEqual(LENS_MIN);
            expect(size).toBeLessThanOrEqual(LENS_MAX);
            prev = size;
        }
    });

    it("L4: a new size is only taken after it has held for the settle time", () => {
        let s: LensSizeState = { ...createLensSize(), speed: 0.12 }; // wants 168, holds 104
        let r = frame(s, 1000);
        expect(r.state.pending).toEqual({ size: 168, since: 1000 });
        expect(r.state.target).toBe(104);
        r = frame(r.state, 1100);
        expect(r.state.target).toBe(104);
        r = frame(r.state, 1000 + LENS_SETTLE_MS);
        expect(r.state.target).toBe(168);
        expect(r.state.pending).toBeNull();
        // Eased, not jumped: 104 + 64 * 0.2
        expect(r.state.shown).toBeCloseTo(116.8, 9);
        expect(r.size).toBe(117);
        s = r.state;
    });

    it("L4: a candidate that changes restarts the wait", () => {
        let r = frame({ ...createLensSize(), speed: 0.12 }, 1000); // pending 168
        r = frame({ ...r.state, speed: 1.4 }, 1100); // now wants 64: replaces it
        expect(r.state.pending).toEqual({ size: 64, since: 1100 });
        r = frame(r.state, 1100 + LENS_SETTLE_MS - 1);
        expect(r.state.target).toBe(104);
        r = frame(r.state, 1100 + LENS_SETTLE_MS);
        expect(r.state.target).toBe(64);
    });

    it("L4: a change smaller than the step is ignored and clears any pending candidate", () => {
        let r = frame({ ...createLensSize(), speed: 0.12 }, 1000);
        expect(r.state.pending).not.toBeNull();
        // Speed whose size is within 18 px of the target (104): ~110
        const speed = 0.12 + ((168 - 110) / (168 - 64)) * (1.4 - 0.12);
        expect(lensSizeForSpeed(speed)).toBe(110);
        r = frame({ ...r.state, speed }, 1050);
        expect(r.state.pending).toBeNull();
        r = frame(r.state, 5000);
        expect(r.state.target).toBe(104);
    });

    it("L5: easing converges on the target, never overshoots, and snaps within half a pixel", () => {
        let s: LensSizeState = { ...createLensSize(), target: 168, shown: 104 };
        let last = 104;
        for (let i = 0; i < 60; i++) {
            const r = updateLensSize({ ...s, speed: 0.12, speedAt: 1000 + i }, 1000 + i);
            s = r.state;
            expect(s.shown).toBeGreaterThanOrEqual(last);
            expect(s.shown).toBeLessThanOrEqual(168);
            last = s.shown;
        }
        expect(s.shown).toBe(168);
    });
});

describe("magnification and visibility", () => {
    it("L6: makes up for what the picture zoom lacks, never below 1", () => {
        expect(lensMag(1)).toBe(4);
        expect(lensMag(2)).toBe(2);
        expect(lensMag(4)).toBe(1);
        expect(lensMag(6)).toBe(1);
    });

    const base: LensVisibilityInput = {
        trackpadActive: true,
        relative: false,
        hidOpen: true,
        modalOpen: false,
        at: { x: 100, y: 100 },
        scale: 1,
        now: 1000,
        until: 2000,
        box: { left: 0, top: 0, w: 800, h: 450 },
        nat: { w: 1600, h: 900 },
    };

    it("L6/L7: shows only where every condition holds", () => {
        expect(lensVisible(base)).toBe(true);
        const cases: [string, Partial<LensVisibilityInput>][] = [
            ["not a trackpad", { trackpadActive: false }],
            ["relative mouse: cursor is a guess", { relative: true }],
            ["socket down", { hidOpen: false }],
            ["dialog open", { modalOpen: true }],
            ["no cursor position", { at: null }],
            ["no picture", { box: null }],
            ["no real frame yet", { nat: { w: 16, h: 9 } }],
            ["linger expired", { now: 2001 }],
            ["zoomed past the lens's usefulness (mag 1.18)", { scale: 3.4 }],
        ];
        for (const [name, patch] of cases) expect(lensVisible({ ...base, ...patch }), name).toBe(false);
        expect(lensVisible({ ...base, scale: 3.3 })).toBe(true); // mag 1.21
        expect(lensVisible({ ...base, now: 2000 })).toBe(true); // linger is inclusive
    });
});

describe("lensSource", () => {
    const box = { left: 0, top: 0, w: 800, h: 450 };
    const nat = { w: 1600, h: 900 };

    it("samples the same magnification at any lens size", () => {
        const small = lensSource(100, 100, 2, box, nat, { x: 400, y: 225 });
        const big = lensSource(200, 200, 2, box, nat, { x: 400, y: 225 });
        expect(small.sw).toBe(100); // (100/2) * 2 stream px per client px
        expect(big.sw).toBe(200);
        expect(small.sx).toBe(750);
        expect(big.sx).toBe(700);
        expect(small.dw / small.sw).toBeCloseTo(big.dw / big.sw, 9);
        expect(small.smoothing).toBe(true);
        expect(lensSource(100, 100, 3, box, nat, { x: 400, y: 225 }).smoothing).toBe(false);
    });

    it("L8: clips to the picture at an edge and offsets the draw", () => {
        const s = lensSource(100, 200, 2, box, nat, { x: 0, y: 225 });
        // side = 100 stream px, centred on x=0: left half is outside the picture
        expect(s.sx).toBe(0);
        expect(s.sw).toBe(50);
        expect(s.dx).toBe(100); // half of the 200 px canvas stays black
        expect(s.dw).toBe(100);
        expect(s.visible).toBe(true);
    });

    it("L8: draws nothing when wholly outside the picture", () => {
        expect(lensSource(100, 200, 2, box, nat, { x: -500, y: -500 }).visible).toBe(false);
        expect(lensSource(100, 200, 2, box, nat, { x: 5000, y: 225 }).visible).toBe(false);
    });
});
