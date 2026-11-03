import { describe, expect, it } from "vitest";
import { assess, describeCall, needsApproval } from "./risk";

const FRESH = { lookAgeMs: 100 };

describe("assess", () => {
    it("looking is never risky, whatever the look age", () => {
        for (const tool of ["screenshot", "read_text", "wait", "screen_info"]) {
            expect(assess(tool, {}, { lookAgeMs: null })).toEqual({ level: "observe", reasons: [] });
        }
    });

    it("plain input is input, not risky", () => {
        expect(assess("click", { x: 1, y: 2 }, FRESH).level).toBe("input");
        expect(assess("type_text", { text: "ls -la" }, FRESH).level).toBe("input");
        expect(assess("key", { keys: ["ctrl+c", "Enter"] }, FRESH).level).toBe("input");
    });

    it("power is always, and says what it does", () => {
        expect(assess("power", { action: "reset" }, FRESH)).toEqual({ level: "always", reasons: ["it resets the target"] });
        expect(assess("power", { action: "off" }, FRESH).reasons).toEqual(["it switches off the target"]);
    });

    it("a key list the schema would have refused is flagged rather than crashing the rules", () => {
        expect(assess("key", { keys: ["ctrl+banana"] }, FRESH).reasons).toEqual(["ctrl+banana is not a key chord I can read"]);
    });

    it("folds left and right and the order of modifiers when matching a chord", () => {
        expect(assess("key", { keys: ["Shift+Ctrl+Delete"] }, FRESH).level).toBe("risky");
        expect(assess("key", { keys: ["Alt+f4"] }, FRESH).level).toBe("risky");
        expect(assess("key", { keys: ["Cmd"] }, FRESH).level).toBe("risky");
        expect(assess("key", { keys: ["super+r"] }, FRESH).level).toBe("input");
    });
});

describe("needsApproval", () => {
    const risky = { level: "risky", reasons: ["x"] } as const;
    const input = { level: "input", reasons: [] } as const;
    const always = { level: "always", reasons: ["x"] } as const;
    const observe = { level: "observe", reasons: [] } as const;

    it.each([
        ["risky", [false, false, true, true]],
        ["always", [false, true, true, true]],
        ["never", [false, false, false, true]],
    ] as const)("policy %s over observe, input, risky, always", (mode, expected) => {
        expect([observe, input, risky, always].map((r) => needsApproval(r, mode))).toEqual(expected);
    });
});

describe("describeCall", () => {
    it("writes a question and a summary for every tool that asks", () => {
        expect(describeCall("key", { keys: ["alt+F4", "Enter"] })).toEqual({
            title: "Press alt+F4, Enter on the PiKVM?",
            summary: "Press the key chord alt+F4, Enter.",
        });
        expect(describeCall("power", { action: "off" }).title).toBe("Power off the target?");
        expect(describeCall("click", { x: 3, y: 4 }).summary).toBe("Click at (3, 4).");
    });
});
