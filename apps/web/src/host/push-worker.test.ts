/**
 * The worker's push and notification-tap handlers (public/sw.js), run as the browser would.
 *
 * Failure modes:
 *  W1. A push whose body cannot be read shows nothing (iOS and Chrome then revoke the subscription).
 *  W2. The payload's text is not what the notification shows, or its tag does not replace the last one.
 *  W3. A tap opens a new window every time instead of the app that is already open, or opens a page outside /app/.
 *  W4. The worker's existing behaviour (offline page, caching) is disturbed by the handlers.
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

function boot(windows: { url: string; focus: ReturnType<typeof vi.fn> }[] = []) {
    const listeners: Record<string, (event: unknown) => void> = {};
    const showNotification = vi.fn(async () => undefined);
    const openWindow = vi.fn(async () => undefined);
    const self = {
        location: { origin: ORIGIN },
        addEventListener: (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
        skipWaiting: vi.fn(),
        clients: { claim: vi.fn(), matchAll: vi.fn(async () => windows), openWindow },
        registration: { showNotification },
    };
    new Function("self", "caches", "fetch", "Response", "URL", source)(self, { keys: async () => [] }, vi.fn(), Response, URL);
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
