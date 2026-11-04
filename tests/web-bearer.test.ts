/**
 * The web host's bearer (PIKVM_ACCESS_TOKEN), driven over real sockets through the route table.
 *
 * A request presenting `Authorization: Bearer` is judged by the bearer alone: a valid token is let through, a wrong one
 * is refused, and the rules of bearerVerdict (no Origin of another host, plain http only from loopback unless allowed,
 * no token configured = refuse) hold on every route. A request with no bearer is handled exactly as before.
 */

import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { WebSocketServer } from "ws";
import { bearerVerdict, presentsBearer, type SyncBearer } from "../src/server/auth";
import { createRouter, type RouteTargets } from "../src/server/routes";
import { createLiveConnections } from "../src/server/live";
import { createWebAssets } from "../src/server/static";

const TOKEN = "web-host-bearer-7f3a";

function marker(name: string) {
    return {
        handleHttp(req: IncomingMessage, res: ServerResponse): void {
            res.writeHead(200, { "content-type": "text/plain", "x-target": name });
            res.end(`${name} ${req.method} ${req.url}`);
        },
    };
}

function targets(bearer?: SyncBearer): RouteTargets {
    const kvmdSockets = new WebSocketServer({ noServer: true });
    const chatSockets = new WebSocketServer({ noServer: true });
    return {
        refuseLoopback: true,
        ...(bearer ? { syncBearer: bearer } : {}),
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
            handle(_req: IncomingMessage, res: ServerResponse): void {
                res.writeHead(200, { "content-type": "text/plain", "x-target": "cursor" });
                res.end("cursor");
            },
        },
        // The web host pins its own accessToken to "": sign-in is the proxy's job there.
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
        app: createWebAssets(resolve(tmpdir(), "pikvm-web-bearer-no-such-app")),
    };
}

interface Running {
    origin: string;
    close(): Promise<void>;
}

/** Serve a router on an ephemeral port. `remote` makes the peer a non-loopback address. */
async function run(t: RouteTargets, remote = false): Promise<Running> {
    const router = createRouter(t);
    const appear = (req: IncomingMessage): void => {
        if (remote) Object.defineProperty(req.socket, "remoteAddress", { value: "203.0.113.9" });
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

async function status(origin: string, path: string, headers: Record<string, string> = {}): Promise<number> {
    const res = await fetch(origin + path, { redirect: "manual", headers });
    await res.text();
    return res.status;
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** A WebSocket handshake status: 101 when accepted, otherwise the refusal (0 = no answer). */
function upgradeStatus(origin: string, path: string, headers: Record<string, string>): Promise<number> {
    const url = new URL(origin + path);
    return new Promise((done) => {
        const req = httpRequest({
            host: url.hostname,
            port: url.port,
            path: url.pathname,
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
    });
}

test("a valid bearer is accepted on the console and the forwarded kvmd routes", async () => {
    const s = await run(targets({ token: TOKEN, allowHttp: false }));
    try {
        assert.equal(await status(s.origin, "/app/api/v1/state", bearer(TOKEN)), 200);
        assert.equal(await status(s.origin, "/app/chat/api/conversations", bearer(TOKEN)), 200);
        assert.equal(await status(s.origin, "/anything-kvmd-owns", bearer(TOKEN)), 200);
    } finally {
        await s.close();
    }
});

test("a wrong bearer is refused 401 on every route", async () => {
    const s = await run(targets({ token: TOKEN, allowHttp: false }));
    try {
        assert.equal(await status(s.origin, "/app/api/v1/state", bearer("nope")), 401);
        assert.equal(await status(s.origin, "/app/chat/api/conversations", bearer("nope")), 401);
        assert.equal(await status(s.origin, "/anything-kvmd-owns", bearer("nope")), 401);
    } finally {
        await s.close();
    }
});

test("no bearer is handled as before: the loopback host is refused by the proxy rule", async () => {
    const s = await run(targets({ token: TOKEN, allowHttp: false }));
    try {
        // Unchanged from the web host without a bearer: refuseLoopback answers 403 to a loopback peer.
        assert.equal(await status(s.origin, "/app/api/v1/state"), 403);
    } finally {
        await s.close();
    }
});

test("no bearer configured: every bearer is refused, even the correct-looking one", async () => {
    const s = await run(targets(undefined));
    try {
        assert.equal(await status(s.origin, "/app/api/v1/state", bearer(TOKEN)), 403);
    } finally {
        await s.close();
    }
});

test("an empty configured token refuses every bearer", async () => {
    const s = await run(targets({ token: "", allowHttp: false }));
    try {
        // An empty bearer ("Bearer ") is not a bearer: it is left to the cookie gate, which refuses a loopback peer 403.
        assert.equal(await status(s.origin, "/app/api/v1/state", bearer("")), 403);
        assert.equal(await status(s.origin, "/app/api/v1/state", bearer(TOKEN)), 401);
    } finally {
        await s.close();
    }
});

test("a bearer from a browser page (an Origin that is not this host) is refused", async () => {
    const s = await run(targets({ token: TOKEN, allowHttp: false }));
    try {
        assert.equal(
            await status(s.origin, "/app/api/v1/state", { ...bearer(TOKEN), origin: "https://evil.example" }),
            401,
        );
        // An Origin that is this very host is not a foreign page: accepted.
        const own = new URL(s.origin).origin;
        assert.equal(await status(s.origin, "/app/api/v1/state", { ...bearer(TOKEN), origin: own }), 200);
    } finally {
        await s.close();
    }
});

test("a WebSocket upgrade with a bearer is judged by the same rules", async () => {
    const s = await run(targets({ token: TOKEN, allowHttp: false }));
    try {
        assert.equal(await upgradeStatus(s.origin, "/app/chat/ws", bearer(TOKEN)), 101);
        assert.equal(await upgradeStatus(s.origin, "/app/chat/ws", bearer("nope")), 0);
        assert.equal(
            await upgradeStatus(s.origin, "/app/chat/ws", { ...bearer(TOKEN), origin: "https://evil.example" }),
            0,
        );
    } finally {
        await s.close();
    }
});

test("plain http from a non-loopback peer is refused unless PIKVM_SYNC_ALLOW_HTTP is set", async () => {
    const refused = await run(targets({ token: TOKEN, allowHttp: false }), true);
    try {
        assert.equal(await status(refused.origin, "/app/api/v1/state", bearer(TOKEN)), 401);
    } finally {
        await refused.close();
    }
    const allowed = await run(targets({ token: TOKEN, allowHttp: true }), true);
    try {
        assert.equal(await status(allowed.origin, "/app/api/v1/state", bearer(TOKEN)), 200);
        assert.equal(await status(allowed.origin, "/app/api/v1/state", bearer("nope")), 401);
    } finally {
        await allowed.close();
    }
});

test("bearerVerdict: the loopback exemption does not apply to a presented bearer", () => {
    const fake = (remote: string, headers: Record<string, string>): IncomingMessage =>
        ({ socket: { remoteAddress: remote }, headers }) as unknown as IncomingMessage;
    const b: SyncBearer = { token: TOKEN, allowHttp: false };
    assert.equal(bearerVerdict(fake("127.0.0.1", { authorization: `Bearer ${TOKEN}` }), b), "allow");
    assert.equal(bearerVerdict(fake("203.0.113.9", { authorization: `Bearer ${TOKEN}` }), b), "deny");
    assert.equal(bearerVerdict(fake("127.0.0.1", { authorization: `Bearer ${TOKEN}`, origin: "https://x.example" }), b), "deny");
    assert.equal(presentsBearer(fake("127.0.0.1", { authorization: "Basic abc" })), false);
});
