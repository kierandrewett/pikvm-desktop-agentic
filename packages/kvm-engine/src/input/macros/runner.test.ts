import { describe, expect, it } from "vitest";
import { createManualClock } from "../../clock/index";
import type { HttpResponse } from "../../http";
import { FakeHttp, status } from "../../testing/fake-socket";
import { FakeKeyTarget } from "../../testing/fake-key-target";
import { createKeyboard } from "../keyboard/keyboard";
import type { Notice } from "../notice";
import { createTypingGate } from "../typing-gate";
import type { MacroLike } from "./catalog";
import { createMacroRunner } from "./runner";

// Failure modes 1-9 in FAILURE_MODES.md.

function setup(opts: { inputOpen?: boolean; keymap?: string | null } = {}) {
    const clock = createManualClock(1_000_000);
    const target = new FakeKeyTarget(() => clock.now());
    const keyboard = createKeyboard({ clock, target });
    const http = new FakeHttp();
    const gate = createTypingGate();
    const notices: Notice[] = [];
    const state = { inputOpen: opts.inputOpen ?? true, keymap: opts.keymap ?? null };
    const runner = createMacroRunner({
        clock,
        keys: keyboard,
        isInputOpen: () => state.inputOpen,
        http,
        gate,
        keymap: () => state.keymap,
        notify: (n) => notices.push(n),
    });
    /** Let the run's promise-based steps and timers play out. */
    const settle = (ms = 0): Promise<void> => clock.advanceAsync(ms);
    return { clock, target, http, gate, notices, runner, state, settle };
}

const cad: MacroLike = {
    label: "CAD then hi",
    steps: [
        { type: "chord", mods: ["ControlLeft", "AltLeft"], code: "Delete" },
        { type: "text", text: "hi" },
    ],
};

const lastNotice = (notices: Notice[]): Notice | undefined => notices[notices.length - 1];

describe("steps", () => {
    it("plays a chord, waits for its release, then types text, then reports it sent", async () => {
        const { target, http, notices, runner, settle } = setup();
        const result = runner.run(cad);
        await settle(1000);
        expect(await result).toEqual({ kind: "sent" });
        expect(target.events).toEqual([
            "ControlLeft:down",
            "AltLeft:down",
            "Delete:down",
            "Delete:up",
            "AltLeft:up",
            "ControlLeft:up",
        ]);
        expect(http.requests).toEqual([
            { method: "POST", path: "/api/hid/print?limit=0&delay=0.02", body: "hi", contentType: "text/plain" },
        ]);
        expect(lastNotice(notices)).toEqual({ text: "CAD then hi sent" });
    });

    it("the next step starts only after the chord has fully released (not when sendChord returns)", async () => {
        const { target, http, runner, settle } = setup();
        http.respond = () => {
            // At the moment the text step is sent, every modifier must already be up.
            expect(target.events.filter((e) => e.endsWith(":down"))).toHaveLength(3);
            expect(target.events.filter((e) => e.endsWith(":up"))).toHaveLength(3);
            return status(200);
        };
        const result = runner.run(cad);
        await settle(1000);
        await result;
        expect(http.requests).toHaveLength(1);
    });

    it("a delay step waits its own time", async () => {
        const { http, runner, settle } = setup();
        const macro: MacroLike = {
            label: "Wait",
            steps: [
                { type: "delay", ms: 3000 },
                { type: "text", text: "x" },
            ],
        };
        const result = runner.run(macro);
        await settle(2999);
        expect(http.requests).toHaveLength(0);
        await settle(1);
        expect(http.requests).toHaveLength(1);
        expect(await result).toEqual({ kind: "sent" });
    });

    it("text steps use the keymap chosen at the moment they are sent", async () => {
        const { http, runner, settle, state } = setup();
        state.keymap = "en-gb";
        const result = runner.run({ label: "T", steps: [{ type: "text", text: "x" }] });
        await settle();
        await result;
        expect(http.requests[0]?.path).toBe("/api/hid/print?limit=0&delay=0.02&keymap=en-gb");
    });

    it("an unknown step type is skipped, not fatal", async () => {
        const { runner, settle } = setup();
        const odd = { label: "Odd", steps: [{ type: "mystery" }, { type: "delay", ms: 1 }] } as unknown as MacroLike;
        const result = runner.run(odd);
        await settle(10);
        expect(await result).toEqual({ kind: "sent" });
    });

    it("a macro with no steps is sent immediately", async () => {
        const { runner, settle } = setup();
        const result = runner.run({ label: "Empty", steps: [] });
        await settle();
        expect(await result).toEqual({ kind: "sent" });
    });

    it("chord steps carry no armed modifiers and no shift flag of their own", async () => {
        const { target, runner, settle } = setup();
        const result = runner.run({ label: "K", steps: [{ type: "chord", code: "KeyA" }] });
        await settle(1000);
        await result;
        expect(target.events).toEqual(["KeyA:down", "KeyA:up"]);
    });
});

describe("a step that did not happen stops the run", () => {
    const threeText: MacroLike = {
        label: "Login",
        steps: [
            { type: "text", text: "user" },
            { type: "chord", code: "Tab" },
            { type: "text", text: "pass" },
            { type: "chord", code: "Enter" },
        ],
    };

    it("a 500 does not toast 'sent' and later steps are not played", async () => {
        const { target, http, notices, runner, settle } = setup();
        http.respond = () => status(500);
        const result = runner.run(threeText);
        await settle(1000);
        expect(await result).toEqual({ kind: "stopped", problem: "text step failed (500)", remaining: 3 });
        expect(target.events).toEqual([]);
        expect(lastNotice(notices)).toEqual({
            text: "Login stopped: text step failed (500) \u2014 3 later steps not sent.",
            error: true,
        });
        expect(notices.some((n) => n.text === "Login sent")).toBe(false);
    });

    it("a 413 says so", async () => {
        const { http, notices, runner, settle } = setup();
        http.respond = () => status(413);
        const result = runner.run(threeText);
        await settle(1000);
        expect(await result).toMatchObject({ kind: "stopped", problem: "that step is too much text to type in one go" });
        expect(lastNotice(notices)?.text).toContain("that step is too much text to type in one go");
    });

    it("a network failure carries its message, or a default", async () => {
        const a = setup();
        a.http.respond = () => Promise.reject(new Error("socket hang up"));
        const ra = a.runner.run(threeText);
        await a.settle(1000);
        expect(await ra).toMatchObject({ problem: "text step failed: socket hang up" });

        const b = setup();
        b.http.respond = () => Promise.reject("nope");
        const rb = b.runner.run(threeText);
        await b.settle(1000);
        expect(await rb).toMatchObject({ problem: "text step failed: network error" });
    });

    it("counts one remaining step in the singular and none with no suffix", async () => {
        const { http, notices, runner, settle } = setup();
        http.respond = () => status(500);
        const one = runner.run({
            label: "M",
            steps: [
                { type: "text", text: "a" },
                { type: "chord", code: "Tab" },
            ],
        });
        await settle(100);
        await one;
        expect(lastNotice(notices)?.text).toBe("M stopped: text step failed (500) \u2014 1 later step not sent.");

        const none = runner.run({ label: "N", steps: [{ type: "text", text: "a" }] });
        await settle(100);
        await none;
        expect(lastNotice(notices)?.text).toBe("N stopped: text step failed (500)");
    });

    it("the run releases the target even when it fails, so macros are not disabled for good", async () => {
        const { http, gate, runner, settle } = setup();
        http.respond = () => status(500);
        const result = runner.run(threeText);
        await settle(100);
        await result;
        expect(gate.store.getState().macro).toBeNull();
        http.respond = () => status(200);
        const again = runner.run({ label: "Ok", steps: [{ type: "text", text: "a" }] });
        await settle(100);
        expect(await again).toEqual({ kind: "sent" });
    });
});

describe("guards", () => {
    it("refuses a second macro while one runs, naming the one that runs", async () => {
        const { notices, runner, settle, http } = setup();
        const gate1 = Promise.withResolvers<HttpResponse>();
        http.respond = () => gate1.promise;
        const first = runner.run({ label: "First", steps: [{ type: "text", text: "a" }] });
        await settle();
        const second = await runner.run({ label: "Second", steps: [{ type: "text", text: "b" }] });
        expect(second).toEqual({ kind: "refused", reason: "running" });
        expect(lastNotice(notices)).toEqual({ text: "First is still running", error: true });
        expect(http.requests).toHaveLength(1);
        gate1.resolve(status(200));
        await settle();
        expect(await first).toEqual({ kind: "sent" });
    });

    it("refuses while a paste is typing", async () => {
        const { gate, notices, runner, http } = setup();
        gate.beginPaste();
        const result = await runner.run({ label: "M", steps: [{ type: "text", text: "b" }] });
        expect(result).toEqual({ kind: "refused", reason: "typing" });
        expect(lastNotice(notices)).toEqual({ text: "A paste is still typing on the target", error: true });
        expect(http.requests).toHaveLength(0);
    });

    it("refuses a macro with key steps while the HID socket is down, and says so", async () => {
        const { target, notices, runner } = setup({ inputOpen: false });
        const result = await runner.run(cad);
        expect(result).toEqual({ kind: "refused", reason: "offline" });
        expect(lastNotice(notices)).toEqual({ text: "CAD then hi has key steps and input is offline", error: true });
        expect(target.events).toEqual([]);
    });

    it("but runs a text-only macro with the socket down (print is HTTP)", async () => {
        const { runner, settle } = setup({ inputOpen: false });
        const result = runner.run({ label: "Text", steps: [{ type: "text", text: "a" }] });
        await settle();
        expect(await result).toEqual({ kind: "sent" });
    });

    it("a refused run does not claim the target", async () => {
        const { gate, runner } = setup({ inputOpen: false });
        await runner.run(cad);
        expect(gate.store.getState()).toEqual({ macro: null, pasting: false });
    });

    it("null is refused harmlessly", async () => {
        const { runner } = setup();
        expect(await runner.run(null)).toMatchObject({ kind: "refused" });
    });

    it("the gate shows the macro while it runs and clears after", async () => {
        const { gate, runner, settle } = setup();
        const seen: Array<string | null> = [];
        gate.store.subscribe(() => seen.push(gate.store.getState().macro));
        const result = runner.run({ label: "Gate", steps: [{ type: "delay", ms: 50 }] });
        expect(gate.store.getState().macro).toBe("Gate");
        await settle(100);
        await result;
        expect(seen).toEqual(["Gate", null]);
    });
});

describe("telling the user about a slow run (failure mode 9)", () => {
    it("says nothing for a quick macro", async () => {
        const { notices, runner, settle } = setup();
        const result = runner.run({ label: "Quick", steps: [{ type: "chord", code: "KeyA" }] });
        await settle(1000);
        await result;
        expect(notices).toEqual([{ text: "Quick sent" }]);
    });

    it("announces a run of two seconds or more with a sticky notice and an estimate", async () => {
        const { notices, runner, settle } = setup();
        const result = runner.run({ label: "Slow", steps: [{ type: "delay", ms: 2000 }] });
        expect(notices[0]).toEqual({ text: "Running Slow \u2014 about 2s\u2026", sticky: true });
        await settle(2500);
        await result;
        expect(lastNotice(notices)).toEqual({ text: "Slow sent" });
    });

    it("estimates long text runs in minutes", async () => {
        const { notices, runner, http, settle } = setup();
        http.respond = () => status(200);
        const result = runner.run({ label: "Big", steps: [{ type: "text", text: "x".repeat(12_000) }] });
        expect(notices[0]?.text).toBe("Running Big \u2014 about 4 min\u2026");
        await settle(10);
        await result;
    });
});
