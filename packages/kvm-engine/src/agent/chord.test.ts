import { describe, expect, it } from "vitest";
import { ChordError, parseChord } from "./chord";

describe("parseChord", () => {
    it("reads modifiers then a key into physical codes", () => {
        expect(parseChord("ctrl+c")).toMatchObject({ mods: ["ControlLeft"], key: "KeyC", canonical: "ctrl+c" });
        expect(parseChord("Ctrl+Shift+Delete")).toMatchObject({
            mods: ["ControlLeft", "ShiftLeft"],
            key: "Delete",
            canonical: "ctrl+shift+delete",
        });
        expect(parseChord("Alt+F4")).toMatchObject({ mods: ["AltLeft"], key: "F4", canonical: "alt+f4" });
        expect(parseChord("enter")).toMatchObject({ mods: [], key: "Enter" });
        expect(parseChord("ctrl+/")).toMatchObject({ key: "Slash" });
        expect(parseChord("ctrl+1")).toMatchObject({ key: "Digit1" });
    });

    it("a modifier on its own is a chord with no key", () => {
        expect(parseChord("super")).toEqual({ mods: ["MetaLeft"], key: null, canonical: "meta" });
        expect(parseChord("Win")).toMatchObject({ canonical: "meta" });
        expect(parseChord("cmd").canonical).toBe("meta");
    });

    it("spells one chord one way, whatever order and names it came in", () => {
        expect(parseChord("shift+ctrl+x").canonical).toBe(parseChord("control+shift+X").canonical);
        expect(parseChord("option+tab").canonical).toBe("alt+tab");
        expect(parseChord("ctrl+alt+del").canonical).toBe("ctrl+alt+delete");
    });

    it("accepts a raw code the model already knows", () => {
        expect(parseChord("ArrowUp")).toMatchObject({ key: "ArrowUp" });
        expect(parseChord("ctrl+KeyA")).toMatchObject({ key: "KeyA" });
    });

    it.each([
        ["", /empty/],
        ["ctrl+", /empty part/],
        ["ctrl++", /empty part/],
        ["ctrl+banana", /"banana" is not a key name/],
        ["ctrl+a+b", /two non-modifier keys/],
    ])("refuses %j before anything is sent", (text, message) => {
        expect(() => parseChord(text)).toThrow(ChordError);
        expect(() => parseChord(text)).toThrow(message);
    });
});
