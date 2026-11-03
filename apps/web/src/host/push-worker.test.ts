/**
 * The worker's push and notification-tap handlers (public/sw.js), run as the browser would.
 *
 * Failure modes:
 *  W1. A push whose body cannot be read shows nothing (iOS and Chrome then revoke the subscription).
 *  W2. The payload's text is not what the notification shows, or its tag does not replace the last one.
 *  W3. A tap opens a new window every time instead of the app that is already open, or opens a page outside /app/.
 *  W4. The worker's existing behaviour (offline page, caching) is disturbed by the handlers.
 *  W5. A push that carries a badge does not put it on the app icon (so it is missing when the app is closed), counts
 *      only the first of several, tells no open page, or an API that fails or is missing stops the notification.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../../public/sw.js"), "utf8");
const ORIGIN = "https://kvm.example";

interface PushEvent {
    data: { json(): unknown } | null;
    waitUntil: ReturnType<typeof vi.fn>;
}

interface Boot {
    /** navigator in the worker: with the Badging API, or without it. */
    navigator?: { setAppBadge?: (count?: number) => Promise<void> };
    /** The badge cache's records, by key (a Map the test can look into), or no Cache Storage at all. */
    cache?: Map<string, string> | "none";
}

function boot(windows: { url: string; focus: ReturnType<typeof vi.fn>; postMessage?: ReturnType<typeof vi.fn> }[] = [], options: Boot = {}) {
    const listeners: Record<string, (event: unknown) => void> = {};
    const showNotification = vi.fn(async () => undefined);
    const openWindow = vi.fn(async () => undefined);
    const self = {
        location: { origin: ORIGIN },
        addEventListener: (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
        skipWaiting: vi.fn(),
        clients: { claim: vi.fn(), matchAll: vi.fn(async () => windows), openWindow },
        registration: { showNotification },
        navigator: options.navigator,
    };
    const records = options.cache instanceof Map ? options.cache : new Map<string, string>();
    const cacheStorage =
        options.cache === "none"
            ? { keys: async () => [] }
            : {
                  keys: async () => [],
                  open: async () => ({
                      match: async (key: string) => (records.has(key) ? new Response(records.get(key)) : undefined),
                      put: async (key: string, response: Response) => void records.set(key, await response.text()),
                  }),
              };
    new Function("self", "caches", "fetch", "Response", "URL", source)(self, cacheStorage, vi.fn(), Response, URL);
    const push = (data: unknown | "unreadable" | null): PushEvent => {
        const event: PushEvent = {
            data: data === null ? null : { json: () => (data === "unreadable" ? JSON.parse("{") : data) },
            waitUntil: vi.fn(),
        };
        listeners["push"]?.(event);
        return event;
    };
    const tap = async (data: unknown) => {
        const notification = { close: vi.fn(), data };
        const event = { notification, waitUntil: vi.fn() };
        listeners["notificationclick"]?.(event);
        await event.waitUntil.mock.calls[0]?.[0];
        return notification;
    };
    return { listeners, showNotification, openWindow, push, tap, self };
}

describe("push", () => {
    it("W2: shows the payload's title and body, replacing the last notification of the same tag, and carries the url", async () => {
        const { push, showNotification } = boot();
        const event = push({ title: "PiKVM", body: "A dialog says Install complete.", tag: "pikvm-screen", url: "/app/" });
        await event.waitUntil.mock.calls[0]?.[0];
        expect(showNotification).toHaveBeenCalledTimes(1);
        const [title, options] = showNotification.mock.calls[0] as unknown as [string, Record<string, unknown>];
        expect(title).toBe("PiKVM");
        expect(options).toMatchObject({ body: "A dialog says Install complete.", tag: "pikvm-screen", renotify: true, data: { url: "/app/" }, icon: "/app/icon-192.png" });
    });

    it("W1: a payload it cannot read, or none at all, still shows a notification", async () => {
        for (const data of ["unreadable", null, {}, { title: 5, body: [] }] as const) {
            const { push, showNotification } = boot();
            const event = push(data);
            await event.waitUntil.mock.calls[0]?.[0];
            expect(showNotification).toHaveBeenCalledTimes(1);
            expect(showNotification.mock.calls[0]).toEqual(["PiKVM", expect.objectContaining({ body: "The screen changed.", tag: "pikvm-screen", data: { url: "/app/" } })]);
        }
    });

    it("W3: a url outside the app in the payload is not kept", async () => {
        const { push, showNotification } = boot();
        await push({ title: "t", body: "b", url: "https://evil.example/" }).waitUntil.mock.calls[0]?.[0];
        expect((showNotification.mock.calls[0] as unknown as [string, { data: { url: string } }])[1].data.url).toBe("/app/");
    });
});

describe("notificationclick", () => {
    it("W3: focuses the app window that is open, opening none", async () => {
        const focus = vi.fn(async () => undefined);
        const { tap, openWindow } = boot([
            { url: "https://kvm.example/elsewhere", focus: vi.fn() },
            { url: "https://kvm.example/app/kvm", focus },
        ]);
        const notification = await tap({ url: "/app/" });
        expect(notification.close).toHaveBeenCalled();
        expect(focus).toHaveBeenCalledTimes(1);
        expect(openWindow).not.toHaveBeenCalled();
    });

    it("W3: opens the app when it is not open, and only a page inside /app/", async () => {
        const first = boot([]);
        await first.tap({ url: "/app/" });
        expect(first.openWindow).toHaveBeenCalledWith(`${ORIGIN}/app/`);
        const second = boot([]);
        await second.tap({ url: "https://evil.example/" });
        expect(second.openWindow).toHaveBeenCalledWith(`${ORIGIN}/app/`);
        const third = boot([]);
        await third.tap(undefined);
        expect(third.openWindow).toHaveBeenCalledWith(`${ORIGIN}/app/`);
    });
});

describe("the worker's other jobs", () => {
    it("W4: still has its install, activate and fetch handlers", () => {
        const { listeners } = boot();
        expect(Object.keys(listeners).sort()).toEqual(["activate", "fetch", "install", "notificationclick", "push"]);
    });
});

describe("the icon badge", () => {
    const pushed = async (event: PushEvent): Promise<void> => void (await event.waitUntil.mock.calls[0]?.[0]);

    it("W5: a push with badge: 1 puts 1 on the icon, keeps the count, and tells the open page", async () => {
        const setAppBadge = vi.fn(async (_count?: number) => undefined);
        const postMessage = vi.fn();
        const cache = new Map<string, string>();
        const { push, showNotification } = boot([{ url: `${ORIGIN}/app/chat`, focus: vi.fn(), postMessage }], { navigator: { setAppBadge }, cache });
        await pushed(push({ title: "PiKVM", body: "b", tag: "pikvm-screen", url: "/app/", badge: 1 }));
        expect(showNotification).toHaveBeenCalledTimes(1);
        expect(setAppBadge).toHaveBeenCalledWith(1);
        expect(JSON.parse(cache.get("/app/badge-state") ?? "{}")).toEqual({ screen: 1 });
        expect(postMessage).toHaveBeenCalledWith({ type: "pikvm-badge", kind: "screen", count: 1 });
    });

    it("W5: a second push while the first is unseen makes it 2, from the cache, as when no page has been open between them", async () => {
        const setAppBadge = vi.fn(async (_count?: number) => undefined);
        const cache = new Map<string, string>();
        await pushed(boot([], { navigator: { setAppBadge }, cache }).push({ badge: 1 }));
        await pushed(boot([], { navigator: { setAppBadge }, cache }).push({ badge: 1 }));
        expect(setAppBadge.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    });

    it("W5: `badge: true` is one, and a count adds that many", async () => {
        const setAppBadge = vi.fn(async (_count?: number) => undefined);
        const cache = new Map<string, string>();
        await pushed(boot([], { navigator: { setAppBadge }, cache }).push({ badge: true }));
        await pushed(boot([], { navigator: { setAppBadge }, cache }).push({ badge: 3 }));
        expect(setAppBadge.mock.calls.map((c) => c[0])).toEqual([1, 4]);
    });

    it("W5: a push with no badge, or one that is not a positive whole number, leaves the icon alone", async () => {
        for (const badge of [undefined, 0, -2, 1.5, "1", null, false]) {
            const setAppBadge = vi.fn(async (_count?: number) => undefined);
            const { push, showNotification } = boot([], { navigator: { setAppBadge } });
            await pushed(push({ title: "t", body: "b", badge }));
            expect(showNotification, String(badge)).toHaveBeenCalledTimes(1);
            expect(setAppBadge, String(badge)).not.toHaveBeenCalled();
        }
    });

    it("W5: a worker without the Badging API, with one that rejects, or with no Cache Storage still shows the notification", async () => {
        const variants: Boot[] = [
            { navigator: {} },
            {},
            { navigator: { setAppBadge: async () => Promise.reject(new Error("not installed")) } },
            { navigator: { setAppBadge: vi.fn(async () => undefined) }, cache: "none" },
        ];
        for (const variant of variants) {
            const { push, showNotification } = boot([{ url: `${ORIGIN}/app/`, focus: vi.fn() }], variant);
            await pushed(push({ title: "t", body: "b", badge: 1 }));
            expect(showNotification).toHaveBeenCalledTimes(1);
        }
    });

    it("W5: the badge cache survives the worker's cleanup of old caches", async () => {
        const deleted: string[] = [];
        const listeners: Record<string, (event: unknown) => void> = {};
        const self = {
            location: { origin: ORIGIN },
            addEventListener: (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
            skipWaiting: vi.fn(),
            clients: { claim: vi.fn() },
        };
        const storage = { keys: async () => ["pikvm-app-v1", "pikvm-badge-v1", "pikvm-console-v2"], delete: async (name: string) => void deleted.push(name) };
        new Function("self", "caches", "fetch", "Response", "URL", source)(self, storage, vi.fn(), Response, URL);
        const activate = { waitUntil: vi.fn() };
        listeners["activate"]?.(activate);
        await activate.waitUntil.mock.calls[0]?.[0];
        expect(deleted).toEqual(["pikvm-console-v2"]);
    });
});
