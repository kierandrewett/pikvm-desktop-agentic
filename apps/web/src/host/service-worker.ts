/**
 * The installed app's service worker (public/sw.js): it keeps the app shell of each build, so the UI opens at once and
 * with no connection, and it shows an offline page for a navigation it has no cache for. A new build's worker waits
 * for the page to take it over (update.ts), so a page and its worker are always one build.
 */

import { isDesktopApp } from "./desktop";

export interface WorkerHost {
    readonly serviceWorker?: { register(url: string, options: { scope: string }): Promise<unknown> };
    readonly secure: boolean;
    readonly desktop: boolean;
    /** A production build: the dev server serves modules the worker would otherwise cache. */
    readonly production: boolean;
}

export const WORKER_URL = "/app/sw.js";
export const WORKER_SCOPE = "/app/";

/** Register the worker where it can work. Resolves false when it was skipped or refused; never throws. */
export async function registerServiceWorker(host: WorkerHost): Promise<boolean> {
    // The desktop app's server is on loopback and always there, and it needs no install.
    if (!host.production || host.desktop || !host.secure || !host.serviceWorker) return false;
    try {
        await host.serviceWorker.register(WORKER_URL, { scope: WORKER_SCOPE });
        return true;
    } catch {
        // Private browsing and some enterprise policies refuse; the app works the same without it.
        return false;
    }
}

/** The worker fills a cache of every file of the build when it installs: that waits until the page has loaded what it needs. */
const AFTER_LOAD_MS = 1_000;

export function registerServiceWorkerForPage(): void {
    const register = () =>
        void registerServiceWorker({
            ...(typeof navigator !== "undefined" && "serviceWorker" in navigator ? { serviceWorker: navigator.serviceWorker } : {}),
            secure: typeof window !== "undefined" && window.isSecureContext,
            desktop: isDesktopApp(),
            production: import.meta.env.PROD,
        });
    if (document.readyState === "complete") window.setTimeout(register, AFTER_LOAD_MS);
    else window.addEventListener("load", () => window.setTimeout(register, AFTER_LOAD_MS), { once: true });
}
