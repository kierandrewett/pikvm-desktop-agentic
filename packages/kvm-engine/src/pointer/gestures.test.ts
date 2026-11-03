// Failure modes P1-P17, R1-R6, D1-D9, M1-M13: see FAILURE_MODES.md.
//
// Whole gestures run through the driver on a manual clock: the same path the app
// takes, with no real timers. Expected values are commands, never source text.

import { describe, expect, it } from "vitest";
import { fracToNorm } from "../view/geometry";
import { IDENTITY_VIEW } from "../view/transform";
import { createManualClock } from "../clock";
import { createPointerDriver } from "./driver";
import { createRig } from "./test-rig";
import { DEFAULT_ENV } from "./types";
import type { Rig } from "./test-rig";

/** The kvmd units of a client point on the default 800x450 pane showing a 16:9 picture. */
function norm(x: number, y: number): string {
    return `${fracToNorm(x / 800)},${fracToNorm(y / 450)}`;
}

const SQUARE = { nat: { w: 900, h: 900 } }; // 450x450 picture, bars either side of x=175..625

/** A swipe of one finger: down, a move past the slop, a frame, up. */
function swipe(r: Rig, id: number, x: number, y: number, dx: number): void {
    r.down(id, x, y);
    r.advance(30);
    r.move(id, x + dx, y);
    r.frame();
    r.up(id);
}

describe("trackpad on an absolute Pi", () => {
    it("P1: a plain tap is exactly one left click and moves nothing", () => {
        const r = createRig();
        r.down(1, 400, 225);
        r.advance(80);
        r.up(1);
        expect(r.take()).toEqual(["click:left"]);
        r.advance(2000);
        expect(r.take()).toEqual([]);
        expect(r.driver.machine.virtualCursor).toEqual({ x: 0, y: 0 });
        expect(r.driver.machine.phase).toBe("idle");
    });

    it("P2: wobble within the slop is still a tap and freezes the cursor", () => {
        const r = createRig();
        r.down(1, 400, 225);
        r.move(1, 410, 228); // 10.4 px
        r.move(1, 393, 219); // 8.5 px from the start
        r.frame();
        expect(r.take()).toEqual([]);
        expect(r.driver.machine.phase).toBe("pending");
        r.up(1);
        expect(r.take()).toEqual(["click:left"]);
        expect(r.driver.machine.virtualCursor).toEqual({ x: 0, y: 0 });
    });

    it("P2: past the slop it is a drag, not a tap", () => {
        const r = createRig();
        r.down(1, 400, 225);
        r.move(1, 417, 225); // 17 px
        expect(r.driver.machine.phase).toBe("dragging");
        r.frame();
        r.up(1);
        expect(r.take().filter((s) => s.startsWith("click"))).toEqual([]);
    });

    it("P17: the lens hears each move once the finger is past 4 px, even inside the tap slop, and the cursor stays frozen", () => {
        const r = createRig();
        r.down(1, 400, 225);
        expect(r.ofType("lens")).toEqual([{ type: "lens" }]); // the touch itself: a fresh gesture
        r.move(1, 402, 226); // 2.2 px from the start: jitter
        r.move(1, 403, 224); // 3.2 px: still jitter
        expect(r.ofType("lens")).toHaveLength(1);
        r.move(1, 405, 225); // 5 px from the start, 2 px of travel
        r.move(1, 408, 229); // 5 px of travel
        expect(r.ofType("lens").slice(1)).toEqual([
            { type: "lens", distance: 2.23606797749979 },
            { type: "lens", distance: 5 },
        ]);
        r.frame();
        expect(r.take()).toEqual([]); // under the 16 px slop: nothing sent, the cursor has not moved
        expect(r.driver.machine.phase).toBe("pending");
        r.move(1, 430, 229); // past the slop: it drags, and still reports its travel once
        // (take() above cleared the log: only this move's command is left)
        expect(r.ofType("lens")).toEqual([{ type: "lens", distance: 22 }]);
    });

    it("P17: the lens is given the move's own timestamp when the input carries one, and none when it does not", () => {
        const r = createRig();
        r.down(1, 400, 225);
        r.driver.send({ type: "move", id: 1, kind: "touch", x: 410, y: 225, buttons: 0, at: 5123.5 });
        r.driver.send({ type: "move", id: 1, kind: "touch", x: 420, y: 225, buttons: 0 });
        expect(r.ofType("lens").slice(1)).toEqual([
            { type: "lens", distance: 10, at: 5123.5 },
            { type: "lens", distance: 10 },
        ]);
    });

    it("P17: the lens is told AFTER the cursor has moved, so it is drawn where the cursor now is", () => {
        const seen: string[] = [];
        const driver = createPointerDriver({ clock: createManualClock(1000), sink: (c) => seen.push(c.type), env: DEFAULT_ENV, coarsePointer: true });
        driver.send({ type: "down", id: 1, kind: "touch", x: 400, y: 225, button: 0 });
        driver.send({ type: "move", id: 1, kind: "touch", x: 440, y: 225, buttons: 0 }); // past the slop: the cursor moves
        const move = seen.slice(seen.indexOf("lens") + 1);
        expect(move).toContain("lens");
        expect(move.indexOf("trackpadCursor")).toBeLessThan(move.indexOf("lens"));
    });

    it("P17: a tap with finger jitter sends the lens no speed, and neither does a direct touch, two fingers or a mouse", () => {
        const tap = createRig();
        tap.down(1, 400, 225);
        tap.move(1, 402, 227);
        tap.move(1, 399, 224);
        tap.up(1);
        expect(tap.ofType("lens").filter((c) => "distance" in c)).toEqual([]);
        const direct = createRig({ env: { touchMode: "direct" } });
        direct.down(1, 400, 225);
        direct.move(1, 420, 225);
        direct.move(1, 440, 225);
        expect(direct.ofType("lens")).toEqual([]);
        const two = createRig();
        two.down(1, 300, 225);
        two.down(2, 500, 225);
        const before = two.ofType("lens").length;
        two.move(1, 280, 225);
        two.move(2, 520, 225);
        expect(two.ofType("lens")).toHaveLength(before);
        const mouse = createRig();
        mouse.move(7, 300, 200, "mouse");
        mouse.down(7, 300, 200, "mouse");
        mouse.move(7, 340, 200, "mouse");
        expect(mouse.ofType("lens")).toEqual([]);
    });

    it("P3: two quick swipes never press a button, however soon the second follows", () => {
        const r = createRig();
        swipe(r, 1, 100, 200, 60);
        r.advance(60);
        swipe(r, 2, 200, 300, 60);
        r.advance(2000); // long enough for any left-over hold timer to have armed
        const out = r.take();
        expect(out).toEqual([`move:4424,0`, `move:8847,0`]);
        expect(out.some((s) => s.startsWith("down:") || s.startsWith("click:"))).toBe(false);
        expect(r.ofType("holdCue")).toEqual([]);
    });

    it("P4/P6: holding still arms at 450 ms, not before, and lifting then right-clicks once", () => {
        const r = createRig();
        r.down(1, 400, 225);
        r.advance(449);
        expect(r.ofType("holdCue")).toEqual([]);
        expect(r.driver.machine.phase).toBe("pending");
        r.advance(1);
        expect(r.ofType("holdCue")).toEqual([{ type: "holdCue", on: true, x: 400, y: 225, direct: false }]);
        expect(r.driver.machine.phase).toBe("armed");
        r.up(1);
        const cues = r.ofType("holdCue");
        expect(r.take()).toEqual(["click:right"]);
        expect(cues.at(-1)).toEqual({ type: "holdCue", on: false, direct: false });
        expect(r.driver.machine.phase).toBe("idle");
    });

    it("P5: hold then move drags with the left button, lifting releases it without a click", () => {
        const r = createRig();
        r.down(1, 400, 225);
        r.advance(450);
        r.move(1, 430, 225);
        expect(r.driver.machine.phase).toBe("dragging");
        expect(r.driver.machine.leftHeld).toBe(true);
        r.frame();
        expect(r.take()).toEqual(["down:left", "move:2212,0"]);
        r.move(1, 460, 225);
        r.frame();
        expect(r.take()).toEqual(["move:4424,0"]);
        r.up(1);
        expect(r.take()).toEqual(["up:left"]);
        expect(r.driver.machine.leftHeld).toBe(false);
        r.advance(1000);
        expect(r.take()).toEqual([]);
    });

    it("P6: moving past the slop before 450 ms cancels the hold for good", () => {
        const r = createRig();
        r.down(1, 400, 225);
        r.advance(300);
        r.move(1, 420, 225);
        r.frame();
        r.take();
        r.advance(5000);
        expect(r.ofType("holdCue")).toEqual([]);
        expect(r.clock.pending()).toBe(0);
        r.up(1);
        expect(r.take()).toEqual([]);
    });

    it("P7: a cancelled touch clicks nothing, plain or armed", () => {
        const r = createRig();
        r.down(1, 400, 225);
        r.up(1, "touch", { cancelled: true });
        expect(r.take()).toEqual([]);
        r.down(2, 400, 225);
        r.advance(500);
        r.up(2, "touch", { cancelled: true });
        expect(r.take()).toEqual([]);
        expect(r.clock.pending()).toBe(0);
    });

    it("P7: a cancelled hold-drag still releases the button", () => {
        const r = createRig();
        r.down(1, 400, 225);
        r.advance(450);
        r.move(1, 440, 225);
        r.frame();
        r.take();
        r.up(1, "touch", { cancelled: true });
        expect(r.take()).toEqual(["up:left"]);
    });

    it("always asks the Pi for absolute output and prevents the default of every touch event", () => {
        const r = createRig();
        expect(r.down(1, 400, 225).preventDefault).toBe(true);
        expect(r.take({ outputs: true })).toEqual(["out:abs"]);
        r.move(1, 420, 225);
        expect(r.move(1, 430, 225).preventDefault).toBe(true);
    });
});

describe("two fingers", () => {
    /** Fingers at (300,225) and (500,225): 200 apart, centre (400,225). */
    function twoDown(r: Rig): void {
        r.down(1, 300, 225);
        r.down(2, 500, 225);
    }

    it("P8: a quick two-finger tap is one right click and the first release is not also a left click", () => {
        const r = createRig();
        twoDown(r);
        r.advance(100);
        r.up(1);
        r.up(2);
        expect(r.take()).toEqual(["click:right"]);
        r.advance(1000);
        expect(r.take()).toEqual([]);
    });

    it("P8: a slow, a moved or a decided gesture is not a tap", () => {
        const slow = createRig();
        twoDown(slow);
        slow.advance(300);
        slow.up(1);
        slow.up(2);
        expect(slow.take()).toEqual([]);

        const edge = createRig();
        twoDown(edge);
        edge.advance(299);
        edge.up(1);
        expect(edge.take()).toEqual(["click:right"]);

        const moved = createRig();
        twoDown(moved);
        moved.move(1, 300, 245);
        moved.move(2, 500, 245);
        moved.up(1);
        moved.up(2);
        expect(moved.take()).toEqual([]);

        const pinched = createRig();
        twoDown(pinched);
        pinched.move(1, 250, 225); // symmetric about the centre would not move it much: still a pinch
        pinched.move(2, 550, 225);
        pinched.up(1);
        pinched.up(2);
        expect(pinched.take().filter((s) => s.startsWith("click"))).toEqual([]);
    });

    it("P11: scrolls one wheel step per 22 px, carrying the remainder, in the finger's direction", () => {
        const r = createRig();
        twoDown(r);
        expect(r.driver.machine.phase).toBe("two-finger");
        r.move(1, 300, 255);
        expect(r.take()).toEqual([]); // 15 px so far: decided as a drag, under a step
        r.move(2, 500, 255);
        expect(r.take()).toEqual(["wheel:0,1"]); // 30 px: one step, 8 left over
        r.move(1, 300, 300);
        expect(r.take()).toEqual(["wheel:0,1"]); // +22.5 px: 30.5 carried -> one step
        r.move(2, 500, 300);
        expect(r.take()).toEqual(["wheel:0,1"]);
        r.move(1, 300, 200);
        r.move(2, 500, 200);
        const up = r.take();
        expect(up.length).toBeGreaterThan(0);
        expect(up.every((s) => s === "wheel:0,-1")).toBe(true);
    });

    it("P11: fingers moving up scroll the other way", () => {
        const r = createRig();
        twoDown(r);
        r.move(1, 300, 165);
        expect(r.take()).toEqual(["wheel:0,-1"]);
    });

    it("P9/P10: a pinch never scrolls, even when its centre drifts a long way", () => {
        const r = createRig();
        twoDown(r);
        r.move(1, 250, 225); // 250 apart: +25 % -> pinch, decided once
        expect(r.driver.machine.phase).toBe("pinching");
        for (let y = 260; y <= 420; y += 20) {
            r.move(1, 250, y);
            r.move(2, 550, y);
        }
        expect(r.take()).toEqual([]);
        expect(r.driver.machine.currentView.scale).toBeGreaterThan(1);
    });

    it("P9/P10: a two-finger drag never zooms, however far the fingers then spread", () => {
        const r = createRig();
        twoDown(r);
        r.move(1, 300, 260);
        r.move(2, 500, 260); // centre moved 35: decided as a drag
        r.move(1, 150, 260);
        r.move(2, 650, 260); // now 500 apart
        expect(r.driver.machine.currentView).toEqual(IDENTITY_VIEW);
        expect(r.ofType("view")).toEqual([]);
    });

    it("P9: pinch is tested first when both thresholds are crossed in one event", () => {
        const r = createRig();
        twoDown(r);
        r.move(1, 200, 300); // distance and centre both jump
        expect(r.driver.machine.phase).toBe("pinching");
        expect(r.take()).toEqual([]);
    });

    it("P12: in direct mode a pinch zooms under the fingers", () => {
        const r = createRig({ env: { touchMode: "direct", mouseMode: "absolute" } });
        twoDown(r);
        r.move(1, 250, 225); // 250 apart, centre (375, 225)
        const v = r.driver.machine.currentView;
        expect(v.scale).toBeCloseTo(1.25, 9);
        // Zoomed about the new centre (375), then the view follows the centre's 25 px drift: the
        // same pan-while-zoomed a pinch gets anywhere the cursor is unknown.
        expect(v.tx).toBeCloseTo(-118.75, 9);
        expect(v.ty).toBeCloseTo(-56.25, 9);
        expect(r.ofType("view").at(-1)).toEqual({ type: "view", view: v }); // the last applied view is what the machine holds
    });

    it("P12: on an absolute trackpad a pinch zooms about the cursor and keeps it near the middle", () => {
        const r = createRig();
        swipe(r, 9, 100, 225, 100); // cursor to client x = 490
        r.clear();
        const before = r.driver.machine.virtualCursorClient!;
        expect(before.x).toBeCloseTo(490, 0);
        twoDown(r);
        r.move(1, 250, 225);
        const m = r.driver.machine;
        expect(m.currentView.scale).toBeCloseTo(1.25, 9);
        expect(Math.abs(m.virtualCursorClient!.x - 400)).toBeLessThan(Math.abs(before.x - 400));
        // and the view never leaves the picture
        expect(m.currentView.tx).toBeLessThanOrEqual(0);
        expect(m.currentView.tx + m.currentView.scale * 800).toBeGreaterThanOrEqual(800);
    });

    it("P13: zoomed with no known cursor (direct) a two-finger drag moves the view and scrolls nothing", () => {
        const r = createRig({ env: { touchMode: "direct", mouseMode: "absolute" }, view: { scale: 2, tx: -400, ty: -225 } });
        twoDown(r);
        r.move(1, 300, 255);
        expect(r.take()).toEqual([]);
        expect(r.driver.machine.currentView).toEqual({ scale: 2, tx: -400, ty: -210 });
    });

    it("P13: zoomed on an absolute trackpad it still scrolls the target", () => {
        const r = createRig({ view: { scale: 2, tx: -400, ty: -225 } });
        twoDown(r);
        r.move(1, 300, 255);
        r.move(2, 500, 255);
        expect(r.take()).toEqual(["wheel:0,1"]);
    });

    it("P14: a third finger is not a gesture and clicks nothing when lifted", () => {
        const r = createRig();
        twoDown(r);
        r.down(3, 400, 100);
        expect(r.driver.machine.phase).toBe("two-finger");
        r.advance(100);
        r.up(3);
        expect(r.take()).toEqual([]);
    });

    it("P15: lifting one finger after a pinch never clicks; the finger left behind steers or is ignored", () => {
        const r = createRig();
        twoDown(r);
        r.move(1, 250, 225);
        r.move(2, 550, 225);
        r.clear();
        r.up(2); // the second finger goes: the first still owns the gesture
        expect(r.take()).toEqual([]);
        expect(r.driver.machine.phase).toBe("dragging");
        r.move(1, 280, 225);
        r.frame();
        // zoomed in by 1.5x, so the same finger travel moves the cursor 1.5x less
        expect(r.take()).toEqual([`move:${Math.round((30 / (800 * r.driver.machine.currentView.scale)) * 0.9 * 65534)},0`]);
        r.up(1);
        expect(r.take()).toEqual([]);

        const q = createRig();
        twoDown(q);
        q.move(1, 250, 225);
        q.move(2, 550, 225);
        q.clear();
        q.up(1); // the first finger goes: the one left behind is spent
        expect(q.driver.machine.phase).toBe("spent");
        q.move(2, 500, 225);
        q.frame();
        q.up(2);
        expect(q.take()).toEqual([]);
        expect(q.driver.machine.phase).toBe("idle");
    });

    it("P16: a zoomed absolute trackpad keeps its cursor in view and inside the picture", () => {
        const r = createRig({ view: { scale: 2, tx: -400, ty: -225 } });
        r.down(1, 400, 225);
        r.move(1, 500, 225); // dx = 100, but the 2x view halves the gain: cursor at client x 490
        expect(r.driver.machine.currentView).toEqual({ scale: 2, tx: -490, ty: -225 });
        r.move(1, 20000, 225); // flung far right: the view stops at the picture's edge
        const v = r.driver.machine.currentView;
        expect(v.tx).toBe(-800);
        expect(r.ofType("view").length).toBeGreaterThan(0);
    });
});

describe("relative HID", () => {
    const relEnv = { touchHid: "rel" as const, mouseMode: "relative" as const, relativeAvailable: true };

    it("R1: sends the finger's own pixels and carries the fraction", () => {
        const r = createRig({ env: relEnv });
        r.down(1, 400, 225);
        r.move(1, 420, 225); // past the slop: 20 px straight through
        expect(r.take()).toEqual(["rel:20,0"]);
        let sent = 0;
        for (let i = 1; i <= 10; i++) {
            r.move(1, 420 + 2.5 * i, 225);
            for (const s of r.take()) sent += Number(s.slice(4).split(",")[0]);
        }
        expect(sent).toBe(25); // 10 x 2.5, none lost to truncation
        expect(r.driver.machine.relativeOwed.x).toBe(0);
    });

    it("R1: a drag sends no absolute move and no frame wait", () => {
        const r = createRig({ env: relEnv });
        r.down(1, 400, 225);
        r.move(1, 430, 240);
        expect(r.take()).toEqual(["rel:30,15"]);
        r.frame();
        expect(r.take()).toEqual([]);
    });

    it("R2: a flick is chunked to 127 and sums exactly", () => {
        const r = createRig({ env: relEnv });
        r.down(1, 100, 225);
        r.move(1, 400, 225);
        expect(r.take()).toEqual(["rel:127,0", "rel:127,0", "rel:46,0"]);
        r.move(1, 100, 225);
        expect(r.take()).toEqual(["rel:-127,0", "rel:-127,0", "rel:-46,0"]);
    });

    it("R3/R4: while the Pi still reports absolute, moves are held as debt and the switch is asked for", () => {
        const r = createRig({ env: { touchHid: "rel", mouseMode: "absolute", relativeAvailable: true } });
        r.down(1, 400, 225);
        r.move(1, 420, 225);
        r.frame();
        expect(r.take({ outputs: true })).toEqual(["out:rel", "out:rel"]); // at the touch, and for the held move
        expect(r.driver.machine.relativeOwed.x).toBe(20);
        r.move(1, 450, 225);
        expect(r.take({ outputs: true })).toEqual(["out:rel"]); // asks again; never an absolute move
        r.mode("relative");
        expect(r.take()).toEqual([]); // flushed on the next frame, not inline
        r.frame();
        expect(r.take()).toEqual(["rel:50,0"]);
        expect(r.driver.machine.relativeOwed.x).toBe(0);
    });

    it("R4: debt is bounded so a switch that never comes cannot bank a jump", () => {
        const r = createRig({ env: { touchHid: "rel", mouseMode: "absolute", relativeAvailable: true } });
        r.down(1, 100, 225);
        r.move(1, 3100, 225);
        r.move(1, 6100, 225);
        expect(r.driver.machine.relativeOwed.x).toBe(4000);
        r.mode("relative");
        r.frame();
        const sent = r.take().reduce((n, s) => n + Number(s.slice(4).split(",")[0]), 0);
        expect(sent).toBe(4000);
    });

    it("R5: a Pi with no relative output stays absolute whatever the setting says", () => {
        const r = createRig({ env: { touchHid: "rel", mouseMode: "absolute", relativeAvailable: false } });
        r.down(1, 400, 225);
        r.move(1, 480, 225);
        r.frame();
        expect(r.take()).toEqual([`move:${Math.round((80 / 800) * 0.9 * 65534)},0`]);
        expect(r.driver.machine.relativeOwed).toEqual({ x: 0, y: 0 });
    });

    it("R6: a relative Pi is never sent an absolute move, even by a mouse hover", () => {
        const r = createRig({ env: { mouseMode: "relative", relativeAvailable: true }, coarse: false });
        r.move(1, 300, 200, "mouse");
        r.frame();
        expect(r.take()).toEqual([]);
    });

    it("a tap in relative mode clicks without moving", () => {
        const r = createRig({ env: relEnv });
        r.down(1, 400, 225);
        r.up(1);
        expect(r.take()).toEqual(["click:left"]);
    });
});

describe("direct touch", () => {
    const direct = { touchMode: "direct" as const, mouseMode: "absolute" as const };

    it("D1: a tap moves to the touch point, then clicks", () => {
        const r = createRig({ env: direct });
        r.down(1, 200, 100);
        r.up(1);
        expect(r.take()).toEqual([`move:${norm(200, 100)}`, "click:left"]);
    });

    it("D1: a held-then-lifted touch right-clicks at the touch point", () => {
        const r = createRig({ env: direct });
        r.down(1, 200, 100);
        r.advance(450);
        expect(r.ofType("holdCue")[0]).toEqual({ type: "holdCue", on: true, x: 200, y: 100, direct: true });
        r.up(1);
        expect(r.take()).toEqual([`move:${norm(200, 100)}`, "click:right"]);
    });

    it("D2: off the picture there is nothing to point at", () => {
        const r = createRig({ env: { ...direct, ...SQUARE } });
        r.down(1, 50, 100);
        r.up(1);
        expect(r.take()).toEqual([]);
        expect(r.driver.machine.pendingAbsolute).toBe(0);
    });

    it("D3: while the Pi is relative the tap waits for absolute and asks for it", () => {
        const r = createRig({ env: { ...direct, mouseMode: "relative" } });
        r.down(1, 200, 100);
        r.up(1);
        expect(r.take({ outputs: true })).toEqual(["out:abs", "out:abs"]); // at the touch, and for the queued step
        expect(r.driver.machine.pendingAbsolute).toBe(1);
        r.advance(2000);
        expect(r.take()).toEqual([]); // nothing lands on whatever the cursor was over
        r.mode("absolute");
        expect(r.take()).toEqual([`move:${norm(200, 100)}`, "click:left"]);
        expect(r.driver.machine.pendingAbsolute).toBe(0);
    });

    it("D3: an unknown mode waits as well", () => {
        const r = createRig({ env: { ...direct, mouseMode: "unknown" } });
        r.down(1, 200, 100);
        r.up(1);
        expect(r.take()).toEqual([]);
        r.mode("absolute");
        expect(r.take()).toEqual([`move:${norm(200, 100)}`, "click:left"]);
    });

    it("D4: taps queued during the switch arrive in order as separate clicks, 90 ms apart", () => {
        const r = createRig({ env: { ...direct, mouseMode: "relative" } });
        r.down(1, 200, 100);
        r.up(1);
        r.advance(100);
        r.down(2, 600, 300);
        r.up(2);
        r.advance(100);
        r.down(3, 400, 225);
        r.up(3);
        r.take();
        r.mode("absolute");
        expect(r.take()).toEqual([`move:${norm(200, 100)}`, "click:left"]);
        r.advance(89);
        expect(r.take()).toEqual([]);
        r.advance(1);
        expect(r.take()).toEqual([`move:${norm(600, 300)}`, "click:left"]);
        r.advance(90);
        expect(r.take()).toEqual([`move:${norm(400, 225)}`, "click:left"]);
    });

    it("D4: while steps are queued a new tap queues behind them even if the Pi is absolute", () => {
        const r = createRig({ env: { ...direct, mouseMode: "relative" } });
        r.down(1, 200, 100);
        r.up(1);
        r.env({ mouseMode: "absolute" }); // the mode changed without the report that drains the queue
        r.down(2, 600, 300);
        r.up(2);
        expect(r.take()).toEqual([]);
        expect(r.driver.machine.pendingAbsolute).toBe(2);
    });

    it("D5: a step older than 2.4 s is dropped with a word about why, never sent later", () => {
        const relative = createRig({ env: { ...direct, mouseMode: "relative" } });
        relative.down(1, 200, 100);
        relative.up(1);
        relative.advance(2499);
        expect(relative.take()).toEqual([]);
        relative.advance(1);
        expect(relative.take()).toEqual(["notice:The Pi did not switch to absolute mouse, so that tap was not sent"]);
        relative.mode("absolute");
        relative.advance(1000);
        expect(relative.take()).toEqual([]);

        const unknown = createRig({ env: { ...direct, mouseMode: "unknown" } });
        unknown.down(1, 200, 100);
        unknown.up(1);
        unknown.advance(2500);
        expect(unknown.take()).toEqual(["notice:The Pi has not reported its mouse mode yet, so that tap was not sent"]);
    });

    it("D5: only the stale steps go; a fresher one survives its neighbour's sweep", () => {
        const r = createRig({ env: { ...direct, mouseMode: "relative" } });
        r.down(1, 200, 100);
        r.up(1); // t = 0
        r.advance(2000);
        r.down(2, 600, 300);
        r.up(2); // t = 2000
        r.advance(500); // first is 2500 old: swept; second is 500 old
        expect(r.take().filter((s) => s.startsWith("notice"))).toHaveLength(1);
        expect(r.driver.machine.pendingAbsolute).toBe(1);
        r.mode("absolute");
        expect(r.take()).toEqual([`move:${norm(600, 300)}`, "click:left"]);
    });

    it("D6: a hold-drag whose finger lifted before the Pi switched never presses afterwards", () => {
        const r = createRig({ env: { ...direct, mouseMode: "relative" } });
        r.down(1, 200, 100);
        r.advance(450);
        r.move(1, 240, 100);
        expect(r.driver.machine.pendingAbsolute).toBe(1);
        r.up(1);
        r.take();
        r.mode("absolute");
        const out = r.take();
        expect(out).toEqual([`move:${norm(200, 100)}`]);
        expect(out).not.toContain("down:left");
    });

    it("D6: a hold-drag on an absolute Pi points, presses, drags and releases", () => {
        const r = createRig({ env: direct });
        r.down(1, 200, 100);
        r.advance(450);
        r.move(1, 240, 100);
        expect(r.take()).toEqual([`move:${norm(200, 100)}`, "down:left", `move:${norm(240, 100)}`].slice(0, 2));
        r.frame();
        expect(r.take()).toEqual([`move:${norm(240, 100)}`]);
        r.up(1);
        expect(r.take()).toEqual(["up:left"]);
    });

    it("D7: one finger pans a zoomed view and sends nothing", () => {
        const r = createRig({ env: direct, view: { scale: 2, tx: -400, ty: -225 } });
        r.down(1, 400, 225);
        r.move(1, 450, 225);
        r.frame();
        expect(r.take()).toEqual([]);
        expect(r.driver.machine.currentView).toEqual({ scale: 2, tx: -350, ty: -225 });
        r.move(1, 460, 215);
        expect(r.driver.machine.currentView).toEqual({ scale: 2, tx: -340, ty: -235 });
        r.up(1);
        expect(r.take()).toEqual([]);
    });

    it("D7: unzoomed it moves the pointer, one move a frame", () => {
        const r = createRig({ env: direct });
        r.down(1, 100, 100);
        r.move(1, 200, 100);
        r.move(1, 300, 100);
        expect(r.take()).toEqual([]); // coalesced until the frame
        r.frame();
        expect(r.take()).toEqual([`move:${norm(300, 100)}`]);
    });

    it("D8: drag-lock presses at the finger once absolute, drags clamped, and a lift is not also a click", () => {
        const r = createRig({ env: { ...direct, dragLock: true } });
        r.down(1, 200, 100);
        expect(r.take()).toEqual([`move:${norm(200, 100)}`, "down:left"]);
        r.move(1, 5000, 100);
        r.frame();
        expect(r.take()).toEqual([`move:32767,${fracToNorm(100 / 450)}`]);
        r.up(1);
        expect(r.take()).toEqual(["up:left"]);
        r.advance(1000);
        expect(r.take()).toEqual([]);
    });

    it("D8: drag-lock on the trackpad presses at once and releases on lift", () => {
        const r = createRig({ env: { dragLock: true } });
        r.down(1, 400, 225);
        expect(r.take()).toEqual(["down:left"]);
        expect(r.clock.pending()).toBe(0); // no hold timer: the press is already down
        r.up(1);
        expect(r.take()).toEqual(["up:left"]);
    });

    it("D9: a pen points directly even with the trackpad selected", () => {
        const r = createRig({ env: { mouseMode: "absolute" } });
        r.down(1, 200, 100, "pen");
        r.up(1, "pen");
        expect(r.take()).toEqual([`move:${norm(200, 100)}`, "click:left"]);
        expect(r.driver.machine.trackpadActive).toBe(false);
    });
});

describe("desktop mouse", () => {
    const mouse = { coarse: false, env: { mouseMode: "absolute" as const } };

    it("M1: left, middle and right map to HID buttons, pressed at the pointer", () => {
        for (const [button, name] of [
            [0, "left"],
            [1, "middle"],
            [2, "right"],
        ] as const) {
            const r = createRig(mouse);
            r.down(1, 400, 225, "mouse", { button });
            expect(r.take()).toEqual([`move:0,0`, `down:${name}`]);
            r.up(1, "mouse", { button });
            expect(r.take()).toEqual([`up:${name}`]);
        }
    });

    it("M1: the thumb buttons send nothing, press or release", () => {
        for (const button of [3, 4, 5]) {
            const r = createRig(mouse);
            r.down(1, 400, 225, "mouse", { button });
            expect(r.take()).toEqual([]);
            expect(r.driver.machine.heldMouseButtons).toEqual([]);
            r.up(1, "mouse", { button });
            expect(r.take()).toEqual([]);
            r.move(1, 300, 200, "mouse");
            r.frame();
            expect(r.take().some((s) => s.startsWith("up:") || s.startsWith("down:"))).toBe(false);
        }
    });

    it("M2: a press in the letterbox is not a KVM click", () => {
        const r = createRig({ ...mouse, env: { ...mouse.env, ...SQUARE } });
        const res = r.down(1, 50, 225, "mouse");
        expect(r.take()).toEqual([]);
        expect(res.preventDefault).toBe(false);
        expect(r.ofType("capture")).toEqual([]);
        r.up(1, "mouse");
        expect(r.take()).toEqual([]);
    });

    it("M3: hover moves are absolute and coalesced to one per frame with the latest position", () => {
        const r = createRig(mouse);
        r.move(1, 100, 100, "mouse");
        r.move(1, 200, 150, "mouse");
        r.move(1, 300, 200, "mouse");
        expect(r.take()).toEqual([]);
        r.frame();
        expect(r.take()).toEqual([`move:${norm(300, 200)}`]);
        r.frame();
        expect(r.take()).toEqual([]);
    });

    it("M4: a drag that leaves the picture keeps steering, pinned to the edge", () => {
        const r = createRig(mouse);
        r.down(1, 400, 225, "mouse");
        r.take();
        r.move(1, 2000, -300, "mouse", 1);
        r.frame();
        const cursor = r.ofType("mouseCursor");
        expect(r.take()).toEqual(["move:32767,-32767"]);
        expect(cursor.at(-1)).toEqual({ type: "mouseCursor", x: 2000, y: -300, dragging: true });
    });

    it("M4: a hover outside the picture sends nothing", () => {
        const r = createRig({ ...mouse, env: { ...mouse.env, ...SQUARE } });
        r.move(1, 50, 225, "mouse");
        r.frame();
        expect(r.take()).toEqual([]);
    });

    it("M5: a move with no buttons proves a lost release: button and click modifiers are let go", () => {
        const r = createRig(mouse);
        r.down(1, 400, 225, "mouse", { clickMods: ["ControlLeft", "ShiftLeft"] });
        expect(r.take()).toEqual(["move:0,0", "key+:ControlLeft", "key+:ShiftLeft", "down:left"]);
        r.move(1, 410, 225, "mouse", 0);
        expect(r.take()).toEqual(["up:left", "key-:ShiftLeft", "key-:ControlLeft"]);
        r.move(1, 420, 225, "mouse", 0);
        r.frame();
        expect(r.take().filter((s) => s.startsWith("up:") || s.startsWith("key"))).toEqual([]);
    });

    it("M6: blur releases what is held and sends nothing when nothing is", () => {
        const idle = createRig(mouse);
        idle.blur();
        expect(idle.take()).toEqual([]);

        const r = createRig(mouse);
        r.down(1, 400, 225, "mouse", { clickMods: ["ControlLeft"] });
        r.take();
        r.blur();
        expect(r.take()).toEqual(["up:left", "key-:ControlLeft"]);
        r.up(1, "mouse");
        expect(r.take()).toEqual([]); // nothing double-released
    });

    it("M6: blur also lets go of a touch hold-drag, and the lift afterwards does not click", () => {
        const r = createRig();
        r.down(1, 400, 225);
        r.advance(450);
        r.move(1, 440, 225);
        r.frame();
        r.take();
        r.blur();
        expect(r.take()).toEqual(["up:left"]);
        expect(r.clock.pending()).toBe(0);
        r.up(1);
        expect(r.take()).toEqual([]);
        expect(r.driver.machine.phase).toBe("idle");
    });

    it("M7: modifiers wrap the click: down first, up after, in reverse; a stale set is released first", () => {
        const r = createRig(mouse);
        r.down(1, 400, 225, "mouse", { clickMods: ["ControlLeft", "ShiftLeft"] });
        r.take();
        r.up(1, "mouse");
        expect(r.take()).toEqual(["up:left", "key-:ShiftLeft", "key-:ControlLeft"]);

        r.down(1, 400, 225, "mouse", { clickMods: ["ControlLeft"] });
        r.take();
        r.down(1, 400, 225, "mouse", { clickMods: ["AltLeft"] }); // the release was lost
        expect(r.take()).toEqual(["move:0,0", "key-:ControlLeft", "key+:AltLeft", "down:left"]);
    });

    it("M8: a target with no live picture also gets a clamped relative nudge, never with one", () => {
        const asleep = createRig({ ...mouse, env: { ...mouse.env, streamLive: false } });
        asleep.move(1, 100, 100, "mouse");
        expect(asleep.take()).toEqual(["rel:30,30"]);
        asleep.move(1, 110, 95, "mouse");
        expect(asleep.take()).toEqual(["rel:10,-5"]);
        asleep.move(1, 110, 95, "mouse");
        expect(asleep.take()).toEqual([]); // no movement, no nudge
        asleep.move(1, 10, 95, "mouse");
        expect(asleep.take()).toEqual(["rel:-30,0"]);

        const live = createRig(mouse);
        live.move(1, 100, 100, "mouse");
        expect(live.take()).toEqual([]);

        const away = createRig({ ...mouse, env: { ...mouse.env, streamLive: false, windowFocused: false } });
        away.move(1, 100, 100, "mouse");
        expect(away.take()).toEqual([]);
    });

    it("M9: a background desktop window sends no moves", () => {
        const r = createRig({ ...mouse, env: { ...mouse.env, windowFocused: false } });
        r.move(1, 300, 200, "mouse");
        r.frame();
        expect(r.take()).toEqual([]);
        r.env({ windowFocused: true });
        r.move(1, 300, 200, "mouse");
        r.frame();
        expect(r.take()).toEqual([`move:${norm(300, 200)}`]);
    });

    it("M10: wheel sends one step per notch in the notch's direction", () => {
        const r = createRig(mouse);
        r.wheel(-100);
        r.wheel(100);
        r.wheel(-3);
        expect(r.take()).toEqual(["wheel:0,1", "wheel:0,-1", "wheel:0,1"]);
    });

    it("M10: on the web Ctrl+wheel zooms the local picture about the pointer and sends nothing", () => {
        const r = createRig(mouse);
        r.wheel(-100, "control", 200, 100);
        expect(r.take()).toEqual([]);
        const v = r.driver.machine.currentView;
        expect(v.scale).toBeCloseTo(1.1, 9);
        expect((200 - v.tx) / v.scale).toBeCloseTo(200, 9);
        r.wheel(100, "meta", 200, 100);
        expect(r.driver.machine.currentView.scale).toBeCloseTo(1, 9);
        r.wheel(100, "control", 200, 100); // already at 1: nothing to undo
        expect(r.driver.machine.currentView).toEqual(IDENTITY_VIEW);
    });

    it("M10: on the desktop Ctrl/Cmd+wheel belongs to the target, with the modifier wrapped round it", () => {
        const r = createRig({ ...mouse, env: { ...mouse.env, desktop: true } });
        r.wheel(-100, "control");
        r.wheel(100, "meta");
        expect(r.take()).toEqual(["wheel:0,1+ControlLeft", "wheel:0,-1+MetaLeft"]);
        expect(r.driver.machine.currentView).toEqual(IDENTITY_VIEW);
    });

    it("M11: a dialog owns the pointer; its swallowed release still lets go of the target", () => {
        const r = createRig(mouse);
        r.down(1, 400, 225, "mouse");
        r.take();
        r.env({ modalOpen: true });
        expect(r.down(2, 300, 200, "mouse").preventDefault).toBe(false);
        r.move(1, 100, 100, "mouse", 1);
        r.frame();
        r.wheel(-100);
        expect(r.take()).toEqual([]);
        r.up(1, "mouse");
        expect(r.take()).toEqual(["up:left"]);
    });

    it("M12: a mouse entering asks for absolute and takes the trackpad's place", () => {
        const r = createRig({ env: { touchHid: "rel", relativeAvailable: true, mouseMode: "relative" } });
        expect(r.driver.machine.trackpadActive).toBe(true);
        r.driver.send({ type: "enter", kind: "mouse" });
        expect(r.take({ outputs: true })).toEqual(["out:abs"]);
        expect(r.driver.machine.trackpadActive).toBe(false);
        r.driver.send({ type: "enter", kind: "touch" });
        expect(r.take({ outputs: true })).toEqual([]);
    });

    it("M12: leaving hides the blob unless a button is held", () => {
        const r = createRig(mouse);
        r.driver.send({ type: "leave", kind: "mouse", buttons: 1 });
        expect(r.ofType("mouseCursorHide")).toEqual([]);
        r.driver.send({ type: "leave", kind: "mouse", buttons: 0 });
        expect(r.ofType("mouseCursorHide")).toHaveLength(1);
    });

    it("hands the keyboard over: the hidden input on the web, nowhere on the desktop", () => {
        const web = createRig(mouse);
        expect(web.down(1, 400, 225, "mouse").preventDefault).toBe(true);
        expect(web.ofType("focus")).toEqual([{ type: "focus", target: "keyboard" }]);
        const desk = createRig({ ...mouse, env: { ...mouse.env, desktop: true } });
        expect(desk.down(1, 400, 225, "mouse").preventDefault).toBe(false);
        expect(desk.ofType("focus")).toEqual([{ type: "focus", target: "none" }]);
    });

    it("the output request follows the input in use, touch and mouse alike", () => {
        const r = createRig({ env: { touchHid: "rel", relativeAvailable: true, mouseMode: "relative" } });
        r.down(1, 400, 225); // trackpad pinned to relative
        expect(r.take({ outputs: true })).toEqual(["out:rel"]);
        r.up(1);
        r.take();
        r.move(2, 100, 100, "mouse");
        expect(r.take({ outputs: true })).toContain("out:abs");
        r.down(3, 400, 225, "touch");
        r.take();
        r.env({ touchMode: "direct" });
        r.up(3);
        r.take();
        r.down(4, 400, 225);
        expect(r.take({ outputs: true })[0]).toBe("out:abs"); // direct touch is absolute
    });
});

describe("view and environment", () => {
    it("M13: a pane resize while zoomed re-clamps the view and repaints the trackpad blob", () => {
        const r = createRig({ view: { scale: 2, tx: -800, ty: -450 } });
        r.driver.machine.handle({ type: "down", t: 0, id: 9, kind: "touch", x: 0, y: 0, button: 0 });
        r.driver.machine.handle({ type: "up", t: 1, id: 9, kind: "touch", button: 0 });
        r.env({ pane: { left: 0, top: 0, width: 400, height: 225 } });
        expect(r.driver.machine.currentView).toEqual({ scale: 2, tx: -400, ty: -225 });
        expect(r.ofType("view")).toEqual([{ type: "view", view: { scale: 2, tx: -400, ty: -225 } }]);
        expect(r.ofType("trackpadCursor").length).toBeGreaterThan(0);
    });

    it("M13: an unrelated env change leaves the view alone", () => {
        const r = createRig({ view: { scale: 2, tx: -400, ty: -225 } });
        r.env({ hidOpen: false });
        expect(r.ofType("view")).toEqual([]);
    });

    it("an external view change is taken without being echoed back", () => {
        const r = createRig();
        r.view({ scale: 3, tx: -10, ty: -10 });
        expect(r.driver.machine.currentView).toEqual({ scale: 3, tx: -10, ty: -10 });
        expect(r.ofType("view")).toEqual([]);
    });

    it("a modal swallowing the finger's lift still releases a drag-lock press", () => {
        const r = createRig({ env: { dragLock: true } });
        r.down(1, 400, 225);
        r.take();
        r.env({ modalOpen: true });
        r.up(1);
        expect(r.take()).toEqual(["up:left"]);
    });

    it("disposing the driver cancels every pending timer", () => {
        const r = createRig();
        r.down(1, 400, 225);
        expect(r.clock.pending()).toBe(1);
        r.driver.dispose();
        expect(r.clock.pending()).toBe(0);
        r.advance(1000);
        expect(r.take()).toEqual([]);
    });
});
