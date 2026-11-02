/**
 * Getting the user's attention when the screen changed while the app was in the background.
 *
 * The desktop app pulses its taskbar entry through the bridge. A browser has no taskbar to pulse,
 * so the same event becomes what a page can do: a marker on the tab's title, the installed app's
 * icon badge, and a system notification where the user has allowed one. All three go away the
 * moment the window is looked at again.
 *
 * A phone cannot do this at all: the page is suspended as soon as it is backgrounded, so nothing
 * is watching the picture. The screen offers the switch only where the page keeps running.
 */

import type { DesktopBridge } from "@pikvm/contracts/desktop";
import { desktopBridge } from "../host/desktop";

export type Attention = Pick<DesktopBridge, "requestAttention">;

/** What the page's title carries while something is waiting. */
export const ATTENTION_MARK = "\u25cf ";
export const ATTENTION_TEXT = "The target's screen changed";

export interface NotificationLike {
    onclick: ((event: Event) => unknown) | null;
    close(): void;
}

/** The slice of the browser the web attention touches, so a test can supply its own. */
export interface AttentionHost {
    readonly document: {
        title: string;
        readonly hidden: boolean;
        hasFocus(): boolean;
        addEventListener(type: "visibilitychange", listener: () => void): void;
        removeEventListener(type: "visibilitychange", listener: () => void): void;
    };
    readonly window: {
        focus(): void;
        addEventListener(type: "focus", listener: () => void): void;
        removeEventListener(type: "focus", listener: () => void): void;
    };
    /** The installed app's icon badge (Chromium, and iOS from 16.4 for an installed app). */
    readonly badge?: { set(): Promise<void>; clear(): Promise<void> };
    /** Shown only when the user has allowed notifications; null when they have not. */
    readonly notify?: (title: string, body: string) => NotificationLike | null;
}

export interface WebAttention extends Attention {
    /** Remove the listeners (a test, or the page going away). */
    dispose(): void;
}

export function createWebAttention(host: AttentionHost): WebAttention {
    let pending = false;
    let original = "";
    let shown: NotificationLike | null = null;

    const looked = (): boolean => !host.document.hidden && host.document.hasFocus();

    const clear = (): void => {
        if (!pending) return;
        pending = false;
        // The title may have moved on since (a route that names itself): only take back what is ours.
        if (host.document.title === ATTENTION_MARK + original) host.document.title = original;
        void host.badge?.clear().catch(() => {});
        shown?.close();
        shown = null;
    };

    const onSeen = (): void => {
        if (looked()) clear();
    };
    host.document.addEventListener("visibilitychange", onSeen);
    host.window.addEventListener("focus", onSeen);

    return {
        requestAttention() {
            // Being looked at is the answer already; the alert is for a window nobody is watching.
            if (looked()) return;
            if (!pending) {
                pending = true;
                original = host.document.title;
                host.document.title = ATTENTION_MARK + original;
            }
            void host.badge?.set().catch(() => {});
            const note = host.notify?.(original || "PiKVM", ATTENTION_TEXT) ?? null;
            if (note) {
                shown?.close();
                shown = note;
                note.onclick = () => {
                    host.window.focus();
                    clear();
                };
            }
        },
        dispose() {
            host.document.removeEventListener("visibilitychange", onSeen);
            host.window.removeEventListener("focus", onSeen);
            clear();
        },
    };
}

/* ---- notification permission ---- */

export type AlertPermission = "granted" | "denied" | "default" | "unsupported";

export function alertPermission(): AlertPermission {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/**
 * Ask for notifications. Browsers only show the prompt from a user gesture, so this is called from
 * the click that turns the alerts on. Refusing leaves the title and badge, which need no permission.
 */
export async function askForAlertPermission(): Promise<AlertPermission> {
    if (typeof Notification === "undefined") return "unsupported";
    if (Notification.permission !== "default") return Notification.permission;
    try {
        return await Notification.requestPermission();
    } catch {
        return "default";
    }
}

/* ---- the page's own ---- */

let web: WebAttention | null = null;

function pageHost(): AttentionHost {
    // Typed as optional: only Chromium, and Safari for an installed app, have them.
    const badgeApi: { setAppBadge?: () => Promise<void>; clearAppBadge?: () => Promise<void> } = navigator;
    const { setAppBadge, clearAppBadge } = badgeApi;
    return {
        document,
        window,
        ...(setAppBadge && clearAppBadge
            ? { badge: { set: () => badgeApi.setAppBadge?.() ?? Promise.resolve(), clear: () => badgeApi.clearAppBadge?.() ?? Promise.resolve() } }
            : {}),
        notify: (title, body) => {
            if (alertPermission() !== "granted") return null;
            try {
                // One notification at a time: a new alert replaces the one still on screen.
                return new Notification(title, { body, tag: "pikvm-screen", icon: "/app/icon-192.png" });
            } catch {
                return null;
            }
        },
    };
}

/** Where a screen change goes: the desktop app's taskbar through the bridge, otherwise the page's own. */
export function attentionSink(): Attention {
    const bridge = desktopBridge();
    if (bridge) return bridge;
    web ??= createWebAttention(pageHost());
    return web;
}
