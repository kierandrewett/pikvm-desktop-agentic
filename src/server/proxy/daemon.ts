/**
 * Reverse proxy to the pikvm-agent daemon.
 *
 * The conversation workspace is served from our own origin and talks to the
 * daemon's HTTP API (sessions, frames, traces, approvals) through this proxy
 * mounted at `/app/daemon/*`. Same-origin means it can `fetch` without CORS,
 * and remote clients are already gated by the server's access token.
 *
 * It streams both directions untouched — JSON request bodies in, and crucially the
 * binary JPEG from `/sessions/{id}/frame` straight back. When the daemon is down
 * we answer 502 so the panel can show an "offline" state rather than hang.
 *
 * This used to name src/views/agent.html as the consumer. That was the native
 * Agent panel, superseded by the React workspace and deleted; the comment
 * outlived the file it pointed at.
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { parseEndpoint, endpointRequestOptions, endpointIsTls } from "../../endpoint";

export interface DaemonProxyDeps {
    /** Where the daemon is: either an origin (http://127.0.0.1:47615) or a
     *  socket (unix:/…/daemon.sock). Both are accepted so the transport can
     *  change without every caller of this changing with it. */
    origin: string;
    /** Desktop-owned action capability. Renderer-supplied auth is discarded. */
    bearerToken: string;
    /** Namespace prefix stripped from req.url before forwarding. Default /app/daemon. */
    prefix?: string;
    /** Request headers never forwarded, lower case. The proxy always replaces
     *  `authorization`; a caller adds what the upstream has no business seeing
     *  (the harness proxy drops the browser's session cookie). */
    dropHeaders?: readonly string[];
    /** The `error` a 502 carries when the upstream is down. Default "daemon_unreachable". */
    unreachableError?: string;
}

export function createDaemonProxy({
    origin,
    bearerToken,
    prefix = "/app/daemon",
    dropHeaders = [],
    unreachableError = "daemon_unreachable",
}: DaemonProxyDeps) {
    const drop = new Set(["authorization", ...dropHeaders.map((name) => name.toLowerCase())]);
    const endpoint = parseEndpoint(origin);
    const doRequest = endpointIsTls(endpoint) ? httpsRequest : httpRequest;

    function handleHttp(req: IncomingMessage, res: ServerResponse): void {
        // Strip the namespace → the daemon path (keep the query string).
        const raw = req.url ?? "/";
        let rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
        if (!rest.startsWith("/")) rest = "/" + rest; // "/app/daemon" → "/"

        // Forward ordinary headers, but never let a renderer choose the daemon
        // capability. The stronger harness capability is never available here.
        // endpointRequestOptions sets Host to match whichever transport this is.
        const headers = {
            ...Object.fromEntries(Object.entries(req.headers).filter(([name]) => !drop.has(name.toLowerCase()))),
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
            res.end(JSON.stringify({ error: unreachableError, origin }));
        });
        // An event stream outlives the request that opened it. A phone that
        // suspends drops its connection without a word, and the upstream would
        // otherwise keep the subscription for as long as the run lasts.
        res.on("close", () => proxyReq.destroy());
        req.pipe(proxyReq);
    }

    return { handleHttp };
}
