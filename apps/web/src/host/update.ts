/**
 * A newer build reaches the installed app, at a moment that does not cost the person anything.
 *
 * The app opens from the service worker's cache (public/sw.js), one cache per build, and a page and its worker are
 * always one build. A deploy therefore arrives in two steps. The browser installs the new worker beside the old one
 * (sw.js changes with every build) and it waits; this page then asks it to take over (`pikvm-apply`) and reloads into
 * the new build. Until then the page runs the build it loaded with and is served that build's files, so nothing it
 * needs goes missing in the middle of use.
 *
 * WHEN is the page's decision. A page that has just started, or has just come back from being put away, applies a
 * waiting build by itself, unless the host is recording or a field holds typed text. At any other moment a slim
 * notice with a Reload action says a new version is ready (update-prompt.tsx) and nothing is interrupted.
 *
 * /app/version.json, which the build writes beside the bundle, stays the source of truth for what is deployed: it is
 * asked when the page starts and whenever the app comes back, it makes the browser look for the new worker at once,
 * and where there is no worker at all (the desktop app, plain http, a browser that refuses one) it decides the
 * reload by itself. A 401 from it means the session has ended: the page goes to the sign-in page, which the cached
 * shell must never hide.
 *
 * It reloads at most once per target build per tab session: if the server somehow keeps answering with the old page,
 * a second reload would loop, so the second time it stays put and shows the old build in Settings > About.
 */

import { liveFeed } from "../kvm/recorder/live";
import { isDesktopApp } from "./desktop";
import { WORKER_SCOPE } from "./service-worker";

export const VERSION_URL = "/app/version.json";
export const RELOADED_FOR_KEY = "pikvm-reloaded-for-build";
/** Checks closer together than this are one check: visibilitychange, pageshow and focus arrive together. */
export const MIN_GAP_MS = 5_000;
const FETCH_TIMEOUT_MS = 4_000;
/** How long a page waits for the worker it asked to take over before it reloads anyway. */
const TAKE_OVER_MS = 5_000;
const QUERY_MS = 1_500;
/** A page this young that nobody has touched is as quiet as a page that has just come back. */
const UNTOUCHED_MS = 20_000;

/** What /app/version.json says. */
export type Deployed = { readonly kind: "build"; readonly build: string } | { readonly kind: "signed-out" } | { readonly kind: "unknown" };

/** What the worker is doing about a newer build. */
export type WorkerState =
    /** No worker here (the desktop app, plain http, refused, not a production build): the deployed build decides. */
    | { readonly kind: "none" }
    /** A worker, and nothing newer in it. */
    | { readonly kind: "idle" }
    /** A newer worker is filling its cache. */
    | { readonly kind: "installing" }
    /** A newer worker has everything it needs and is waiting for a page to ask it to take over. */
    | { readonly kind: "waiting"; readonly build: string }
    /** A newer worker already controls this page (another tab asked for it): this page runs an older build than its worker. */
    | { readonly kind: "moved"; readonly build: string };

/** "return": the app has just been brought back. "other": anything else (a worker announcement, the network returning). */
export type Moment = "return" | "other";

export type UpdateOutcome =
    /** Running what is deployed, and nothing is waiting. */
    | "current"
    /** The host says a newer build is deployed and the worker is still fetching it. */
    | "fetching"
    /** A newer build is ready: applied now, or offered. */
    | "ready"
    /** The host could not be asked and nothing is waiting. */
    | "unknown"
    /** The host says the session has ended. */
    | "signed-out";

export interface UpdateHost {
    /** The build this page is running. */
    readonly running: string;
    deployed(): Promise<Deployed>;
    /** Asks the browser to look for a new worker now (the worker file changes with every build). */
    refreshWorker(): void;
    worker(): Promise<WorkerState>;
    /** Has the waiting worker take over. Resolves true once it is active (a reload is then served by it), false if it did not activate in time. */
    takeOver(): Promise<boolean>;
    /** Calls back when a worker finishes installing or one takes this page over. Returns the unsubscribe. */
    onWorkerChange(listener: () => void): () => void;
    reload(): void;
    /** Goes to the sign-in page. */
    signIn(): void;
    /** The build a reload was last made for in this tab session. */
    reloadedFor(): string | null;
    markReloadedFor(build: string): void;
    /** Whether the page may be reloaded now without costing the person anything. */
    quiet(moment: Moment): boolean;
    /** Shows (a build) or hides (null) the notice that a new version is ready. */
    offer(build: string | null): void;
}

export interface UpdateWatcher {
    check(moment: Moment): Promise<UpdateOutcome>;
    /** The person asked for it (the notice's Reload): no waiting for a quiet moment. */
    applyNow(): Promise<void>;
}

interface Pending {
    readonly how: "take" | "reload";
    readonly target: string;
}

export function createUpdateWatcher(host: UpdateHost): UpdateWatcher {
    let deployedBuild: string | undefined;
    let offered: string | undefined;
    let applying = false;

    async function pending(): Promise<Pending | null> {
        const worker = await host.worker();
        if (worker.kind === "waiting") return { how: "take", target: worker.build };
        if (worker.kind === "moved") return { how: "reload", target: worker.build };
        if (worker.kind === "none" && deployedBuild !== undefined && deployedBuild !== host.running) return { how: "reload", target: deployedBuild };
        return null;
    }

    async function apply(p: Pending): Promise<void> {
        if (applying) return;
        applying = true;
        try {
            // A worker that did not activate in time is not reloaded for: a reload now would be served by the old worker, and
            // the notice stays so the person can ask again.
            if (p.how === "take" && !(await host.takeOver())) return;
            host.markReloadedFor(p.target);
            host.reload();
        } finally {
            applying = false;
        }
    }

    /** Applies or offers what is ready; true when something is. */
    async function consider(moment: Moment): Promise<boolean> {
        const p = await pending();
        if (!p) {
            host.offer(null);
            return false;
        }
        // Already reloaded for this build in this tab session and still here: stay put, About says which build runs.
        if (host.reloadedFor() === p.target) return true;
        if (host.quiet(moment)) void apply(p);
        else if (offered !== p.target) {
            offered = p.target;
            host.offer(p.target);
        }
        return true;
    }

    return {
        async check(moment) {
            host.refreshWorker();
            const deployed = await host.deployed();
            if (deployed.kind === "signed-out") {
                host.signIn();
                return "signed-out";
            }
            deployedBuild = deployed.kind === "build" ? deployed.build : undefined;
            if (await consider(moment)) return "ready";
            if (deployed.kind === "unknown") return "unknown";
            return deployed.build === host.running ? "current" : "fetching";
        },
        async applyNow() {
            const p = await pending();
            if (p) await apply(p);
        },
    };
}

/** Check whenever the app starts or comes back. Returns the unsubscribe. */
export function watchForUpdates(host: UpdateHost, now: () => number = Date.now): { readonly stop: () => void; readonly watcher: UpdateWatcher } {
    const watcher = createUpdateWatcher(host);
    let last = -Infinity;
    const check = (moment: Moment) => {
        if (now() - last < MIN_GAP_MS) return;
        last = now();
        void watcher.check(moment);
    };
    const onVisible = () => {
        if (document.visibilityState === "visible") check("return");
    };
    const onPageShow = (event: PageTransitionEvent) => {
        if (event.persisted) check("return");
    };
    const onOnline = () => check("other");
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    // A worker that finishes installing, or takes this page over, does not wait for the next return to be heard.
    const offWorker = host.onWorkerChange(() => void watcher.check("other"));
    check("other");
    return {
        watcher,
        stop: () => {
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("pageshow", onPageShow);
            window.removeEventListener("online", onOnline);
            offWorker();
        },
    };
}

/* ---- This page ---- */

async function fetchDeployed(): Promise<Deployed> {
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(VERSION_URL, { cache: "no-store", credentials: "same-origin", signal: abort.signal });
        // The host answered and says this session is not signed in (or no longer is).
        if (res.status === 401) return { kind: "signed-out" };
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return { kind: "unknown" };
        const body: unknown = await res.json();
        if (typeof body !== "object" || body === null || !("build" in body)) return { kind: "unknown" };
        return typeof body.build === "string" && body.build !== "" ? { kind: "build", build: body.build } : { kind: "unknown" };
    } catch {
        return { kind: "unknown" };
    } finally {
        window.clearTimeout(timer);
    }
}

/** Asks a worker which build it is. Undefined when it does not say in time. */
function queryBuild(worker: ServiceWorker): Promise<string | undefined> {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = window.setTimeout(() => resolve(undefined), QUERY_MS);
        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
            window.clearTimeout(timer);
            const data = event.data;
            resolve(typeof data === "object" && data !== null && "build" in data && typeof data.build === "string" ? data.build : undefined);
        };
        worker.postMessage({ type: "pikvm-query" }, [channel.port2]);
    });
}

/** The worker asks every page which build it runs before it deletes a build's cache (public/sw.js, cleanUp). */
function answerBuildQuestions(container: ServiceWorkerContainer): void {
    container.addEventListener("message", (event) => {
        const data: unknown = event.data;
        if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "pikvm-which-build") return;
        event.ports[0]?.postMessage({ build: __BUILD_ID__ });
    });
}

/** What of the page's own state decides whether a reload would cost something. */
function pageQuiet(startedAt: number, touched: () => boolean) {
    return (moment: Moment): boolean => {
        // The host makes the recording, but the page that is closed is the one that follows it and stops it.
        const feed = liveFeed().store.getState();
        if (feed.live === null ? feed.stale : feed.live.recording !== null) return false;
        const focused = document.activeElement;
        if (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement) {
            if (focused.value !== "") return false;
        } else if (focused instanceof HTMLElement && focused.isContentEditable && (focused.textContent ?? "") !== "") return false;
        return moment === "return" || (!touched() && performance.now() - startedAt < UNTOUCHED_MS);
    };
}

const prompt = { target: null as string | null, listeners: new Set<() => void>() };

/** The build the "new version is ready" notice is shown for; null when it is not shown (update-prompt.tsx). */
export function promptTarget(): string | null {
    return prompt.target;
}

export function subscribePrompt(listener: () => void): () => void {
    prompt.listeners.add(listener);
    return () => prompt.listeners.delete(listener);
}

function setPrompt(target: string | null): void {
    if (prompt.target === target) return;
    prompt.target = target;
    for (const listener of prompt.listeners) listener();
}

let running: UpdateWatcher | null = null;

/** The notice's Reload. */
export function reloadForUpdate(): void {
    setPrompt(null);
    void running?.applyNow();
}

/** The notice's dismiss: nothing more is said about this build, and the next quiet moment applies it. */
export function dismissUpdatePrompt(): void {
    setPrompt(null);
}

function pageHost(): UpdateHost {
    const container = typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : undefined;
    const startedAt = performance.now();
    let touched = false;
    const markTouched = () => {
        touched = true;
    };
    for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) document.addEventListener(type, markTouched, { capture: true, passive: true, once: true });

    const listeners = new Set<() => void>();
    const emit = () => {
        for (const listener of listeners) listener();
    };
    let movedOnto = false;
    let takingOver = false;
    let watchingRegistration = false;

    const registration = async (): Promise<ServiceWorkerRegistration | undefined> => {
        try {
            return await container?.getRegistration(WORKER_SCOPE);
        } catch {
            return undefined;
        }
    };

    const watchRegistration = (reg: ServiceWorkerRegistration): void => {
        if (watchingRegistration) return;
        watchingRegistration = true;
        const follow = (worker: ServiceWorker | null): void => {
            worker?.addEventListener("statechange", () => {
                if (worker.state === "installed") emit();
            });
        };
        follow(reg.installing);
        reg.addEventListener("updatefound", () => follow(reg.installing));
    };

    if (container) {
        answerBuildQuestions(container);
        // A page has started: the worker may delete the caches of builds that no page runs any more (public/sw.js, cleanUp).
        container.controller?.postMessage({ type: "pikvm-hello" });
        // A worker that is not the one this page started with controls it now: it took over at another tab's request.
        container.addEventListener("controllerchange", () => {
            container.controller?.postMessage({ type: "pikvm-hello" });
            if (takingOver) return;
            movedOnto = true;
            emit();
        });
        // The worker says a build is ready when its cache is full; the registration says when it is waiting.
        container.addEventListener("message", (event) => {
            const data: unknown = event.data;
            if (typeof data === "object" && data !== null && "type" in data && data.type === "pikvm-update-ready") emit();
        });
    }

    return {
        running: __BUILD_ID__,
        deployed: fetchDeployed,
        refreshWorker: () => void registration().then((reg) => reg?.update().catch(() => undefined)),
        async worker() {
            const reg = await registration();
            if (!container || !reg) return { kind: "none" };
            watchRegistration(reg);
            if (movedOnto) return { kind: "moved", build: (container.controller ? await queryBuild(container.controller) : undefined) ?? "worker" };
            if (reg.waiting) return { kind: "waiting", build: (await queryBuild(reg.waiting)) ?? "waiting" };
            return reg.installing ? { kind: "installing" } : { kind: "idle" };
        },
        async takeOver() {
            const reg = await registration();
            const waiting = reg?.waiting;
            if (!container || !waiting) return false;
            takingOver = true;
            // The worker never claims a page (public/sw.js), so there is no controllerchange to wait for: the navigation after
            // the reload is served by the new worker only once it is active. Anything else (redundant, or still not active when
            // the time is up) means no reload.
            const activated = await new Promise<boolean>((resolve) => {
                const finish = (ok: boolean) => {
                    window.clearTimeout(timer);
                    waiting.removeEventListener("statechange", onState);
                    resolve(ok);
                };
                const onState = () => {
                    if (waiting.state === "activated") finish(true);
                    else if (waiting.state === "redundant") finish(false);
                };
                const timer = window.setTimeout(() => finish(waiting.state === "activated"), TAKE_OVER_MS);
                waiting.addEventListener("statechange", onState);
                waiting.postMessage({ type: "pikvm-apply" });
            });
            if (!activated) takingOver = false;
            return activated;
        },
        onWorkerChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        reload: () => location.reload(),
        signIn: () => {
            // The worker asks the host first for the next page while the person is signed out, so the shell is not shown to them again.
            container?.controller?.postMessage({ type: "pikvm-signed-out" });
            const here = location.pathname + location.search;
            location.assign(here === "/app/" ? "/app/login" : `/app/login?next=${encodeURIComponent(here)}`);
        },
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
        quiet: pageQuiet(startedAt, () => touched),
        offer: setPrompt,
    };
}

/** The page's own watch. A dev server (no version.json) and the desktop app (it ships its own bundle) never check. */
export function watchPageForUpdates(): () => void {
    if (!import.meta.env.PROD || isDesktopApp()) return () => {};
    const watch = watchForUpdates(pageHost());
    running = watch.watcher;
    return watch.stop;
}
