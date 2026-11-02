/**
 * What differs between the three places the screen runs: the desktop app (Electron), a browser
 * on a computer, and a phone or tablet. Each question is asked here once so the components do
 * not scatter `window.pikvmDesktop` checks.
 */

import { useEffect, useSyncExternalStore } from "react";
import { desktopBridge, isDesktopApp } from "../host/desktop";

export { isDesktopApp };

/** Chrome's Keyboard Lock. Not in the DOM typings, and absent outside Chromium. */
interface KeyboardLockApi {
    lock?: () => Promise<void>;
    unlock?: () => void;
}
const keyboardLock = (): KeyboardLockApi | undefined => Reflect.get(navigator, "keyboard");

/** The phone and tablet layout: a coarse primary pointer, and never inside the desktop app. */
export const DOCK_QUERY = "(pointer: coarse)";

/* ---- screen wake lock ---- */

/**
 * Keep the phone's screen on while the KVM is in front of it. A KVM is often left watching an
 * install or a reboot, and the screen locking part way through drops the stream and the socket
 * with it. Released when hidden (the browser drops it then anyway) and asked for again on
 * return. In the desktop app the shell holds it (Electron's power save blocker, through the bridge) on
 * the same rule: while the page is visible.
 */
export function useWakeLock(enabled: boolean): void {
    useEffect(() => {
        const bridge = desktopBridge();
        if (bridge) {
            if (!enabled) return;
            const sync = (): void => bridge.keepDisplayAwake(!document.hidden);
            sync();
            document.addEventListener("visibilitychange", sync);
            return () => {
                document.removeEventListener("visibilitychange", sync);
                bridge.keepDisplayAwake(false);
            };
        }
        if (!enabled || !navigator.wakeLock?.request) return;
        let lock: WakeLockSentinel | null = null;
        let disposed = false;
        const request = (): void => {
            if (lock || document.hidden || disposed) return;
            navigator.wakeLock
                .request("screen")
                .then((sentinel) => {
                    if (disposed) {
                        void sentinel.release().catch(() => {});
                        return;
                    }
                    lock = sentinel;
                    sentinel.addEventListener("release", () => {
                        if (lock === sentinel) lock = null;
                    });
                })
                .catch(() => {});
        };
        const release = (): void => {
            const held = lock;
            lock = null;
            void held?.release().catch(() => {});
        };
        const onVisibility = (): void => (document.hidden ? release() : request());
        request();
        document.addEventListener("visibilitychange", onVisibility);
        // Some browsers only grant it after a gesture, so the first touch asks again if the load-time request was refused.
        document.addEventListener("pointerdown", request, { passive: true });
        return () => {
            disposed = true;
            document.removeEventListener("visibilitychange", onVisibility);
            document.removeEventListener("pointerdown", request);
            release();
        };
    }, [enabled]);
}

/* ---- in the background ---- */

function subscribeBackground(notify: () => void): () => void {
    document.addEventListener("visibilitychange", notify);
    window.addEventListener("focus", notify);
    window.addEventListener("blur", notify);
    return () => {
        document.removeEventListener("visibilitychange", notify);
        window.removeEventListener("focus", notify);
        window.removeEventListener("blur", notify);
    };
}

/** The window is hidden, or visible but not the one being typed into (another window is in front). */
export function useInBackground(): boolean {
    return useSyncExternalStore(
        subscribeBackground,
        () => document.hidden || !document.hasFocus(),
        () => false,
    );
}

/* ---- full screen with Keyboard Lock ---- */

/**
 * The host OS keeps Super shortcuts and Alt+Tab for itself, so Win, Win+Shift+S or Alt+Tab never
 * reach the page and cannot be forwarded. Chrome's Keyboard Lock hands them over, but only in
 * full screen, so the two go together. Holding Esc leaves, as Chrome tells the user.
 */
export function fullscreenSupported(): boolean {
    return isDesktopApp() || (!!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === "function");
}

function subscribeFullscreen(notify: () => void): () => void {
    const handler = (): void => {
        if (!document.fullscreenElement) {
            keyboardLock()?.unlock?.();
        }
        notify();
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
}

export function useIsFullscreen(): boolean {
    return useSyncExternalStore(
        subscribeFullscreen,
        () => !!document.fullscreenElement,
        () => false,
    );
}

/** Enter or leave full screen. Resolves false when the browser refused. */
export async function toggleFullscreen(): Promise<boolean> {
    const bridge = desktopBridge();
    if (bridge) {
        // The shell owns the window, so it does both halves (full screen and Keyboard Lock) and
        // the page does not need a user gesture still being live by the time the IPC answers.
        const entering = !document.fullscreenElement;
        return bridge.window.setFullscreen(entering, { lockKeyboard: true }).then(
            () => true,
            () => false,
        );
    }
    if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
        return true;
    }
    try {
        await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch {
        return false;
    }
    await keyboardLock()?.lock?.().catch(() => {});
    return true;
}

/* ---- screenshot ---- */

export function screenshotName(now: Date = new Date()): string {
    const pad = (n: number): string => String(n).padStart(2, "0");
    const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `pikvm-${day}-${time}.jpg`;
}

/** Fetch a full-resolution frame and hand it to the browser as a download. Resolves with the file's name. */
export async function saveScreenshot(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string> {
    const res = await fetchImpl("/api/streamer/snapshot?allow_offline=1", { cache: "no-store" });
    if (!res.ok) throw new Error(`The screenshot failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const name = screenshotName();
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Not at once: some browsers start the download after the click returns.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return name;
}

/** How long to wait for the desktop app to say a download is done before assuming it was saved. */
export const DOWNLOAD_WAIT_MS = 20_000;

export type DownloadOutcome = "completed" | "cancelled" | "interrupted";

/**
 * Clicking a download link only hands the file to the OS: it may ask where to save, and the user may say no.
 * In the desktop app "saved" is therefore only true once the shell says so; a browser has no such report,
 * so it is taken as saved, and so is a shell that stays silent for `DOWNLOAD_WAIT_MS`.
 */
export function awaitDownload(name: string, wait: number = DOWNLOAD_WAIT_MS): Promise<DownloadOutcome> {
    const bridge = desktopBridge();
    if (!bridge) return Promise.resolve("completed");
    return new Promise((resolve) => {
        const off = bridge.onDownloadDone((download) => {
            if (download.name !== name) return;
            clearTimeout(timer);
            off();
            resolve(download.state);
        });
        const timer = setTimeout(() => {
            off();
            resolve("completed");
        }, wait);
    });
}
