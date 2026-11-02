import type { HttpPort } from "./http";

/** The browser's fetch behind the engine's HTTP port. Same-origin, never cached. */
export function createFetchHttp(fetchImpl: typeof fetch = (...args) => fetch(...args)): HttpPort {
    return {
        async request(req) {
            const headers: Record<string, string> = {};
            if (req.contentType) headers["Content-Type"] = req.contentType;
            const init: RequestInit = { method: req.method, cache: "no-store", headers };
            if (req.body !== undefined) init.body = req.body;
            const res = await fetchImpl(req.path, init);
            return { ok: res.ok, status: res.status };
        },
    };
}
