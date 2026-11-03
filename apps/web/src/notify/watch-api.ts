/**
 * The screen watch's routes (`/app/api/v1/watch/*`, answered by src/server/watch/routes.ts), called with plain fetch.
 * Every failure is a `WatchApiError` whose message is fit to show: the server's own `error` text when it sent one.
 */

import { WATCH_PATH, type CheckEntry, type WatchSettingsPatch, type WatchTestResult, type WatchView } from "@pikvm/contracts/watch";

export class WatchApiError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = "WatchApiError";
    }
}

async function call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`${WATCH_PATH}${path}`, {
            method: init.method ?? "GET",
            ...(init.body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : {}),
            ...(init.signal ? { signal: init.signal } : {}),
        });
    } catch {
        throw new WatchApiError("Cannot reach the app server.");
    }
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
        const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : "";
        throw new WatchApiError(message || `The server answered ${res.status}.`, res.status);
    }
    return body as T;
}

export const getWatch = (signal?: AbortSignal): Promise<WatchView> => call("", signal ? { signal } : {});

export const patchWatch = (patch: WatchSettingsPatch): Promise<WatchView> => call("", { method: "PATCH", body: patch });

export const getChecks = (limit = 10, signal?: AbortSignal): Promise<{ checks: CheckEntry[] }> =>
    call(`/checks?limit=${limit}`, signal ? { signal } : {});

export const subscribeDevice = (subscription: unknown): Promise<{ subscribed: true }> =>
    call("/subscribe", { method: "POST", body: { subscription } });

export const unsubscribeDevice = (endpoint: string): Promise<{ removed: boolean }> =>
    call("/unsubscribe", { method: "POST", body: { endpoint } });

export const sendTestNotification = (): Promise<WatchTestResult> => call("/test", { method: "POST", body: {} });
