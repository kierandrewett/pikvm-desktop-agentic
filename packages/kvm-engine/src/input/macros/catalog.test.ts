import { describe, expect, it } from "vitest";
import { MACRO_CHORD_MS, MACRO_MODS, macroDuration, macroGlyph, macroKeyGroups, macroNeedsInput } from "./catalog";

// Failure modes 10-12 in FAILURE_MODES.md.

// The server's own key-code shape (the macro store's validator, mirrored in @pikvm/contracts KeyCode).
const SERVER_KEY_CODE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;

describe("what the editor offers (failure mode 10)", () => {
    const codes = macroKeyGroups().flatMap(([, keys]) => keys.map(([code]) => code));

    it("is a full keyboard with no duplicates", () => {
        expect(codes.length).toBeGreaterThan(100);
        expect(new Set(codes).size).toBe(codes.length);
    });

    it("every offered key and modifier survives the server's validation, or the macro would be silently dropped", () => {
        for (const code of codes) expect(code, code).toMatch(SERVER_KEY_CODE);
        for (const [code] of MACRO_MODS) expect(code, code).toMatch(SERVER_KEY_CODE);
    });

    it("offers AltGr separately from Alt", () => {
        expect(MACRO_MODS.map(([c]) => c)).toEqual(["ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft", "AltRight"]);
    });

    it("includes keys a laptop does not have: F13-F24 and the numpad", () => {
        expect(codes).toContain("F24");
        expect(codes).toContain("Numpad0");
        expect(codes).toContain("NumpadEnter");
    });
});

describe("macroGlyph (failure mode 11)", () => {
    it("falls back to the label's initials unless the icon is drawable", () => {
        expect(macroGlyph({ icon: "not-a-real-icon", label: "Short 0" })).toBe("SH");
        expect(macroGlyph({ label: "Reboot now" })).toBe("RE");
        expect(macroGlyph({ icon: "   ", label: "Reboot now" })).toBe("RE");
    });

    it("keeps a one or two character glyph someone meant", () => {
        expect(macroGlyph({ icon: "\u26a1", label: "Reboot now" })).toBe("\u26a1");
        expect(macroGlyph({ icon: "OK", label: "Reboot now" })).toBe("OK");
        expect(macroGlyph({ icon: "\u{1F600}\u{1F600}", label: "Reboot now" })).toBe("\u{1F600}\u{1F600}");
    });
});

describe("estimates (failure mode 12)", () => {
    it("charges a chord a flat 120ms, text at the paste rate and delays as given", () => {
        expect(
            macroDuration({
                steps: [
                    { type: "chord", code: "KeyA" },
                    { type: "text", text: "x".repeat(100) },
                    { type: "delay", ms: 500 },
                ],
            }),
        ).toBeCloseTo(MACRO_CHORD_MS + 2000 + 500);
    });

    it("tolerates junk", () => {
        expect(macroDuration(null)).toBe(0);
        expect(macroDuration({ steps: [{ type: "delay", ms: Number.NaN }] })).toBe(0);
    });

    it("needs input only when there is a chord step", () => {
        expect(macroNeedsInput({ steps: [{ type: "text", text: "a" }, { type: "delay", ms: 1 }] })).toBe(false);
        expect(macroNeedsInput({ steps: [{ type: "delay", ms: 1 }, { type: "chord", code: "KeyA" }] })).toBe(true);
        expect(macroNeedsInput(null)).toBe(false);
    });
});
