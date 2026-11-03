// Failure modes L1-L17: see FAILURE_MODES.md.
//
// A finger is simulated on a plain time axis: `drag` feeds touch moves of `px` pixels every `everyMs`.
// No real timers.

import { describe, expect, it } from "vitest";
import {
    LENS_ENGAGE_PX,
    LENS_FLIP_BACK_PX,
    LENS_GAP,
    LENS_HIDE_DELAY_MS,
    LENS_HIDE_SPEED,
    LENS_MAX_DT_MS,
    LENS_MIN_MAG,
    LENS_MIN_MOVES,
    LENS_SHOW_DELAY_MS,
    LENS_SHOW_SPEED,
    LENS_SIZE,
    LENS_SPEED_TAU_MS,
    LENS_ZOOM,
    beginLensTouch,
    createLensSize,
    lensActive,
    lensMag,
    lensPlace,
    lensReachable,
    lensSource,
    lensVisible,
    noteLensFingers,
    noteLensSpeed,
    quenchLens,
    settleLens,
} from "./lens";
import type { LensSizeState, LensVisibilityInput } from "./lens";

class Finger {
    state: LensSizeState = createLensSize();
    t = 1000;
    /** `shown` after every move, in order. */
    readonly shown: boolean[] = [];

    /** Move `px` pixels every `everyMs` for `forMs`. */
    drag(px: number, everyMs: number, forMs: number): void {
        for (let spent = 0; spent < forMs; spent += everyMs) {
            this.t += everyMs;
            this.state = noteLensSpeed(this.state, px, this.t);
            this.shown.push(this.state.shown);
        }
    }

    get on(): boolean {
        return this.state.shown;
    }

    /** Time passes with no move: the finger rests. */
    rest(ms: number): void {
        this.t += ms;
        this.state = settleLens(this.state, this.t);
        this.shown.push(this.state.shown);
    }
}

/** 0.5 px every 16 ms = 31 px/s. */
const SLOW = [0.5, 16] as const;
/** 3.5 px every 16 ms = 219 px/s: under the show speed, well under the hide speed. */
const MID = [3.5, 16] as const;
/** 6 px every 16 ms = 375 px/s: between the show and the hide speed. */
const BAND = [6, 16] as const;
/** A fast swipe: 20 px every 16 ms = 1250 px/s. */
const FAST = [20, 16] as const;

describe("the speed average", () => {
    it("L1: the first move is the speed, over the longest gap a move may count as", () => {
        const s = noteLensSpeed(createLensSize(), 8, 1000);
        expect(s.speed).toBeCloseTo((8 / LENS_MAX_DT_MS) * 1000, 9);
        expect(s.moves).toBe(1);
    });

    it("L1: events at the same instant are finite and add no spike", () => {
        const a = noteLensSpeed(createLensSize(), 0.5, 1000);
        const b = noteLensSpeed(a, 0.5, 1000);
        expect(Number.isFinite(b.speed)).toBe(true);
        expect(b.speed).toBeLessThan(2 * a.speed + 1);
    });

    it("L1: a steady speed reads as itself however unevenly the events arrive", () => {
        let s = createLensSize();
        let t = 1000;
        const gaps = [3, 30, 5, 22, 16, 8, 27, 16];
        for (let i = 0; i < 80; i++) {
            const gap = gaps[i % gaps.length] as number;
            t += gap;
            s = noteLensSpeed(s, (200 * gap) / 1000, t);
            if (i > 10) {
                expect(s.speed).toBeGreaterThan(165);
                expect(s.speed).toBeLessThan(235);
            }
        }
    });

    it("L1: follows a change of speed within the time constant, in both directions alike", () => {
        for (const [from, to] of [
            [40, 600],
            [600, 40],
        ] as const) {
            const f = new Finger();
            f.drag((from * 16) / 1000, 16, 1000);
            f.drag((to * 16) / 1000, 16, LENS_SPEED_TAU_MS);
            expect(Math.abs(f.state.speed - to)).toBeLessThan(0.5 * Math.abs(from - to)); // more than halfway in one time constant
            f.drag((to * 16) / 1000, 16, 4 * LENS_SPEED_TAU_MS);
            expect(f.state.speed).toBeCloseTo(to, -1);
        }
    });

    it("L1: a finger that paused and sets off again is not averaged against the pause", () => {
        const f = new Finger();
        f.drag(...SLOW, 800);
        f.t += 2500; // a long rest with no moves
        f.drag(...FAST, 48);
        expect(f.state.speed).toBeGreaterThan(LENS_HIDE_SPEED);
    });
});

describe("on and off", () => {
    it("L2: the thresholds are ordered, so there is a band", () => {
        expect(LENS_SHOW_SPEED).toBeLessThan(LENS_HIDE_SPEED);
    });

    it("L3: no lens before the finger has moved: a touch alone, or one move, shows nothing", () => {
        expect(createLensSize().shown).toBe(false);
        const f = new Finger();
        f.drag(...SLOW, 16); // one move
        expect(f.state.moves).toBe(LENS_MIN_MOVES - 1);
        expect(f.on).toBe(false);
        expect(LENS_ENGAGE_PX).toBeGreaterThan(0);
        expect(LENS_ENGAGE_PX).toBeLessThan(16); // inside the tap slop, so a tap's jitter is under it
    });

    it("L3/L11: the second move of a slow finger decides; the lens follows after the show delay", () => {
        const f = new Finger();
        f.drag(...SLOW, 32);
        expect(f.state.want).toBe(true);
        expect(f.shown).toEqual([false, false]);
    });

    it("L4: a fast finger never shows it, from the first move, however long it goes on", () => {
        const f = new Finger();
        f.drag(...FAST, 10000);
        expect(f.shown.some(Boolean)).toBe(false);
        const flick = new Finger();
        flick.drag(40, 16, 48); // a flick from standing
        expect(flick.shown.some(Boolean)).toBe(false);
    });

    it("L4: speeding up hides it, and slowing down brings it back (each after its delay)", () => {
        const f = new Finger();
        f.drag(...SLOW, 400);
        expect(f.on).toBe(true);
        f.drag(...FAST, 400);
        expect(f.on).toBe(false);
        f.drag(...SLOW, 800);
        expect(f.on).toBe(true);
    });

    it("L5: a finger that stops sending moves keeps the decision: a swipe's rest never lets it in, a nudge's rest keeps it", () => {
        const swipe = new Finger();
        swipe.drag(...FAST, 400);
        swipe.rest(5000);
        expect(swipe.on).toBe(false);
        const nudge = new Finger();
        nudge.drag(...MID, 400);
        nudge.rest(5000);
        expect(nudge.on).toBe(true);
    });

    it("L6: hysteresis: in the band it stays as it was, so a finger hovering on the threshold does not flicker", () => {
        // hidden stays hidden in the band
        const hidden = new Finger();
        hidden.drag(...FAST, 400);
        hidden.drag(...BAND, 800);
        expect(hidden.state.speed).toBeGreaterThan(LENS_SHOW_SPEED);
        expect(hidden.state.speed).toBeLessThan(LENS_HIDE_SPEED);
        expect(hidden.on).toBe(false);
        // shown stays shown in the band
        const shown = new Finger();
        shown.drag(...SLOW, 400);
        shown.drag(...BAND, 800);
        expect(shown.state.speed).toBeGreaterThan(LENS_SHOW_SPEED);
        expect(shown.state.speed).toBeLessThan(LENS_HIDE_SPEED);
        expect(shown.on).toBe(true);
        // and a speed wobbling +-5 % round the show threshold changes the decision at most once
        const wobble = new Finger();
        wobble.drag(...FAST, 400);
        let t = wobble.t;
        const changes: boolean[] = [];
        for (let i = 0; i < 400; i++) {
            t += 16;
            const speed = LENS_SHOW_SPEED * (1 + 0.05 * Math.sin(i / 3));
            wobble.state = noteLensSpeed(wobble.state, (speed * 16) / 1000, t);
            if (changes.at(-1) !== wobble.state.shown) changes.push(wobble.state.shown);
        }
        expect(changes.length).toBeLessThanOrEqual(2);
    });
});

describe("delays", () => {
    /** Moves until `want` flips to `value`; returns the time it did. */
    const until = (f: Finger, move: readonly [number, number], value: boolean): number => {
        for (let i = 0; i < 200 && f.state.want !== value; i++) f.drag(...move, move[1]);
        expect(f.state.want).toBe(value);
        return f.t;
    };

    it("the delays are deliberate: a fraction of a second each, the hide a little longer than the show", () => {
        for (const ms of [LENS_SHOW_DELAY_MS, LENS_HIDE_DELAY_MS]) {
            expect(ms).toBeGreaterThanOrEqual(100);
            expect(ms).toBeLessThanOrEqual(400);
        }
        expect(LENS_HIDE_DELAY_MS).toBeGreaterThan(LENS_SHOW_DELAY_MS);
    });

    it("L11/L12: a slow finger that then stops shows it once the show delay has passed, with no further move", () => {
        const f = new Finger();
        f.drag(...SLOW, 32); // two moves: the decision is made
        const decided = f.t;
        expect(f.on).toBe(false);
        expect(lensActive(f.state)).toBe(true); // a change is waiting: the painter keeps the clock running
        f.rest(LENS_SHOW_DELAY_MS - 1);
        expect(f.on).toBe(false);
        f.rest(1);
        expect(f.t - decided).toBe(LENS_SHOW_DELAY_MS);
        expect(f.on).toBe(true);
        f.rest(5000); // and it stays
        expect(f.on).toBe(true);
    });

    it("L12: settling is idempotent and never moves backwards in time", () => {
        const f = new Finger();
        f.drag(...SLOW, 32);
        const early = settleLens(f.state, f.t - 500);
        expect(early).toBe(f.state);
        f.rest(LENS_SHOW_DELAY_MS);
        expect(settleLens(f.state, f.t)).toBe(f.state);
        expect(settleLens(f.state, f.t - 500)).toBe(f.state);
    });

    it("L11: a slow stretch shorter than the show delay never shows it", () => {
        const f = new Finger();
        f.drag(...FAST, 160);
        f.drag(...SLOW, LENS_SHOW_DELAY_MS - 60); // slows at the end of a flick
        f.drag(...FAST, 160);
        f.rest(2000);
        expect(f.shown.some(Boolean)).toBe(false);
        expect(lensActive(f.state)).toBe(false);
    });

    it("L11: no show if the speed goes over during the delay, and the wait starts again from nothing", () => {
        const f = new Finger();
        f.drag(...SLOW, 32);
        f.rest(LENS_SHOW_DELAY_MS - 40);
        f.drag(...FAST, 64); // over the show speed inside the delay
        expect(f.state.want).toBe(false);
        f.rest(2000);
        expect(f.on).toBe(false);
        // slow again: its own full delay from the moment it is slow
        const slowAt = until(f, SLOW, true);
        f.rest(LENS_SHOW_DELAY_MS - 1);
        expect(f.on).toBe(false);
        f.rest(1);
        expect(f.on).toBe(true);
        expect(f.t - slowAt).toBe(LENS_SHOW_DELAY_MS);
    });

    it("L13: it goes only after the hide condition has held for the hide delay", () => {
        const f = new Finger();
        f.drag(...SLOW, 400);
        expect(f.on).toBe(true);
        const fastAt = until(f, FAST, false);
        expect(f.on).toBe(true); // not yet
        f.rest(LENS_HIDE_DELAY_MS - (f.t - fastAt) - 1);
        expect(f.on).toBe(true);
        f.rest(1);
        expect(f.on).toBe(false);
        expect(lensActive(f.state)).toBe(false);
    });

    it("L13: a finger that goes fast and stops still has it hide after the delay", () => {
        const f = new Finger();
        f.drag(...SLOW, 400);
        until(f, FAST, false);
        f.rest(LENS_HIDE_DELAY_MS * 2);
        expect(f.on).toBe(false);
    });

    it("L13: a slow move during the hide delay cancels it: on throughout, no off-on flicker", () => {
        const f = new Finger();
        f.drag(...SLOW, 400);
        until(f, FAST, false);
        f.shown.length = 0;
        f.rest(LENS_HIDE_DELAY_MS / 2);
        f.drag(...SLOW, 200); // slow again, well inside the delay of the hide
        expect(f.state.want).toBe(true);
        f.rest(5000);
        expect(f.on).toBe(true);
        expect(f.shown.every(Boolean)).toBe(true);
    });

    it("L13: a speed hiccup that is back inside the delay never makes it blink, a wobble in the show/hide band included", () => {
        const f = new Finger();
        f.drag(...SLOW, 400);
        f.shown.length = 0;
        for (let i = 0; i < 20; i++) {
            f.drag(...FAST, 64); // fast for 4 moves, under the hide delay
            f.drag(...SLOW, 320);
        }
        f.rest(5000);
        expect(f.shown.every(Boolean)).toBe(true);
    });

    it("L9/L14: a lift hides it after the hide delay, not at once", () => {
        const f = new Finger();
        f.drag(...SLOW, 400);
        expect(f.on).toBe(true);
        f.state = noteLensFingers(f.state, false, f.t);
        expect(f.on).toBe(true);
        expect(f.state.want).toBe(false);
        f.rest(LENS_HIDE_DELAY_MS - 1);
        expect(f.on).toBe(true);
        f.rest(1);
        expect(f.on).toBe(false);
    });

    it("L9/L14: a second finger (a pinch) is a hide that waits too, and a lift before the show delay cancels a show", () => {
        const f = new Finger();
        f.drag(...SLOW, 400);
        f.state = noteLensFingers(f.state, false, f.t); // second finger down
        f.rest(LENS_HIDE_DELAY_MS / 2);
        f.state = noteLensFingers(f.state, true, f.t); // and gone again
        f.rest(5000);
        expect(f.on).toBe(true);
        const early = new Finger();
        early.drag(...SLOW, 32);
        early.rest(LENS_SHOW_DELAY_MS / 2);
        early.state = noteLensFingers(early.state, false, early.t);
        early.rest(5000);
        expect(early.on).toBe(false);
        expect(lensActive(early.state)).toBe(false);
    });

    it("L14: a new touch inside the hide delay cancels it and the lens stays up under the new finger", () => {
        const f = new Finger();
        f.drag(...SLOW, 400);
        f.state = noteLensFingers(f.state, false, f.t);
        f.rest(LENS_HIDE_DELAY_MS - 50);
        expect(f.on).toBe(true);
        f.state = beginLensTouch(f.state, f.t);
        expect(f.on).toBe(true);
        f.rest(5000); // it rests, or taps
        expect(f.on).toBe(true);
        // and the new finger decides from its own speed
        f.drag(...FAST, 400);
        expect(f.on).toBe(false);
    });

    it("L14: a new touch after the hide delay, or with no lens up, starts from nothing", () => {
        const f = new Finger();
        f.drag(...SLOW, 400);
        f.state = noteLensFingers(f.state, false, f.t);
        f.rest(LENS_HIDE_DELAY_MS);
        expect(f.on).toBe(false);
        f.state = beginLensTouch(f.state, f.t);
        f.rest(5000);
        expect(f.on).toBe(false);
        expect(f.state.moves).toBe(0);
        f.drag(...SLOW, 16); // one move is still not enough
        f.rest(5000);
        expect(f.on).toBe(false);
    });

    it("L15: a new touch drops a show that was waiting", () => {
        const f = new Finger();
        f.drag(...SLOW, 32);
        f.rest(LENS_SHOW_DELAY_MS / 2);
        f.state = beginLensTouch(f.state, f.t);
        expect(f.state.want).toBe(false);
        expect(lensActive(f.state)).toBe(false);
        f.rest(5000);
        expect(f.on).toBe(false);
    });

    it("L16: a hard limit takes it away at once and drops the wait: slow for the show delay again to get it back", () => {
        const f = new Finger();
        f.drag(...SLOW, 400);
        expect(f.on).toBe(true);
        f.state = quenchLens(f.state);
        expect(f.on).toBe(false);
        expect(lensActive(f.state)).toBe(false);
        expect(quenchLens(f.state)).toBe(f.state);
        f.rest(5000);
        expect(f.on).toBe(false);
        f.drag(...SLOW, 16);
        expect(f.on).toBe(false);
        f.drag(...SLOW, LENS_SHOW_DELAY_MS + 32);
        expect(f.on).toBe(true);
    });
});

describe("magnification", () => {
    it("L7: the picture's own zoom counts towards the total, never below 1", () => {
        expect(lensMag(1)).toBe(LENS_ZOOM);
        expect(lensMag(1.5)).toBe(LENS_ZOOM / 1.5);
        expect(lensMag(LENS_ZOOM)).toBe(1);
        expect(lensMag(LENS_ZOOM * 2)).toBe(1);
    });

    it("L7: where the picture alone is nearly that close it never shows", () => {
        expect(lensReachable(LENS_ZOOM / LENS_MIN_MAG - 0.05)).toBe(true);
        expect(lensReachable(LENS_ZOOM / LENS_MIN_MAG + 0.05)).toBe(false);
    });
});

describe("placement", () => {
    const pane = { left: 0, top: 0, width: 390, height: 700 };
    const half = LENS_SIZE / 2;
    const offset = half + LENS_GAP;

    it("L8: fixed above the cursor, the same offset wherever it is in the pane", () => {
        for (const at of [
            { x: 200, y: 400 },
            { x: 60, y: 300 },
            { x: 330, y: 650 },
            { x: 200, y: 400.5 },
        ]) {
            const p = lensPlace(at, pane, false);
            expect(p.y).toBe(at.y - offset);
            expect(p.below).toBe(false);
        }
        // and the cursor is not under it: the lens's bottom edge is LENS_GAP above the cursor
        expect(lensPlace({ x: 200, y: 400 }, pane, false).y + half).toBe(400 - LENS_GAP);
    });

    it("L8: follows the cursor sideways, held inside the pane", () => {
        expect(lensPlace({ x: 200, y: 400 }, pane, false).x).toBe(200);
        expect(lensPlace({ x: 3, y: 400 }, pane, false).x).toBe(half);
        expect(lensPlace({ x: 388, y: 400 }, pane, false).x).toBe(390 - half);
    });

    it("L8: goes below only where there is no room above, and does not hop at the edge", () => {
        const edge = offset + half; // the cursor y at which the lens just fits above
        expect(lensPlace({ x: 200, y: edge }, pane, false)).toMatchObject({ below: false, y: edge - offset });
        const flipped = lensPlace({ x: 200, y: edge - 1 }, pane, false);
        expect(flipped).toMatchObject({ below: true, y: edge - 1 + offset });
        // once below it stays below while the cursor wobbles over the edge ...
        expect(lensPlace({ x: 200, y: edge + 10 }, pane, true).below).toBe(true);
        expect(lensPlace({ x: 200, y: edge + LENS_FLIP_BACK_PX - 1 }, pane, true).below).toBe(true);
        // ... and returns above only with room to spare
        expect(lensPlace({ x: 200, y: edge + LENS_FLIP_BACK_PX }, pane, true)).toMatchObject({ below: false, y: edge + LENS_FLIP_BACK_PX - offset });
        // a pane too short for either side: whichever side has more room, with the same margin before it changes
        const short = { left: 0, top: 0, width: 390, height: 228 };
        expect(lensPlace({ x: 200, y: 99 }, short, false).below).toBe(true);
        expect(lensPlace({ x: 200, y: 120 }, short, true).below).toBe(true);
        expect(lensPlace({ x: 200, y: 134 }, short, true).below).toBe(true);
        expect(lensPlace({ x: 200, y: 135 }, short, true).below).toBe(false);
        expect(lensPlace({ x: 200, y: 120 }, short, false).below).toBe(false); // comfortably above: room above >= room below
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
        box: { left: 0, top: 0, w: 800, h: 450 },
        nat: { w: 1600, h: 900 },
    };

    it("L9/L16: shows only where every hard limit holds (the finger's own say is LensSizeState, and waits)", () => {
        expect(lensVisible(base)).toBe(true);
        const cases: [string, Partial<LensVisibilityInput>][] = [
            ["not a trackpad (the desktop mouse has no lens)", { trackpadActive: false }],
            ["relative mouse: cursor is a guess", { relative: true }],
            ["socket down", { hidOpen: false }],
            ["dialog open", { modalOpen: true }],
            ["no cursor position", { at: null }],
            ["no picture", { box: null }],
            ["no real frame yet", { nat: { w: 16, h: 9 } }],
            ["zoomed past the lens's usefulness", { scale: LENS_ZOOM / LENS_MIN_MAG + 0.05 }],
        ];
        for (const [name, patch] of cases) expect(lensVisible({ ...base, ...patch }), name).toBe(false);
        expect(lensVisible({ ...base, scale: LENS_ZOOM / LENS_MIN_MAG - 0.05 })).toBe(true);
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

    it("L10: clips to the picture at an edge and offsets the draw", () => {
        const s = lensSource(100, 200, 2, box, nat, { x: 0, y: 225 });
        // side = 100 stream px, centred on x=0: left half is outside the picture
        expect(s.sx).toBe(0);
        expect(s.sw).toBe(50);
        expect(s.dx).toBe(100); // half of the 200 px canvas stays black
        expect(s.dw).toBe(100);
        expect(s.visible).toBe(true);
    });

    it("L10: draws nothing when wholly outside the picture", () => {
        expect(lensSource(100, 200, 2, box, nat, { x: -500, y: -500 }).visible).toBe(false);
        expect(lensSource(100, 200, 2, box, nat, { x: 5000, y: 225 }).visible).toBe(false);
    });
});
