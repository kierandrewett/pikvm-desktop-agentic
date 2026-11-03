import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CursorUpdate } from "@pikvm/contracts/api";
import { createManualClock } from "@pikvm/kvm-engine";
import { createCursorHub, type MouseMode, type Resolution } from "../src/server/cursor/hub";

/** A hub on a manual clock, with the Pi's mouse mode and screen the test sets. */
function rig(start: { mode?: MouseMode; screen?: Resolution | undefined } = {}) {
    const clock = createManualClock(1_000);
    const pi = { mode: start.mode ?? ("absolute" as MouseMode), screen: "screen" in start ? start.screen : ({ width: 1920, height: 1080 } as Resolution | undefined) };
    const hub = createCursorHub({ mode: () => pi.mode, resolution: () => pi.screen, clock, frameMs: 16 });
    const told: CursorUpdate[] = [];
    hub.subscribe((u) => told.push(u));
    return { clock, pi, hub, told };
}

describe("where the pointer is", () => {
    it("is unknown until something moves it, and nobody is told of nothing", () => {
        const { hub, told, clock } = rig();
        assert.equal(hub.current(), null);
        clock.advance(100);
        assert.deepEqual(told, []);
    });

    it("takes an absolute move as it is, with the client that made it", () => {
        const { hub, told } = rig();
        hub.absolute("desk", 1000, -2000);
        assert.deepEqual(hub.current(), { x: 1000, y: -2000, source: "desk", seq: 1 });
        assert.deepEqual(told, [{ x: 1000, y: -2000, source: "desk", seq: 1 }]);
    });

    it("clamps an absolute move to the screen", () => {
        const { hub } = rig();
        hub.absolute("a", 99999, -99999);
        assert.deepEqual(hub.current(), { x: 32767, y: -32768, source: "a", seq: 1 });
    });

    it("ignores a move that is not a number", () => {
        const { hub } = rig();
        hub.absolute("a", Number.NaN, 0);
        hub.absolute("a", 0, Number.POSITIVE_INFINITY);
        hub.relative("a", Number.NaN, 1);
        hub.place("a", Number.NaN, 1);
        assert.equal(hub.current(), null);
    });

    it("says nothing when a move lands where the pointer already was", () => {
        const { hub, told, clock } = rig();
        hub.absolute("a", 5, 5);
        clock.advance(50);
        hub.absolute("b", 5, 5);
        clock.advance(50);
        assert.equal(told.length, 1);
        assert.equal(hub.current()?.seq, 1);
        assert.equal(hub.current()?.source, "a");
    });

    it("drops an absolute move while the Pi is relative: kvmd drops it too", () => {
        const { hub, pi } = rig({ mode: "relative" });
        hub.absolute("a", 10, 10);
        assert.equal(hub.current(), null);
        pi.mode = "absolute";
        hub.absolute("a", 10, 10);
        assert.equal(hub.current()?.x, 10);
    });
});

describe("relative moves", () => {
    it("say nothing while no position is known: the first absolute move starts it", () => {
        const { hub, told, clock } = rig({ mode: "relative" });
        hub.relative("phone", 40, 40);
        clock.advance(100);
        assert.equal(hub.current(), null);
        assert.deepEqual(told, []);
    });

    it("move the last known position by the delta in target pixels, as a fraction of the screen", () => {
        const { hub, pi } = rig({ mode: "absolute" });
        hub.absolute("desk", 0, 0);
        pi.mode = "relative";
        // 1919 target pixels is the whole width: 65534 units.
        hub.relative("phone", 1919 / 2, 1079 / 2);
        const at = hub.current();
        assert.equal(at?.source, "phone");
        assert.ok(Math.abs((at?.x ?? 0) - 32767) <= 1, `x ${at?.x}`);
        assert.ok(Math.abs((at?.y ?? 0) - 32767) <= 1, `y ${at?.y}`);
    });

    it("clamp at every edge and come back from it by the same measure", () => {
        const { hub, pi } = rig();
        hub.absolute("desk", 30000, -30000);
        pi.mode = "relative";
        hub.relative("phone", 5000, -5000);
        assert.deepEqual([hub.current()?.x, hub.current()?.y], [32767, -32768]);
        hub.relative("phone", -1919, 1079);
        // A whole screen's width back, and a whole screen's height down: from the far corners to the opposite ones.
        assert.ok(Math.abs((hub.current()?.x ?? 0) - (32767 - 65534)) <= 1, `x ${hub.current()?.x}`);
        assert.ok(Math.abs((hub.current()?.y ?? 0) - (-32768 + 65534)) <= 1, `y ${hub.current()?.y}`);
    });

    it("add up slow drags that are each a fraction of a unit", () => {
        const { hub, pi } = rig({ screen: { width: 65535, height: 65535 } });
        hub.absolute("desk", 0, 0);
        pi.mode = "relative";
        // One target pixel on a screen this wide is about one unit.
        for (let i = 0; i < 100; i += 1) hub.relative("phone", 1, 0);
        assert.ok(Math.abs((hub.current()?.x ?? 0) - 100) <= 2);
    });

    it("are dropped while the Pi is absolute: it drops them too", () => {
        const { hub } = rig({ mode: "absolute" });
        hub.absolute("desk", 0, 0);
        hub.relative("phone", 100, 100);
        assert.deepEqual([hub.current()?.x, hub.current()?.y], [0, 0]);
    });

    it("are not read while the Pi's mode is unknown", () => {
        const { hub, pi } = rig();
        hub.absolute("desk", 0, 0);
        pi.mode = "unknown";
        hub.relative("phone", 100, 100);
        assert.equal(hub.current()?.seq, 1);
    });

    it("use an assumed screen while the Pi has not said", () => {
        const { hub, pi } = rig({ screen: undefined });
        hub.absolute("desk", 0, 0);
        pi.mode = "relative";
        hub.relative("phone", 192, 0);
        assert.ok((hub.current()?.x ?? 0) > 6000 && (hub.current()?.x ?? 0) < 7000);
    });
});

describe("the agent", () => {
    it("knows where it put the pointer in either mode", () => {
        const { hub, pi } = rig({ mode: "relative" });
        hub.place("agent", 123, -456);
        assert.deepEqual(hub.current(), { x: 123, y: -456, source: "agent", seq: 1 });
        pi.mode = "absolute";
        hub.place("agent", 7, 7);
        assert.equal(hub.current()?.x, 7);
    });

    it("gives a relative start to the moves that follow it", () => {
        const { hub } = rig({ mode: "relative" });
        hub.place("agent", 0, 0);
        hub.relative("phone", 1919 / 4, 0);
        assert.ok(Math.abs((hub.current()?.x ?? 0) - 16383) <= 1);
    });
});

describe("the screen's resolution changing", () => {
    it("keeps an absolute position: it is a fraction of whatever the screen is", () => {
        const { hub, pi } = rig();
        hub.absolute("desk", 1234, -4321);
        pi.screen = { width: 3840, height: 2160 };
        hub.noteResolution();
        assert.deepEqual([hub.current()?.x, hub.current()?.y], [1234, -4321]);
        assert.equal(hub.current()?.seq, 1);
    });

    it("keeps the pixel a relative pointer was on, as the target's own system does", () => {
        const { hub, pi, told, clock } = rig();
        hub.absolute("desk", 0, 0);
        pi.mode = "relative";
        hub.noteResolution();
        clock.advance(50);
        told.length = 0;
        // 1920x1080 -> 960x540: the pointer's pixel stays, so it is twice as far across the smaller screen.
        pi.screen = { width: 960, height: 540 };
        hub.noteResolution();
        const at = hub.current();
        assert.ok(Math.abs((at?.x ?? 0) - 32767) < 80, `x ${at?.x}`);
        assert.equal(at?.source, "host");
        clock.advance(50);
        assert.equal(told.length, 1);
    });

    it("clamps a relative pointer that the smaller screen no longer holds", () => {
        const { hub, pi } = rig();
        hub.absolute("desk", 30000, 30000);
        pi.mode = "relative";
        hub.noteResolution();
        pi.screen = { width: 640, height: 360 };
        hub.noteResolution();
        assert.deepEqual([hub.current()?.x, hub.current()?.y], [32767, 32767]);
    });

    it("is noticed by the next move without anyone saying so", () => {
        const { hub, pi } = rig();
        hub.absolute("desk", 0, 0);
        pi.mode = "relative";
        hub.noteResolution();
        pi.screen = { width: 960, height: 540 };
        hub.relative("phone", 0, 1);
        assert.ok((hub.current()?.x ?? 0) > 32000);
    });

    it("learns the first resolution without moving anything", () => {
        const { hub, pi } = rig({ screen: undefined });
        hub.absolute("desk", 500, 500);
        pi.screen = { width: 1280, height: 720 };
        hub.noteResolution();
        assert.equal(hub.current()?.seq, 1);
    });
});

describe("telling everyone", () => {
    it("tells the first move at once and a burst after it as one update with the newest position", () => {
        const { hub, told, clock } = rig();
        hub.absolute("a", 1, 1);
        assert.equal(told.length, 1);
        clock.advance(4);
        hub.absolute("a", 2, 2);
        clock.advance(4);
        hub.absolute("a", 3, 3);
        assert.equal(told.length, 1);
        clock.advance(8);
        assert.equal(told.length, 2);
        assert.deepEqual(told[1], { x: 3, y: 3, source: "a", seq: 3 });
    });

    it("is never more than once a frame, however fast the mouse", () => {
        const { hub, told, clock } = rig();
        for (let i = 1; i <= 1000; i += 1) {
            hub.absolute("a", i, i);
            clock.advance(1);
        }
        clock.advance(20);
        // 1000 ms at 16 ms a frame.
        assert.ok(told.length <= 64, `${told.length} updates`);
        assert.equal(told.at(-1)?.x, 1000);
    });

    it("tells a move after a quiet spell at once", () => {
        const { hub, told, clock } = rig();
        hub.absolute("a", 1, 1);
        clock.advance(500);
        hub.absolute("a", 2, 2);
        assert.equal(told.length, 2);
    });

    it("tells the writer who wrote last when two write inside one frame", () => {
        const { hub, told, clock } = rig();
        hub.absolute("a", 1, 1);
        clock.advance(2);
        hub.absolute("a", 2, 2);
        hub.absolute("b", 3, 3);
        clock.advance(20);
        assert.deepEqual(told.at(-1), { x: 3, y: 3, source: "b", seq: 3 });
    });

    it("tells every subscriber, and a subscriber that left hears nothing more", () => {
        const { hub, clock } = rig();
        const heard = Array.from({ length: 200 }, () => [] as CursorUpdate[]);
        const off = heard.map((list) => hub.subscribe((u) => list.push(u)));
        hub.absolute("a", 1, 1);
        clock.advance(20);
        off[0]!();
        hub.absolute("a", 2, 2);
        clock.advance(20);
        assert.equal(heard[0]!.length, 1);
        for (const list of heard.slice(1)) assert.deepEqual(list.map((u) => u.x), [1, 2]);
    });

    it("lets a listener leave while it is told", () => {
        const { hub, told } = rig();
        let off = (): void => undefined;
        off = hub.subscribe(() => off());
        hub.absolute("a", 1, 1);
        assert.equal(told.length, 1);
    });

    it("stops its timer and its listeners when it is disposed", () => {
        const { hub, told, clock } = rig();
        hub.absolute("a", 1, 1);
        clock.advance(2);
        hub.absolute("a", 2, 2);
        assert.equal(clock.pending(), 1);
        hub.dispose();
        assert.equal(clock.pending(), 0);
        clock.advance(100);
        assert.equal(told.length, 1);
    });

    it("always delivers the last position of a burst, whatever the gaps: the trailing update is never dropped", () => {
        let seed = 12345;
        const random = (): number => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        for (let burst = 0; burst < 200; burst += 1) {
            const { hub, told, clock } = rig();
            const moves = 1 + Math.floor(random() * 40);
            let last = 0;
            for (let i = 0; i < moves; i += 1) {
                // Gaps from 0 to 40 ms: inside a frame, on its edge, and past it.
                last = burst * 100 + i + 1;
                hub.absolute("a", last, -last);
                clock.advance(Math.floor(random() * 41));
            }
            // Nothing newer is coming: within one frame everyone has been told the last one.
            clock.advance(16);
            assert.equal(told.at(-1)?.x, last, `burst ${burst} of ${moves}`);
            assert.equal(told.at(-1)?.seq, hub.current()?.seq);
            assert.equal(clock.pending(), 0, "and no timer is left running");
        }
    });

    it("delivers the trailing position even when the move that made it came the very instant the frame ended", () => {
        const { hub, told, clock } = rig();
        hub.absolute("a", 1, 1);
        clock.advance(15);
        hub.absolute("a", 2, 2);
        clock.advance(1);
        assert.equal(told.at(-1)?.x, 2);
        hub.absolute("a", 3, 3);
        hub.absolute("a", 4, 4);
        clock.advance(16);
        assert.equal(told.at(-1)?.x, 4);
    });
});
