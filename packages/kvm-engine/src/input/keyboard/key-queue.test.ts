import { describe, expect, it, vi } from "vitest";
import { createManualClock } from "../../clock/index";
import { FakeKeyTarget } from "../../testing/fake-key-target";
import { createKeyQueue } from "./key-queue";
import { createModifierMirror } from "./modifier-mirror";

// Failure modes 6-12 in FAILURE_MODES.md.

function setup() {
    const clock = createManualClock(0);
    const target = new FakeKeyTarget(() => clock.now());
    const mirror = createModifierMirror((code, down) => target.key(code, down));
    const queue = createKeyQueue({ clock, output: target, caps: target, mirror });
    return { clock, target, mirror, queue };
}

describe("one chord", () => {
    it("a bare key goes down on the next tick, is held 22ms, then up", () => {
        const { clock, target, queue } = setup();
        queue.chord([], "KeyA");
        expect(target.events).toEqual([]);
        clock.advance(0);
        expect(target.events).toEqual(["KeyA:down"]);
        clock.advance(21);
        expect(target.events).toEqual(["KeyA:down"]);
        clock.advance(1);
        expect(target.events).toEqual(["KeyA:down", "KeyA:up"]);
        expect(target.times).toEqual([0, 22]);
    });

    it("modifiers go down FIRST, settle 6ms, and only then does the key follow", () => {
        const { clock, target, queue } = setup();
        queue.chord(["ControlLeft", "ShiftLeft"], "KeyT");
        // Mods are written synchronously, in their own report, before any key.
        expect(target.events).toEqual(["ControlLeft:down", "ShiftLeft:down"]);
        clock.advance(5);
        expect(target.events).toHaveLength(2);
        clock.advance(1);
        expect(target.events).toEqual(["ControlLeft:down", "ShiftLeft:down", "KeyT:down"]);
        clock.advance(22);
        // The key comes up, then the modifiers in reverse order.
        expect(target.events.slice(3)).toEqual(["KeyT:up", "ShiftLeft:up", "ControlLeft:up"]);
        expect(target.times).toEqual([0, 0, 6, 28, 28, 28]);
    });

    it("never leaves a modifier down once the chord is done", () => {
        const { clock, target, mirror, queue } = setup();
        queue.chord(["ControlLeft", "AltLeft"], "Delete");
        clock.advance(1000);
        expect(mirror.heldCodes()).toEqual([]);
        const down = target.events.filter((e) => e.endsWith("down")).length;
        const up = target.events.filter((e) => e.endsWith("up")).length;
        expect(up).toBe(down);
    });
});

describe("serialisation", () => {
    it("plays chords strictly one after another with a 4ms gap and never interleaves", () => {
        const { clock, target, queue } = setup();
        queue.chord(["ShiftLeft"], "KeyA");
        queue.chord([], "KeyB");
        queue.chord(["ControlLeft"], "KeyC");
        clock.advance(10_000);
        expect(target.events).toEqual([
            "ShiftLeft:down",
            "KeyA:down",
            "KeyA:up",
            "ShiftLeft:up",
            "KeyB:down",
            "KeyB:up",
            "ControlLeft:down",
            "KeyC:down",
            "KeyC:up",
            "ControlLeft:up",
        ]);
        // chord 1: mods at 0, key 6..28, gap to 32; chord 2: key at 32, up 54, gap 58; chord 3 mods at 58
        expect(target.times[4]).toBe(32);
        expect(target.times[5]).toBe(54);
        expect(target.times[6]).toBe(58);
    });

    it("queued chords wait while one is playing", () => {
        const { clock, queue } = setup();
        queue.chord([], "KeyA");
        queue.chord([], "KeyB");
        expect(queue.busy()).toBe(true);
        expect(queue.length()).toBe(1);
        clock.advance(10_000);
        expect(queue.busy()).toBe(false);
        expect(queue.length()).toBe(0);
    });

    it("a runaway producer is capped at 600 and drops the oldest", () => {
        const { clock, target, queue } = setup();
        for (let i = 0; i < 700; i++) queue.chord([], `Key${i}`);
        // One is already playing; the rest are capped at 600.
        expect(queue.length()).toBe(600);
        clock.advance(1_000_000);
        const downs = target.events.filter((e) => e.endsWith(":down"));
        expect(downs).toHaveLength(601);
        expect(downs[0]).toBe("Key0:down");
        expect(downs[1]).toBe("Key100:down"); // 1..99 were dropped
    });
});

describe("modifier ownership", () => {
    it("does not press or release a modifier the user is holding", () => {
        const { clock, target, mirror, queue } = setup();
        mirror.press("ControlLeft");
        target.clear();
        queue.chord(["ControlLeft", "ShiftLeft"], "KeyT");
        clock.advance(100);
        expect(target.events).toEqual(["ShiftLeft:down", "KeyT:down", "KeyT:up", "ShiftLeft:up"]);
        expect(mirror.isHeld("ControlLeft")).toBe(true);
    });

    it("a chord whose modifiers are all held still plays with the key settle delay", () => {
        const { clock, target, mirror, queue } = setup();
        mirror.press("ControlLeft");
        target.clear();
        queue.chord(["ControlLeft"], "KeyC");
        clock.advance(5);
        expect(target.events).toEqual([]);
        clock.advance(1);
        expect(target.events).toEqual(["KeyC:down"]);
    });
});

describe("shift folding", () => {
    it("an armed Shift and a shift flag press Shift once", () => {
        const { clock, target, queue } = setup();
        queue.chord(["ShiftLeft"], "Digit1", true);
        clock.advance(100);
        expect(target.events.filter((e) => e === "ShiftLeft:down")).toHaveLength(1);
    });

    it("a physical ShiftRight satisfies the shift flag", () => {
        const { clock, target, queue } = setup();
        queue.chord(["ShiftRight"], "Digit1", true);
        clock.advance(100);
        expect(target.events).not.toContain("ShiftLeft:down");
    });

    it("the shift flag adds ShiftLeft when none is present", () => {
        const { clock, target, queue } = setup();
        queue.chord([], "Digit1", true);
        clock.advance(100);
        expect(target.events[0]).toBe("ShiftLeft:down");
    });
});

describe("letter case against the target's Caps Lock at play time", () => {
    const play = (caps: { known: boolean; on: boolean }, shift: boolean) => {
        const { clock, target, queue } = setup();
        target.known = caps.known;
        target.on = caps.on;
        queue.chord([], "KeyH", shift, true);
        clock.advance(100);
        return target.events.includes("ShiftLeft:down");
    };

    it("caps off: Shift for capitals only", () => {
        expect(play({ known: true, on: false }, true)).toBe(true);
        expect(play({ known: true, on: false }, false)).toBe(false);
    });

    it("caps on: the sense inverts, so lowercase needs Shift and capitals do not", () => {
        expect(play({ known: true, on: true }, false)).toBe(true);
        expect(play({ known: true, on: true }, true)).toBe(false);
    });

    it("unknown caps is treated as off", () => {
        expect(play({ known: false, on: true }, true)).toBe(true);
        expect(play({ known: false, on: true }, false)).toBe(false);
    });

    it("a Caps toggle queued ahead is accounted for, because case is decided when played", () => {
        const { clock, target, queue } = setup();
        target.on = false;
        queue.chord([], "CapsLock");
        queue.chord([], "KeyH", true, true); // queued while caps still reads off
        clock.advance(1000);
        // By the time H plays, the toggle has flipped the expectation to on, so a capital needs no Shift.
        expect(target.events).toEqual(["CapsLock:down", "CapsLock:up", "KeyH:down", "KeyH:up"]);
    });

    it("a letter with Shift already armed is not subject to the caps flip", () => {
        const { clock, target, queue } = setup();
        target.on = true;
        queue.chord(["ShiftLeft"], "KeyH", false, true);
        clock.advance(100);
        expect(target.events.filter((e) => e === "ShiftLeft:down")).toHaveLength(1);
    });

    it("non-letter keys ignore Caps Lock entirely", () => {
        const { clock, target, queue } = setup();
        target.on = true;
        queue.chord([], "Digit1", false, false);
        clock.advance(100);
        expect(target.events).not.toContain("ShiftLeft:down");
    });
});

describe("Caps Lock bookkeeping", () => {
    it("notes the toggle when the chord is PLAYED, not when it is queued", () => {
        const { clock, target, queue } = setup();
        queue.chord([], "KeyA");
        queue.chord([], "CapsLock");
        expect(target.toggles).toBe(0);
        clock.advance(1000);
        expect(target.toggles).toBe(1);
    });
});

describe("afterKeys", () => {
    it("fires on the next tick when idle", () => {
        const { clock, queue } = setup();
        const cb = vi.fn();
        queue.afterKeys(cb);
        expect(cb).not.toHaveBeenCalled();
        clock.advance(0);
        expect(cb).toHaveBeenCalledOnce();
    });

    it("waits for every queued key to be pressed AND released", () => {
        const { clock, target, queue } = setup();
        const seen: string[][] = [];
        queue.chord(["ControlLeft", "AltLeft"], "Delete");
        queue.chord([], "KeyA");
        queue.afterKeys(() => seen.push([...target.events]));
        clock.advance(10_000);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual([
            "ControlLeft:down",
            "AltLeft:down",
            "Delete:down",
            "Delete:up",
            "AltLeft:up",
            "ControlLeft:up",
            "KeyA:down",
            "KeyA:up",
        ]);
    });

    it("runs every waiter even if one throws", () => {
        const { clock, queue } = setup();
        const second = vi.fn();
        queue.chord([], "KeyA");
        queue.afterKeys(() => {
            throw new Error("boom");
        });
        queue.afterKeys(second);
        clock.advance(1000);
        expect(second).toHaveBeenCalledOnce();
        expect(queue.busy()).toBe(false);
    });

    it("a chord queued from a waiter plays normally afterwards", () => {
        const { clock, target, queue } = setup();
        queue.chord([], "KeyA");
        queue.afterKeys(() => queue.chord([], "KeyB"));
        clock.advance(10_000);
        expect(target.events).toEqual(["KeyA:down", "KeyA:up", "KeyB:down", "KeyB:up"]);
    });
});
