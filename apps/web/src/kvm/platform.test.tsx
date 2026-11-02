// The PWA lifecycle pieces: wake lock, full screen with Keyboard Lock, screenshot download.

import { DESKTOP_BRIDGE_KEY } from "@pikvm/contracts/desktop";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveScreenshot, screenshotName, toggleFullscreen, useWakeLock } from "./platform";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function WakeLock({ enabled }: { enabled: boolean }) {
    useWakeLock(enabled);
    return null;
}

function stubWakeLock() {
    const sentinels: Array<{ release: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn> }> = [];
    const request = vi.fn(async () => {
        const sentinel = { release: vi.fn(async () => {}), addEventListener: vi.fn() };
        sentinels.push(sentinel);
        return sentinel;
    });
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    return { request, sentinels };
}

describe("wake lock", () => {
    it("is held while the screen is visible, let go when the page is hidden, and asked for again on return", async () => {
        const { request, sentinels } = stubWakeLock();
        let hidden = false;
        vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
        render(<WakeLock enabled />);
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
        expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);

        hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    });

    it("a refused load-time request is tried again on the first touch", async () => {
        const request = vi.fn().mockRejectedValueOnce(new Error("needs a gesture")).mockResolvedValue({ release: vi.fn(async () => {}), addEventListener: vi.fn() });
        Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
        render(<WakeLock enabled />);
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        document.dispatchEvent(new Event("pointerdown"));
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    });

    it("is released when the screen goes away", async () => {
        const { request, sentinels } = stubWakeLock();
        const { unmount } = render(<WakeLock enabled />);
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(sentinels).toHaveLength(1));
        await Promise.resolve();
        unmount();
        expect(sentinels[0]?.release).toHaveBeenCalled();
    });

    it("does nothing in the desktop app, where holding the display awake is not this window's call", () => {
        const { request } = stubWakeLock();
        Object.defineProperty(window, "pikvmDesktop", { configurable: true, value: {} });
        render(<WakeLock enabled />);
        expect(request).not.toHaveBeenCalled();
        Reflect.deleteProperty(window, "pikvmDesktop");
    });
});

describe("full screen with Keyboard Lock", () => {
    it("enters full screen and then locks the keyboard, so Win and Alt+Tab reach the target", async () => {
        const order: string[] = [];
        Object.defineProperty(document.documentElement, "requestFullscreen", {
            configurable: true,
            value: vi.fn(async () => {
                order.push("fullscreen");
            }),
        });
        Object.defineProperty(navigator, "keyboard", {
            configurable: true,
            value: {
                lock: vi.fn(async () => {
                    order.push("lock");
                }),
            },
        });
        expect(await toggleFullscreen()).toBe(true);
        expect(order).toEqual(["fullscreen", "lock"]);
    });

    it("in the desktop app the shell does both halves, so the page asks it and touches neither API", async () => {
        const setFullscreen = vi.fn(async () => {});
        const requestFullscreen = vi.fn();
        Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: requestFullscreen });
        Object.defineProperty(window, DESKTOP_BRIDGE_KEY, { configurable: true, value: { window: { setFullscreen } } });
        try {
            expect(await toggleFullscreen()).toBe(true);
            expect(setFullscreen).toHaveBeenCalledWith(true, { lockKeyboard: true });
            expect(requestFullscreen).not.toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(window, DESKTOP_BRIDGE_KEY);
        }
    });

    it("reports a refusal instead of locking a keyboard in a window that is not full screen", async () => {
        const lock = vi.fn(async () => {});
        Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: vi.fn(async () => Promise.reject(new Error("no"))) });
        Object.defineProperty(navigator, "keyboard", { configurable: true, value: { lock } });
        expect(await toggleFullscreen()).toBe(false);
        expect(lock).not.toHaveBeenCalled();
    });
});

describe("screenshot", () => {
    it("names the file by the moment it was taken", () => {
        expect(screenshotName(new Date(2026, 10, 2, 9, 5, 7))).toBe("pikvm-20261102-090507.jpg");
    });

    it("downloads the full-resolution frame, even while the source is offline", async () => {
        // jsdom's Blob cannot be the body of a Response, so the reply is just what saveScreenshot reads.
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["jpeg"]) }));
        URL.createObjectURL = vi.fn(() => "blob:frame");
        URL.revokeObjectURL = vi.fn();
        const clicked: string[] = [];
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
            clicked.push(`${this.download} ${this.href}`);
        });
        await saveScreenshot(fetchImpl as unknown as typeof fetch);
        expect(fetchImpl).toHaveBeenCalledWith("/api/streamer/snapshot?allow_offline=1", { cache: "no-store" });
        expect(clicked).toHaveLength(1);
        expect(clicked[0]).toMatch(/^pikvm-\d{8}-\d{6}\.jpg blob:frame/);
    });

    it("fails with the status when kvmd refuses", async () => {
        const fetchImpl = vi.fn(async () => new Response("no", { status: 503 }));
        await expect(saveScreenshot(fetchImpl as unknown as typeof fetch)).rejects.toThrow("The screenshot failed (503)");
    });
});
