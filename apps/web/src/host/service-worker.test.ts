/**
 * Failure modes:
 *  W1. The worker registers where it cannot work (plain http, the desktop app's loopback server, the dev server).
 *  W2. A browser that refuses a worker breaks the app's start instead of just not installing.
 *  W3. The worker is registered with a scope that reaches the proxied PiKVM UI or the event socket at "/".
 */

import { describe, expect, it, vi } from "vitest";
import { registerServiceWorker, WORKER_SCOPE, WORKER_URL, type WorkerHost } from "./service-worker";

const host = (over: Partial<WorkerHost> = {}): WorkerHost => ({
    serviceWorker: { register: vi.fn(async () => ({})) },
    secure: true,
    desktop: false,
    production: true,
    ...over,
});

describe("registerServiceWorker", () => {
    it("W1: skips plain http, the desktop app, the dev server and a browser with no workers", async () => {
        for (const over of [{ secure: false }, { desktop: true }, { production: false }, { serviceWorker: undefined }] as Partial<WorkerHost>[]) {
            const h = host(over);
            expect(await registerServiceWorker(h)).toBe(false);
            if (over.serviceWorker !== undefined) expect(h.serviceWorker?.register).not.toHaveBeenCalled();
        }
    });

    it("W2: a refusal is swallowed and reported as not registered", async () => {
        const h = host({ serviceWorker: { register: vi.fn(async () => Promise.reject(new Error("blocked"))) } });
        expect(await registerServiceWorker(h)).toBe(false);
    });

    it("W3: registers /app/sw.js with the /app/ scope, and nothing wider", async () => {
        const h = host();
        expect(await registerServiceWorker(h)).toBe(true);
        expect(h.serviceWorker?.register).toHaveBeenCalledWith(WORKER_URL, { scope: WORKER_SCOPE });
        expect(WORKER_URL).toBe("/app/sw.js");
        expect(WORKER_SCOPE).toBe("/app/");
    });
});
