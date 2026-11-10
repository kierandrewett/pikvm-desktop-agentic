/**
 * The number on the installed app's icon (the Badging API: navigator.setAppBadge / clearAppBadge).
 *
 * Two things put it there, and each clears it when the person has seen what it was about:
 *   - "chat": a chat run finished while the app was hidden. Seen when the app is in front on the Chat tab.
 *   - "screen": the screen watch pushed (Settings > Screen alerts). Seen when the app is in front on the KVM tab, the
 *     screen the alert is about. The service worker (public/sw.js) sets the badge itself on a push, so it is there
 *     when the app is closed, and keeps the count of unseen pushes in the cache `pikvm-badge-v1` so a page that opens
 *     later (on another tab) still knows the icon is about the screen, and does not clear it.
 *
 * The count on the icon is the sum of what is unseen. A browser without the API (every desktop browser but Chrome and
 * Safari's, an iOS that is not the installed app) gets no calls at all, and one that rejects is ignored: a badge is
 * never worth an error.
 */

import type { TabId } from "../app/nav";

export type BadgeKind = "chat" | "screen";

/** The part of `navigator` the API is on. Optional both: absent where the API is not. */
export interface BadgeTarget {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
}

/** Where the unseen screen pushes are kept between a closed app's worker and the page. */
export interface BadgeStore {
    load(): Promise<number>;
    save(count: number): void;
}

export const BADGE_CACHE = "pikvm-badge-v1";
export const BADGE_KEY = "/app/badge-state";

/** The unseen screen count in Cache Storage, the same record the worker writes. Reads 0 where there is no cache. */
export function cacheBadgeStore(storage: CacheStorage | undefined): BadgeStore {
    return {
        async load() {
            try {
                const hit = await (await storage?.open(BADGE_CACHE))?.match(BADGE_KEY);
                const record: unknown = await hit?.json();
                return typeof record === "object" && record !== null && "screen" in record && typeof record.screen === "number" && record.screen > 0
                    ? Math.floor(record.screen)
                    : 0;
            } catch {
                return 0;
            }
        },
        save(count) {
            void (async () => {
                try {
                    const cache = await storage?.open(BADGE_CACHE);
                    await cache?.put(BADGE_KEY, new Response(JSON.stringify({ screen: count }), { headers: { "content-type": "application/json" } }));
                } catch {
                    // No cache (private mode): the badge still works while the page is open.
                }
            })();
        },
    };
}

export interface AppBadge {
    /** `count` more unseen things of this kind. */
    add(kind: BadgeKind, count?: number): void;
    /** What is unseen of this kind has been seen. */
    seen(kind: BadgeKind): void;
    /** The worker counted `count` unseen screen pushes while no page was listening. The icon already shows them. */
    restore(count: number): void;
    /** What the icon shows now: the sum, 0 when it is clear. */
    total(): number;
}

export function createAppBadge(target: BadgeTarget | undefined, store?: BadgeStore): AppBadge {
    const unseen: Record<BadgeKind, number> = { chat: 0, screen: 0 };
    const total = (): number => unseen.chat + unseen.screen;

    const show = (): void => {
        const count = total();
        try {
            const done = count > 0 ? target?.setAppBadge?.(count) : target?.clearAppBadge?.();
            done?.catch(() => {});
        } catch {
            // An API that throws synchronously (a revoked permission, a detached document): there is no badge.
        }
    };

    return {
        add(kind, count = 1) {
            if (!Number.isFinite(count) || count <= 0) return;
            unseen[kind] += Math.floor(count);
            if (kind === "screen") store?.save(unseen.screen);
            show();
        },
        seen(kind) {
            unseen[kind] = 0;
            if (kind === "screen") store?.save(0);
            show();
        },
        restore(count) {
            if (Number.isFinite(count) && count > unseen.screen) unseen.screen = Math.floor(count);
        },
        total,
    };
}

export interface BadgeControllerDeps {
    badge: AppBadge;
    /** The app is in front of the person: visible, not in the background. */
    visible(): boolean;
    /** Where the worker's unseen screen pushes were counted, read once before anything is cleared. */
    store?: BadgeStore;
}

export interface BadgeController {
    /** Read what the worker counted while no page was open. Nothing is cleared before this has finished. */
    start(): Promise<void>;
    /** The tab in front changed (or the app came back, or went away). */
    tab(tab: TabId | undefined): void;
    /** The page's visibility changed. */
    reconcile(): void;
    /** A chat run ended. Counts only when the app is hidden. */
    chatRunFinished(): void;
    /** The screen watch pushed `count` (the service worker already set the icon). */
    screenPush(count: number): void;
}

/** Which tab has seen which kind. */
const SEES: Readonly<Record<TabId, BadgeKind | undefined>> = { kvm: "screen", chat: "chat", recordings: undefined, settings: undefined };

export function createBadgeController({ badge, visible, store }: BadgeControllerDeps): BadgeController {
    let current: TabId | undefined;
    let started = store === undefined;
    const reconcile = (): void => {
        // Before the worker's count is known, clearing "chat" would clear a screen badge it cannot see.
        if (!started || !visible() || current === undefined) return;
        const kind = SEES[current];
        if (kind) badge.seen(kind);
    };
    return {
        async start() {
            if (store && !started) {
                badge.restore(await store.load());
                started = true;
                reconcile();
            }
        },
        tab(tab) {
            current = tab;
            reconcile();
        },
        reconcile,
        chatRunFinished() {
            if (!visible()) badge.add("chat");
        },
        screenPush(count) {
            // The worker has already put the count on the icon and in the cache; the page only learns it.
            badge.restore(count);
            // An open page in front on the KVM has already seen it.
            reconcile();
        },
    };
}

/** What the service worker's push handler says to an open page (public/sw.js). */
export interface PushBadgeMessage {
    readonly type: "pikvm-badge";
    readonly kind: "screen";
    /** How many unseen pushes the worker has now counted, itself included. */
    readonly count: number;
}

export function isPushBadgeMessage(data: unknown): data is PushBadgeMessage {
    if (typeof data !== "object" || data === null) return false;
    return "type" in data && data.type === "pikvm-badge" && "kind" in data && data.kind === "screen" && "count" in data && typeof data.count === "number";
}

/* ---- the page's one instance ---- */

// navigator carries the Badging API where the browser has it, and lib.dom does not declare it: this narrows it to the
// two optional methods above, which is all that is called, each only after a feature check.
const target: BadgeTarget | undefined = typeof navigator === "undefined" ? undefined : (navigator as unknown as BadgeTarget);

const store = cacheBadgeStore(typeof caches === "undefined" ? undefined : caches);

export const badgeController: BadgeController = createBadgeController({
    badge: createAppBadge(target, store),
    visible: () => typeof document !== "undefined" && document.visibilityState === "visible",
    store,
});
