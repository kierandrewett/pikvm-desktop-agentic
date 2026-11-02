import { describe, expect, it, vi } from "vitest";
import { createManualClock } from "../../clock/index";
import { FakeKeyTarget } from "../../testing/fake-key-target";
import { createKeyboard } from "./keyboard";
import type { KeyEventLike } from "./key-chord";

// Failure modes 6-20 in FAILURE_MODES.md, through the facade the UI uses.

function setup(layout: "us" | "uk" = "us") {
    const clock = createManualClock(1_000_000);
    const target = new FakeKeyTarget(() => clock.now());
    const onCaretMoved = vi.fn();
    const keyboard = createKeyboard({ clock, target, layout });
    keyboard.onCaretMoved(onCaretMoved);
    return { clock, target, keyboard, onCaretMoved };
}

function ev(code: string, extra: Partial<KeyEventLike> = {}): KeyEventLike {
    return { code, key: code, repeat: false, ...extra };
}

/** A keydown for a printable key. */
const printable = (ch: string, extra: Partial<KeyEventLike> = {}): KeyEventLike =>
    ev(ch.length === 1 && /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : ch, { key: ch, ...extra });

describe("typing characters", () => {
    it("types a capital with Shift and a lowercase without, caps off", () => {
        const { clock, target, keyboard } = setup();
        keyboard.sendChar("H");
        keyboard.sendChar("i");
        clock.advance(1000);
        expect(target.events).toEqual(["ShiftLeft:down", "KeyH:down", "KeyH:up", "ShiftLeft:up", "KeyI:down", "KeyI:up"]);
    });

    it("with the target's Caps Lock on, 'Hello' still comes out as Hello", () => {
        const { clock, target, keyboard } = setup();
        target.on = true;
        for (const ch of "Hello") keyboard.sendChar(ch);
        clock.advance(10_000);
        const shifted = target.events
            .map((e, i, all) => (e === "ShiftLeft:down" ? all[i + 1] : null))
            .filter(Boolean);
        // Under Caps Lock the lowercase letters are the ones that need Shift.
        expect(shifted).toEqual(["KeyE:down", "KeyL:down", "KeyL:down", "KeyO:down"]);
    });

    it("non-letters resolve shift from the layout, UK differs from US", () => {
        const us = setup("us");
        us.keyboard.sendChar('"');
        us.clock.advance(100);
        expect(us.target.events).toContain("Quote:down");
        const uk = setup("uk");
        uk.keyboard.sendChar('"');
        uk.clock.advance(100);
        expect(uk.target.events).toContain("Digit2:down");
        expect(uk.target.events[0]).toBe("ShiftLeft:down");
    });

    it("setLayout changes the map for later characters", () => {
        const { clock, target, keyboard } = setup("us");
        keyboard.setLayout("uk");
        keyboard.sendChar("#");
        clock.advance(100);
        expect(target.events).toEqual(["Backslash:down", "Backslash:up"]);
    });

    it("a character the layout has no key for is dropped and does not consume armed modifiers", () => {
        const { clock, target, keyboard } = setup();
        keyboard.tapModifier("ControlLeft");
        keyboard.sendChar("\u00e9");
        clock.advance(100);
        expect(target.events).toEqual([]);
        expect(keyboard.armed.getState().armed).toEqual(["ControlLeft"]);
    });

    it("sendCode asks the soft-keyboard field to start over", () => {
        const { keyboard, onCaretMoved } = setup();
        keyboard.sendCode("ArrowLeft");
        expect(onCaretMoved).toHaveBeenCalledOnce();
    });

    it("sendChar does not (typing extends the field, it does not move the caret)", () => {
        const { keyboard, onCaretMoved } = setup();
        keyboard.sendChar("a");
        expect(onCaretMoved).not.toHaveBeenCalled();
    });
});

describe("armed sticky modifiers", () => {
    it("arm, then the next key carries them and they clear", () => {
        const { clock, target, keyboard } = setup();
        keyboard.tapModifier("ControlLeft");
        keyboard.sendChar("c");
        clock.advance(100);
        expect(target.events).toEqual(["ControlLeft:down", "KeyC:down", "KeyC:up", "ControlLeft:up"]);
        expect(keyboard.armed.getState().armed).toEqual([]);
    });

    it("a double tap within 350ms locks the modifier across keys", () => {
        const { clock, target, keyboard } = setup();
        keyboard.tapModifier("ControlLeft");
        clock.advance(200);
        keyboard.tapModifier("ControlLeft");
        expect(keyboard.armed.getState()).toEqual({ armed: ["ControlLeft"], locked: ["ControlLeft"] });
        keyboard.sendChar("c");
        keyboard.sendChar("v");
        clock.advance(1000);
        expect(target.events.filter((e) => e === "ControlLeft:down")).toHaveLength(2);
        expect(keyboard.armed.getState().armed).toEqual(["ControlLeft"]);
        // A third tap releases the lock.
        keyboard.tapModifier("ControlLeft");
        expect(keyboard.armed.getState()).toEqual({ armed: [], locked: [] });
    });

    it("a slow second tap disarms instead of locking", () => {
        const { clock, keyboard } = setup();
        keyboard.tapModifier("ShiftLeft");
        clock.advance(400);
        keyboard.tapModifier("ShiftLeft");
        expect(keyboard.armed.getState()).toEqual({ armed: [], locked: [] });
    });

    it("armed Shift and a typed capital press Shift once", () => {
        const { clock, target, keyboard } = setup();
        keyboard.tapModifier("ShiftLeft");
        keyboard.sendChar("A");
        clock.advance(100);
        expect(target.events.filter((e) => e === "ShiftLeft:down")).toHaveLength(1);
    });

    it("a shortcut button merges armed modifiers without duplicating a named one", () => {
        const { clock, target, keyboard, onCaretMoved } = setup();
        keyboard.tapModifier("ControlLeft");
        keyboard.tapModifier("ShiftLeft");
        keyboard.sendShortcut("ControlLeft+KeyC");
        clock.advance(100);
        expect(target.events).toEqual([
            "ControlLeft:down",
            "ShiftLeft:down",
            "KeyC:down",
            "KeyC:up",
            "ShiftLeft:up",
            "ControlLeft:up",
        ]);
        expect(keyboard.armed.getState().armed).toEqual([]);
        expect(onCaretMoved).toHaveBeenCalled();
    });

    it("withArmedModifiers holds them around a mouse action and releases in reverse", () => {
        const { target, keyboard } = setup();
        keyboard.tapModifier("ControlLeft");
        keyboard.tapModifier("ShiftLeft");
        keyboard.withArmedModifiers((release) => {
            expect(target.events).toEqual(["ControlLeft:down", "ShiftLeft:down"]);
            release();
        });
        expect(target.events).toEqual(["ControlLeft:down", "ShiftLeft:down", "ShiftLeft:up", "ControlLeft:up"]);
        expect(keyboard.armed.getState().armed).toEqual([]);
    });

    it("takeArmed returns the armed modifiers and clears the unlocked ones without pressing anything", () => {
        const { clock, target, keyboard } = setup();
        keyboard.tapModifier("ControlLeft");
        clock.advance(10);
        keyboard.tapModifier("ControlLeft"); // double tap: locked
        keyboard.tapModifier("ShiftLeft");
        expect(keyboard.takeArmed()).toEqual(["ControlLeft", "ShiftLeft"]);
        expect(keyboard.armed.getState().armed).toEqual(["ControlLeft"]);
        expect(keyboard.takeArmed()).toEqual(["ControlLeft"]);
        clock.advance(1000);
        expect(target.events).toEqual([]);
    });

    it("withArmedModifiers leaves a physically held modifier alone", () => {
        const { target, keyboard } = setup();
        keyboard.keydown(ev("ControlLeft", { ctrlKey: true }), false);
        target.clear();
        keyboard.tapModifier("ControlLeft");
        keyboard.withArmedModifiers((release) => release());
        expect(target.events).toEqual([]);
        expect(keyboard.modifiers.isHeld("ControlLeft")).toBe(true);
    });
});

describe("keydown decisions", () => {
    it("a printable key is sent as a character and the event is claimed", () => {
        const { clock, target, keyboard } = setup();
        const out = keyboard.keydown(printable("a"), true);
        clock.advance(100);
        expect(out.preventDefault).toBe(true);
        expect(target.events).toEqual(["KeyA:down", "KeyA:up"]);
    });

    it("on the hidden-field path printable keys are left to beforeinput and the event is not claimed", () => {
        const { clock, target, keyboard } = setup();
        const out = keyboard.keydown(printable("a"), false);
        clock.advance(100);
        expect(out.preventDefault).toBe(false);
        expect(target.events).toEqual([]);
    });

    it("Shift+Enter arrives as Shift+Enter", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(ev("Enter", { shiftKey: true }), false);
        clock.advance(100);
        expect(target.events).toEqual(["ShiftLeft:down", "Enter:down", "Enter:up", "ShiftLeft:up"]);
    });

    it("an IME composition is not claimed or sent", () => {
        const { clock, target, keyboard } = setup();
        const out = keyboard.keydown(printable("a", { isComposing: true }), true);
        clock.advance(100);
        expect(out.preventDefault).toBe(false);
        expect(target.events).toEqual([]);
    });

    it("an armed modifier is consumed by a chord key too", () => {
        const { clock, keyboard } = setup();
        keyboard.tapModifier("AltLeft");
        keyboard.keydown(ev("Tab"), false);
        clock.advance(100);
        expect(keyboard.armed.getState().armed).toEqual([]);
    });
});

describe("holding a modifier on the host (failure modes 9-10)", () => {
    it("a bare modifier keydown is held on the target once, however often it auto-repeats", () => {
        const { target, keyboard } = setup();
        const out = keyboard.keydown(ev("ControlLeft", { ctrlKey: true }), false);
        keyboard.keydown(ev("ControlLeft", { ctrlKey: true, repeat: true }), false);
        keyboard.keydown(ev("ControlLeft", { ctrlKey: true, repeat: true }), false);
        expect(out.preventDefault).toBe(false);
        expect(target.events).toEqual(["ControlLeft:down"]);
    });

    it("keyup releases it", () => {
        const { target, keyboard } = setup();
        keyboard.keydown(ev("ControlLeft", { ctrlKey: true }), false);
        keyboard.keyup(ev("ControlLeft"));
        expect(target.events).toEqual(["ControlLeft:down", "ControlLeft:up"]);
    });

    it("Ctrl held on the host, then C: the chord leaves Ctrl alone and the keyup releases it once", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(ev("ControlLeft", { ctrlKey: true }), false);
        keyboard.keydown(ev("KeyC", { key: "c", ctrlKey: true }), false);
        clock.advance(100);
        expect(target.events).toEqual(["ControlLeft:down", "KeyC:down", "KeyC:up"]);
        keyboard.keyup(ev("KeyC"));
        keyboard.keyup(ev("ControlLeft"));
        expect(target.events.filter((e) => e === "ControlLeft:up")).toHaveLength(1);
    });

    it("a modifier released while its keys are still queued comes up only after they go out", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(ev("MetaLeft", { metaKey: true }), false);
        keyboard.keydown(ev("ShiftLeft", { metaKey: true, shiftKey: true }), false);
        keyboard.keydown(ev("KeyS", { key: "s", metaKey: true, shiftKey: true }), false);
        // Both modifiers are released before the S chord has played.
        keyboard.keyup(ev("ShiftLeft"));
        keyboard.keyup(ev("MetaLeft"));
        clock.advance(1000);
        const order = target.events;
        const sDown = order.indexOf("KeyS:down");
        expect(sDown).toBeGreaterThan(-1);
        expect(order.indexOf("MetaLeft:up")).toBeGreaterThan(order.indexOf("KeyS:up"));
        expect(order.indexOf("ShiftLeft:up")).toBeGreaterThan(order.indexOf("KeyS:up"));
    });

    it("a deferred release is dropped if the key was pressed again meanwhile", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(ev("ControlLeft", { ctrlKey: true }), false);
        keyboard.sendChord([], "KeyA"); // keep the queue busy
        keyboard.keyup(ev("ControlLeft")); // deferred
        keyboard.keydown(ev("ControlLeft", { ctrlKey: true }), false); // pressed again
        clock.advance(1000);
        expect(keyboard.modifiers.isHeld("ControlLeft")).toBe(true);
        expect(target.events.filter((e) => e === "ControlLeft:up")).toHaveLength(0);
    });

    it("releaseAll lets go of everything held", () => {
        const { target, keyboard } = setup();
        keyboard.keydown(ev("ControlLeft", { ctrlKey: true }), false);
        keyboard.keydown(ev("AltLeft", { altKey: true }), false);
        keyboard.releaseAll();
        expect(keyboard.modifiers.heldCodes()).toEqual([]);
        expect(target.events.filter((e) => e.endsWith("up")).sort()).toEqual(["AltLeft:up", "ControlLeft:up"]);
    });
});

describe("dedupe and repeat admission (failure mode 11)", () => {
    it("the same chord twice inside 60ms is one press (keydown plus a fallback)", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(ev("Enter"), false);
        clock.advance(30);
        keyboard.keydown(ev("Enter"), false);
        clock.advance(1000);
        expect(target.events.filter((e) => e === "Enter:down")).toHaveLength(1);
    });

    it("but passes again after 60ms", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(ev("Enter"), false);
        clock.advance(60);
        keyboard.keydown(ev("Enter"), false);
        clock.advance(1000);
        expect(target.events.filter((e) => e === "Enter:down")).toHaveLength(2);
    });

    it("Shift+Enter straight after Enter is NOT swallowed: the identity includes the modifiers", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(ev("Enter"), false);
        clock.advance(10);
        keyboard.keydown(ev("Enter", { shiftKey: true }), false);
        clock.advance(1000);
        expect(target.events.filter((e) => e === "Enter:down")).toHaveLength(2);
    });

    it("typed characters carry no dedupe, so a fast 'aaa' all lands", () => {
        const { clock, target, keyboard } = setup();
        for (let i = 0; i < 3; i++) keyboard.keydown(printable("a"), true);
        clock.advance(1000);
        expect(target.events.filter((e) => e === "KeyA:down")).toHaveLength(3);
    });

    it("auto-repeat is admitted only while the queue is nearly drained", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(ev("ArrowRight"), false);
        // The host repeats far faster than the queue plays; most are refused.
        for (let i = 0; i < 20; i++) keyboard.keydown(ev("ArrowRight", { repeat: true }), false);
        clock.advance(10_000);
        const presses = target.events.filter((e) => e === "ArrowRight:down").length;
        expect(presses).toBeGreaterThan(1);
        expect(presses).toBeLessThan(6);
    });

    it("auto-repeat of a printable key is throttled the same way", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(printable("a"), true);
        for (let i = 0; i < 20; i++) keyboard.keydown(printable("a", { repeat: true }), true);
        clock.advance(10_000);
        expect(target.events.filter((e) => e === "KeyA:down").length).toBeLessThan(6);
    });

    it("the Enter fallback is skipped when keydown just handled Enter, and sends once otherwise", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(ev("Enter", { shiftKey: true }), false);
        clock.advance(10);
        keyboard.sendEnterFallback();
        clock.advance(1000);
        expect(target.events.filter((e) => e === "Enter:down")).toHaveLength(1);

        target.clear();
        keyboard.sendEnterFallback();
        keyboard.sendEnterFallback(); // repeat of the same event
        clock.advance(1000);
        expect(target.events.filter((e) => e === "Enter:down")).toHaveLength(1);
    });
});

describe("plain Backspace detection (soft keyboard capture rule)", () => {
    it("is plain only with no modifier held and none armed", () => {
        const { keyboard } = setup();
        expect(keyboard.isPlainBackspace({ key: "Backspace" })).toBe(true);
        expect(keyboard.isPlainBackspace({ key: "Backspace", ctrlKey: true })).toBe(false);
        expect(keyboard.isPlainBackspace({ key: "Backspace", altKey: true })).toBe(false);
        expect(keyboard.isPlainBackspace({ key: "Backspace", metaKey: true })).toBe(false);
        expect(keyboard.isPlainBackspace({ key: "a" })).toBe(false);
        keyboard.tapModifier("ControlLeft");
        expect(keyboard.isPlainBackspace({ key: "Backspace" })).toBe(false);
    });

    it("Shift+Backspace is still plain (Shift is not in the list, console parity)", () => {
        const { keyboard } = setup();
        expect(keyboard.isPlainBackspace({ key: "Backspace", shiftKey: true })).toBe(true);
    });
});

describe("host Caps Lock sync (failure modes 12-16)", () => {
    const withCaps = (hostOn: boolean, extra: Partial<KeyEventLike> = {}): KeyEventLike =>
        printable("a", { getModifierState: (k: string) => k === "CapsLock" && hostOn, ...extra });

    const capsPresses = (target: FakeKeyTarget) => target.events.filter((e) => e === "CapsLock:down").length;

    it("a first reading with Caps OFF does nothing", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(withCaps(false), true);
        clock.advance(1000);
        expect(capsPresses(target)).toBe(0);
    });

    it("a first reading with Caps ON toggles a target that is off, ahead of the key", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(withCaps(true), true);
        clock.advance(1000);
        expect(capsPresses(target)).toBe(1);
        expect(target.events.indexOf("CapsLock:down")).toBeLessThan(target.events.indexOf("KeyA:down"));
    });

    it("a first reading with Caps ON does nothing when the target already agrees", () => {
        const { clock, target, keyboard } = setup();
        target.on = true;
        keyboard.keydown(withCaps(true), true);
        clock.advance(1000);
        expect(capsPresses(target)).toBe(0);
    });

    it("a change since the last reading toggles the target", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(withCaps(false), true);
        clock.advance(100);
        keyboard.keydown(withCaps(true), true);
        clock.advance(1000);
        expect(capsPresses(target)).toBe(1);
    });

    it("no change, no toggle", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(withCaps(true), true);
        clock.advance(1000);
        target.reportCaps(true);
        target.clear();
        keyboard.keydown(withCaps(true), true);
        clock.advance(1000);
        expect(capsPresses(target)).toBe(0);
    });

    it("does nothing while the target's LED is unknown", () => {
        const { clock, target, keyboard } = setup();
        target.known = false;
        keyboard.keydown(withCaps(true), true);
        clock.advance(1000);
        expect(capsPresses(target)).toBe(0);
    });

    it("does nothing while a toggle is still in flight", () => {
        const { clock, target, keyboard } = setup();
        target.pending = true;
        keyboard.keydown(withCaps(true), true);
        clock.advance(1000);
        expect(capsPresses(target)).toBe(0);
    });

    it.each([
        ["an IME keyCode 229", { keyCode: 229 }],
        ["Unidentified", { key: "Unidentified" }],
        ["no physical code", { code: "" }],
        ["a composition", { isComposing: true }],
    ] as const)("ignores evidence from %s", (_name, extra) => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(withCaps(true, extra), true);
        clock.advance(1000);
        expect(capsPresses(target)).toBe(0);
    });

    it("ignores events with no getModifierState (a soft keyboard)", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keydown(printable("a"), true);
        clock.advance(1000);
        expect(capsPresses(target)).toBe(0);
    });

    it("the Caps Lock key itself is forwarded bare, then reconciled once the LED has answered", () => {
        const { clock, target, keyboard } = setup();
        const caps = (hostOn: boolean) =>
            ev("CapsLock", { getModifierState: (k: string) => k === "CapsLock" && hostOn });
        keyboard.keydown(caps(true), false);
        clock.advance(100);
        // forwarded as a bare chord by the keydown path, which flips the target's expectation
        expect(capsPresses(target)).toBe(1);
        target.reportCaps(true); // LED agrees with the host: nothing to reconcile
        clock.advance(2000);
        expect(capsPresses(target)).toBe(1);
    });

    it("reconciles with one more press if the target disagrees with the host after 1.4s", () => {
        const { clock, target, keyboard } = setup();
        const caps = (hostOn: boolean) =>
            ev("CapsLock", { getModifierState: (k: string) => k === "CapsLock" && hostOn });
        keyboard.keydown(caps(true), false);
        clock.advance(100);
        target.reportCaps(false); // the press did not take
        clock.advance(1400);
        expect(capsPresses(target)).toBe(2);
    });

    it("a macOS-style lone keyup turning Caps off is reconciled too", () => {
        const { clock, target, keyboard } = setup();
        target.on = true;
        keyboard.keyup(ev("CapsLock", { getModifierState: () => false }));
        clock.advance(1400);
        expect(capsPresses(target)).toBe(1);
    });

    it("reconcile is skipped while a toggle is pending", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keyup(ev("CapsLock", { getModifierState: () => true }));
        target.pending = true;
        clock.advance(2000);
        expect(capsPresses(target)).toBe(0);
    });

    it("a second Caps event restarts the reconcile timer instead of stacking", () => {
        const { clock, target, keyboard } = setup();
        keyboard.keyup(ev("CapsLock", { getModifierState: () => true }));
        clock.advance(1000);
        keyboard.keyup(ev("CapsLock", { getModifierState: () => true }));
        clock.advance(1000);
        expect(capsPresses(target)).toBe(0);
        clock.advance(400);
        expect(capsPresses(target)).toBe(1);
    });
});
