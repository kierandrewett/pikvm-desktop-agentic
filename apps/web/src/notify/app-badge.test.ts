/**
 * The number on the app icon: what puts it there and what takes it off.
 *
 * Failure modes:
 *  B1. A browser without the Badging API gets a call (and throws), or one that rejects or throws breaks the app.
 *  B2. A chat run that ends while the app is in front sets a badge nobody needs, or one that ends while hidden does not.
 *  B3. The badge stays after the person looked: on the Chat tab for chat, on the KVM for the screen; or it goes away
 *      when they look at something else (Settings, or Chat for a screen alert).
 *  B4. A screen alert the worker counted while the app was closed is cleared by a page that opens on Chat, because it
 *      cleared before it had read the count.
 *  B5. Garbage from the worker (or from anything else posting to the page) is taken for a push.
 */

import { describe, expect, it, vi, type Mock } from "vitest";
import { cacheBadgeStore, createAppBadge, createBadgeController, isPushBadgeMessage, type BadgeStore, type BadgeTarget } from "./app-badge";

interface StubTarget extends BadgeTarget {
    setAppBadge: Mock<(count?: number) => Promise<void>>;
    clearAppBadge: Mock<() => Promise<void>>;
}

/** A navigator with the Badging API, and what the icon shows now: the last call's effect. */
function icon(nav: StubTarget): number {
    const set = nav.setAppBadge.mock.invocationCallOrder.at(-1) ?? 0;
    const clear = nav.clearAppBadge.mock.invocationCallOrder.at(-1) ?? 0;
    return set > clear ? (nav.setAppBadge.mock.calls.at(-1)?.[0] ?? 0) : 0;
}

interface MemoryStore extends BadgeStore {
    value: number;
}

/** The cache the worker and the page share. `initial` is what the worker counted while no page was open. */
function memoryStore(initial: number): MemoryStore {
    const store: MemoryStore = {
        value: initial,
        load: async () => store.value,
        save: (count) => {
            store.value = count;
        },
    };
    return store;
}

function app(options: { visible?: boolean; workerCounted?: number } = {}) {
    const nav: StubTarget = { setAppBadge: vi.fn(async () => undefined), clearAppBadge: vi.fn(async () => undefined) };
    const store = memoryStore(options.workerCounted ?? 0);
    let visible = options.visible ?? true;
    const controller = createBadgeController({ badge: createAppBadge(nav, store), visible: () => visible, store });
    // The worker has set the icon itself for what it counted.
    if (options.workerCounted) void nav.setAppBadge(options.workerCounted);
    return {
        nav,
        store,
        controller,
        show: () => (visible = true),
        hide: () => (visible = false),
    };
}

describe("B1: an unsupported or unwilling browser is not an error", () => {
    it("calls nothing where the API is absent", () => {
        const badge = createAppBadge({});
        expect(() => {
            badge.add("chat");
            badge.seen("chat");
            badge.restore(3);
        }).not.toThrow();
        expect(createAppBadge(undefined).total()).toBe(0);
    });

    it("handles an API that rejects (the rejection is caught, not left unhandled), and one that throws at once", () => {
        const caught = vi.fn();
        const rejected = { catch: caught } as unknown as Promise<void>;
        const rejecting = createAppBadge({ setAppBadge: () => rejected, clearAppBadge: () => rejected });
        rejecting.add("chat");
        rejecting.seen("chat");
        expect(caught).toHaveBeenCalledTimes(2);
        const throwing = createAppBadge({
            setAppBadge: () => {
                throw new Error("detached");
            },
        });
        expect(() => throwing.add("screen")).not.toThrow();
    });

    it("the cache store reads 0 and writes nothing where there is no Cache Storage or it fails", async () => {
        expect(await cacheBadgeStore(undefined).load()).toBe(0);
        expect(() => cacheBadgeStore(undefined).save(2)).not.toThrow();
        const broken = { open: () => Promise.reject(new Error("private mode")) } as unknown as CacheStorage;
        expect(await cacheBadgeStore(broken).load()).toBe(0);
        expect(() => cacheBadgeStore(broken).save(1)).not.toThrow();
    });

    it("the cache store reads what the worker wrote, and nothing from a record it cannot read", async () => {
        const cache = { match: async () => new Response(JSON.stringify({ screen: 3 })) };
        const storage = { open: async () => cache } as unknown as CacheStorage;
        expect(await cacheBadgeStore(storage).load()).toBe(3);
        const junk = { open: async () => ({ match: async () => new Response("{") }) } as unknown as CacheStorage;
        expect(await cacheBadgeStore(junk).load()).toBe(0);
    });
});

describe("B2: a chat run that ends", () => {
    it("while the app is hidden sets the badge, and the next one adds to it", async () => {
        const { controller, nav, hide } = app();
        await controller.start();
        hide();
        controller.chatRunFinished();
        expect(icon(nav)).toBe(1);
        controller.chatRunFinished();
        expect(icon(nav)).toBe(2);
    });

    it("while the app is in front does not", async () => {
        const { controller, nav } = app();
        await controller.start();
        controller.tab("chat");
        controller.chatRunFinished();
        expect(icon(nav)).toBe(0);
    });
});

describe("B3: seen", () => {
    it("coming back to the app on the Chat tab clears a chat badge, and not before", async () => {
        const { controller, nav, hide, show } = app();
        await controller.start();
        controller.tab("chat");
        hide();
        controller.chatRunFinished();
        expect(icon(nav)).toBe(1);
        controller.reconcile(); // still hidden: nothing is seen
        expect(icon(nav)).toBe(1);
        show();
        controller.reconcile();
        expect(icon(nav)).toBe(0);
    });

    it("the KVM and Settings do not clear a chat badge; Chat does", async () => {
        const { controller, nav, hide, show } = app();
        await controller.start();
        controller.tab("settings");
        hide();
        controller.chatRunFinished();
        show();
        controller.reconcile();
        expect(icon(nav)).toBe(1);
        controller.tab("kvm");
        expect(icon(nav)).toBe(1);
        controller.tab("chat");
        expect(icon(nav)).toBe(0);
    });

    it("a screen alert is seen on the KVM, not on Chat, and the chat count beside it stays until Chat is seen", async () => {
        const { controller, nav, hide, show, store } = app();
        await controller.start();
        controller.tab("chat");
        hide();
        store.value = 2; // what the worker counted, and showed
        controller.screenPush(2);
        controller.chatRunFinished();
        expect(icon(nav)).toBe(3);
        show();
        controller.reconcile(); // Chat is in front: chat is seen, the screen alert is not
        expect(icon(nav)).toBe(2);
        expect(store.value).toBe(2);
        controller.tab("kvm");
        expect(icon(nav)).toBe(0);
        expect(store.value).toBe(0); // and the next launch does not bring it back
    });

    it("a push that reaches an open page already looking at the KVM is cleared at once", async () => {
        const { controller, nav, store } = app();
        await controller.start();
        controller.tab("kvm");
        store.value = 1;
        void nav.setAppBadge(1); // the worker's
        controller.screenPush(1);
        expect(icon(nav)).toBe(0);
        expect(store.value).toBe(0);
    });

    it("a push that reaches a page in the background is left on the icon", async () => {
        const { controller, nav, hide, store } = app();
        await controller.start();
        controller.tab("kvm");
        hide();
        store.value = 1;
        void nav.setAppBadge(1);
        controller.screenPush(1);
        expect(icon(nav)).toBe(1);
    });
});

describe("B4: an alert counted while the app was closed", () => {
    it("a page that opens on Chat leaves it on the icon, and the KVM clears it, in the cache as well", async () => {
        const { controller, nav, store } = app({ workerCounted: 2 });
        const started = controller.start();
        controller.tab("chat"); // the tab is known before the cache has been read
        expect(nav.clearAppBadge).not.toHaveBeenCalled();
        await started;
        expect(nav.clearAppBadge).not.toHaveBeenCalled();
        expect(icon(nav)).toBe(2);
        controller.tab("kvm");
        expect(icon(nav)).toBe(0);
        expect(store.value).toBe(0);
    });

    it("the first chat run after it adds to it instead of replacing it", async () => {
        const { controller, nav, hide } = app({ workerCounted: 2 });
        await controller.start();
        controller.tab("settings");
        hide();
        controller.chatRunFinished();
        expect(icon(nav)).toBe(3);
    });

    it("with nothing counted and the app opening on Chat the icon is clear", async () => {
        const { controller, nav } = app();
        await controller.start();
        controller.tab("chat");
        expect(icon(nav)).toBe(0);
    });
});

describe("B5: messages from the worker", () => {
    it("only a screen badge message with a number counts", () => {
        expect(isPushBadgeMessage({ type: "pikvm-badge", kind: "screen", count: 2 })).toBe(true);
        const junk = [null, undefined, 4, "pikvm-badge", {}, { type: "pikvm-badge" }, { type: "pikvm-badge", kind: "chat", count: 1 }, { type: "pikvm-badge", kind: "screen", count: "2" }, { type: "other", kind: "screen", count: 1 }];
        for (const message of junk) expect(isPushBadgeMessage(message), JSON.stringify(message)).toBe(false);
    });

    it("a count that is not a positive number adds nothing", () => {
        const nav: StubTarget = { setAppBadge: vi.fn(async () => undefined), clearAppBadge: vi.fn(async () => undefined) };
        const badge = createAppBadge(nav);
        for (const count of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) badge.add("screen", count);
        expect(nav.setAppBadge).not.toHaveBeenCalled();
        expect(badge.total()).toBe(0);
    });
});
