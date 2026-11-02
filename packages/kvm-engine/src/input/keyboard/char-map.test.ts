import { describe, expect, it } from "vitest";
import { charToKey, isLetterKey } from "./char-map";

// Failure mode 5 in FAILURE_MODES.md.

describe("US layout", () => {
    it.each([
        ["a", "KeyA", false],
        ["A", "KeyA", true],
        ["1", "Digit1", false],
        ["!", "Digit1", true],
        ["`", "Backquote", false],
        ["~", "Backquote", true],
        ["[", "BracketLeft", false],
        ["{", "BracketLeft", true],
        ["\\", "Backslash", false],
        ["|", "Backslash", true],
        [";", "Semicolon", false],
        [":", "Semicolon", true],
        ["'", "Quote", false],
        ['"', "Quote", true],
        ["/", "Slash", false],
        ["?", "Slash", true],
        ["-", "Minus", false],
        ["_", "Minus", true],
        ["=", "Equal", false],
        ["+", "Equal", true],
        [" ", "Space", false],
    ])("%j -> %s shift=%s", (ch, code, shift) => {
        expect(charToKey(ch, "us")).toEqual({ code, shift });
    });

    it("every printable ASCII character has a key, and no two share code and shift", () => {
        const seen = new Map<string, string>();
        for (let c = 0x20; c < 0x7f; c++) {
            const ch = String.fromCharCode(c);
            const key = charToKey(ch, "us");
            expect(key, ch).not.toBeNull();
            const id = `${key?.code}|${key?.shift}`;
            expect(seen.get(id), `${ch} collides with ${seen.get(id)}`).toBeUndefined();
            seen.set(id, ch);
        }
    });

    it("characters the layout has no key for are null (they must be pasted instead)", () => {
        expect(charToKey("\u00e9", "us")).toBeNull();
        expect(charToKey("\u20ac", "us")).toBeNull();
        expect(charToKey("\n", "us")).toBeNull();
    });
});

describe("UK layout", () => {
    it.each([
        ['"', "Digit2", true],
        ["@", "Quote", true],
        ["#", "Backslash", false],
        ["~", "Backslash", true],
        ["\\", "IntlBackslash", false],
        ["|", "IntlBackslash", true],
        ["\u00a3", "Digit3", true],
        ["\u00ac", "Backquote", true],
    ])("%j -> %s shift=%s", (ch, code, shift) => {
        expect(charToKey(ch, "uk")).toEqual({ code, shift });
    });

    it("falls through to the US map for everything not overridden", () => {
        expect(charToKey("a", "uk")).toEqual({ code: "KeyA", shift: false });
        expect(charToKey("/", "uk")).toEqual({ code: "Slash", shift: false });
    });

    it("the pound sign exists only on UK", () => {
        expect(charToKey("\u00a3", "us")).toBeNull();
    });
});

describe("isLetterKey", () => {
    it("is true for A-Z keys only", () => {
        expect(isLetterKey("KeyA")).toBe(true);
        expect(isLetterKey("KeyZ")).toBe(true);
        expect(isLetterKey("Digit1")).toBe(false);
        expect(isLetterKey("Space")).toBe(false);
        expect(isLetterKey("KeyAA")).toBe(false);
    });
});
