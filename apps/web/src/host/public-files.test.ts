/**
 * What makes the app installable and gives it a "can't reach the KVM" page: public/manifest.webmanifest
 * and public/sw.js, read from disk and exercised as the browser would.
 *
 * Failure modes:
 *  P1. The manifest is not linked from the page, or its start URL / icons fall outside what the host serves.
 *  P2. The worker answers an API or harness request itself, or caches a response meant to be live.
 *  P3. A navigation while the host is down shows the browser's error page instead of the worker's.
 *  P4. A POST, a cross-origin request or the proxied PiKVM UI goes through the worker.
 *  P5. An asset falls back to a stale cached copy only when the network fails, never in preference to it.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Paths, not URLs: the jsdom environment swaps in a URL class that fs does not accept.
const publicDir = resolve(import.meta.dirname, "../../public");
const read = (name: string): string => readFileSync(resolve(publicDir, name), "utf8");

describe("manifest", () => {
    const manifest = JSON.parse(read("manifest.webmanifest")) as {
        id: string;
        start_url: string;
        scope: string;
        display: string;
        icons: Array<{ src: string; sizes: string; purpose: string }>;
    };

    it("P1: is linked from the page, starts inside its own scope and is standalone", () => {
        expect(readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8")).toContain('rel="manifest" href="/app/manifest.webmanifest"');
        expect(manifest.display).toBe("standalone");
        expect(manifest.scope).toBe("/app/");
        expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
        expect(manifest.id).toBe("/app/");
    });

    it("P1: every icon is a file the app ships, with a 192 and a 512 and a maskable one", () => {
        for (const icon of manifest.icons) {
            expect(icon.src.startsWith("/app/")).toBe(true);
            expect(existsSync(resolve(publicDir, icon.src.slice("/app/".length))), icon.src).toBe(true);
        }
        expect(manifest.icons.some((i) => i.sizes === "192x192")).toBe(true);
        expect(manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
        expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
    });
});

interface FakeEvent {
    request: { method: string; url: string; mode: string };
    respondWith: ReturnType<typeof vi.fn>;
    waitUntil: ReturnType<typeof vi.fn>;
}

function boot(fetchImpl: (req: unknown) => Promise<Response>, cached: Record<string, Response> = {}) {
    const listeners: Record<string, (e: unknown) => void> = {};
    const self = { location: { origin: "https://kvm.example" }, addEventListener: (t: string, l: (e: unknown) => void) => (listeners[t] = l), skipWaiting: vi.fn(), clients: { claim: vi.fn() } };
    const store = new Map<string, Response>(Object.entries(cached));
    const caches = {
        keys: async () => ["old", "pikvm-app-v1"],
        delete: vi.fn(async () => true),
        open: async () => ({ put: async (req: { url: string }, res: Response) => void store.set(req.url, res) }),
        match: async (req: { url: string }) => store.get(req.url),
    };
    new Function("self", "caches", "fetch", "Response", "URL", read("sw.js"))(self, caches, fetchImpl, Response, URL);
    const fire = (method: string, url: string, mode = "no-cors"): FakeEvent => {
        const event: FakeEvent = { request: { method, url, mode }, respondWith: vi.fn(), waitUntil: vi.fn() };
        listeners["fetch"]?.(event);
        return event;
    };
    return { fire, store, caches, self, listeners };
}

describe("worker", () => {
    const down = async (): Promise<Response> => Promise.reject(new TypeError("offline"));

    it("P3: a navigation with the host down answers with the retrying 'can't reach' page, 503, uncacheable", async () => {
        const { fire } = boot(down);
        const event = fire("GET", "https://kvm.example/app/kvm", "navigate");
        const res = (await event.respondWith.mock.calls[0]?.[0]) as Response;
        expect(res.status).toBe(503);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        expect(html).toContain("Can't reach the KVM");
        expect(html).toContain('id="retry"');
    });

    it("P3: a navigation that works passes the network's answer straight through (a sign-in redirect included)", async () => {
        const redirect = new Response(null, { status: 200 });
        const { fire } = boot(async () => redirect);
        const event = fire("GET", "https://kvm.example/app/kvm", "navigate");
        expect(await event.respondWith.mock.calls[0]?.[0]).toBe(redirect);
    });

    it("P2/P4: the API, the harness, the legacy console, other methods, other origins and the proxied Pi UI are not the worker's", () => {
        const { fire } = boot(down);
        for (const url of [
            "https://kvm.example/app/api/v1/state",
            "https://kvm.example/app/harness/runs",
            "https://kvm.example/app/daemon/status",
            "https://kvm.example/app/legacy/",
            "https://kvm.example/api/ws",
            "https://kvm.example/streamer/stream",
            "https://other.example/app/assets/x.js",
        ]) {
            expect(fire("GET", url).respondWith, url).not.toHaveBeenCalled();
        }
        expect(fire("POST", "https://kvm.example/app/assets/x.js").respondWith).not.toHaveBeenCalled();
    });

    it("P5: an asset is the network's answer, kept as a fallback, and only the fallback when the network fails", async () => {
        const fresh = new Response("new", { status: 200 });
        Object.defineProperty(fresh, "type", { value: "basic" });
        const stale = new Response("old");
        const url = "https://kvm.example/app/assets/app.js";
        const online = boot(async () => fresh, { [url]: stale });
        const hit = online.fire("GET", url);
        expect(await hit.respondWith.mock.calls[0]?.[0]).toBe(fresh);
        await hit.waitUntil.mock.calls[0]?.[0];
        expect(await (online.store.get(url) as Response).text()).toBe("new");

        const offline = boot(down, { [url]: stale });
        const miss = offline.fire("GET", url);
        expect(await miss.respondWith.mock.calls[0]?.[0]).toBe(stale);
    });

    it("on activation drops every cache but its own", async () => {
        const { listeners, caches, self } = boot(down);
        const waits: Promise<unknown>[] = [];
        listeners["activate"]?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
        await Promise.all(waits);
        expect(caches.delete).toHaveBeenCalledTimes(1);
        expect(caches.delete).toHaveBeenCalledWith("old");
        expect(self.clients.claim).toHaveBeenCalled();
    });
});
