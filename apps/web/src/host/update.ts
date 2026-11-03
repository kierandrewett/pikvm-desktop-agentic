/**
 * A newer build applies when the installed app is brought back, not only on a cold start.
 *
 * The service worker never caches the page and index.html is revalidated (src/server/static.ts), so a COLD
 * launch always runs the deployed build. But a phone keeps a put-away app alive, and bringing it back resumes
 * the old page and its old JavaScript without a navigation: after a deploy the app would keep running the
 * previous build until iOS happened to evict it. So when the page becomes visible again (or the network
 * returns) it asks /app/version.json, which the build writes beside the bundle, what is deployed, and reloads
 * once if that is not the build it is running.
 *
 * It reloads at most once per deployed build per tab session: if the server somehow keeps answering with
 * the old page, a second reload would loop, so the second time it stays put and shows the old build in
 * Settings > About, which is the thing to look at.
 */

import { isDesktopApp } from "./desktop";

export const VERSION_URL = "/app/version.json";
export const RELOADED_FOR_KEY = "pikvm-reloaded-for-build";
/** Checks closer together than this are one check: visibilitychange, pageshow and focus arrive together. */
export const MIN_GAP_MS = 5_000;
const FETCH_TIMEOUT_MS = 4_000;

export type UpdateOutcome = "current" | "reloading" | "unknown";

export interface UpdateHost {
    /** The build this page is running. */
    readonly running: string;
    /** The deployed build, or undefined when it cannot be learned (offline, no such file, not JSON). */
    deployed(): Promise<string | undefined>;
    reload(): void;
    /** The build a reload was last made for in this tab session. */
    reloadedFor(): string | null;
    markReloadedFor(build: string): void;
}

export async function checkForUpdate(host: UpdateHost): Promise<UpdateOutcome> {
    const deployed = await host.deployed();
    if (deployed === undefined) return "unknown";
    if (deployed === host.running) return "current";
    if (host.reloadedFor() === deployed) return "unknown";
    host.markReloadedFor(deployed);
    host.reload();
    return "reloading";
}

async function fetchDeployed(): Promise<string | undefined> {
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(VERSION_URL, { cache: "no-store", credentials: "same-origin", signal: abort.signal });
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return undefined;
        const body: unknown = await res.json();
        if (typeof body !== "object" || body === null || !("build" in body)) return undefined;
        return typeof body.build === "string" && body.build !== "" ? body.build : undefined;
    } catch {
        return undefined;
    } finally {
        window.clearTimeout(timer);
    }
}

function pageHost(): UpdateHost {
    return {
        running: __BUILD_ID__,
        deployed: fetchDeployed,
        reload: () => location.reload(),
        reloadedFor: () => {
            try {
                return sessionStorage.getItem(RELOADED_FOR_KEY);
            } catch {
                return null;
            }
        },
        markReloadedFor: (build) => {
            try {
                sessionStorage.setItem(RELOADED_FOR_KEY, build);
            } catch {
                // No storage: the worst case is one more reload per check, bounded by the gap above.
            }
        },
    };
}

/** Check whenever the app comes back. Returns the unsubscribe. */
export function watchForUpdates(host: UpdateHost, now: () => number = Date.now): () => void {
    let last = -Infinity;
    const check = () => {
        if (now() - last < MIN_GAP_MS) return;
        last = now();
        // The worker is replaced when sw.js changes; asking here makes that happen on this resume, not the next navigation.
        void navigator.serviceWorker?.getRegistration("/app/").then((registration) => registration?.update(), () => undefined);
        void checkForUpdate(host);
    };
    const onVisible = () => {
        if (document.visibilityState === "visible") check();
    };
    const onPageShow = (event: PageTransitionEvent) => {
        if (event.persisted) check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", check);
    return () => {
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("pageshow", onPageShow);
        window.removeEventListener("online", check);
    };
}

/** The page's own watch. A dev server (no version.json) and the desktop app (it ships its own bundle) never check. */
export function watchPageForUpdates(): () => void {
    if (!import.meta.env.PROD || isDesktopApp()) return () => {};
    return watchForUpdates(pageHost());
}
