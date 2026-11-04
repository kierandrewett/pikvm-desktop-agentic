/**
 * A route table over real sockets for the web host's sign-in tests: every target it can reach is a stub that
 * answers with its own name, so a reply says WHICH handler a request got to. The gate under test is the real
 * one (`createRouter` with a real `WebAuth`).
 *
 * Every connection here is loopback; `peer` rewrites the address the host sees, the way a client on another machine
 * (or a proxy on the docker network) would look.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { createRouter, type RouteTargets } from "../../src/server/routes";
import { createLiveConnections } from "../../src/server/live";
import { createWebAssets } from "../../src/server/static";
import type { WebAuth } from "../../src/server/web-auth";

function marker(name: string) {
    return {
        handleHttp(req: IncomingMessage, res: ServerResponse): void {
            res.writeHead(200, { "content-type": "text/plain", "x-target": name });
            res.end(`${name} ${req.method} ${req.url}`);
        },
    };
}

/** The route targets, with `webAuth` as the gate (none: the desktop's gate with no token, which lets everything in). */
export function stubTargets(webAuth?: WebAuth): RouteTargets {
    const kvmdSockets = new WebSocketServer({ noServer: true });
    const chatSockets = new WebSocketServer({ noServer: true });
    return {
        ...(webAuth ? { webAuth } : {}),
        chat: {
            async handleRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
                res.writeHead(200, { "content-type": "text/plain", "x-target": "chat" });
                res.end(`chat ${req.method} ${req.url}`);
            },
            handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
                chatSockets.handleUpgrade(req, socket, head, (ws) => ws.send(`chat ${req.url}`));
                return true;
            },
        },
        agent: {
            handles: (path: string) => path.startsWith("/app/api/v1/agent/"),
            handle(req: IncomingMessage, res: ServerResponse, path: string): void {
                res.writeHead(200, { "content-type": "text/plain", "x-target": "agent" });
                res.end(`agent ${req.method} ${path}`);
            },
        },
        watch: {
            handles: (path: string) => path.startsWith("/app/api/v1/watch"),
            handle(req: IncomingMessage, res: ServerResponse, path: string): void {
                res.writeHead(200, { "content-type": "text/plain", "x-target": "watch" });
                res.end(`watch ${req.method} ${path}`);
            },
        },
        cursor: {
            handles: (path: string) => path === "/app/api/v1/cursor",
            // A server-sent-events stream: one event, then the stream ends so a test can read it whole.
            handle(_req: IncomingMessage, res: ServerResponse): void {
                res.writeHead(200, { "content-type": "text/event-stream", "x-target": "cursor" });
                res.end('data: {"x":0.5,"y":0.5}\n\n');
            },
        },
        live: createLiveConnections(),
        accessToken: () => "",
        kvmd: {
            ...marker("kvmd"),
            handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
                kvmdSockets.handleUpgrade(req, socket, head, (ws) => ws.send(`kvmd ${req.url}`));
            },
        },
        api: {
            async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
                res.writeHead(200, { "content-type": "text/plain", "x-target": "api" });
                res.end(`api ${req.method} ${req.url}`);
            },
        },
        assets: createWebAssets(resolve(process.cwd(), "src/views")),
        app: createWebAssets(resolve(tmpdir(), "pikvm-web-rig-no-such-app")),
    };
}

export interface Running {
    origin: string;
    close(): Promise<void>;
}

/** Serve a router on an ephemeral port. `peer` is the address the host sees for every connection (default: loopback). */
export async function run(t: RouteTargets, peer?: string): Promise<Running> {
    const router = createRouter(t);
    const appear = (req: IncomingMessage): void => {
        if (peer) Object.defineProperty(req.socket, "remoteAddress", { value: peer });
    };
    const server: Server = createServer((req, res) => {
        appear(req);
        router.onRequest(req, res);
    });
    server.on("upgrade", (req, socket, head) => {
        appear(req);
        router.onUpgrade(req, socket, head);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((done) => {
                server.closeAllConnections();
                server.close(() => done());
            }),
    };
}

export interface Reply {
    status: number;
    body: string;
    target: string | null;
    headers: Headers;
    cookies: string[];
}

/** Everything every call saw (status line, headers and body), so a test can look for what must never appear. */
export const transcript: string[] = [];

export async function call(origin: string, path: string, init: RequestInit = {}): Promise<Reply> {
    const res = await fetch(origin + path, { redirect: "manual", ...init });
    const body = await res.text();
    const lines: string[] = [];
    res.headers.forEach((value, key) => lines.push(`${key}: ${value}`));
    const headers = lines.join("\n");
    transcript.push(`${res.status}\n${headers}\n${body}`);
    return { status: res.status, body, target: res.headers.get("x-target"), headers: res.headers, cookies: res.headers.getSetCookie() };
}

/** A WebSocket handshake status: 101 when accepted, otherwise the refusal (0 = no answer, the socket was destroyed). */
export function upgradeStatus(origin: string, path: string, headers: Record<string, string> = {}): Promise<number> {
    const url = new URL(origin + path);
    const { promise, resolve: done } = Promise.withResolvers<number>();
    const req = httpRequest({
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            ...headers,
        },
    });
    req.on("upgrade", (_res, socket) => {
        socket.destroy();
        done(101);
    });
    req.on("response", (res) => {
        res.resume();
        done(res.statusCode ?? 0);
    });
    req.on("error", () => done(0));
    req.end();
    return promise;
}
