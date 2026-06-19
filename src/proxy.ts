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

        proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
            const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`];
            for (const [k, v] of Object.entries(proxyRes.headers)) {
                if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
                else if (v !== undefined) lines.push(`${k}: ${v}`);
            }
            clientSocket.write(lines.join("\r\n") + "\r\n\r\n");
            if (proxyHead && proxyHead.length) clientSocket.write(proxyHead);

            const onErr = () => {
                proxySocket.destroy();
                clientSocket.destroy();
            };
            proxySocket.on("error", onErr);
            clientSocket.on("error", onErr);
            proxySocket.pipe(clientSocket);
            clientSocket.pipe(proxySocket);
        });

        proxyReq.on("error", () => clientSocket.destroy());
        if (head && head.length) proxyReq.write(head);
        proxyReq.end();
    }

    return { handleHttp, handleUpgrade };
}
