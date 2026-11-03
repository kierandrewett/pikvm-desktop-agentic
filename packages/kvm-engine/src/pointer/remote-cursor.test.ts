// The shared cursor, as the pointer machine lives it: another client moves the target's pointer, this one follows
// while it is idle, keeps its own while it is moving, and never writes back what it was told.

import { describe, expect, it } from "vitest";
import { fracToNorm } from "../view/geometry";
import { IDENTITY_VIEW } from "../view/transform";
import { createRig } from "./test-rig";
import type { Rig } from "./test-rig";
import { REMOTE_HOLD_MS } from "./types";

/** kvmd units of a point of the default 800x450 pane (a 16:9 picture filling it). */
const at = (x: number, y: number) => ({ x: Math.round(fracToNorm(x / 800)), y: Math.round(fracToNorm(y / 450)) });

const shown = (r: Rig) => r.ofType("remoteCursor").map((c) => c.show);

/** One finger drags a little, as a trackpad hand does, and stays down. */
function dragging(r: Rig, id = 1): void {
    r.down(id, 400, 225);
    r.advance(30);
    r.move(id, 440, 225);
    r.frame();
}

describe("an idle client follows", () => {
    it("takes the other client's position as the cursor, and says it is somebody else's", () => {
        const r = createRig();
        r.remote(5000, -7000);
        expect(r.driver.machine.virtualCursor).toEqual({ x: 5000, y: -7000 });
        expect(shown(r)).toEqual([true]);
    });

    it("never sends anything to the target for it: no echo can start from a client that only listens", () => {
        const r = createRig();
        for (let i = 0; i < 200; i += 1) {
            r.remote(i * 100, -i * 100);
            r.frame();
        }
        r.advance(5000);
        expect(r.take({ outputs: true })).toEqual([]);
    });

    it("follows in every mode, so the next drag starts from where the target's cursor is", () => {
        const r = createRig({ env: { mouseMode: "absolute" } });
        r.remote(-10000, 12000);
        r.advance(10);
        r.take();
        r.down(1, 400, 225);
        r.advance(30);
        r.move(1, 440, 225);
        r.frame();
        const [move] = r.take();
        const [, y] = move!.replace("move:", "").split(",").map(Number);
        expect(y).toBe(12000);
        const x = Number(move!.replace("move:", "").split(",")[0]);
        expect(x).toBeGreaterThan(-10000);
    });

    it("keeps the cursor of a relative Pi's trackpad too (the position is an estimate there, and the host's is better)", () => {
        const r = createRig({ env: { mouseMode: "relative", touchHid: "rel" } });
        r.remote(1234, -4321);
        expect(r.driver.machine.virtualCursor).toEqual({ x: 1234, y: -4321 });
    });

    it("clamps a position outside the screen", () => {
        const r = createRig();
        r.remote(99999, -99999);
        expect(r.driver.machine.virtualCursor).toEqual({ x: 32767, y: -32768 });
    });

    it("follows the newest of several in a row", () => {
        const r = createRig();
        r.remote(1, 1);
        r.remote(2, 2);
        r.remote(3, 3);
        expect(r.driver.machine.virtualCursor).toEqual({ x: 3, y: 3 });
    });

    it("puts the blob where the picture's point is, for any pane and picture", () => {
        const r = createRig({ env: { pane: { left: 100, top: 50, width: 400, height: 400 }, nat: { w: 1600, h: 900 } } });
        r.remote(0, 0);
        // 16:9 in a square pane: 400x225 centred, bars above and below.
        expect(r.driver.machine.virtualCursorClient).toEqual({ x: 300, y: 250 });
    });
});

describe("a client that is moving the pointer keeps it", () => {
    it("a finger down: the other client's position waits, and the cursor under the finger does not jump", () => {
        const r = createRig();
        dragging(r);
        const before = r.driver.machine.virtualCursor;
        r.remote(-20000, 20000);
        r.frame();
        expect(r.driver.machine.virtualCursor).toEqual(before);
        expect(shown(r)).toEqual([]);
    });

    it("a finger that lifts hands the cursor over after the hold, once, with the newest position", () => {
        const r = createRig();
        dragging(r);
        r.remote(100, 100);
        r.remote(200, 200);
        r.remote(300, 300);
        r.up(1);
        r.advance(REMOTE_HOLD_MS - 10);
        expect(r.driver.machine.virtualCursor.x).not.toBe(300);
        r.advance(20);
        r.advance(REMOTE_HOLD_MS);
        expect(r.driver.machine.virtualCursor).toEqual({ x: 300, y: 300 });
        expect(shown(r)).toEqual([true]);
        r.advance(5000);
        expect(shown(r)).toEqual([true]);
    });

    it("a finger that lifts and lands again within the hold is one gesture: still nothing taken", () => {
        const r = createRig();
        dragging(r);
        r.remote(100, 100);
        r.up(1);
        r.advance(REMOTE_HOLD_MS - 100);
        dragging(r);
        r.advance(REMOTE_HOLD_MS - 100);
        r.remote(150, 150);
        expect(r.driver.machine.virtualCursor.x).not.toBe(100);
        expect(r.driver.machine.virtualCursor.x).not.toBe(150);
    });

    it("a still finger down is still moving the pointer: nothing is taken however long it rests", () => {
        const r = createRig();
        r.down(1, 400, 225);
        r.remote(100, 100);
        r.advance(REMOTE_HOLD_MS * 6);
        expect(r.driver.machine.virtualCursor).toEqual({ x: 0, y: 0 });
        r.up(1);
        r.advance(REMOTE_HOLD_MS * 2);
        expect(r.driver.machine.virtualCursor).toEqual({ x: 100, y: 100 });
    });

    it("what waited is not taken once this client's own newer move has come back from the host", () => {
        const r = createRig();
        dragging(r);
        r.remote(100, 100);
        r.remote(-5, -5, true);
        r.up(1);
        r.advance(REMOTE_HOLD_MS * 3);
        expect(r.driver.machine.virtualCursor.x).not.toBe(100);
        expect(shown(r)).toEqual([]);
    });

    it("a move by the other client after this one's own echo still waits and is taken", () => {
        const r = createRig();
        dragging(r);
        r.remote(-5, -5, true);
        r.remote(100, 100);
        r.up(1);
        r.advance(REMOTE_HOLD_MS * 3);
        expect(r.driver.machine.virtualCursor).toEqual({ x: 100, y: 100 });
    });

    it("an echo of this client's own move moves nothing and draws nothing", () => {
        const r = createRig();
        dragging(r);
        r.up(1);
        r.advance(REMOTE_HOLD_MS * 2);
        const before = r.driver.machine.virtualCursor;
        r.remote(before.x + 500, before.y, true);
        expect(r.driver.machine.virtualCursor).toEqual(before);
        expect(shown(r)).toEqual([]);
    });

    it("a mouse moving over the picture, buttons up or down, keeps the cursor as well", () => {
        const r = createRig({ coarse: false });
        r.move(1, 400, 225, "mouse", 0);
        r.remote(100, 100);
        r.advance(REMOTE_HOLD_MS / 2);
        expect(r.driver.machine.virtualCursor.x).not.toBe(100);
        r.advance(REMOTE_HOLD_MS);
        expect(r.driver.machine.virtualCursor.x).toBe(100);
    });

    it("a wheel turn keeps it for the hold", () => {
        const r = createRig({ coarse: false });
        r.wheel(100);
        r.remote(100, 100);
        expect(r.driver.machine.virtualCursor.x).not.toBe(100);
        r.advance(REMOTE_HOLD_MS * 2);
        expect(r.driver.machine.virtualCursor.x).toBe(100);
    });
});

describe("both at once do not fight", () => {
    it("two clients moving at once: each keeps its own cursor while it moves, and takes the other's position after it stops", () => {
        const r = createRig();
        // This client drags for a second while the other moves at every frame.
        r.down(1, 100, 225);
        const mine: number[] = [];
        for (let i = 0; i < 60; i += 1) {
            r.move(1, 100 + i * 8, 225);
            r.remote(-30000 + i * 100, 0);
            r.frame();
            mine.push(r.driver.machine.virtualCursor.x);
        }
        // Only this client's own finger moved the cursor: it never went back and forth (the first steps are inside the slop).
        expect(mine.every((x, i) => i === 0 || x >= (mine[i - 1] ?? 0))).toBe(true);
        expect(mine.at(-1)).toBeGreaterThan(mine[0] ?? 0);
        r.up(1);
        r.advance(REMOTE_HOLD_MS * 2);
        expect(r.driver.machine.virtualCursor).toEqual({ x: -30000 + 59 * 100, y: 0 });
    });

    it("a client that is the last writer does not move when the host's answer to its own move arrives late", () => {
        const r = createRig();
        dragging(r);
        r.remote(900, 900);
        r.remote(0, 0, true); // this client's later write, answered after
        r.up(1);
        r.advance(REMOTE_HOLD_MS * 3);
        expect(r.driver.machine.virtualCursor.x).not.toBe(900);
    });
});

describe("somebody else's pointer is drawn as theirs", () => {
    it("until this client moves the pointer, and then it is this client's again, said once", () => {
        const r = createRig();
        r.remote(100, 100);
        r.advance(5);
        r.clear();
        r.down(1, 400, 225);
        r.up(1);
        r.advance(20);
        expect(shown(r)).toEqual([false]);
        r.clear();
        r.down(1, 400, 225);
        r.move(1, 420, 225);
        r.up(1);
        expect(shown(r)).toEqual([]);
    });

    it("a mouse moving over the picture takes it back at once", () => {
        const r = createRig({ coarse: false });
        r.remote(100, 100);
        r.clear();
        r.move(1, 300, 200, "mouse", 0);
        expect(shown(r)).toEqual([false]);
    });

    it("is drawn again where it now is when the picture is zoomed, panned or resized, and only while it is shown", () => {
        const r = createRig();
        r.remote(100, 100);
        r.clear();
        r.view({ ...IDENTITY_VIEW, scale: 2 });
        expect(shown(r)).toEqual([true]);
        r.clear();
        r.env({ pane: { left: 0, top: 0, width: 600, height: 450 } });
        expect(shown(r).length).toBeGreaterThan(0);
        expect(shown(r).every(Boolean)).toBe(true);
        r.down(1, 400, 225);
        r.up(1);
        r.clear();
        r.view(IDENTITY_VIEW);
        expect(shown(r)).toEqual([]);
    });

    it("is not drawn at all for a client that only ever followed nothing", () => {
        const r = createRig();
        r.env({ pane: { left: 0, top: 0, width: 600, height: 450 } });
        r.view({ ...IDENTITY_VIEW, scale: 2 });
        expect(shown(r)).toEqual([]);
    });
});
