/**
 * REST client. Every mutating request carries the CSRF header the server requires.
 */
export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code: string,
        readonly issues?: unknown,
    ) {
        super(message);
    }
}

/**
 * Names this tab. Writes send it as `x-chat-tab`; the server echoes it on the `chat.sync` event so this tab skips
 * the refetch for its own change (docs/spec/realtime.md). It is not a credential and carries no user data.
 */
export const TAB_ID = crypto.randomUUID().replaceAll("-", "").slice(0, 16);

import { apiUrl } from "./config";

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(apiUrl(path), {
        method,
        signal,
        credentials: "same-origin",
        headers: {
            "x-chat-request": "1",
            "x-chat-tab": TAB_ID,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
        const e = json?.error ?? {};
        throw new ApiError(e.message ?? json?.message ?? res.statusText, res.status, e.code ?? "error", e.issues);
    }
    return json as T;
}

export const api = {
    /** `signal` lets TanStack Query abort the request when the query is cancelled. */
    get: <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal),
    post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
    put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
    patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
    del: <T>(path: string) => request<T>("DELETE", path),
};
