/**
 * Reverse proxy to the pikvm-agent daemon.
 *
 * The native Agent panel (src/views/agent.html) is served from our own origin and
 * talks to the daemon's HTTP API (sessions, frames, traces, approvals) through this
 * proxy mounted at `/_agent/daemon/*`. Same-origin means the panel can `fetch`
 * without CORS, and remote clients are already gated by the server's access token.
 *
 * It streams both directions untouched — JSON request bodies in, and crucially the
 * binary JPEG from `/sessions/{id}/frame` straight back. The daemon is a separate
 * process we do NOT manage; when it's down we answer 502 so the panel can show an
 * "offline" state rather than hang.
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

export interface DaemonProxyDeps {
    /** Daemon base URL, e.g. http://127.0.0.1:47615 (no trailing slash needed). */
    origin: string;
    /** Namespace prefix stripped from req.url before forwarding. Default /_agent/daemon. */
    prefix?: string;
}

export function createDaemonProxy({ origin, prefix = "/_agent/daemon" }: DaemonProxyDeps) {
    const target = new URL(origin);
    const isHttps = target.protocol === "https:";
    const doRequest = isHttps ? httpsRequest : httpRequest;
    const defaultPort = isHttps ? "443" : "80";

    function handleHttp(req: IncomingMessage, res: ServerResponse): void {
        // Strip the namespace → the daemon path (keep the query string).
        const raw = req.url ?? "/";
        let rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
        if (!rest.startsWith("/")) rest = "/" + rest; // "/_agent/daemon" → "/"

        const proxyReq = doRequest(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || defaultPort,
                method: req.method,
                path: rest,
                // Forward headers but point Host at the daemon.
                headers: { ...req.headers, host: target.host },
            },
            (proxyRes) => {
                res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
                proxyRes.pipe(res);
            },
        );
        proxyReq.on("error", () => {
            if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "daemon_unreachable", origin }));
        });
        req.pipe(proxyReq);
    }

    return { handleHttp };
}
