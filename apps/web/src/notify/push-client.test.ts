/**
 * This device's subscription through the app's service worker.
 *
 * Failure modes:
 *  C1. The server's key (base64url) is passed to the browser as text, or mis-decoded.
 *  C2. A subscription made with an older server key is kept, so every push the server sends is refused.
 *  C3. A good subscription is replaced on every visit, so the endpoint changes under the server.
 *  C4. No worker registered: a hang on `ready`, or a vague error.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { currentSubscription, keyBytes, subscribeThisDevice, unsubscribeThisDevice } from "./push-client";

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-ib37J8xQmBDw_4Z3Xoy3qB8Tnh_5Glx-kNVqpCrmI9mLgnV-j6dMyNpZ-KY";

afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "serviceWorker");
});

interface FakeSub {
    endpoint: string;
    options: { applicationServerKey: ArrayBuffer | null };
    unsubscribe: ReturnType<typeof vi.fn>;
    toJSON: () => unknown;
}

function worker(existing: FakeSub | null) {
    const created: FakeSub[] = [];
    const pushManager = {
        getSubscription: vi.fn(async () => existing),
        subscribe: vi.fn(async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
            const sub: FakeSub = {
                endpoint: "https://fcm.googleapis.com/fcm/send/new",
                options: { applicationServerKey: options.applicationServerKey.buffer as ArrayBuffer },
                unsubscribe: vi.fn(async () => true),
                toJSON: () => ({}),
            };
            created.push(sub);
            return sub;
        }),
    };
    const registration = { pushManager };
    Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: { getRegistration: vi.fn(async () => registration), ready: Promise.resolve(registration) },
    });
    return { pushManager, created };
}

describe("keyBytes", () => {
    it("C1: decodes the application server key to its 65 bytes", () => {
        const bytes = keyBytes(KEY);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.length).toBe(65);
        expect(bytes[0]).toBe(4);
    });
});

describe("subscribeThisDevice", () => {
    it("subscribes visibly with the key's bytes", async () => {
        const { pushManager } = worker(null);
        const sub = await subscribeThisDevice(KEY);
        expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
        const options = pushManager.subscribe.mock.calls[0]![0];
        expect(options.userVisibleOnly).toBe(true);
        expect(Array.from(options.applicationServerKey)).toEqual(Array.from(keyBytes(KEY)));
        expect(sub.endpoint).toContain("fcm");
    });

    it("C3: keeps a subscription made with the same key", async () => {
        const existing: FakeSub = {
            endpoint: "https://fcm.googleapis.com/fcm/send/old",
            options: { applicationServerKey: keyBytes(KEY).buffer },
            unsubscribe: vi.fn(async () => true),
            toJSON: () => ({}),
        };
        const { pushManager } = worker(existing);
        expect(await subscribeThisDevice(KEY)).toBe(existing);
        expect(pushManager.subscribe).not.toHaveBeenCalled();
        expect(existing.unsubscribe).not.toHaveBeenCalled();
    });

    it("C2: drops a subscription made with another key and subscribes again", async () => {
        const existing: FakeSub = {
            endpoint: "https://fcm.googleapis.com/fcm/send/old",
            options: { applicationServerKey: new Uint8Array(65).buffer },
            unsubscribe: vi.fn(async () => true),
            toJSON: () => ({}),
        };
        const { pushManager } = worker(existing);
        await subscribeThisDevice(KEY);
        expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
        expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    });

    it("C4: with no worker registered it says so, and does not wait for one", async () => {
        Object.defineProperty(navigator, "serviceWorker", {
            configurable: true,
            value: { getRegistration: async () => undefined, ready: new Promise(() => undefined) },
        });
        await expect(subscribeThisDevice(KEY)).rejects.toThrow(/background worker is not running/);
        expect(await currentSubscription()).toBeNull();
    });
});

describe("unsubscribeThisDevice", () => {
    it("drops the subscription and returns its endpoint for the server to forget; null when there was none", async () => {
        const existing: FakeSub = {
            endpoint: "https://fcm.googleapis.com/fcm/send/old",
            options: { applicationServerKey: null },
            unsubscribe: vi.fn(async () => true),
            toJSON: () => ({}),
        };
        worker(existing);
        expect(await unsubscribeThisDevice()).toBe("https://fcm.googleapis.com/fcm/send/old");
        expect(existing.unsubscribe).toHaveBeenCalled();
        worker(null);
        expect(await unsubscribeThisDevice()).toBeNull();
    });
});
