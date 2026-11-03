/**
 * FAILURE MODES (written before the tests) — a newer build must reach the installed app when it is brought back
 *
 *  1. The app is put away and brought back after a deploy and keeps running the old build (no check on return).
 *  2. The check reloads when the builds are the SAME, or when the answer could not be read (offline, a 404 page,
 *     not JSON): a flaky link must never reload a working app.
 *  3. The server keeps answering with the old page, so every return reloads again: a reload loop.
 *  4. visibilitychange to "hidden" (the app being put away) triggers a check, or three events in one return
 *     (visibilitychange, pageshow, online) make three requests and three reloads.
 *  5. Settings > About does not say which build runs, so nobody can tell whether the phone updated.
 *  6. The service worker caches /app/version.json as a fallback: offline, an app that updated since then reads the
 *     old copy as "a newer build" and reloads itself into the offline page.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate, MIN_GAP_MS, type UpdateHost, watchForUpdates } from "./update";

function host(running: string, answers: (string | undefined)[]): UpdateHost & { reloads: number; marked: string | null } {
    const state = { reloads: 0, marked: null as string | null };
    let call = 0;
    return {
        running,
        deployed: async () => answers[Math.min(call++, answers.length - 1)],
        reload: () => void (state.reloads += 1),
        reloadedFor: () => state.marked,
        markReloadedFor: (build) => void (state.marked = build),
        get reloads() {
            return state.reloads;
        },
        get marked() {
            return state.marked;
        },
    };
}

describe("checkForUpdate", () => {
    it("reloads when a different build is deployed", async () => {
        const h = host("old", ["new"]);
        expect(await checkForUpdate(h)).toBe("reloading");
        expect(h.reloads).toBe(1);
        expect(h.marked).toBe("new");
    });

    it("does nothing when the deployed build is the one running", async () => {
        const h = host("same", ["same"]);
        expect(await checkForUpdate(h)).toBe("current");
        expect(h.reloads).toBe(0);
    });

    it("does nothing when the deployed build cannot be learned", async () => {
        const h = host("old", [undefined]);
        expect(await checkForUpdate(h)).toBe("unknown");
        expect(h.reloads).toBe(0);
    });

    it("reloads once per deployed build, so a server that keeps serving the old page cannot loop it", async () => {
        const h = host("old", ["new", "new", "new"]);
        await checkForUpdate(h);
        expect(await checkForUpdate(h)).toBe("unknown");
        expect(await checkForUpdate(h)).toBe("unknown");
        expect(h.reloads).toBe(1);
    });

    it("reloads again for a build that came after that one", async () => {
        const h = host("old", ["new", "newer"]);
        await checkForUpdate(h);
        await checkForUpdate(h);
        expect(h.reloads).toBe(2);
        expect(h.marked).toBe("newer");
    });
});

describe("watchForUpdates", () => {
    let stop = () => {};
    afterEach(() => {
        stop();
        vi.restoreAllMocks();
    });

    const visibility = (state: "visible" | "hidden") => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
        document.dispatchEvent(new Event("visibilitychange"));
    };
    // The check is a few awaited steps long and has no timer of its own: flushing microtasks is enough.
    const settle = async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
    };

    it("checks when the page becomes visible, not when it is hidden", async () => {
        const h = host("old", ["new"]);
        stop = watchForUpdates(h, () => 0);
        visibility("hidden");
        await settle();
        expect(h.reloads).toBe(0);
        visibility("visible");
        await settle();
        expect(h.reloads).toBe(1);
    });

    it("treats the events of one return as one check", async () => {
        const h = host("old", ["old", "old", "old"]);
        const spy = vi.spyOn(h, "deployed");
        stop = watchForUpdates(h, () => 1_000);
        visibility("visible");
        window.dispatchEvent(new Event("online"));
        const show = new Event("pageshow") as PageTransitionEvent;
        Object.defineProperty(show, "persisted", { value: true });
        window.dispatchEvent(show);
        await settle();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("checks again once the gap has passed, and a page restored from memory counts as a return", async () => {
        const h = host("old", ["old", "old"]);
        const spy = vi.spyOn(h, "deployed");
        let clock = 0;
        stop = watchForUpdates(h, () => clock);
        visibility("visible");
        clock += MIN_GAP_MS + 1;
        const show = new Event("pageshow") as PageTransitionEvent;
        Object.defineProperty(show, "persisted", { value: true });
        window.dispatchEvent(show);
        await settle();
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("stops listening when told to", async () => {
        const h = host("old", ["new"]);
        watchForUpdates(h, () => 0)();
        visibility("visible");
        await settle();
        expect(h.reloads).toBe(0);
    });
});

describe("the service worker", () => {
    it("never touches /app/version.json, not even as an offline fallback", () => {
        const worker = readFileSync(resolve(import.meta.dirname, "../../public/sw.js"), "utf8");
        const live = /const LIVE = (\/.*\/);/.exec(worker)?.[1];
        expect(live).toBeDefined();
        const pattern = new RegExp(live?.slice(1, -1) ?? "");
        expect(pattern.test("/app/version.json")).toBe(true);
        expect(pattern.test("/app/assets/index-abc.js")).toBe(false);
    });
});
