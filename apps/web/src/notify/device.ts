/**
 * Whether THIS device can receive the watch's notifications, and if not, what the person has to do.
 *
 * iPhone is the case that matters: Safari delivers Web Push only to an app added to the Home Screen and opened from there
 * (iOS 16.4 and later). In a Safari tab there is no PushManager at all, so "unsupported" and "not installed" would look
 * the same without the user-agent check; the message differs because the fix does.
 */

export interface DeviceEnv {
    /** The page is a secure context (https, or localhost). */
    secure: boolean;
    ios: boolean;
    /** Opened from the Home Screen icon (or an installed PWA), not a browser tab. */
    standalone: boolean;
    serviceWorker: boolean;
    pushManager: boolean;
    notification: boolean;
    permission: NotificationPermission | undefined;
}

export type DeviceState =
    | { kind: "ready"; permission: "default" | "granted" }
    | { kind: "insecure" | "needs-install" | "unsupported" | "denied"; message: string };

export function describeDevice(env: DeviceEnv): DeviceState {
    if (!env.secure) {
        return { kind: "insecure", message: "Notifications need a secure connection (https). This page was opened over plain http." };
    }
    if (env.ios && !env.standalone) {
        return {
            kind: "needs-install",
            message:
                "On an iPhone or iPad notifications only work from the app on the Home Screen. In Safari tap Share, then Add to Home Screen, and open the app from its icon.",
        };
    }
    if (!env.serviceWorker || !env.pushManager || !env.notification) {
        return {
            kind: "unsupported",
            message: env.ios
                ? "This version of iOS cannot receive notifications from an app. It needs iOS 16.4 or later."
                : "This browser cannot receive push notifications.",
        };
    }
    if (env.permission === "denied") {
        return {
            kind: "denied",
            message: env.ios
                ? "Notifications are blocked for this app. Turn them on in the iPhone's Settings, Notifications, PiKVM, then come back."
                : "Notifications are blocked for this site. Allow them in the browser's site settings, then come back.",
        };
    }
    return { kind: "ready", permission: env.permission === "granted" ? "granted" : "default" };
}

export function readDeviceEnv(): DeviceEnv {
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone =
        Reflect.get(navigator, "standalone") === true ||
        (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
    return {
        secure: window.isSecureContext,
        ios,
        standalone,
        serviceWorker: "serviceWorker" in navigator,
        pushManager: "PushManager" in window,
        notification: "Notification" in window,
        permission: "Notification" in window ? Notification.permission : undefined,
    };
}
