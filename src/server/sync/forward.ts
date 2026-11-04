/**
 * Remote server mode: while a saved server is in use, this process is a thin, authenticated reverse proxy to it.
 *
 * The server owns all its state (settings, macros, its PiKVM list, chat, the agent, the screen watch, the cursor) and
 * talks to its own PiKVM with its own credentials, so video, keyboard and mouse run app -> server -> PiKVM.
 *
 * Forwarded (`isRemotePath`): everything except the local-only paths below. That is `/app/api/*` and `/app/chat/*`
 * (REST, server-sent events, the chat WebSocket), `/` only as kvmd's own front page (`?native=1`), and the kvmd
 * passthrough (every other path, HTTP and WebSocket upgrades alike: the HID socket, the video stream, Janus).
 *
 * Local, always: the sign-in pages, the PWA and icon files, the web app's own files under `/app/` (its pages, its
 * build, the legacy console), the saved-server switch `/app/api/v1/servers*`, and the `/_agent` redirects.
 *
 * Passwords: a PiKVM password in a `/app/api/v1/pikvms` request body goes only to the server in use, and only
 * over https (or http to a loopback host). The body is piped straight to that one upstream request: it is not
 * buffered, cached, written to disk or logged, and neither is the Authorization header. No reply this process
 * sends carries a password: its own error replies are fixed sentences, and the server's replies are relayed as
 * they come (the server reports a PiKVM's password only as `passwordSet`).
 *
 * What leaves: a fixed set of request headers, the server's `Authorization: Bearer <token>`, and, for an HTTP or
 * WebSocket request, this app's `Origin` replaced by the server's own origin (this process has already checked the
 * page's origin, and the server's same-origin check then answers for it). No cookie, no page `Authorization`. What
 * comes back loses hop-by-hop headers and `Set-Cookie`, and an absolute `Location` on the server's own address becomes
 * a path. Bodies, server-sent events and WebSocket bytes stream with back-pressure both ways; a close or error on one
 * side closes the other. The address is checked on every request (https, or http to this machine). A server that
 * cannot be reached, or refuses its token, is a 502 with a fixed sentence; the token never appears in a reply or a log.
 */

import {
    request as httpRequest,
    type ClientRequest,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type OutgoingHttpHeaders,
    type RequestOptions,
    type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isPublicPath } from "../auth";
import { checkServerOrigin, type Connection } from "../../server-store";
import { json } from "../http";

/** `/x` matches `/x` itself and `/x/...`, never `/xy`. */
export function under(path: string, prefix: string): boolean {
    return path === prefix || path.startsWith(prefix + "/");
}

/** Does this request belong to the server while one is in use? The list is in the header comment above. */
export function isRemotePath(path: string, url?: URL): boolean {
    if (path === "/") return url?.searchParams.get("native") === "1";
    if (isPublicPath(path) || under(path, "/_agent")) return false;
    if (path === "/app" || path.startsWith("/app/")) {
        if (under(path, "/app/api/v1/servers")) return false;
        return under(path, "/app/api") || under(path, "/app/chat");
    }
    return true;
}

/** The request headers that mean the same to the server. Cookies, `Authorization` and anything else stay here. */
const PASSED = new Set([
    "accept",
    "accept-encoding",
    "accept-language",
    "cache-control",
    "pragma",
    "content-type",
    "content-length",
    "content-encoding",
    "if-none-match",
    "if-modified-since",
    "if-range",
    "range",
    "last-event-id",
    "user-agent",
]);

/** Chat's own request headers (its CSRF marker, its tab id, its draft owner) belong to the page, so they go too. */
const passedHeader = (name: string): boolean => PASSED.has(name) || name.startsWith("x-chat-");

/** The WebSocket handshake headers a server needs to negotiate the socket. */
const SOCKET_REQUEST = ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"];

/** Reply headers that are about one hop, or would plant a cookie on this origin. */
const DROPPED = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "set-cookie",
]);

/** Handshake reply headers the page needs to accept the socket and its negotiated options. */
const SOCKET_REPLY = ["sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"];

const BAD_GATEWAY = "HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
const UNREACHABLE = "Could not reach the server.";
const REFUSED = "The server did not accept the access token.";

export interface ForwarderDeps {
    /** The server in use, or null while this computer's own server is (nothing is forwarded then). */
    connection: () => Connection | null;
    /** Told after every exchange with a server whether it answered at all. */
    reached: (id: string, ok: boolean) => void;
}

export interface Forwarder {
    handles(path: string, url?: URL): boolean;
    handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
    /** Ends every open exchange with the server with this id, on both sides: a request or stream, or a socket. */
    closeFor(id: string): void;
}

/** An open exchange with a server (a request or stream, or a WebSocket), tagged with the server it targets. */
interface Relay {
    readonly server: string;
    destroy(): void;
}

type Send = (options: RequestOptions, callback?: (res: IncomingMessage) => void) => ClientRequest;

interface Target {
    readonly server: Connection;
    readonly origin: URL;
    readonly send: Send;
}

/** Where to send, or null when the saved address is no longer acceptable (checked per request, where the token goes). */
function targetOf(server: Connection): Target | null {
    try {
        const origin = new URL(checkServerOrigin(server.origin));
        const send: Send = origin.protocol === "https:" ? httpsRequest : httpRequest;
        return { server, origin, send };
    } catch {
        return null;
    }
}

/** The options for one request to the server: its address, its method and path, and the headers that may go. */
function requestOptions(target: Target, method: string, path: string, headers: IncomingHttpHeaders, extra: OutgoingHttpHeaders): RequestOptions {
    const out: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined && passedHeader(name)) out[name] = value;
    }
    Object.assign(out, extra);
    out["authorization"] = `Bearer ${target.server.token}`;
    out["host"] = target.origin.host;
    // The page's origin was checked here already; the server sees its own origin, which its same-origin check accepts.
    if (headers.origin !== undefined) out["origin"] = target.origin.origin;
    return {
        protocol: target.origin.protocol,
        hostname: target.origin.hostname.replace(/^\[|\]$/g, ""),
        port: target.origin.port || undefined,
        method,
        path,
        headers: out,
    };
}

function replyHeaders(headers: IncomingHttpHeaders, origin: URL): OutgoingHttpHeaders {
    const out: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || DROPPED.has(name)) continue;
        if (name === "location" && typeof value === "string") {
            // An absolute address on the server becomes a path, so the page stays on this origin.
            try {
                const loc = new URL(value, origin);
                out[name] = loc.origin === origin.origin ? `${loc.pathname}${loc.search}${loc.hash}` : value;
                continue;
            } catch {
                /* not a URL: passes as it is */
            }
        }
        out[name] = value;
    }
    return out;
}

export function createForwarder(deps: ForwarderDeps): Forwarder {
    const relays = new Set<Relay>();
    return {
        closeFor(id) {
            for (const relay of [...relays]) {
                if (relay.server !== id) continue;
                relays.delete(relay);
                relay.destroy();
            }
        },

        handles: (path, url) => deps.connection() !== null && isRemotePath(path, url),

        handle(req, res, url) {
            return new Promise<void>((done) => {
                const server = deps.connection();
                const target = server ? targetOf(server) : null;
                if (!server || !target) {
                    json(res, 502, { error: "The server address is not acceptable." });
                    return done();
                }
                let settled = false;
                const finish = (): void => {
                    relays.delete(relay);
                    if (!settled) {
                        settled = true;
                        done();
                    }
                };
                const fail = (): void => {
                    deps.reached(server.id, false);
                    if (!res.headersSent) json(res, 502, { error: UNREACHABLE });
                    else res.destroy();
                    finish();
                };

                const upstream = target.send(requestOptions(target, req.method ?? "GET", url.pathname + url.search, req.headers, {}), (reply) => {
                    deps.reached(server.id, true);
                    // A 401 here means the token was refused: that is this process's fault, and a 401 would read as the page's own sign-in.
                    if (reply.statusCode === 401) {
                        reply.resume();
                        json(res, 502, { error: REFUSED });
                        return finish();
                    }
                    res.writeHead(reply.statusCode ?? 502, replyHeaders(reply.headers, target.origin));
                    reply.pipe(res);
                    reply.on("end", finish);
                    reply.on("error", () => {
                        res.destroy();
                        finish();
                    });
                });
                upstream.on("error", fail);
                const relay: Relay = {
                    server: server.id,
                    destroy: () => {
                        upstream.destroy();
                        res.destroy();
                    },
                };
                relays.add(relay);
                // A page that goes away ends what it was reading (server-sent events stay open otherwise).
                res.on("close", () => {
                    if (!res.writableFinished) upstream.destroy();
                    finish();
                });
                // The body is piped straight through: never buffered, cached or written anywhere on this side.
                req.pipe(upstream);
            });
        },

        handleUpgrade(req, socket, head) {
            const server = deps.connection();
            const target = server ? targetOf(server) : null;
            if (!server || !target) {
                socket.end(BAD_GATEWAY);
                return;
            }
            const extra: OutgoingHttpHeaders = { connection: "Upgrade", upgrade: "websocket" };
            for (const name of SOCKET_REQUEST) {
                const value = req.headers[name];
                if (value !== undefined) extra[name] = value;
            }
            const upstream = target.send(requestOptions(target, "GET", req.url ?? "/", req.headers, extra));
            let upstreamLeg: Duplex | undefined;
            const relay: Relay = {
                server: server.id,
                destroy: () => {
                    upstream.destroy();
                    upstreamLeg?.destroy();
                    socket.destroy();
                },
            };
            relays.add(relay);
            socket.once("close", () => relays.delete(relay));

            upstream.on("upgrade", (reply, upstreamSocket, upstreamHead) => {
                deps.reached(server.id, true);
                upstreamLeg = upstreamSocket;
                const lines = ["HTTP/1.1 101 Switching Protocols", "upgrade: websocket", "connection: Upgrade"];
                for (const name of SOCKET_REPLY) {
                    const value = reply.headers[name];
                    if (typeof value === "string") lines.push(`${name}: ${value}`);
                }
                socket.write(lines.join("\r\n") + "\r\n\r\n");
                // Bytes read past the handshake on either side belong to the other side.
                if (upstreamHead.length > 0) socket.write(upstreamHead);
                if (head.length > 0) upstreamSocket.write(head);
                // Frames are small and latency-bound: no Nagle delay on either leg, when the socket is a TCP one.
                if (socket instanceof Socket) socket.setNoDelay(true);
                if (upstreamSocket instanceof Socket) upstreamSocket.setNoDelay(true);
                // Either side closing or failing closes the other; back-pressure comes from pipe().
                const tie = (from: Duplex, to: Duplex): void => {
                    from.on("error", () => to.destroy());
                    from.on("close", () => to.destroy());
                };
                tie(socket, upstreamSocket);
                tie(upstreamSocket, socket);
                socket.pipe(upstreamSocket);
                upstreamSocket.pipe(socket);
            });
            // The server answered with an ordinary reply instead of switching protocols: refuse the page the same way.
            upstream.on("response", (reply) => {
                reply.resume();
                deps.reached(server.id, true);
                socket.end(BAD_GATEWAY);
            });
            upstream.on("error", () => {
                deps.reached(server.id, false);
                socket.end(BAD_GATEWAY);
            });
            socket.on("error", () => upstream.destroy());
            upstream.end();
        },
    };
}
