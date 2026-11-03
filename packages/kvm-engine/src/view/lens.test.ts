// Failure modes L1-L15: see FAILURE_MODES.md.
//
// Fingers are simulated on a plain time axis: `drag` feeds touch moves of `px` pixels
// every `everyMs` into the model and runs the per-frame update after each. No real timers.

import { describe, expect, it } from "vitest";
import {
    LENS_ENGAGE_PX,
    LENS_FAST_SPEED,
    LENS_FULL,
    LENS_GROW_MS,
    LENS_MAG_OFF,
    LENS_MAG_ON,
    LENS_MAX_DT_MS,
    LENS_SLOW_SPEED,
    LENS_SPEED_TAU_MS,
    LENS_START,
    LENS_ZOOM_MAX,
    createLensSize,
    lensMag,
    lensReachable,
    lensSource,
    lensVisible,
    lensZoomForSpeed,
    noteLensSpeed,
    smoothLensSpeed,
    updateLensSize,
} from "./lens";
import type { LensFrame, LensSizeState, LensVisibilityInput } from "./lens";

/** A finger over a timeline, at a picture zoom. */
class Finger {
    state: LensSizeState = createLensSize();
    t = 1000;
    scale = 1;
    last: LensFrame = updateLensSize(this.state, this.t);
    /** Every frame's total zoom and visibility, in order. */
    readonly zooms: number[] = [];
    readonly shown: boolean[] = [];

    /** Move `px` pixels every `everyMs` for `forMs`, running a frame after each move. */
    drag(px: number, everyMs: number, forMs: number): void {
        for (let spent = 0; spent < forMs; spent += everyMs) {
            this.t += everyMs;
            this.state = noteLensSpeed(this.state, px, this.t);
            this.frame();
        }
    }

    /** Frames with no movement (the finger rests). */
    wait(ms: number): void {
        for (let spent = 0; spent < ms; spent += 16) {
            this.t += 16;
            this.frame();
        }
    }

    frame(): void {
        this.last = updateLensSize(this.state, this.t, this.scale);
        this.state = this.last.state;
        this.zooms.push(this.last.zoom);
        this.shown.push(this.last.visible);
    }

    get visible(): boolean {
        return this.last.visible;
    }
    get size(): number {
        return this.last.size;
    }
}

/** 0.5 px every 16 ms = 31 px/s: under the slow speed. */
const SLOW = [0.5, 16] as const;
/** 3 px every 16 ms = 188 px/s: between slow and fast. */
const MID = [3, 16] as const;
/** A fast swipe: 20 px every 16 ms = 1250 px/s. */
const FAST = [20, 16] as const;

/** The speed at which the lens magnification (scale 1) is exactly `mag`, by bisection on the curve. */
function speedForMag(mag: number): number {
    let lo = LENS_SLOW_SPEED;
    let hi = LENS_FAST_SPEED;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (lensZoomForSpeed(mid) > mag) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

describe("speed to zoom curve", () => {
    it("L1: full zoom at or under the slow speed, none at or over the fast speed", () => {
        expect(LENS_SLOW_SPEED).toBeLessThan(LENS_FAST_SPEED);
        for (const s of [0, 1, LENS_SLOW_SPEED]) expect(lensZoomForSpeed(s)).toBe(LENS_ZOOM_MAX);
        for (const s of [LENS_FAST_SPEED, LENS_FAST_SPEED + 1, 5000, 1e9]) expect(lensZoomForSpeed(s)).toBe(1);
    });

    it("L1: monotonic (never zooms in as the finger speeds up) and always within 1..max", () => {
        let prev = Infinity;
        for (let s = 0; s <= 1000; s += 0.5) {
            const z = lensZoomForSpeed(s);
            expect(z).toBeLessThanOrEqual(prev);
            expect(z).toBeGreaterThanOrEqual(1);
            expect(z).toBeLessThanOrEqual(LENS_ZOOM_MAX);
            prev = z;
        }
    });

    it("L2: continuous, with no step anywhere along it", () => {
        let prev = lensZoomForSpeed(0);
        let biggest = 0;
        for (let s = 0.5; s <= 1000; s += 0.5) {
            const z = lensZoomForSpeed(s);
            biggest = Math.max(biggest, Math.abs(z - prev));
            prev = z;
        }
        // 0.5 px/s of speed moves the zoom by well under 0.02 even at the steepest point
        expect(biggest).toBeLessThan(0.02);
        // and the middle of the range is the middle of the zoom
        expect(lensZoomForSpeed((LENS_SLOW_SPEED + LENS_FAST_SPEED) / 2)).toBeCloseTo((1 + LENS_ZOOM_MAX) / 2, 9);
    });
});

describe("speed average", () => {
    it("L3: the first sample is the speed (no averaging against the 0 of no data), over the longest gap a move may count as", () => {
        const s = smoothLensSpeed(createLensSize(), 8, 1000);
        expect(s.speed).toBeCloseTo((8 / LENS_MAX_DT_MS) * 1000, 9);
        expect(s.speedAt).toBe(1000);
    });

    it("L3: events at the same instant are finite and add no spike", () => {
        const a = smoothLensSpeed(createLensSize(), 0.5, 1000);
        const b = smoothLensSpeed(a, 0.5, 1000);
        expect(Number.isFinite(b.speed)).toBe(true);
        expect(b.speed).toBeLessThan(2 * a.speed + 1);
    });

    it("L3: a steady speed reads as itself however unevenly the events arrive", () => {
        // 200 px/s with the events 3-30 ms apart in a repeating, lumpy pattern
        let s = createLensSize();
        let t = 1000;
        const gaps = [3, 30, 5, 22, 16, 8, 27, 16];
        for (let i = 0; i < 80; i++) {
            const gap = gaps[i % gaps.length] as number;
            t += gap;
            s = noteLensSpeed(s, (200 * gap) / 1000, t);
            if (i > 10) expect(s.speed).toBeGreaterThan(165);
            if (i > 10) expect(s.speed).toBeLessThan(235);
        }
    });

    it("L3: follows a change of speed within the time constant, in both directions alike", () => {
        const settle = (from: number, to: number) => {
            const f = new Finger();
            f.drag((from * 16) / 1000, 16, 1000);
            const before = f.state.speed;
            f.drag((to * 16) / 1000, 16, LENS_SPEED_TAU_MS);
            const afterOneTau = f.state.speed;
            f.drag((to * 16) / 1000, 16, 4 * LENS_SPEED_TAU_MS);
            return { before, afterOneTau, settled: f.state.speed };
        };
        for (const [from, to] of [[40, 600], [600, 40]] as const) {
            const r = settle(from, to);
            expect(r.before).toBeCloseTo(from, 0);
            expect(Math.abs(r.afterOneTau - to)).toBeLessThan(0.5 * Math.abs(from - to)); // more than halfway in one time constant
            expect(r.settled).toBeCloseTo(to, -1); // and there within a few percent
        }
    });

    it("L3: a finger that paused and sets off again is not averaged against the pause", () => {
        const f = new Finger();
        f.drag(...SLOW, 800);
        f.t += 2500; // a long rest with no moves
        f.drag(20, 16, 48); // then three fast events
        expect(f.state.speed).toBeGreaterThan(LENS_FAST_SPEED);
    });

    it("L4: a finger that stops sending moves holds its speed: a swipe's rest never lets the lens creep in", () => {
        const f = new Finger();
        f.drag(...FAST, 400);
        const held = f.state.speed;
        f.wait(5000);
        expect(f.state.speed).toBe(held);
        expect(f.visible).toBe(false);
        expect(Math.max(...f.zooms)).toBeLessThan(1.0001);
    });
});

describe("when it appears", () => {
    it("L5: nothing before the finger has moved: a resting finger or a tap never shows it", () => {
        const f = new Finger();
        f.wait(5000);
        expect(f.visible).toBe(false);
        expect(f.zooms.every((z) => z === LENS_ZOOM_MAX)).toBe(true); // the speed is 0: max zoom, but not engaged
        expect(f.shown.some(Boolean)).toBe(false);
        expect(LENS_ENGAGE_PX).toBeGreaterThan(0);
        expect(LENS_ENGAGE_PX).toBeLessThan(16); // well inside the tap slop, so a tap's jitter is under it
    });

    it("L6: no wait: a slow move shows it on the very first frame, at the full zoom", () => {
        const f = new Finger();
        f.drag(...SLOW, 16);
        expect(f.shown).toEqual([true]);
        expect(f.last.zoom).toBe(LENS_ZOOM_MAX);
        expect(f.last.mag).toBe(LENS_ZOOM_MAX);
        expect(f.size).toBe(LENS_START);
    });

    it("L6: a medium move shows it too, at a zoom in between (it is not on/off)", () => {
        const f = new Finger();
        f.drag(...MID, 400);
        expect(f.visible).toBe(true);
        expect(f.last.zoom).toBeGreaterThan(1.5);
        expect(f.last.zoom).toBeLessThan(LENS_ZOOM_MAX - 0.5);
    });

    it("L7: fast movement never shows it, from the first event, however long it goes on", () => {
        const f = new Finger();
        f.drag(...FAST, 10000);
        expect(f.shown.some(Boolean)).toBe(false);
        expect(f.zooms.every((z) => z < LENS_MAG_ON)).toBe(true);
        // a single flick event is enough to be past the fast speed even from a standing start
        const flick = new Finger();
        flick.drag(40, 16, 16);
        expect(flick.shown).toEqual([false]);
    });

    it("L8: the zoom follows the finger continuously: slowing down zooms in, speeding up zooms out, no jump in a frame", () => {
        const f = new Finger();
        f.drag(...FAST, 160);
        f.drag(...SLOW, 1200); // slow right down
        const down = f.zooms.slice(10);
        for (let i = 1; i < down.length; i++) {
            expect(down[i]).toBeGreaterThanOrEqual(down[i - 1] as number);
            expect(Math.abs((down[i] as number) - (down[i - 1] as number))).toBeLessThan(1.2);
        }
        expect(f.last.zoom).toBeGreaterThan(LENS_ZOOM_MAX - 0.3);
        const n = f.zooms.length;
        f.drag(...FAST, 400); // and out again
        const up = f.zooms.slice(n);
        for (let i = 1; i < up.length; i++) expect(up[i]).toBeLessThanOrEqual(up[i - 1] as number);
        expect(f.visible).toBe(false);
    });

    it("L8: a fast move after it has appeared hides it within a few frames, and slowing again brings it straight back", () => {
        const f = new Finger();
        f.drag(...SLOW, 400);
        expect(f.visible).toBe(true);
        f.drag(...FAST, 64);
        expect(f.visible).toBe(false);
        f.drag(...SLOW, 800);
        expect(f.visible).toBe(true);
    });

    it("L9: starts small and eases to full size within the grow time, never past it, never shrinking", () => {
        const f = new Finger();
        f.drag(...SLOW, 16);
        const sizes: number[] = [f.size];
        for (let i = 0; i < 40; i++) {
            f.drag(...SLOW, 16);
            sizes.push(f.size);
        }
        expect(sizes[0]).toBe(LENS_START);
        for (let i = 1; i < sizes.length; i++) {
            expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1] as number);
            expect(sizes[i]).toBeLessThanOrEqual(LENS_FULL);
        }
        expect(sizes.at(-1)).toBe(LENS_FULL);
        expect(LENS_GROW_MS).toBeLessThanOrEqual(200); // no perceptible wait
        const half = new Finger();
        half.drag(...SLOW, 16 + LENS_GROW_MS / 2);
        expect(half.size).toBeGreaterThan(LENS_START);
        expect(half.size).toBeLessThan(LENS_FULL);
    });

    it("L10: a slow nudge that ends with the finger resting keeps its zoom", () => {
        const f = new Finger();
        f.drag(...MID, 800);
        const z = f.last.zoom;
        f.wait(1000);
        expect(f.last.zoom).toBe(z);
        expect(f.visible).toBe(true);
    });

    it("L11: a new touch starts from nothing: the last gesture's lens and speed are dropped", () => {
        const f = new Finger();
        f.drag(...SLOW, 800);
        expect(f.visible).toBe(true);
        f.state = createLensSize();
        f.frame();
        expect(f.visible).toBe(false);
        f.drag(...FAST, 160); // and a first fast move is not averaged against the old slow speed
        expect(f.shown.slice(-10).some(Boolean)).toBe(false);
    });
});

describe("hysteresis", () => {
    const on = speedForMag(LENS_MAG_ON);
    const off = speedForMag(LENS_MAG_OFF);
    const at = (speed: number, shownAt: number | null): LensSizeState => ({ speed, dist: 0, time: 0, speedAt: 1000, engaged: true, shownAt });

    it("L12: the band is real: the speed that shows it is slower than the speed that hides it", () => {
        expect(LENS_MAG_OFF).toBeLessThan(LENS_MAG_ON);
        expect(off).toBeGreaterThan(on);
    });

    it("L12: hidden stays hidden inside the band; it appears once the speed is under the ON speed", () => {
        expect(updateLensSize(at((on + off) / 2, null), 2000).visible).toBe(false);
        expect(updateLensSize(at(on + 0.5, null), 2000).visible).toBe(false);
        expect(updateLensSize(at(on - 0.5, null), 2000).visible).toBe(true);
    });

    it("L12: shown stays shown inside the band; it goes only once the speed is over the OFF speed", () => {
        expect(updateLensSize(at((on + off) / 2, 1500), 2000).visible).toBe(true);
        expect(updateLensSize(at(off - 0.5, 1500), 2000).visible).toBe(true);
        expect(updateLensSize(at(off + 0.5, 1500), 2000).visible).toBe(false);
    });

    it("L12: a finger hovering on the threshold does not flicker", () => {
        // Speed wobbling +-4 % round the ON speed, frame by frame: at most one change in either direction.
        let state = at(on * 1.1, null);
        let changes = 0;
        let prev = false;
        for (let i = 0; i < 400; i++) {
            const speed = on * (1 + 0.04 * Math.sin(i / 3));
            state = { ...state, speed };
            const frame = updateLensSize(state, 2000 + i * 16);
            state = frame.state;
            if (frame.visible !== prev) changes++;
            prev = frame.visible;
        }
        expect(changes).toBeLessThanOrEqual(1);
    });
});

describe("picture zoom", () => {
    it("L13: the picture's own zoom counts towards the total; the lens makes up the rest, never below 1", () => {
        const f = new Finger();
        f.scale = 2;
        f.drag(...SLOW, 400);
        expect(f.last.zoom).toBe(LENS_ZOOM_MAX);
        expect(f.last.mag).toBe(LENS_ZOOM_MAX / 2);
        expect(lensMag(1)).toBe(LENS_ZOOM_MAX);
        expect(lensMag(2)).toBe(LENS_ZOOM_MAX / 2);
        expect(lensMag(LENS_ZOOM_MAX)).toBe(1);
        expect(lensMag(LENS_ZOOM_MAX * 2)).toBe(1);
    });

    it("L13: where the picture alone is that close the lens never shows, however slow the finger", () => {
        const f = new Finger();
        f.scale = LENS_ZOOM_MAX / LENS_MAG_ON + 0.05;
        expect(lensReachable(f.scale)).toBe(false);
        f.drag(...SLOW, 1000);
        expect(f.shown.some(Boolean)).toBe(false);
        expect(lensReachable(LENS_ZOOM_MAX / LENS_MAG_ON - 0.05)).toBe(true);
    });
});

describe("visibility in context", () => {
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

    it("L14: shows only where every condition holds", () => {
        expect(lensVisible(base)).toBe(true);
        const cases: [string, Partial<LensVisibilityInput>][] = [
            ["not a trackpad (the desktop mouse has no lens)", { trackpadActive: false }],
            ["relative mouse: cursor is a guess", { relative: true }],
            ["socket down", { hidOpen: false }],
            ["dialog open", { modalOpen: true }],
            ["no cursor position", { at: null }],
            ["no picture", { box: null }],
            ["no real frame yet", { nat: { w: 16, h: 9 } }],
            ["linger expired", { now: 2001 }],
            ["zoomed past the lens's usefulness", { scale: LENS_ZOOM_MAX / LENS_MAG_ON + 0.05 }],
        ];
        for (const [name, patch] of cases) expect(lensVisible({ ...base, ...patch }), name).toBe(false);
        expect(lensVisible({ ...base, scale: LENS_ZOOM_MAX / LENS_MAG_ON - 0.05 })).toBe(true);
        expect(lensVisible({ ...base, now: 2000 })).toBe(true); // linger is inclusive
    });

    it("L14: after the lift it stays for the linger time, then hides (the painter's deadline)", () => {
        const f = new Finger();
        f.drag(...SLOW, 800);
        expect(f.visible).toBe(true);
        const liftedAt = f.t;
        const until = liftedAt + 1400;
        const shownAt = (ms: number) => {
            f.t = liftedAt + ms;
            f.frame();
            return f.visible && lensVisible({ ...base, now: f.t, until });
        };
        expect(shownAt(16)).toBe(true);
        expect(shownAt(1400)).toBe(true);
        expect(shownAt(1401)).toBe(false);
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

    it("L15: clips to the picture at an edge and offsets the draw", () => {
        const s = lensSource(100, 200, 2, box, nat, { x: 0, y: 225 });
        // side = 100 stream px, centred on x=0: left half is outside the picture
        expect(s.sx).toBe(0);
        expect(s.sw).toBe(50);
        expect(s.dx).toBe(100); // half of the 200 px canvas stays black
        expect(s.dw).toBe(100);
        expect(s.visible).toBe(true);
    });

    it("L15: draws nothing when wholly outside the picture", () => {
        expect(lensSource(100, 200, 2, box, nat, { x: -500, y: -500 }).visible).toBe(false);
        expect(lensSource(100, 200, 2, box, nat, { x: 5000, y: 225 }).visible).toBe(false);
    });
});
