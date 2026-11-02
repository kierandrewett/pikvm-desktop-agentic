import { describe, expect, it } from "vitest";
import type { HttpResponse } from "../../http";
import { FakeHttp, status } from "../../testing/fake-socket";
import type { Notice } from "../notice";
import { createTypingGate } from "../typing-gate";
import { createPaster } from "./paster";
import { humanDuration, keymapChoice, pasteDuration, printPath, printQuery } from "./print-query";

// Failure modes 13-20 in FAILURE_MODES.md.

function setup(keymap: string | null = null) {
    const http = new FakeHttp();
    const gate = createTypingGate();
    const notices: Notice[] = [];
    const state = { keymap };
    const paster = createPaster({ http, gate, keymap: () => state.keymap, notify: (n) => notices.push(n), locale: "en-GB" });
    return { http, gate, notices, paster, state };
}

describe("printQuery (failure mode 13)", () => {
    it("is unlimited, 20ms per key, and names no keymap by default", () => {
        expect(printQuery(null)).toBe("limit=0&delay=0.02");
        expect(printQuery("")).toBe("limit=0&delay=0.02");
        expect(printQuery(undefined)).toBe("limit=0&delay=0.02");
    });

    it("adds the keymap, URL-encoded", () => {
        expect(printQuery("en-gb")).toBe("limit=0&delay=0.02&keymap=en-gb");
        expect(printQuery("a b&c")).toBe("limit=0&delay=0.02&keymap=a%20b%26c");
    });

    it("the path is the endpoint plus the query", () => {
        expect(printPath("de")).toBe("/api/hid/print?limit=0&delay=0.02&keymap=de");
    });
});

describe("durations (failure mode 14)", () => {
    it("says nothing under ten seconds", () => {
        expect(pasteDuration(0)).toBe("");
        expect(pasteDuration(499)).toBe("");
        expect(pasteDuration(500)).toBe("about 10s");
    });

    it("switches to minutes from 90 seconds", () => {
        expect(humanDuration(89_000)).toBe("about 89s");
        expect(humanDuration(90_000)).toBe("about 2 min");
        expect(pasteDuration(12_000)).toBe("about 4 min");
    });
});

describe("keymap choice (failure mode 15)", () => {
    it("reads kvmd's real shape, a MAP of name to details, sorted", () => {
        const c = keymapChoice({ default: "en-us", available: { "en-us": {}, fr: {}, de: {}, "en-gb": {} } });
        expect(c.options).toEqual(["de", "en-gb", "en-us", "fr"]);
        expect(c.selected).toBe("en-us");
        expect(c.disabled).toBe(false);
        expect(c.hidden).toBe(false);
    });

    it("also accepts a list of names", () => {
        const c = keymapChoice({ default: "en-us", available: ["fr", "en-us"] });
        expect(c.options).toEqual(["en-us", "fr"]);
    });

    it("puts the default in the list even if the Pi did not list it", () => {
        expect(keymapChoice({ default: "en-us", available: { fr: {}, de: {} } }).options).toEqual(["en-us", "de", "fr"]);
    });

    it("one option is shown but not a choice; none is hidden", () => {
        const one = keymapChoice({ default: "en-us", available: {} });
        expect(one).toMatchObject({ options: ["en-us"], disabled: true, hidden: false });
        const none = keymapChoice({});
        expect(none).toMatchObject({ options: [], disabled: true, hidden: true, selected: null });
        expect(keymapChoice(null).hidden).toBe(true);
    });

    it("has a stable identity so a repaint can leave the user's pick alone", () => {
        const a = keymapChoice({ default: "x", available: { y: {}, x: {} } });
        const b = keymapChoice({ default: "x", available: ["x", "y"] });
        expect(a.key).toBe(b.key);
        expect(a.key).toBe("x,y");
    });

    it("ignores non-string entries in a list", () => {
        expect(keymapChoice({ available: ["a", 3 as unknown as string] }).options).toEqual(["a"]);
    });
});

describe("paste (failure modes 16-20)", () => {
    it("types the text through kvmd with the chosen keymap and reports it", async () => {
        const { http, notices, paster } = setup("en-gb");
        const result = await paster.paste("hello");
        expect(result).toEqual({ kind: "typed", chars: 5 });
        expect(http.requests).toEqual([
            {
                method: "POST",
                path: "/api/hid/print?limit=0&delay=0.02&keymap=en-gb",
                body: "hello",
                contentType: "text/plain",
            },
        ]);
        expect(notices).toEqual([
            { text: "Typing 5 characters on the target\u2026", sticky: true },
            { text: "Typed 5 characters on the target" },
        ]);
    });

    it("says the length and duration of a long paste while it types, and singular for one char", async () => {
        const { notices, paster } = setup();
        await paster.paste("x".repeat(12_000));
        expect(notices[0]).toEqual({
            text: "Typing 12,000 characters on the target \u2014 about 4 min\u2026",
            sticky: true,
        });
        notices.length = 0;
        await paster.paste("x");
        expect(notices[0]?.text).toBe("Typing 1 character on the target\u2026");
        expect(notices[1]?.text).toBe("Typed 1 character on the target");
    });

    it("sends nothing for empty text", async () => {
        const { http, notices, paster } = setup();
        expect(await paster.paste("")).toEqual({ kind: "empty" });
        expect(http.requests).toEqual([]);
        expect(notices).toEqual([]);
    });

    it("413 is 'too much text', other statuses report the code", async () => {
        const { http, notices, paster } = setup();
        http.respond = () => status(413);
        expect(await paster.paste("x")).toEqual({ kind: "too-large" });
        expect(notices[notices.length - 1]).toEqual({ text: "That is too much text for one paste.", error: true });
        http.respond = () => status(500);
        expect(await paster.paste("x")).toEqual({ kind: "failed", status: 500 });
        expect(notices[notices.length - 1]).toEqual({ text: "Paste failed (500)", error: true });
    });

    it("a network failure reports its message, or a default", async () => {
        const { http, notices, paster } = setup();
        http.respond = () => Promise.reject(new Error("offline"));
        expect(await paster.paste("x")).toEqual({ kind: "network", message: "offline" });
        expect(notices[notices.length - 1]).toEqual({ text: "Paste failed: offline", error: true });
        http.respond = () => Promise.reject(undefined);
        expect(await paster.paste("x")).toEqual({ kind: "network", message: "network error" });
    });

    it("is refused while a macro runs, naming it, and sends nothing (Ctrl+Enter bypasses the disabled button)", async () => {
        const { gate, http, notices, paster } = setup();
        gate.beginMacro("Login");
        expect(await paster.paste("x")).toEqual({ kind: "refused", reason: "macro-running" });
        expect(notices).toEqual([{ text: "Login is still running", error: true }]);
        expect(http.requests).toEqual([]);
    });

    it("holds the gate for exactly as long as it types, then releases it even on failure", async () => {
        const { gate, http, paster } = setup();
        const pending = Promise.withResolvers<HttpResponse>();
        http.respond = () => pending.promise;
        const run = paster.paste("x");
        expect(gate.store.getState().pasting).toBe(true);
        pending.resolve(status(500));
        await run;
        expect(gate.store.getState().pasting).toBe(false);
    });

    it("a second paste while the first is in flight is refused, not interleaved", async () => {
        const { http, notices, paster } = setup();
        const pending = Promise.withResolvers<HttpResponse>();
        http.respond = () => pending.promise;
        const first = paster.paste("first");
        expect(await paster.paste("second")).toEqual({ kind: "refused", reason: "paste-busy" });
        expect(http.requests).toHaveLength(1);
        expect(notices[notices.length - 1]).toEqual({ text: "A paste is still typing on the target", error: true });
        pending.resolve(status(200));
        expect(await first).toEqual({ kind: "typed", chars: 5 });
    });

    it("reads the keymap at send time", async () => {
        const { http, paster, state } = setup("en-us");
        state.keymap = "de";
        await paster.paste("x");
        expect(http.requests[0]?.path).toContain("keymap=de");
    });
});
