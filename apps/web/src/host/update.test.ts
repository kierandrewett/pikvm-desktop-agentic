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
 *     old copy as "a newer build" and reloads itself into the offline page. (Proved in a real browser: the worker
 *     answers nothing but what its build lists, and e2e shell-cache shows version.json failing offline.)
 *
 * What a worker does with a waiting build (take over, reload, offer a notice) is proved in a real browser, not here
 * (apps/web/src/kvm/FAILURE_MODES.md K98 to K105). This file covers the page's rules for hosts with no worker.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdateWatcher, MIN_GAP_MS, type Deployed, type UpdateHost, watchForUpdates } from "./update";

const build = (id: string | undefined): Deployed => (id === undefined ? { kind: "unknown" } : { kind: "build", build: id });

/** A page with no worker (the desktop app, plain http): the deployed build alone decides. */
function host(running: string, answers: (string | undefined)[]): UpdateHost & { reloads: number; marked: string | null } {
    const state = { reloads: 0, marked: null as string | null };
    let call = 0;
    return {
        running,
        deployed: async () => build(answers[Math.min(call++, answers.length - 1)]),
        refreshWorker: () => undefined,
        worker: async () => ({ kind: "none" }),
        takeOver: async () => true,
        onWorkerChange: () => () => undefined,
        reload: () => void (state.reloads += 1),
        signIn: () => undefined,
        reloadedFor: () => state.marked,
        markReloadedFor: (id) => void (state.marked = id),
        quiet: () => true,
        offer: () => undefined,
        get reloads() {
            return state.reloads;
        },
        get marked() {
            return state.marked;
        },
    };
}

describe("the update check with no worker", () => {
    it("reloads when a different build is deployed", async () => {
        const h = host("old", ["new"]);
        expect(await createUpdateWatcher(h).check("return")).toBe("ready");
        await Promise.resolve();
        expect(h.reloads).toBe(1);
        expect(h.marked).toBe("new");
    });

    it("does nothing when the deployed build is the one running", async () => {
        const h = host("same", ["same"]);
        expect(await createUpdateWatcher(h).check("return")).toBe("current");
        expect(h.reloads).toBe(0);
    });

    it("does nothing when the deployed build cannot be learned", async () => {
        const h = host("old", [undefined]);
        expect(await createUpdateWatcher(h).check("return")).toBe("unknown");
        expect(h.reloads).toBe(0);
    });

    it("reloads once per deployed build, so a server that keeps serving the old page cannot loop it", async () => {
        const h = host("old", ["new", "new", "new"]);
        const watcher = createUpdateWatcher(h);
        await watcher.check("return");
        await watcher.check("return");
        await watcher.check("return");
        await Promise.resolve();
        expect(h.reloads).toBe(1);
    });

    it("reloads again for a build that came after that one", async () => {
        const h = host("old", ["new", "newer"]);
        await createUpdateWatcher(h).check("return");
        await Promise.resolve();
        await createUpdateWatcher(h).check("return");
        await Promise.resolve();
        expect(h.reloads).toBe(2);
        expect(h.marked).toBe("newer");
    });

    it("a session that has ended goes to the sign-in page and reloads nothing", async () => {
        const h = host("old", ["new"]);
        const signIn = vi.spyOn(h, "signIn");
        h.deployed = async () => ({ kind: "signed-out" });
        expect(await createUpdateWatcher(h).check("return")).toBe("signed-out");
        expect(signIn).toHaveBeenCalledTimes(1);
        expect(h.reloads).toBe(0);
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
    // The page checks once as it starts; these tests are about the checks that follow.
    const watch = (h: UpdateHost, now: () => number) => {
        const watching = watchForUpdates(h, now);
        stop = watching.stop;
    };

    it("checks when the page becomes visible, not when it is hidden", async () => {
        const h = host("old", ["old", "new"]);
        let clock = 0;
        watch(h, () => clock);
        await settle();
        clock += MIN_GAP_MS + 1;
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
        watch(h, () => 1_000);
        visibility("visible");
        window.dispatchEvent(new Event("online"));
        const show = new Event("pageshow") as PageTransitionEvent;
        Object.defineProperty(show, "persisted", { value: true });
        window.dispatchEvent(show);
        await settle();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("checks again once the gap has passed, and a page restored from memory counts as a return", async () => {
        const h = host("old", ["old", "old", "old"]);
        const spy = vi.spyOn(h, "deployed");
        let clock = 0;
        watch(h, () => clock);
        clock += MIN_GAP_MS + 1;
        const show = new Event("pageshow") as PageTransitionEvent;
        Object.defineProperty(show, "persisted", { value: true });
        window.dispatchEvent(show);
        await settle();
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("stops listening when told to", async () => {
        const h = host("old", ["old", "new"]);
        let clock = 0;
        const watching = watchForUpdates(h, () => clock);
        await settle();
        watching.stop();
        clock += MIN_GAP_MS + 1;
        visibility("visible");
        await settle();
        expect(h.reloads).toBe(0);
    });
});
