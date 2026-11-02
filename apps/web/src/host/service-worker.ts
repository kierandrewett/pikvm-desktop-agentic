/**
 * The installed app's service worker (public/sw.js): an offline page for the moment the KVM
 * cannot be reached, and nothing else. See the worker for why it never serves a cached page.
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

export function registerServiceWorkerForPage(): void {
    void registerServiceWorker({
        ...(typeof navigator !== "undefined" && "serviceWorker" in navigator ? { serviceWorker: navigator.serviceWorker } : {}),
        secure: typeof window !== "undefined" && window.isSecureContext,
        desktop: isDesktopApp(),
        production: import.meta.env.PROD,
    });
}
