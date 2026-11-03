/**
 * Reverse proxy to the PiKVM target.
 *
 * The web/desktop clients never talk to the Pi directly. They talk to our server,
 * which forwards everything that is not under our own `/app` namespace straight
 * to the Pi (its web UI, the MJPEG stream, the HID WebSocket, login, all of it),
 * injecting the PiKVM auth on every request so the client does not have to log in
 * to the Pi itself.
 *
 * Why proxy instead of rebuilding the viewer: the Pi already has a working stream,
 * HID and input pipeline. Re-implementing that would be a lot of fragile work for
 * no gain. Proxying keeps a single source of truth (the Pi).
 *
 * Responses are relayed byte for byte. This file used to splice a floating-button
 * bundle into proxied HTML; the sidebar it opened no longer exists, so the
 * injection only added buffering and a dead button to the Full-UI frame.
 */

import { CURSOR_CLIENT_PARAM } from "@pikvm/contracts/api";
import { request as httpRequest, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import type { PiKvmControl } from "../../pikvm-control";

/** What a person did through the proxy that reaches the target as input. A heartbeat is not one. */
export type HidInputKind = "key" | "mouse_move" | "mouse_button" | "mouse_wheel" | "mouse_relative" | "print";

export interface ProxyDeps {
    control: PiKvmControl;
    /**
     * Signalled on user HID input over the proxied input WebSocket (/api/ws) — so the
     * idle mouse-jiggler knows the user is active and holds off.
     */
    onHidActivity?: () => void;
    /**
     * Absolute cursor position (PiKVM normalized units) seen on that same socket, and which client sent it
     * (see `clientOf`). The jiggler's nudge nets back to zero displacement only if we know where the cursor
     * ACTUALLY is; without this we only track moves we sent ourselves, so a nudge would teleport the user's
     * pointer to a stale guess. The shared cursor tells every other client.
     */
    onHidMouseMove?: (x: number, y: number, source: string) => void;
    /** A relative move (target pixels) seen on that socket, and which client sent it. */
    onHidMouseRelative?: (dx: number, dy: number, source: string) => void;
    /**
     * A key, button, move, wheel or paste a person sent to the target through this proxy. Unlike
     * onHidActivity it ignores heartbeats, so it can end the agent's control without a pinging
     * tab doing it. The agent's own input never passes here: it has its own link to the Pi.
     */
    onHidInput?: (kind: HidInputKind) => void;
}

export interface HidTapEvents {
    onActivity: () => void;
    onMouseMove?: (x: number, y: number) => void;
    onMouseRelative?: (dx: number, dy: number) => void;
    onInput?: (kind: HidInputKind) => void;
}

/** kvmd's binary HID frames carry the event type in the first byte; 0 is a ping. */
const BINARY_KINDS: Readonly<Record<number, HidInputKind>> = {
    1: "key",
    2: "mouse_button",
    3: "mouse_move",
    4: "mouse_relative",
    5: "mouse_wheel",
};

const TEXT_KINDS: Record<string, true> = { key: true, mouse_move: true, mouse_button: true, mouse_wheel: true, mouse_relative: true };

/** The query parameter a page puts on its input socket's URL to say which client it is; the Pi never sees it. */
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Which client an input socket's URL names, and the URL without that parameter (kvmd is sent what it always was).
 * A missing or malformed name is not an error: the socket is a client of its own without a name.
 */
export function clientOf(url: string): { path: string; client: string | null } {
    const cut = url.indexOf("?");
    if (cut < 0) return { path: url, client: null };
    const params = new URLSearchParams(url.slice(cut + 1));
    const named = params.get(CURSOR_CLIENT_PARAM);
    if (!params.has(CURSOR_CLIENT_PARAM)) return { path: url, client: null };
    params.delete(CURSOR_CLIENT_PARAM);
    const rest = params.toString();
    return { path: rest ? `${url.slice(0, cut)}?${rest}` : url.slice(0, cut), client: named !== null && CLIENT_ID.test(named) ? named : null };
}

/**
 * Watch the (always-masked) client→server HID socket. Every data frame counts as user
 * activity; `mouse_move` frames are unmasked and parsed so we also learn where the
 * cursor is, and every frame that is real input (not a ping) is classified for onInput.
 * Buffers across TCP segment boundaries; defensive — never throws into the
 * socket pipeline, and never modifies it (the pipe still forwards every byte).
 */
export function makeHidTap(events: HidTapEvents): (chunk: Buffer) => void {
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
                const frameLen = off + (masked ? 4 : 0) + len;
                if (buf.length < frameLen) break; // frame not fully arrived yet
                const frame = buf.subarray(0, frameLen);
                buf = buf.subarray(frameLen);
                if (opcode !== 0x1 && opcode !== 0x2) continue; // ping/pong/close carry no input
                events.onActivity();
                // Only frames small enough to be an input event — anything larger is not a
                // KVMD HID message and isn't worth decoding.
                if (len === 0 || len > 4096) continue;
                const payload = frame.subarray(off + (masked ? 4 : 0));
                const mask = masked ? frame.subarray(off, off + 4) : undefined;
                if (opcode === 0x2) {
                    const type = mask ? payload[0]! ^ mask[0]! : payload[0]!;
                    const kind = BINARY_KINDS[type];
                    if (kind) {
                        events.onInput?.(kind);
                        if (events.onMouseMove || events.onMouseRelative) readBinaryMouse(type, mask ? unmask(payload, mask) : payload, events);
                    }
                } else if (events.onMouseMove || events.onMouseRelative || events.onInput) {
                    readTextEvent(payload, mask, events);
                }
            }
            if (buf.length > 1 << 20) buf = Buffer.alloc(0); // safety cap (not a real WS stream)
        } catch {
            /* never disturb the proxied socket */
        }
    };
}

/** A masked payload with the client's mask taken off. */
function unmask(payload: Buffer, mask: Buffer): Buffer {
    const out = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) out[i] = payload[i]! ^ mask[i & 3]!;
    return out;
}

/**
 * The position in kvmd's binary mouse frames (what its own web page sends). Absolute: type 3, then x and y as
 * signed 16-bit big-endian. Relative: type 4, a squash flag, then one or more (dx, dy) pairs of signed bytes.
 * A frame of any other length is not read: a wrong position told to every client is worse than none.
 */
function readBinaryMouse(type: number, bytes: Buffer, events: HidTapEvents): void {
    if (type === 3 && bytes.length === 5) {
        events.onMouseMove?.(bytes.readInt16BE(1), bytes.readInt16BE(3));
    } else if (type === 4 && bytes.length >= 4 && bytes.length % 2 === 0) {
        let dx = 0;
        let dy = 0;
        for (let i = 2; i < bytes.length; i += 2) {
            dx += bytes.readInt8(i);
            dy += bytes.readInt8(i + 1);
        }
        events.onMouseRelative?.(dx, dy);
    }
}

/** Unmask a WebSocket text payload and report what KVMD event it is. */
function readTextEvent(payload: Buffer, mask: Buffer | undefined, events: HidTapEvents): void {
    const text = (mask ? unmask(payload, mask) : payload).toString("utf8");
    // A bare "ping" text frame is not JSON; every input event is.
    if (text.charCodeAt(0) !== 0x7b) return;
    let msg: { event_type?: unknown; event?: { to?: { x?: unknown; y?: unknown }; delta?: { x?: unknown; y?: unknown } } };
    try {
        msg = JSON.parse(text);
    } catch {
        return;
    }
    const type = msg?.event_type;
    if (typeof type !== "string" || !Object.hasOwn(TEXT_KINDS, type)) return;
    events.onInput?.(type as HidInputKind);
    const to = type === "mouse_move" ? msg.event?.to : undefined;
    if (typeof to?.x === "number" && typeof to?.y === "number") events.onMouseMove?.(to.x, to.y);
    const delta = type === "mouse_relative" ? msg.event?.delta : undefined;
    if (typeof delta?.x === "number" && typeof delta?.y === "number") events.onMouseRelative?.(delta.x, delta.y);
}

const HTTP_HID_KINDS: Record<string, HidInputKind> = {
    "/api/hid/print": "print",
    "/api/hid/events/send_key": "key",
    "/api/hid/events/send_shortcut": "key",
    "/api/hid/events/send_mouse_button": "mouse_button",
    "/api/hid/events/send_mouse_move": "mouse_move",
    "/api/hid/events/send_mouse_relative": "mouse_relative",
    "/api/hid/events/send_mouse_wheel": "mouse_wheel",
};

/** The HTTP routes a client can also type, click or paste through. A person pasting into the target is input. */
function httpHidInput(method: string | undefined, url: string | undefined): HidInputKind | null {
    if (method !== "POST" || !url) return null;
    const path = url.split("?", 1)[0] ?? "";
    return Object.hasOwn(HTTP_HID_KINDS, path) ? HTTP_HID_KINDS[path]! : null;
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
    /** Counts the input sockets that named no client, so each is a client of its own. */
    let sockets = 0;

    async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const input = httpHidInput(req.method, req.url);
        if (input) deps.onHidInput?.(input);
        const { origin, headers: auth, rejectUnauthorized } = await deps.control.proxyTarget();
        const isHttps = origin.protocol === "https:";
        const requestFn = isHttps ? httpsRequest : httpRequest;

        // The body is relayed untouched, so accept-encoding passes through and the
        // Pi's compression reaches the client as it was sent.
        const outHeaders: OutgoingHttpHeaders = { ...req.headers, ...auth, host: origin.host };
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

                res.writeHead(status, headers);
                proxyRes.pipe(res);
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
        // Which of our own pages this socket is, if it says: kvmd gets the URL it always got.
        const url = req.url ?? "/";
        const isInput = url.startsWith("/api/ws");
        const { path, client } = isInput ? clientOf(url) : { path: url, client: null };
        const source = client ?? `socket-${++sockets}`;
        const outHeaders: OutgoingHttpHeaders = { ...req.headers, ...auth, host: origin.host };

        const proxyReq = requestFn({
            protocol: origin.protocol,
            hostname: origin.hostname,
            port: origin.port || (isHttps ? 443 : 80),
            method: req.method,
            path,
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
            if (isInput && (deps.onHidActivity || deps.onHidInput || deps.onHidMouseMove || deps.onHidMouseRelative)) {
                const moved = deps.onHidMouseMove;
                const nudged = deps.onHidMouseRelative;
                clientSocket.on(
                    "data",
                    makeHidTap({
                        onActivity: deps.onHidActivity ?? (() => undefined),
                        ...(moved ? { onMouseMove: (x: number, y: number) => moved(x, y, source) } : {}),
                        ...(nudged ? { onMouseRelative: (dx: number, dy: number) => nudged(dx, dy, source) } : {}),
                        ...(deps.onHidInput ? { onInput: deps.onHidInput } : {}),
                    }),
                );
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
