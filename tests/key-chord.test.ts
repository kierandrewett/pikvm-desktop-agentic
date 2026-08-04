import assert from "node:assert/strict";
import test from "node:test";

// Plain browser script (UMD) shared with the console renderer.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const KeyChord = require("../src/views/key-chord.js") as {
    decide(ev: Record<string, unknown>, opts?: { armed?: string[]; printable?: boolean }): {
        kind: string;
        mods?: string[];
        code?: string;
        char?: string;
        why?: string;
    };
};

/** A KeyboardEvent-shaped object. */
function ev(code: string, extra: Record<string, unknown> = {}) {
    return { code, key: code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...extra };
}

const decide = (e: Record<string, unknown>, opts = {}) => KeyChord.decide(e, { printable: true, ...opts });

test("Shift+Enter reaches the target as Shift+Enter", () => {
    const d = decide(ev("Enter", { key: "Enter", shiftKey: true }));
    assert.equal(d.kind, "chord");
    assert.equal(d.code, "Enter");
    assert.deepEqual(d.mods, ["ShiftLeft"]);
});

test("a plain Enter carries no modifiers", () => {
    const d = decide(ev("Enter", { key: "Enter" }));
    assert.deepEqual(d.mods, []);
    assert.equal(d.code, "Enter");
});

test("Shift is kept on every control key, not just the printable ones", () => {
    for (const code of ["Tab", "Backspace", "Delete", "Home", "End", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown"]) {
        const d = decide(ev(code, { key: code, shiftKey: true }));
        assert.equal(d.kind, "chord", code);
        assert.equal(d.code, code);
        assert.deepEqual(d.mods, ["ShiftLeft"], code);
    }
});

test("Ctrl+Shift+Escape stays Task Manager and does not decay into Ctrl+Escape", () => {
    const d = decide(ev("Escape", { key: "Escape", ctrlKey: true, shiftKey: true }));
    assert.equal(d.code, "Escape");
    assert.deepEqual(d.mods, ["ControlLeft", "ShiftLeft"]);
});

test("function keys carry their modifiers", () => {
    assert.deepEqual(decide(ev("F5", { key: "F5" })).mods, []);
    assert.deepEqual(decide(ev("F5", { key: "F5", shiftKey: true })).mods, ["ShiftLeft"]);
    assert.deepEqual(decide(ev("F12", { key: "F12", ctrlKey: true, altKey: true })).mods, ["ControlLeft", "AltLeft"]);
});

test("a hardware chord keeps every held modifier", () => {
    const d = decide(ev("KeyT", { key: "T", ctrlKey: true, shiftKey: true }));
    assert.equal(d.kind, "chord");
    assert.equal(d.code, "KeyT");
    assert.deepEqual(d.mods, ["ControlLeft", "ShiftLeft"]);
});

test("Shift+letter goes down the printable path so the layout resolves the glyph", () => {
    const d = decide(ev("KeyA", { key: "A", shiftKey: true }));
    assert.equal(d.kind, "char");
    assert.equal(d.char, "A");
});

test("the hidden-field path leaves printable keys to beforeinput", () => {
    assert.equal(decide(ev("KeyA", { key: "a" }), { printable: false }).kind, "ignore");
    // ...but still owns the control keys and the hardware chords.
    assert.equal(decide(ev("Enter", { key: "Enter", shiftKey: true }), { printable: false }).kind, "chord");
    assert.equal(decide(ev("KeyC", { key: "c", ctrlKey: true }), { printable: false }).kind, "chord");
});

test("armed sticky modifiers merge with the held ones without duplicating Shift", () => {
    const d = decide(ev("Enter", { key: "Enter", shiftKey: true }), { armed: ["ShiftLeft"] });
    assert.deepEqual(d.mods, ["ShiftLeft"], "a doubled ShiftLeft would leave it stuck down on the target");

    const armedOnly = decide(ev("Enter", { key: "Enter" }), { armed: ["ControlLeft"] });
    assert.deepEqual(armedOnly.mods, ["ControlLeft"]);

    const both = decide(ev("Delete", { key: "Delete", ctrlKey: true }), { armed: ["AltLeft"] });
    assert.deepEqual(both.mods, ["ControlLeft", "AltLeft"]);
});

test("a physical ShiftRight is not doubled up with a synthetic ShiftLeft", () => {
    const d = decide(ev("Enter", { key: "Enter", shiftKey: true }), { armed: ["ShiftRight"] });
    assert.deepEqual(d.mods, ["ShiftRight"]);
});

test("bare modifiers ride the chord instead of being sent on their own", () => {
    for (const code of ["ShiftLeft", "ShiftRight", "ControlLeft", "AltLeft", "MetaLeft"]) {
        assert.equal(decide(ev(code)).kind, "ignore", code);
    }
});

test("Caps Lock is swallowed, never forwarded", () => {
    const d = decide(ev("CapsLock"));
    assert.equal(d.kind, "swallow");
});

test("an IME composition is left alone", () => {
    assert.equal(decide(ev("KeyA", { key: "a", isComposing: true })).kind, "ignore");
});

test("an unmapped named key still goes out as a chord", () => {
    const d = decide(ev("Insert", { key: "Insert", shiftKey: true }));
    assert.equal(d.kind, "chord");
    assert.equal(d.code, "Insert");
    assert.deepEqual(d.mods, ["ShiftLeft"]);
});

test("a soft keyboard reporting no code still resolves a named key", () => {
    const d = decide({ code: "", key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
    assert.equal(d.kind, "chord");
    assert.equal(d.code, "Enter");
});
