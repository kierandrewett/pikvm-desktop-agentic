// Failure modes L1-L12: see FAILURE_MODES.md.
//
// Fingers are simulated on a plain time axis: `move` feeds one touch move of `px` pixels
// at time `t` into the model, `frame` runs the per-frame update. No real timers.

import { describe, expect, it } from "vitest";
import {
    LENS_DWELL_MS,
    LENS_FINE_PATH_MAX,
    LENS_FULL,
    LENS_GROW_MS,
    LENS_START,
    beginLensGesture,
    createLensSize,
    lensMag,
    lensSource,
    lensVisible,
    noteLensSpeed,
    smoothLensSpeed,
    updateLensSize,
} from "./lens";
import type { LensFrame, LensSizeState, LensVisibilityInput } from "./lens";

/** A finger over a timeline. */
class Finger {
    state: LensSizeState = createLensSize();
    t = 1000;
    last: LensFrame = { state: this.state, visible: false, size: 0 };

    /** Move `px` pixels every `everyMs` for `forMs`, running a frame after each move. */
    drag(px: number, everyMs: number, forMs: number): void {
        for (let spent = 0; spent < forMs; spent += everyMs) {
            this.t += everyMs;
            this.state = noteLensSpeed(this.state, px, this.t);
            this.frame();
        }
    }

    /** Frames with no movement (the finger rests or has lifted). */
    wait(ms: number): void {
        for (let spent = 0; spent < ms; spent += 16) {
            this.t += 16;
            this.frame();
        }
    }

    frame(): void {
        this.last = updateLensSize(this.state, this.t);
        this.state = this.last.state;
    }

    get visible(): boolean {
        return this.last.visible;
    }
    get size(): number {
        return this.last.size;
    }
}

/** Fine adjustment: 1 px every 16 ms = 0.06 px/ms, well under the fine speed. */
const FINE = [1, 16] as const;
/** A fast swipe: 20 px every 16 ms = 1.25 px/ms. */
const FAST = [20, 16] as const;

describe("speed average", () => {
    it("L1: the first sample assumes one 16 ms frame", () => {
        const s = smoothLensSpeed(createLensSize(), 16, 1000);
        expect(s.speed).toBeCloseTo(1 - Math.exp(-16 / 140), 9);
        expect(s.speedAt).toBe(1000);
    });

    it("L1: two samples at the same instant use dt = 1, not 0", () => {
        const a = smoothLensSpeed(createLensSize(), 16, 1000);
        const b = smoothLensSpeed(a, 5, 1000);
        expect(Number.isFinite(b.speed)).toBe(true);
        expect(b.speed).toBeCloseTo(a.speed + (5 - a.speed) * (1 - Math.exp(-1 / 140)), 9);
    });

    it("L2: decays by itself when the finger stops sending moves", () => {
        const fast: LensSizeState = { ...createLensSize(), speed: 2, speedAt: 1000 };
        expect(updateLensSize(fast, 1030).state.speed).toBe(2);
        expect(updateLensSize(fast, 2000).state.speed).toBeLessThan(0.01);
        expect(smoothLensSpeed(fast, null, 1140).speed).toBeCloseTo(2 * Math.exp(-1), 9);
    });
});

describe("when it appears", () => {
    it("L3: a fast swipe never shows it, however long it goes on", () => {
        const f = new Finger();
        f.drag(...FAST, 10000);
        expect(f.visible).toBe(false);
    });

    it("L3: a single flick event is fast even though the average has not caught up", () => {
        const f = new Finger();
        f.drag(...FINE, 800);
        f.t += 16;
        f.state = noteLensSpeed(f.state, 40, f.t); // 2.5 px/ms in one event
        expect(f.state.fineSince).toBeNull();
        f.frame();
        expect(f.visible).toBe(false);
    });

    it("L4: before the second is up it is hidden, and it appears once a full second of fine moves has passed", () => {
        const f = new Finger();
        f.drag(...FINE, LENS_DWELL_MS - 100);
        expect(f.visible).toBe(false);
        f.drag(...FINE, 200);
        expect(f.visible).toBe(true);
        expect(f.size).toBeGreaterThanOrEqual(LENS_START);
        expect(f.size).toBeLessThan(LENS_FULL);
    });

    it("L6: starts small and grows smoothly to the full size, never past it", () => {
        const f = new Finger();
        f.drag(...FINE, LENS_DWELL_MS + 16);
        expect(f.visible).toBe(true);
        const sizes: number[] = [f.size];
        for (let i = 0; i < 60; i++) {
            f.drag(...FINE, 16);
            sizes.push(f.size);
        }
        expect(sizes[0]).toBeLessThanOrEqual(LENS_START + 4);
        for (let i = 1; i < sizes.length; i++) {
            expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1] as number); // never shrinks
            expect(Math.abs((sizes[i] as number) - (sizes[i - 1] as number))).toBeLessThan(LENS_FULL - LENS_START); // never jumps
            expect(sizes[i]).toBeLessThanOrEqual(LENS_FULL);
        }
        expect(sizes.at(-1)).toBe(LENS_FULL);
        // full size is smaller than the old 168
        expect(LENS_FULL).toBeLessThan(168);
        // and the growth takes about LENS_GROW_MS
        const grown = new Finger();
        grown.drag(...FINE, LENS_DWELL_MS + 16);
        grown.drag(...FINE, LENS_GROW_MS / 2);
        expect(grown.size).toBeGreaterThan(LENS_START);
        expect(grown.size).toBeLessThan(LENS_FULL);
    });

    it("L5: a fast flick part-way hides it and restarts the second from scratch", () => {
        const f = new Finger();
        f.drag(...FINE, 700);
        f.drag(...FAST, 64);
        expect(f.visible).toBe(false);
        expect(f.state.fineSince).toBeNull();
        // 900 ms of fine movement after the flick is not enough: the clock started over
        f.drag(...FINE, 900);
        expect(f.visible).toBe(false);
        // (the speed average also needs ~250 ms to settle back under the fine speed first)
        f.drag(...FINE, 600);
        expect(f.visible).toBe(true);
    });

    it("L5: a fast move after it has appeared hides it at once, and growth restarts when it returns", () => {
        const f = new Finger();
        f.drag(...FINE, 1600);
        expect(f.size).toBe(LENS_FULL);
        f.drag(...FAST, 48);
        expect(f.visible).toBe(false);
        f.drag(...FINE, 1000);
        expect(f.visible).toBe(false);
        f.drag(...FINE, 160);
        expect(f.visible).toBe(true);
        expect(f.size).toBeLessThan(LENS_FULL);
    });

    it("L5: in-between speeds restart the wait before it appears but do not flicker it out once up", () => {
        const mid = [5, 16] as const; // 0.31 px/ms: not fine, not fast
        const before = new Finger();
        before.drag(...FINE, 800);
        before.drag(...mid, 400); // the average climbs past the fine speed
        expect(before.state.fineSince).toBeNull();
        before.drag(...FINE, 300);
        expect(before.visible).toBe(false);

        const after = new Finger();
        after.drag(...FINE, 1200);
        expect(after.visible).toBe(true);
        after.drag(...mid, 600);
        expect(after.visible).toBe(true);
    });

    it("L4: a slow glide across the screen is travelling, not adjusting", () => {
        const f = new Finger();
        // 0.2 px/ms is under the fine speed, but 3.2 px per 16 ms for 2 s is 400 px of path
        f.drag(3.2, 16, 2000);
        expect(f.visible).toBe(false);
        expect(LENS_FINE_PATH_MAX).toBeLessThan(400);
    });

    it("L7: a pause before it has appeared breaks the run; a rest or a tap never shows it", () => {
        const f = new Finger();
        f.drag(...FINE, 600);
        f.wait(500); // the finger stopped adjusting
        f.drag(...FINE, 500);
        expect(f.visible).toBe(false);

        const rest = new Finger();
        rest.wait(5000); // finger down, never moved
        expect(rest.visible).toBe(false);
        const tap = new Finger();
        tap.drag(...FINE, 32);
        tap.wait(2000);
        expect(tap.visible).toBe(false);
    });

    it("L8: a new touch starts from nothing", () => {
        const f = new Finger();
        f.drag(...FINE, 1600);
        expect(f.visible).toBe(true);
        f.state = beginLensGesture(f.state);
        f.frame();
        expect(f.visible).toBe(false);
        f.drag(...FINE, 900);
        expect(f.visible).toBe(false);
    });
});

describe("lift and linger", () => {
    const ctx: LensVisibilityInput = {
        trackpadActive: true,
        relative: false,
        hidOpen: true,
        modalOpen: false,
        at: { x: 100, y: 100 },
        scale: 1,
        now: 0,
        until: 0,
        box: { left: 0, top: 0, w: 800, h: 450 },
        nat: { w: 1600, h: 900 },
    };

    it("L9: after the lift it stays for the linger time, then hides", () => {
        const f = new Finger();
        f.drag(...FINE, 1600);
        expect(f.visible).toBe(true);
        const liftedAt = f.t;
        const until = liftedAt + 1400; // the painter's linger deadline from the last touch
        const shownAt = (ms: number) => {
            f.t = liftedAt + ms;
            f.frame();
            return f.visible && lensVisible({ ...ctx, now: f.t, until });
        };
        expect(shownAt(16)).toBe(true);
        expect(shownAt(1000)).toBe(true);
        expect(shownAt(1400)).toBe(true);
        expect(shownAt(1401)).toBe(false);
    });

    it("L9: fast movement during the linger hides it immediately", () => {
        const f = new Finger();
        f.drag(...FINE, 1600);
        f.wait(300);
        f.drag(...FAST, 48);
        expect(f.visible).toBe(false);
    });
});

describe("magnification and visibility", () => {
    it("L6: makes up for what the picture zoom lacks, never below 1", () => {
        expect(lensMag(1)).toBe(5);
        expect(lensMag(2)).toBe(2.5);
        expect(lensMag(5)).toBe(1);
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
            ["zoomed past the lens's usefulness (mag 1.19)", { scale: 4.2 }],
        ];
        for (const [name, patch] of cases) expect(lensVisible({ ...base, ...patch }), name).toBe(false);
        expect(lensVisible({ ...base, scale: 4.1 })).toBe(true); // mag 1.22
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
