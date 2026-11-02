// The PWA lifecycle pieces: wake lock, full screen with Keyboard Lock, screenshot download.

import { DESKTOP_BRIDGE_KEY } from "@pikvm/contracts/desktop";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitDownload, saveScreenshot, screenshotName, toggleFullscreen, useWakeLock } from "./platform";

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

    /* Desktop app. FAILURE MODES: the browser wake lock is used inside Electron (it may not work there);
     * the display is held while the window is minimised or hidden; it is never released on unmount, so
     * the machine stays awake after leaving the KVM; a disabled hook still holds it. */
    describe("in the desktop app", () => {
        const install = () => {
            const keepDisplayAwake = vi.fn();
            Object.defineProperty(window, "pikvmDesktop", { configurable: true, value: { keepDisplayAwake } });
            return keepDisplayAwake;
        };
        afterEach(() => Reflect.deleteProperty(window, "pikvmDesktop"));

        it("holds the display while visible, lets go when hidden, and takes it again on return", () => {
            const keep = install();
            const { request } = stubWakeLock();
            let hidden = false;
            vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
            render(<WakeLock enabled />);
            expect(keep).toHaveBeenLastCalledWith(true);
            hidden = true;
            document.dispatchEvent(new Event("visibilitychange"));
            expect(keep).toHaveBeenLastCalledWith(false);
            hidden = false;
            document.dispatchEvent(new Event("visibilitychange"));
            expect(keep).toHaveBeenLastCalledWith(true);
            expect(request).not.toHaveBeenCalled();
        });

        it("starts hidden without holding it", () => {
            const keep = install();
            vi.spyOn(document, "hidden", "get").mockReturnValue(true);
            render(<WakeLock enabled />);
            expect(keep).toHaveBeenLastCalledWith(false);
        });

        it("releases on unmount, and a disabled hook never asks", () => {
            const keep = install();
            const { unmount } = render(<WakeLock enabled />);
            expect(keep).toHaveBeenLastCalledWith(true);
            unmount();
            expect(keep).toHaveBeenLastCalledWith(false);
            keep.mockClear();
            render(<WakeLock enabled={false} />);
            expect(keep).not.toHaveBeenCalled();
        });
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
        expect(await saveScreenshot(fetchImpl as unknown as typeof fetch)).toMatch(/^pikvm-\d{8}-\d{6}\.jpg$/);
    });

    it("fails with the status when kvmd refuses", async () => {
        const fetchImpl = vi.fn(async () => new Response("no", { status: 503 }));
        await expect(saveScreenshot(fetchImpl as unknown as typeof fetch)).rejects.toThrow("The screenshot failed (503)");
    });
});

describe("waiting for the download to land", () => {
    function bridgeWith() {
        const listeners = new Set<(d: { name: string; state: string; path: string }) => void>();
        const bridge = { onDownloadDone: (l: (d: { name: string; state: string; path: string }) => void) => (listeners.add(l), () => listeners.delete(l)) };
        Object.defineProperty(window, DESKTOP_BRIDGE_KEY, { configurable: true, value: bridge });
        return { emit: (d: { name: string; state: string; path: string }) => listeners.forEach((l) => l(d)), listeners };
    }
    afterEach(() => Reflect.deleteProperty(window, DESKTOP_BRIDGE_KEY));

    it("a browser has no report, so the file is taken as saved", async () => {
        expect(await awaitDownload("a.jpg")).toBe("completed");
    });

    it("in the desktop app it is the shell's word for THIS file that counts", async () => {
        const { emit, listeners } = bridgeWith();
        const result = awaitDownload("a.jpg");
        emit({ name: "other.jpg", state: "cancelled", path: "" });
        emit({ name: "a.jpg", state: "cancelled", path: "" });
        expect(await result).toBe("cancelled");
        expect(listeners.size).toBe(0);
    });

    it("a shell that stays silent is taken as saved after the wait, and stops listening", async () => {
        const { listeners } = bridgeWith();
        expect(await awaitDownload("a.jpg", 10)).toBe("completed");
        expect(listeners.size).toBe(0);
    });
});
