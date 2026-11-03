/**
 * This device's push subscription, through the app's service worker (public/sw.js, scope /app/).
 *
 * The permission prompt must be asked inside the tap that switched the watch on (Safari refuses it otherwise), so the
 * caller asks `Notification.requestPermission()` first and only then comes here.
 */

import { WORKER_SCOPE } from "../host/service-worker";

/** The browser wants the application server key as bytes. */
export function keyBytes(publicKey: string): Uint8Array<ArrayBuffer> {
    const padded = publicKey.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (publicKey.length % 4)) % 4);
    const raw = atob(padded);
    const out = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
    const found = await navigator.serviceWorker.getRegistration(WORKER_SCOPE);
    if (!found) throw new Error("The app's background worker is not running yet. Reload the app once and try again.");
    // A registration can still be installing on the first run: wait for it to be active.
    return navigator.serviceWorker.ready;
}

const sameKey = (current: ArrayBuffer | null, wanted: Uint8Array): boolean => {
    if (!current || current.byteLength !== wanted.length) return false;
    const have = new Uint8Array(current);
    return have.every((byte, i) => byte === wanted[i]);
};

/** This device's existing subscription, or null. */
export async function currentSubscription(): Promise<PushSubscription | null> {
    if (!("serviceWorker" in navigator)) return null;
    const found = await navigator.serviceWorker.getRegistration(WORKER_SCOPE);
    return found ? found.pushManager.getSubscription() : null;
}

/**
 * Subscribe (or keep the existing subscription) with the server's key. A subscription made with another key (the
 * server's key file was replaced) is dropped and made again, or the push service would refuse the server's sends.
 */
export async function subscribeThisDevice(publicKey: string): Promise<PushSubscription> {
    const wanted = keyBytes(publicKey);
    const worker = await registration();
    const existing = await worker.pushManager.getSubscription();
    if (existing && sameKey(existing.options.applicationServerKey, wanted)) return existing;
    await existing?.unsubscribe();
    return worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
}

/** Drop this device's subscription; its endpoint, so the server can forget it too, or null when there was none. */
export async function unsubscribeThisDevice(): Promise<string | null> {
    const existing = await currentSubscription();
    if (!existing) return null;
    const { endpoint } = existing;
    await existing.unsubscribe();
    return endpoint;
}
