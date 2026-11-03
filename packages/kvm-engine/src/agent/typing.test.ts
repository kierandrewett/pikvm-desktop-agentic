import { describe, expect, it } from "vitest";
import { layoutFromKeymap, planText } from "./typing";

describe("planText", () => {
    it("types letters, digits and punctuation as physical keys with Shift where the glyph needs it", () => {
        expect(planText("aB1!", "us", false).strokes).toEqual([
            { code: "KeyA", shift: false },
            { code: "KeyB", shift: true },
            { code: "Digit1", shift: false },
            { code: "Digit1", shift: true },
        ]);
    });

    it("a newline is Enter and a tab is Tab, and a Windows line ending is one Enter", () => {
        expect(planText("a\nb\r\nc\td", "us", false).strokes.map((s) => s.code)).toEqual([
            "KeyA",
            "Enter",
            "KeyB",
            "Enter",
            "KeyC",
            "Tab",
            "KeyD",
        ]);
    });

    it("uses the UK ISO keys for the characters that move", () => {
        expect(planText('"@#~\\|', "uk", false).strokes).toEqual([
            { code: "Digit2", shift: true },
            { code: "Quote", shift: true },
            { code: "Backslash", shift: false },
            { code: "Backslash", shift: true },
            { code: "IntlBackslash", shift: false },
            { code: "IntlBackslash", shift: true },
        ]);
        expect(planText('"', "us", false).strokes).toEqual([{ code: "Quote", shift: true }]);
    });

    it("inverts Shift for letters, and only letters, while the target's Caps Lock is on", () => {
        expect(planText("aB1!", "us", true).strokes).toEqual([
            { code: "KeyA", shift: true },
            { code: "KeyB", shift: false },
            { code: "Digit1", shift: false },
            { code: "Digit1", shift: true },
        ]);
    });

    it("names every character the layout cannot type, once, instead of dropping it", () => {
        const plan = planText("caf\u00e9 \u{1f600} caf\u00e9", "us", false);
        expect(plan.unmappable).toEqual(["\u00e9", "\u{1f600}"]);
    });
});

describe("layoutFromKeymap", () => {
    it("is UK only for the en-gb family", () => {
        expect(layoutFromKeymap("en-gb")).toBe("uk");
        expect(layoutFromKeymap("EN-GB")).toBe("uk");
        expect(layoutFromKeymap("en-us")).toBe("us");
        expect(layoutFromKeymap("de")).toBe("us");
        expect(layoutFromKeymap(undefined)).toBe("us");
    });
});
