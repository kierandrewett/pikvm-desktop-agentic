// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createManualClock } from "../../clock/index";
import { FakeKeyTarget } from "../../testing/fake-key-target";
import { createKeyboard } from "../keyboard/keyboard";
import { bindHiddenField } from "./hidden-field.dom";
import { KB_PAD } from "./field-mirror";

// Failure modes 10-14 in FAILURE_MODES.md: the adapter wired to a real keyboard on a real
// (jsdom) input, asserted on what reaches the target.

let cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
});

function setup(isBlocked?: () => boolean) {
    const clock = createManualClock(1_000_000);
    const target = new FakeKeyTarget(() => clock.now());
    const keyboard = createKeyboard({ clock, target });
    const el = document.createElement("input");
    document.body.appendChild(el);
    const binding = bindHiddenField(el, { keyboard, ...(isBlocked ? { isBlocked } : {}) });
    cleanup.push(() => {
        binding.unbind();
        el.remove();
    });
    const downs = (): string[] => target.events.filter((e) => e.endsWith(":down")).map((e) => e.replace(":down", ""));
    /** Type into the field the way a browser does: change the value, fire input. */
    const input = (value: string, init: InputEventInit = {}): void => {
        el.value = value;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, ...init }));
    };
    const key = (type: "keydown" | "keyup", init: KeyboardEventInit): KeyboardEvent => {
        const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
        el.dispatchEvent(e);
        return e;
    };
    return { clock, target, keyboard, el, binding, downs, input, key };
}

describe("field to wire", () => {
    it("starts at the pad", () => {
        const { el } = setup();
        expect(el.value).toBe(KB_PAD);
    });

    it("typing in the field types on the target", () => {
        const { clock, el, input, downs } = setup();
        input(`${el.value}Hi`);
        clock.advance(1000);
        expect(downs()).toEqual(["ShiftLeft", "KeyH", "KeyI"]);
    });

    it("a Backspace on the empty field reaches the target once, through the diff", () => {
        const { clock, el, input, key, downs } = setup();
        // Plain Backspace keydown is left to the field (not forwarded as a chord)...
        const e = key("keydown", { key: "Backspace", code: "Backspace" });
        expect(e.defaultPrevented).toBe(false);
        clock.advance(1000);
        expect(downs()).toEqual([]);
        // ...and the browser then deletes a pad character, which the diff turns into one Backspace.
        input(el.value.slice(0, -1));
        clock.advance(1000);
        expect(downs()).toEqual(["Backspace"]);
    });

    it("plain Backspace does not propagate to listeners above the field (no second forwarder)", () => {
        const { el, key } = setup();
        let seen = 0;
        document.body.addEventListener("keydown", () => seen++);
        key("keydown", { key: "Backspace", code: "Backspace" });
        expect(seen).toBe(0);
        key("keydown", { key: "a", code: "KeyA" });
        expect(seen).toBeGreaterThan(0);
        expect(el.value).toBe(KB_PAD);
    });

    it("Ctrl+Backspace is a chord, not left to the field", () => {
        const { clock, key, downs } = setup();
        const e = key("keydown", { key: "Backspace", code: "Backspace", ctrlKey: true });
        clock.advance(1000);
        expect(e.defaultPrevented).toBe(true);
        expect(downs()).toEqual(["ControlLeft", "Backspace"]);
    });
});

describe("keys the target took from keydown (failure mode 12)", () => {
    it("an arrow key sends the chord and starts the field over", () => {
        const { clock, el, input, key, downs } = setup();
        input(`${KB_PAD}abc`);
        clock.advance(1000);
        const e = key("keydown", { key: "ArrowLeft", code: "ArrowLeft" });
        expect(e.defaultPrevented).toBe(true);
        expect(el.value).toBe(KB_PAD);
        clock.advance(1000);
        expect(downs()).toContain("ArrowLeft");
    });

    it("a data-key button (sendCode) starts the field over too", () => {
        const { el, input, keyboard } = setup();
        input(`${KB_PAD}abc`);
        keyboard.sendCode("Tab");
        expect(el.value).toBe(KB_PAD);
    });

    it("a printable keydown on the hidden field is left alone (beforeinput/input produce the character)", () => {
        const { clock, key, downs } = setup();
        const e = key("keydown", { key: "a", code: "KeyA" });
        clock.advance(1000);
        expect(e.defaultPrevented).toBe(false);
        expect(downs()).toEqual([]);
    });
});

describe("Enter (failure mode 13)", () => {
    it("beforeinput's insertLineBreak sends Enter once and is cancelled", () => {
        const { clock, el, downs } = setup();
        const e = new InputEvent("beforeinput", { inputType: "insertLineBreak", bubbles: true, cancelable: true });
        el.dispatchEvent(e);
        clock.advance(1000);
        expect(e.defaultPrevented).toBe(true);
        expect(downs()).toEqual(["Enter"]);
    });

    it("is not repeated when keydown already sent Shift+Enter", () => {
        const { clock, el, key, downs } = setup();
        key("keydown", { key: "Enter", code: "Enter", shiftKey: true });
        clock.advance(10);
        el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertParagraph", bubbles: true, cancelable: true }));
        clock.advance(1000);
        expect(downs().filter((d) => d === "Enter")).toHaveLength(1);
    });

    it("other beforeinput types are untouched", () => {
        const { el } = setup();
        const e = new InputEvent("beforeinput", { inputType: "insertText", data: "a", bubbles: true, cancelable: true });
        el.dispatchEvent(e);
        expect(e.defaultPrevented).toBe(false);
    });
});

describe("composition and blur", () => {
    it("a committed IME word is typed at compositionend", () => {
        const { clock, el, input, downs } = setup();
        el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        input(`${KB_PAD}he`, { isComposing: true });
        clock.advance(1000);
        el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        clock.advance(1000);
        expect(downs().filter((d) => d === "KeyH" || d === "KeyE")).toEqual(["KeyH", "KeyE"]);
    });

    it("blur clears the field", () => {
        const { el, input } = setup();
        input(`${KB_PAD}abc`);
        el.dispatchEvent(new FocusEvent("blur"));
        expect(el.value).toBe(KB_PAD);
    });
});

describe("blocked input (failure mode 14)", () => {
    it("swallows keydown, beforeinput and input while a modal or the full UI owns the keyboard", () => {
        let blocked = true;
        const { clock, el, input, key, downs } = setup(() => blocked);
        const k = key("keydown", { key: "Enter", code: "Enter" });
        expect(k.defaultPrevented).toBe(true);
        const b = new InputEvent("beforeinput", { inputType: "insertLineBreak", bubbles: true, cancelable: true });
        el.dispatchEvent(b);
        expect(b.defaultPrevented).toBe(true);
        input(`${KB_PAD}typed`);
        clock.advance(1000);
        expect(downs()).toEqual([]);
        expect(el.value).toBe(KB_PAD);
        blocked = false;
        input(`${KB_PAD}x`);
        clock.advance(1000);
        expect(downs()).toEqual(["KeyX"]);
    });
});

describe("unbind", () => {
    it("stops forwarding", () => {
        const { clock, el, binding, input, downs } = setup();
        binding.unbind();
        input(`${KB_PAD}a`);
        clock.advance(1000);
        expect(downs()).toEqual([]);
        expect(el.value).toBe(`${KB_PAD}a`);
    });
});
