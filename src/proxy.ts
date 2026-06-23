/**
 * Reverse proxy to the PiKVM target.
 *
 * The web/desktop clients never talk to the Pi directly. They talk to our server,
 * which forwards everything that is not under our own `/_agent` namespace straight
 * to the Pi (its web UI, the MJPEG stream, the HID WebSocket, login, all of it),
 * injecting the PiKVM auth on every request so the client does not have to log in
 * to the Pi itself. We bolt our agent UI on by injecting a small bundle into the
 * proxied HTML.
 *
 * Why proxy instead of rebuilding the viewer: the Pi already has a working stream,
 * HID and input pipeline. Re-implementing that would be a lot of fragile work for
 * no gain. Proxying keeps a single source of truth (the Pi) and lets us bolt on
 * what we need.
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import type { PiKvmControl } from "./pikvm-control";

export interface ProxyDeps {
    control: PiKvmControl;
    /**
     * Markup spliced into proxied HTML: `head` before </head>, `body` before
     * </body>. Request-aware so the desktop shell (which has its own native
     * sidebar) can suppress the body injection.
     */
    htmlInjection: (req: IncomingMessage) => { head: string; body: string };
    /**
     * Observe user HID activity on the proxied input WebSocket (/api/ws). Called for
     * every client→Pi input frame; `pos` carries the HID-normalized cursor coords for
     * a mouse_move (else null). Used by the idle mouse-jiggler to know when the user
     * is active and where the cursor actually is.
     */
    onHidActivity?: (pos: { x: number; y: number } | null) => void;
}

/**
 * Parse client→server WebSocket frames (always masked) off the HID socket, calling
 * `onActivity` for each input frame. Buffers across TCP segment boundaries; for a
 * mouse_move it extracts the absolute cursor position. Best-effort and defensive —
 * it never throws into the socket pipeline.
 */
function makeHidTap(onActivity: (pos: { x: number; y: number } | null) => void): (chunk: Buffer) => void {
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    return (chunk: Buffer) => {
        try {
            buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
            while (buf.length >= 2) {
                const opcode = buf[0]! & 0x0f;
                const masked = (buf[1]! & 0x80) !== 0;
                let len = buf[1]! & 0x7f;
                let off = 2;
                if (len === 126) {
                    if (buf.length < 4) break;
                    len = buf.readUInt16BE(2);
                    off = 4;
                } else if (len === 127) {
                    if (buf.length < 10) break;
                    len = Number(buf.readBigUInt64BE(2));
                    off = 10;
                }
                const maskLen = masked ? 4 : 0;
                if (buf.length < off + maskLen + len) break; // frame not fully arrived yet
                const maskKey = masked ? buf.subarray(off, off + 4) : null;
                const payload = buf.subarray(off + maskLen, off + maskLen + len);
                buf = buf.subarray(off + maskLen + len);
                if (opcode !== 0x1 && opcode !== 0x2) continue; // skip ping/pong/close control frames
                if (maskKey) for (let i = 0; i < payload.length; i++) payload[i]! ^= maskKey[i & 3]!;
                let pos: { x: number; y: number } | null = null;
                try {
                    const txt = payload.toString("utf8");
                    if (txt.indexOf("mouse_move") >= 0) {
                        const to = JSON.parse(txt)?.event?.to;
                        if (to && typeof to.x === "number" && typeof to.y === "number") pos = { x: to.x, y: to.y };
                    }
                } catch {
                    /* not JSON we care about */
                }
                onActivity(pos);
            }
            if (buf.length > 1 << 20) buf = Buffer.alloc(0); // safety cap (not a real WS stream)
        } catch {
            /* never disturb the proxied socket */
        }
    };
}

/** Rewrite a Set-Cookie so it binds to OUR origin, not the Pi's. */
function rewriteSetCookie(value: string, secureConnection: boolean): string {
    let out = value.replace(/;\s*Domain=[^;]+/gi, "");
    if (!secureConnection) out = out.replace(/;\s*Secure/gi, "");
    return out;
}

// Hop-by-hop headers must not be forwarded (RFC 7230). Forwarding
// transfer-encoding alongside a content-length we set produces an illegal,
// unparseable response.
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authenticate", "proxy-authorization"];

/** If the Pi sent an absolute redirect back to itself, keep the client on us. */
function rewriteLocation(location: string, target: URL): string {
    try {
        const u = new URL(location, target.origin);
        if (u.host === target.host) return u.pathname + u.search + u.hash;
    } catch {
        /* relative or malformed — leave as-is */
    }
    return location;
}

export function createPiKvmProxy(deps: ProxyDeps) {
    async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const { origin, headers: auth, rejectUnauthorized } = await deps.control.proxyTarget();
        const isHttps = origin.protocol === "https:";
        const requestFn = isHttps ? httpsRequest : httpRequest;

        // Strip accept-encoding so HTML comes back uncompressed and we can inject
        // into it cheaply; the stream and binary assets are unaffected.
        const outHeaders: OutgoingHttpHeaders = { ...req.headers, ...auth, host: origin.host };
        delete outHeaders["accept-encoding"];
        delete outHeaders["connection"];

        const proxyReq = requestFn(
            {
                protocol: origin.protocol,
                hostname: origin.hostname,
                port: origin.port || (isHttps ? 443 : 80),
                method: req.method,
                path: req.url,
                headers: outHeaders,
                rejectUnauthorized,
            },
            (proxyRes) => {
                const status = proxyRes.statusCode ?? 502;
                const headers: OutgoingHttpHeaders = { ...proxyRes.headers };
                for (const h of HOP_BY_HOP) delete headers[h];
                const secure = (req.socket as { encrypted?: boolean }).encrypted === true;

                if (headers["set-cookie"]) {
                    const cookies = Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [headers["set-cookie"] as string];
                    headers["set-cookie"] = cookies.map((c) => rewriteSetCookie(c, secure));
                }
                if (typeof headers["location"] === "string") {
                    headers["location"] = rewriteLocation(headers["location"], origin);
                }

                const contentType = String(proxyRes.headers["content-type"] ?? "");
                const isHtml = contentType.includes("text/html");
                if (!isHtml) {
                    res.writeHead(status, headers);
                    proxyRes.pipe(res);
                    return;
                }

                // Buffer the HTML, inject our bundle before </head>, fix length.
                const chunks: Buffer[] = [];
                proxyRes.on("data", (c: Buffer) => chunks.push(c));
                proxyRes.on("end", () => {
                    let body = Buffer.concat(chunks).toString("utf8");
                    const inject = deps.htmlInjection(req);
                    if (inject.head) {
                        if (body.includes("</head>")) body = body.replace("</head>", `${inject.head}</head>`);
                        else body = inject.head + body;
                    }
                    if (inject.body) {
                        if (body.includes("</body>")) body = body.replace("</body>", `${inject.body}</body>`);
                        else body += inject.body;
                    }
                    const buf = Buffer.from(body, "utf8");
                    delete headers["content-length"];
                    headers["content-length"] = String(buf.byteLength);
                    res.writeHead(status, headers);
                    res.end(buf);
                });
            },
        );

        proxyReq.on("error", (err) => {
            if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
            res.end(`Proxy error: ${err.message}`);
        });
        // If the client goes away (phone drops mid-stream, tab closed), abort the
        // upstream request so a long-lived response (the MJPEG video) doesn't leak
        // a Pi connection on every mobile reconnect. Harmless after normal end.
        res.on("close", () => {
            if (!proxyReq.destroyed) proxyReq.destroy();
        });
        req.pipe(proxyReq);
    }

    async function handleUpgrade(req: IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
        const { origin, headers: auth, rejectUnauthorized } = await deps.control.proxyTarget();
        const isHttps = origin.protocol === "https:";
        const requestFn = isHttps ? httpsRequest : httpRequest;
        const outHeaders: OutgoingHttpHeaders = { ...req.headers, ...auth, host: origin.host };

        const proxyReq = requestFn({
            protocol: origin.protocol,
            hostname: origin.hostname,
            port: origin.port || (isHttps ? 443 : 80),
            method: req.method,
            path: req.url,
            headers: outHeaders,
            rejectUnauthorized,
        });

        // Settle once: either the upgrade succeeds or the upstream answers with a
        // normal response / error. Guards against double-handling and lets us know
        // whether a client disconnect should still abort the pending upstream req.
        let settled = false;

        // If the client (a phone on a flaky link) drops before the handshake
        // completes, abort the upstream request so we don't leak a Pi connection.
        const earlyAbort = () => {
            if (!settled) proxyReq.destroy();
        };
        clientSocket.on("close", earlyAbort);
        clientSocket.on("error", earlyAbort);

        proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
            settled = true;
            const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`];
            for (const [k, v] of Object.entries(proxyRes.headers)) {
                if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
                else if (v !== undefined) lines.push(`${k}: ${v}`);
            }
            clientSocket.write(lines.join("\r\n") + "\r\n\r\n");
            if (proxyHead && proxyHead.length) clientSocket.write(proxyHead);

            // Tear down BOTH ends when either closes or errors, so a Pi-side close
            // (stream restart) drops the client cleanly and a client-side close
            // (phone sleeps / switches network) frees the upstream connection.
            const cleanup = () => {
                proxySocket.destroy();
                clientSocket.destroy();
            };
            proxySocket.on("error", cleanup);
            proxySocket.on("close", cleanup);
            clientSocket.on("error", cleanup);
            clientSocket.on("close", cleanup);
            // Observe user HID input (mouse/keys) on the input WebSocket for the idle
            // jiggler — a passive 'data' listener; the pipe still forwards every byte.
            if (deps.onHidActivity && typeof req.url === "string" && req.url.startsWith("/api/ws")) {
                clientSocket.on("data", makeHidTap(deps.onHidActivity));
            }
            proxySocket.pipe(clientSocket);
            clientSocket.pipe(proxySocket);
        });

        // Upstream answered WITHOUT upgrading (auth failure, redirect, 5xx, Pi
        // restarting): relay it to the client and close, instead of hanging the
        // WebSocket open until it times out.
        proxyReq.on("response", (proxyRes) => {
            if (settled) return;
            settled = true;
            if (!clientSocket.writable) {
                proxyRes.resume();
                clientSocket.destroy();
                return;
            }
            const lines = [`HTTP/1.1 ${proxyRes.statusCode ?? 502} ${proxyRes.statusMessage ?? ""}`];
            for (const [k, v] of Object.entries(proxyRes.headers)) {
                if (HOP_BY_HOP.includes(k.toLowerCase())) continue;
                if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
                else if (v !== undefined) lines.push(`${k}: ${v}`);
            }
            lines.push("connection: close");
            clientSocket.write(lines.join("\r\n") + "\r\n\r\n");
            proxyRes.pipe(clientSocket);
            proxyRes.on("end", () => clientSocket.end());
            proxyRes.on("error", () => clientSocket.destroy());
        });

        proxyReq.on("error", () => {
            settled = true;
            clientSocket.destroy();
        });
        // A dead/unreachable Pi must not hang the client socket forever.
        proxyReq.setTimeout(15000, () => proxyReq.destroy());
        if (head && head.length) proxyReq.write(head);
        proxyReq.end();
    }

    return { handleHttp, handleUpgrade };
}
