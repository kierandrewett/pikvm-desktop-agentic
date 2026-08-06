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
import { parseEndpoint, endpointRequestOptions, endpointIsTls } from "./endpoint";

export interface DaemonProxyDeps {
    /** Where the daemon is: either an origin (http://127.0.0.1:47615) or a
     *  socket (unix:/…/daemon.sock). Both are accepted so the transport can
     *  change without every caller of this changing with it. */
    origin: string;
    /** Desktop-owned action capability. Renderer-supplied auth is discarded. */
    bearerToken: string;
    /** Namespace prefix stripped from req.url before forwarding. Default /_agent/daemon. */
    prefix?: string;
}

export function createDaemonProxy({
    origin,
    bearerToken,
    prefix = "/_agent/daemon",
}: DaemonProxyDeps) {
    const endpoint = parseEndpoint(origin);
    const doRequest = endpointIsTls(endpoint) ? httpsRequest : httpRequest;

    function handleHttp(req: IncomingMessage, res: ServerResponse): void {
        // Strip the namespace → the daemon path (keep the query string).
        const raw = req.url ?? "/";
        let rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
        if (!rest.startsWith("/")) rest = "/" + rest; // "/_agent/daemon" → "/"

        // Forward ordinary headers, but never let a renderer choose the daemon
        // capability. The stronger harness capability is never available here.
        // endpointRequestOptions sets Host to match whichever transport this is.
        const headers = {
            ...Object.fromEntries(
                Object.entries(req.headers).filter(([name]) => name.toLowerCase() !== "authorization"),
            ),
            authorization: `Bearer ${bearerToken}`,
        };

        const proxyReq = doRequest(
            endpointRequestOptions(endpoint, rest, req.method, headers),
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
