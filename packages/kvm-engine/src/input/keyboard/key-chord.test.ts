import { describe, expect, it } from "vitest";
import { chordMods, decide as rawDecide, type KeyEventLike } from "./key-chord";
import { createModifierMirror } from "./modifier-mirror";

// Failure modes 1-4 in FAILURE_MODES.md (ported from tests/key-chord.test.ts).

function ev(code: string, extra: Partial<KeyEventLike> = {}): KeyEventLike {
    return { code, key: code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...extra };
}

const decide = (e: KeyEventLike, opts: { armed?: string[]; printable?: boolean } = {}) =>
    rawDecide(e, { printable: true, ...opts });

describe("decide", () => {
    it("Shift+Enter reaches the target as Shift+Enter", () => {
        expect(decide(ev("Enter", { shiftKey: true }))).toEqual({ kind: "chord", code: "Enter", mods: ["ShiftLeft"] });
    });

    it("a plain Enter carries no modifiers", () => {
        expect(decide(ev("Enter"))).toEqual({ kind: "chord", code: "Enter", mods: [] });
    });

    it("Shift is kept on every control key, not just the printable ones", () => {
        for (const code of ["Tab", "Backspace", "Delete", "Home", "End", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Escape"]) {
            expect(decide(ev(code, { shiftKey: true })), code).toEqual({ kind: "chord", code, mods: ["ShiftLeft"] });
        }
    });

    it("Ctrl+Shift+Escape stays Task Manager and does not decay into Ctrl+Escape", () => {
        const d = decide(ev("Escape", { ctrlKey: true, shiftKey: true }));
        expect(d).toEqual({ kind: "chord", code: "Escape", mods: ["ControlLeft", "ShiftLeft"] });
    });

    it("function keys carry their modifiers", () => {
        expect(decide(ev("F5"))).toMatchObject({ mods: [] });
        expect(decide(ev("F5", { shiftKey: true }))).toMatchObject({ mods: ["ShiftLeft"] });
        expect(decide(ev("F12", { ctrlKey: true, altKey: true }))).toMatchObject({ mods: ["ControlLeft", "AltLeft"] });
    });

    it("a hardware chord keeps every held modifier", () => {
        expect(decide(ev("KeyT", { key: "T", ctrlKey: true, shiftKey: true }))).toEqual({
            kind: "chord",
            code: "KeyT",
            mods: ["ControlLeft", "ShiftLeft"],
        });
    });

    it("Shift+letter goes down the printable path so the layout resolves the glyph", () => {
        expect(decide(ev("KeyA", { key: "A", shiftKey: true }))).toEqual({ kind: "char", char: "A" });
    });

    it("the hidden-field path leaves printable keys to beforeinput", () => {
        expect(decide(ev("KeyA", { key: "a" }), { printable: false })).toEqual({
            kind: "ignore",
            why: "printable-handled-elsewhere",
        });
        // ...but still owns the control keys and the hardware chords.
        expect(decide(ev("Enter", { shiftKey: true }), { printable: false }).kind).toBe("chord");
        expect(decide(ev("KeyC", { key: "c", ctrlKey: true }), { printable: false }).kind).toBe("chord");
    });

    it("armed sticky modifiers merge with the held ones without duplicating Shift", () => {
        expect(decide(ev("Enter", { shiftKey: true }), { armed: ["ShiftLeft"] })).toMatchObject({ mods: ["ShiftLeft"] });
        expect(decide(ev("Enter"), { armed: ["ControlLeft"] })).toMatchObject({ mods: ["ControlLeft"] });
        expect(decide(ev("Delete", { ctrlKey: true }), { armed: ["AltLeft"] })).toMatchObject({
            mods: ["ControlLeft", "AltLeft"],
        });
    });

    it("a physical ShiftRight is not doubled up with a synthetic ShiftLeft", () => {
        expect(decide(ev("Enter", { shiftKey: true }), { armed: ["ShiftRight"] })).toMatchObject({ mods: ["ShiftRight"] });
    });

    it("bare modifiers ride the chord instead of being sent on their own", () => {
        for (const code of ["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]) {
            expect(decide(ev(code)), code).toEqual({ kind: "ignore", why: "bare-modifier" });
        }
    });

    it("Caps Lock is forwarded bare, even with modifiers held", () => {
        const d = decide(ev("CapsLock", { shiftKey: true }), { armed: ["ControlLeft"] });
        expect(d).toEqual({ kind: "chord", code: "CapsLock", mods: [] });
    });

    it("Caps Lock is recognised by key when a soft keyboard sends no code", () => {
        expect(decide({ key: "CapsLock" })).toEqual({ kind: "chord", code: "CapsLock", mods: [] });
    });

    it("an IME composition is left alone", () => {
        expect(decide(ev("KeyA", { key: "a", isComposing: true }))).toEqual({ kind: "ignore", why: "composing" });
    });

    it("an unmapped named key still goes out as a chord", () => {
        expect(decide(ev("Insert", { shiftKey: true }))).toEqual({ kind: "chord", code: "Insert", mods: ["ShiftLeft"] });
    });

    it("a soft keyboard reporting no code still resolves a named key", () => {
        expect(decide({ code: "", key: "Enter" })).toEqual({ kind: "chord", code: "Enter", mods: [] });
    });

    it("a hardware chord with no code is ignored rather than sent as nothing", () => {
        expect(decide({ key: "c", ctrlKey: true })).toEqual({ kind: "ignore", why: "no-code" });
    });

    it("a printable key with a multi-character name and no code is ignored", () => {
        expect(decide({ key: "Dead" })).toEqual({ kind: "ignore", why: "no-code" });
    });

    it("a key named like an object prototype member is not mistaken for a control key", () => {
        expect(decide({ code: "", key: "constructor" })).toEqual({ kind: "ignore", why: "no-code" });
        expect(decide({ code: "toString", key: "toString" })).toEqual({ kind: "chord", code: "toString", mods: [] });
    });

    it("armed modifiers apply to a control key from a soft keyboard", () => {
        expect(decide({ key: "Backspace" }, { armed: ["ControlLeft"] })).toEqual({
            kind: "chord",
            code: "Backspace",
            mods: ["ControlLeft"],
        });
    });
});

describe("chordMods", () => {
    it("orders held modifiers Ctrl, Alt, Meta, then armed, then Shift", () => {
        expect(chordMods(ev("KeyA", { ctrlKey: true, altKey: true, metaKey: true, shiftKey: true }), ["AltRight"])).toEqual([
            "ControlLeft",
            "AltLeft",
            "MetaLeft",
            "AltRight",
            "ShiftLeft",
        ]);
    });

    it("does not duplicate an armed modifier that is also held", () => {
        expect(chordMods(ev("KeyA", { ctrlKey: true }), ["ControlLeft"])).toEqual(["ControlLeft"]);
    });
});

describe("modifier mirror", () => {
    const setup = () => {
        const sent: Array<[string, boolean]> = [];
        const mirror = createModifierMirror((code, down) => sent.push([code, down]));
        return { sent, mirror };
    };

    it("holds a modifier down until the user lets go", () => {
        const { sent, mirror } = setup();
        mirror.press("ControlLeft");
        expect(sent).toEqual([["ControlLeft", true]]);
        // Auto-repeat fires keydown over and over; the target must see one press.
        mirror.press("ControlLeft");
        expect(sent).toHaveLength(1);
        expect(mirror.isHeld("ControlLeft")).toBe(true);

        mirror.release("ControlLeft");
        expect(sent[1]).toEqual(["ControlLeft", false]);
        // A second keyup (or a blur after one) must not send a stray release.
        mirror.release("ControlLeft");
        expect(sent).toHaveLength(2);
    });

    it("does not let a chord release a modifier the user is holding", () => {
        const { mirror } = setup();
        mirror.press("ControlLeft");
        // The chord wants Ctrl+Shift+T; Ctrl is the user's, Shift is the chord's.
        expect(mirror.owned(["ControlLeft", "ShiftLeft"])).toEqual(["ShiftLeft"]);
        expect(mirror.isHeld("ControlLeft")).toBe(true);
    });

    it("gives a chord everything when nothing is held", () => {
        const { mirror } = setup();
        expect(mirror.owned(["ControlLeft", "AltLeft"])).toEqual(["ControlLeft", "AltLeft"]);
        expect(mirror.owned([])).toEqual([]);
    });

    it("releases everything at once, and only once", () => {
        const { sent, mirror } = setup();
        mirror.press("ControlLeft");
        mirror.press("ShiftLeft");
        sent.length = 0;
        expect(mirror.releaseAll().sort()).toEqual(["ControlLeft", "ShiftLeft"]);
        expect(sent.map(([c, d]) => `${c}:${d}`).sort()).toEqual(["ControlLeft:false", "ShiftLeft:false"]);
        expect(mirror.heldCodes()).toEqual([]);
        sent.length = 0;
        mirror.releaseAll();
        expect(sent).toEqual([]);
    });

    it("ignores an empty code", () => {
        const { sent, mirror } = setup();
        expect(mirror.press("")).toBe(false);
        expect(mirror.release("")).toBe(false);
        expect(sent).toEqual([]);
    });
});
