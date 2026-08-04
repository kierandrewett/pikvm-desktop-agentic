import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanMacros, MacroStore, DEFAULT_MACROS } from "../src/macros";

const dir = () => mkdtempSync(join(tmpdir(), "pikvm-macros-"));

test("keeps a well-formed macro and normalises what it can", () => {
    const [macro] = cleanMacros([
        {
            label: "  Capture region  ",
            icon: "⛶extra",
            steps: [
                { type: "chord", mods: ["AltLeft", "ControlLeft"], code: "KeyS" },
                { type: "text", text: "hello" },
                { type: "delay", ms: 250.6 },
            ],
        },
    ]);
    assert.ok(macro);
    assert.equal(macro.label, "Capture region");
    assert.equal(macro.id, "capture-region", "an id is derived when none is given");
    assert.equal([...macro.icon!].length, 2, "the button glyph is capped at two characters");
    assert.equal(macro.pinned, true, "pinned unless explicitly false");
    assert.deepEqual(macro.steps[2], { type: "delay", ms: 251 });
});

test("drops steps that would do nothing rather than sending garbage to the target", () => {
    const macros = cleanMacros([
        {
            label: "Half broken",
            steps: [
                { type: "chord", code: "" }, // no key
                { type: "chord", code: "Key S; rm -rf" }, // not a physical code
                { type: "text", text: "" }, // nothing to type
                { type: "delay", ms: -5 }, // not a pause
                { type: "wat" }, // unknown kind
                { type: "chord", mods: ["ShiftLeft"], code: "Tab" }, // the good one
            ],
        },
    ]);
    assert.equal(macros.length, 1);
    assert.deepEqual(macros[0]!.steps, [{ type: "chord", mods: ["ShiftLeft"], code: "Tab" }]);
});

test("a macro with no usable steps is dropped, not stored empty", () => {
    assert.deepEqual(cleanMacros([{ label: "Empty", steps: [] }]), []);
    assert.deepEqual(cleanMacros([{ label: "", steps: [{ type: "delay", ms: 10 }] }]), []);
});

test("duplicate ids are made unique so one macro cannot shadow another", () => {
    const macros = cleanMacros([
        { id: "same", label: "First", steps: [{ type: "chord", code: "KeyA" }] },
        { id: "same", label: "Second", steps: [{ type: "chord", code: "KeyB" }] },
    ]);
    assert.equal(macros.length, 2);
    assert.notEqual(macros[0]!.id, macros[1]!.id);
});

test("a pause is capped so a macro cannot wedge the queue", () => {
    const [macro] = cleanMacros([
        { label: "Slow", steps: [{ type: "delay", ms: 999_999 }] },
    ]);
    assert.equal((macro!.steps[0] as { ms: number }).ms, 10_000);
});

test("ships the example macro on first run and round-trips a save", () => {
    const path = join(dir(), "macros.json");
    const store = new MacroStore(path);
    assert.deepEqual(store.list(), DEFAULT_MACROS);

    store.replace([
        { label: "Run box", steps: [{ type: "chord", mods: ["MetaLeft"], code: "KeyR" }] },
    ]);
    // Reading it back through a fresh store proves the file, not just memory.
    assert.equal(new MacroStore(path).list()[0]!.label, "Run box");
    assert.ok(readFileSync(path, "utf-8").includes("MetaLeft"));
});

test("a hand-edited bare array is accepted as well as the wrapped shape", () => {
    const path = join(dir(), "macros.json");
    writeFileSync(path, JSON.stringify([{ label: "Bare", steps: [{ type: "chord", code: "F5" }] }]));
    assert.equal(new MacroStore(path).list()[0]!.label, "Bare");
});

test("a corrupt file falls back to the defaults instead of erroring", () => {
    const path = join(dir(), "macros.json");
    writeFileSync(path, "{ not json");
    assert.deepEqual(new MacroStore(path).list(), DEFAULT_MACROS);
});
