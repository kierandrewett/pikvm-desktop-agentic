/**
 * The route table, driven over real sockets.
 *
 * Each target the table can reach is replaced by a stub that answers with its
 * own name, so a response says WHICH handler a request got to. The tests are
 * about the table and the gate, not the handlers behind them.
 *
 * The gate exempts loopback, and every connection here is loopback, so the
 * "remote" server rewrites the peer address the way a client on another
 * machine would present it.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { sessionValue, SESSION_COOKIE } from "../src/server/auth";
import { createRouter, type RouteTargets } from "../src/server/routes";
import { createWebAssets } from "../src/server/static";
import { createTerminalSocket } from "../src/server/terminal-socket";
import type { TerminalSessions } from "../src/terminal-server";

const TOKEN = "correct horse battery staple";
const WORKSPACE = { "x-pikvm-workspace": "1" };

/** A handler that answers `<name> <METHOD> <url>`. */
function marker(name: string) {
    return {
        handleHttp(req: IncomingMessage, res: ServerResponse): void {
            res.writeHead(200, { "content-type": "text/plain", "x-target": name });
            res.end(`${name} ${req.method} ${req.url}`);
        },
    };
}

function targets(over: { token?: string; harness?: boolean; appDir?: string } = {}): RouteTargets {
    const kvmdSockets = new WebSocketServer({ noServer: true });
    const sessions = {
        ensurePrimary() {},
        subscribe(send: (msg: unknown) => void) {
            send({ terminal: "stub" });
            return () => {};
        },
        handle() {},
    } as unknown as TerminalSessions;
    return {
        accessToken: () => over.token ?? "",
        kvmd: {
            ...marker("kvmd"),
            handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
                kvmdSockets.handleUpgrade(req, socket, head, (ws) => ws.send(`kvmd ${req.url}`));
            },
        },
        daemon: marker("daemon"),
        harness: over.harness === false ? null : marker("harness"),
        api: {
            async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
                res.writeHead(200, { "content-type": "text/plain", "x-target": "api" });
                res.end(`api ${req.method} ${req.url}`);
            },
        },
        workspace: {
            handles: (path: string) => path === "/app/workspace" || path.startsWith("/app/workspace/"),
            serve(path: string, res: ServerResponse): boolean {
                res.writeHead(200, { "content-type": "text/plain", "x-target": "workspace" });
                res.end(`workspace ${path}`);
                return true;
            },
        },
        // The real console bundle, so a page and its scripts are really served.
        assets: createWebAssets(resolve(process.cwd(), "src/views")),
        app: createWebAssets(over.appDir ?? resolve(tmpdir(), "pikvm-routes-no-such-app")),
        terminal: createTerminalSocket(sessions),
    };
}

interface Running {
    origin: string;
    close(): Promise<void>;
}

/** Serve a router on an ephemeral port. `remote` makes every peer look non-loopback. */
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

interface Reply {
    status: number;
    body: string;
    target: string | null;
    headers: Headers;
}

async function call(origin: string, path: string, init: RequestInit = {}): Promise<Reply> {
    const res = await fetch(origin + path, { redirect: "manual", ...init });
    return { status: res.status, body: await res.text(), target: res.headers.get("x-target"), headers: res.headers };
}

/** Open a WebSocket and report the first message, or why it was refused. */
function socket(origin: string, path: string, headers: Record<string, string> = {}): Promise<string> {
    return new Promise((done) => {
        const ws = new WebSocket(origin.replace("http", "ws") + path, { headers });
        ws.on("message", (data) => {
            done(data.toString());
            ws.close();
        });
        ws.on("unexpected-response", (_req, res) => {
            done(`refused ${res.statusCode}`);
            res.resume();
        });
        ws.on("error", (err) => done(`error ${err.message}`));
    });
}

test("everything outside /app reaches kvmd, and / goes to the console", async () => {
    const s = await run(targets());
    try {
        const root = await call(s.origin, "/");
        assert.equal(root.status, 302);
        assert.equal(root.headers.get("location"), "/app/");

        // A query string does not make it a different page.
        assert.equal((await call(s.origin, "/?x=1")).headers.get("location"), "/app/");

        // The Full-UI frame asks for the Pi's own front page by name.
        const native = await call(s.origin, "/?native=1");
        assert.equal(native.target, "kvmd");

        for (const path of ["/api/info", "/streamer/state", "/janus/ws", "/kvm/", "/login/", "/share/x"]) {
            const hit = await call(s.origin, path);
            assert.equal(hit.target, "kvmd", path);
            assert.equal(hit.body, `kvmd GET ${path}`, "the path reaches kvmd unchanged");
        }
        // An /app lookalike is not ours.
        assert.equal((await call(s.origin, "/application")).target, "kvmd");
        assert.equal((await call(s.origin, "/app-x/y")).target, "kvmd");
    } finally {
        await s.close();
    }
});

test("/app serves the console page and its static files", async () => {
    const s = await run(targets());
    try {
        assert.equal((await call(s.origin, "/app")).headers.get("location"), "/app/");

        for (const path of ["/app/", "/app/legacy", "/app/legacy/"]) {
            const page = await call(s.origin, path);
            assert.equal(page.status, 200, path);
            assert.match(page.headers.get("content-type") ?? "", /text\/html/);
            assert.match(page.body, /<link rel="manifest" href="\/app\/manifest\.webmanifest"/);
        }

        // Every script and stylesheet the page names is a file we serve. A path
        // rewrite once turned /app/console.js into /app/.js and the page came up
        // bare while every route test still passed.
        const page = await call(s.origin, "/app/");
        const refs = [...page.body.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="(\/app\/[^"]+)"/g)].map((m) => m[1]);
        assert.ok(refs.includes("/app/console.js") && refs.includes("/app/console.css"), refs.join(" "));
        for (const ref of refs) assert.equal((await call(s.origin, ref)).status, 200, ref);

        const script = await call(s.origin, "/app/console.js");
        assert.equal(script.status, 200);
        assert.match(script.headers.get("content-type") ?? "", /text\/javascript/);

        const manifest = await call(s.origin, "/app/manifest.webmanifest");
        assert.equal(manifest.status, 200);
        assert.match(manifest.headers.get("content-type") ?? "", /manifest\+json/);
        const parsed = JSON.parse(manifest.body) as { id: string; start_url: string; icons: { src: string }[] };
        assert.equal(parsed.start_url, "/app/");
        assert.equal(parsed.id, "/app/");
        // Every icon the manifest names is one the gate lets through unsigned.
        for (const icon of parsed.icons) assert.equal((await call(s.origin, icon.src)).status, 200, icon.src);

        // Ours to refuse, and refused as JSON: it must not fall through to the Pi.
        const missing = await call(s.origin, "/app/nope.js");
        assert.equal(missing.status, 404);
        assert.deepEqual(JSON.parse(missing.body), { error: "Not found" });
        assert.equal((await call(s.origin, "/app/unknown", { method: "POST" })).status, 404);
    } finally {
        await s.close();
    }
});

test("static files cannot be reached from outside the bundle", async () => {
    const s = await run(targets());
    try {
        for (const path of ["/app/%2e%2e/package.json", "/app/..%2fpackage.json", "/app/%2e%2e%2f%2e%2e%2fpackage.json"]) {
            const hit = await call(s.origin, path);
            // The URL parser folds an encoded `..` into the path, so this may be
            // kvmd's request now; what it must never be is a file from our tree.
            assert.ok(hit.status === 404 || hit.target === "kvmd", `${path}: ${hit.status}`);
            assert.doesNotMatch(hit.body, /"name": "pikvm-desktop-agentic"/, path);
        }
    } finally {
        await s.close();
    }
});

test("the static bundle's containment check needs the trailing separator", async () => {
    // views-x sits beside views and shares its prefix; a bare startsWith lets it in.
    const assets = createWebAssets(resolve(process.cwd(), "src/vie"));
    const served = { ended: false };
    const res = { writeHead() {}, end: () => (served.ended = true) } as unknown as ServerResponse;
    assert.equal(assets.serve("../views/console.html", res), false);
    assert.equal(served.ended, false);
});

test("/app/api is ours and only takes JSON writes", async () => {
    const s = await run(targets());
    try {
        const read = await call(s.origin, "/app/api/v1/state");
        assert.equal(read.target, "api");

        // A text/plain POST is what a cross-site page can send without a
        // preflight; the API will not take it.
        const form = await call(s.origin, "/app/api/v1/macros", {
            method: "PUT",
            headers: { "content-type": "text/plain" },
            body: "[]",
        });
        assert.equal(form.status, 415);

        const ok = await call(s.origin, "/app/api/v1/settings", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        assert.equal(ok.target, "api");

        // No CORS, on a reply or on a preflight.
        assert.equal(read.headers.get("access-control-allow-origin"), null);
        assert.equal(form.headers.get("access-control-allow-origin"), null);
        const preflight = await call(s.origin, "/app/api/v1/macros", {
            method: "OPTIONS",
            headers: { origin: "https://evil.example", "access-control-request-method": "PUT" },
        });
        assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    } finally {
        await s.close();
    }
});

test("the daemon and harness routes demand the workspace header, loopback or not", async () => {
    const s = await run(targets());
    try {
        for (const path of ["/app/daemon/sessions", "/app/daemon", "/app/harness/api/runs"]) {
            const bare = await call(s.origin, path, { method: "POST" });
            assert.equal(bare.status, 403, path);
            assert.deepEqual(JSON.parse(bare.body), { error: "Missing workspace header" });
        }
        const wrong = await call(s.origin, "/app/daemon/sessions", { headers: { "x-pikvm-workspace": "0" } });
        assert.equal(wrong.status, 403);

        const daemon = await call(s.origin, "/app/daemon/sessions?limit=1", { headers: WORKSPACE });
        assert.equal(daemon.target, "daemon");
        const harness = await call(s.origin, "/app/harness/api/runs", { method: "POST", headers: WORKSPACE });
        assert.equal(harness.target, "harness");
        // A lookalike prefix is not the proxy.
        assert.equal((await call(s.origin, "/app/daemonx")).status, 404);
    } finally {
        await s.close();
    }
});

test("a harness that was not configured has no route, not an open one", async () => {
    const s = await run(targets({ harness: false }));
    try {
        // Not even the header opens it: there is nothing behind it.
        const hit = await call(s.origin, "/app/harness/api/runs", { headers: WORKSPACE });
        assert.equal(hit.status, 503);
        assert.match(hit.body, /harness proxy not configured/);
    } finally {
        await s.close();
    }
});

test("the workspace bundle is mounted at /app/workspace", async () => {
    const s = await run(targets());
    try {
        assert.equal((await call(s.origin, "/app/workspace/")).body, "workspace /app/workspace/");
        assert.equal((await call(s.origin, "/app/workspace/app.js")).target, "workspace");
        // GET only: the bundle is static.
        assert.equal((await call(s.origin, "/app/workspace/", { method: "POST" })).status, 404);
    } finally {
        await s.close();
    }
});

test("with a token set, a remote client is stopped everywhere but the public files", async () => {
    const s = await run(targets({ token: TOKEN }), true);
    try {
        // Scripts and the API get a refusal; a browser asking for a page gets the sign-in page.
        for (const path of ["/api/info", "/app/console.js", "/app/api/v1/state", "/app/daemon/x", "/app/harness/x"]) {
            const refused = await call(s.origin, path, { headers: { accept: "application/json", ...WORKSPACE } });
            assert.equal(refused.status, 401, path);
            assert.deepEqual(JSON.parse(refused.body), { error: "Unauthorized" });
        }
        for (const path of ["/", "/app/", "/api/info"]) {
            const page = await call(s.origin, path, { headers: { accept: "text/html,*/*" } });
            assert.equal(page.status, 302, path);
            assert.equal(page.headers.get("location"), "/app/login");
        }

        // The sign-in page, and what it links to, must load before anyone is signed in.
        const login = await call(s.origin, "/app/login");
        assert.equal(login.status, 200);
        assert.match(login.body, /action="\/app\/auth"/);
        for (const path of [
            "/app/manifest.webmanifest",
            "/app/icon.png",
            "/app/icon-192.png",
            "/app/icon-512.png",
            "/app/apple-touch-icon.png",
            "/app/sw.js",
        ]) {
            assert.equal((await call(s.origin, path)).status, 200, path);
        }
    } finally {
        await s.close();
    }
});

test("signing in sets a session that passes the gate", async () => {
    const s = await run(targets({ token: TOKEN }), true);
    try {
        const wrong = await call(s.origin, "/app/auth", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "token=nope",
        });
        assert.equal(wrong.status, 302);
        assert.equal(wrong.headers.get("location"), "/app/login?error=1");
        assert.equal(wrong.headers.get("set-cookie"), null);

        const right = await call(s.origin, "/app/auth", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: `token=${encodeURIComponent(TOKEN)}`,
        });
        assert.equal(right.status, 302);
        assert.equal(right.headers.get("location"), "/app/");
        const cookie = right.headers.get("set-cookie") ?? "";
        assert.ok(cookie.startsWith(`${SESSION_COOKIE}=${sessionValue(TOKEN)}`));
        assert.match(cookie, /HttpOnly/);

        const signedIn = { cookie: `${SESSION_COOKIE}=${sessionValue(TOKEN)}` };
        assert.equal((await call(s.origin, "/api/info", { headers: signedIn })).target, "kvmd");
        assert.equal((await call(s.origin, "/app/api/v1/state", { headers: signedIn })).target, "api");
        assert.equal((await call(s.origin, "/api/info", { headers: { authorization: `Bearer ${TOKEN}` } })).target, "kvmd");

        const out = await call(s.origin, "/app/logout", { headers: signedIn });
        assert.equal(out.headers.get("location"), "/app/login?bye=1");
        assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
    } finally {
        await s.close();
    }
});

test("loopback skips the gate, which is why the capability routes need their header", async () => {
    const s = await run(targets({ token: TOKEN }), false);
    try {
        assert.equal((await call(s.origin, "/api/info")).target, "kvmd");
        assert.equal((await call(s.origin, "/app/daemon/x")).status, 403);
    } finally {
        await s.close();
    }
});

test("WebSocket upgrades: kvmd's sockets, our terminal, nothing else under /app", async () => {
    const s = await run(targets());
    try {
        assert.equal(await socket(s.origin, "/api/ws"), "kvmd /api/ws");
        assert.equal(await socket(s.origin, "/api/ws?stream=0"), "kvmd /api/ws?stream=0");
        assert.equal(await socket(s.origin, "/janus/ws"), "kvmd /janus/ws");
        assert.equal(await socket(s.origin, "/app/terminal"), JSON.stringify({ terminal: "stub" }));
        // The bare /terminal alias is gone: it is kvmd's path now, like any other.
        assert.equal(await socket(s.origin, "/terminal"), "kvmd /terminal");
        // Used to be forwarded to the Pi as a path the Pi has never heard of.
        assert.equal(await socket(s.origin, "/app/other"), "refused 404");
    } finally {
        await s.close();
    }
});

test("an unauthenticated upgrade is refused when the gate is on", async () => {
    const s = await run(targets({ token: TOKEN }), true);
    try {
        for (const path of ["/api/ws", "/janus/ws", "/app/terminal"]) {
            const result = await socket(s.origin, path);
            assert.match(result, /^error /, `${path}: ${result}`);
        }
        const signedIn = { cookie: `${SESSION_COOKIE}=${sessionValue(TOKEN)}` };
        assert.equal(await socket(s.origin, "/api/ws", signedIn), "kvmd /api/ws");
        assert.equal(await socket(s.origin, "/app/terminal", signedIn), JSON.stringify({ terminal: "stub" }));
        // And a bearer token is as good as a cookie.
        assert.equal(await socket(s.origin, "/janus/ws", { authorization: `Bearer ${TOKEN}` }), "kvmd /janus/ws");
    } finally {
        await s.close();
    }
});

/** A directory shaped like apps/web/dist. */
function fakeAppBuild(): string {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-app-build-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>app shell</title>");
    writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log('app')");
    writeFileSync(join(dir, "icon-192.png"), "png");
    return dir;
}

test("once the web app is built it owns /app/ and its client routes; the console moves to /app/legacy/", async () => {
    const dir = fakeAppBuild();
    const s = await run(targets({ appDir: dir }));
    try {
        for (const path of ["/app/", "/app/kvm", "/app/chat", "/app/settings", "/app/settings/keyboard/deep"]) {
            const page = await call(s.origin, path);
            assert.equal(page.status, 200, path);
            assert.match(page.body, /app shell/, path);
            assert.equal(page.headers.get("cache-control"), "no-cache");
        }
        // The old console is still reachable, and only there.
        for (const path of ["/app/legacy", "/app/legacy/"]) {
            const legacy = await call(s.origin, path);
            assert.equal(legacy.status, 200, path);
            assert.doesNotMatch(legacy.body, /app shell/);
            assert.match(legacy.body, /<title>/);
        }
        assert.equal((await call(s.origin, "/app/console.js")).status, 200, "the console's own files still load");

        // Hashed files are cached for good, the rest is revalidated.
        const hashed = await call(s.origin, "/app/assets/index-abc123.js");
        assert.equal(hashed.status, 200);
        assert.match(hashed.headers.get("cache-control") ?? "", /immutable/);
        assert.equal((await call(s.origin, "/app/icon-192.png")).headers.get("cache-control"), "no-cache");
        // A hashed file that does not exist is a 404, not the shell.
        assert.equal((await call(s.origin, "/app/assets/index-nope.js")).status, 404);
        // Only GET is a page.
        assert.equal((await call(s.origin, "/app/kvm", { method: "POST" })).status, 404);
        // Framing is the app's job (its KVM and Chat tabs), so the server forbids none of it.
        const legacy = await call(s.origin, "/app/legacy/");
        assert.equal(legacy.headers.get("x-frame-options"), null);
        assert.equal(legacy.headers.get("content-security-policy"), null);
    } finally {
        await s.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("without a web app build /app/ is the console and the client routes are not ours", async () => {
    const s = await run(targets());
    try {
        assert.match((await call(s.origin, "/app/")).body, /<title>/);
        assert.equal((await call(s.origin, "/app/kvm")).status, 404);
        assert.equal((await call(s.origin, "/app/settings/x")).status, 404);
    } finally {
        await s.close();
    }
});

test("the web app's pages are behind the gate; its icons are public", async () => {
    const dir = fakeAppBuild();
    const s = await run(targets({ appDir: dir, token: TOKEN }), true);
    try {
        assert.equal((await call(s.origin, "/app/kvm", { headers: { accept: "application/json" } })).status, 401);
        assert.equal((await call(s.origin, "/app/assets/index-abc123.js", { headers: { accept: "application/json" } })).status, 401);
        assert.equal((await call(s.origin, "/app/icon-192.png")).status, 200);
    } finally {
        await s.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("installs made before the move to /app can retire their old service worker", async () => {
    const s = await run(targets());
    try {
        const worker = await call(s.origin, "/_agent/sw.js");
        assert.equal(worker.status, 200);
        assert.match(worker.headers.get("content-type") ?? "", /^text\/javascript/);
        assert.equal(worker.headers.get("cache-control"), "no-store");
        // It clears both caches the old worker used, unregisters itself and
        // sends its windows to the new app.
        assert.match(worker.body, /skipWaiting/);
        assert.match(worker.body, /pikvm-console-v2/);
        assert.match(worker.body, /pikvm-agent-v1/);
        assert.match(worker.body, /registration\.unregister\(\)/);
        assert.match(worker.body, /client\.navigate\(self\.location\.origin \+ "\/app\/"\)/);
        // It is valid script, not just text that mentions the right words.
        assert.doesNotThrow(() => new Function(worker.body));

        // Everything else under the old prefix lands on the new one, with no path mapping.
        for (const path of ["/_agent", "/_agent/", "/_agent/console", "/_agent/api/state", "/_agent/terminal.html?x=1"]) {
            const moved = await call(s.origin, path);
            assert.equal(moved.status, 302, path);
            assert.equal(moved.headers.get("location"), "/app/", path);
        }
        const head = await call(s.origin, "/_agent/console", { method: "HEAD" });
        assert.equal(head.status, 302);
        // A lookalike is not the old prefix; it is kvmd's like any other path.
        assert.equal((await call(s.origin, "/_agentx")).target, "kvmd");
        // Writes are not redirected: nothing ever POSTed there that is worth sending on.
        assert.equal((await call(s.origin, "/_agent/api/macros", { method: "PUT" })).target, "kvmd");
    } finally {
        await s.close();
    }
});

test("the old prefix is behind the gate, except for the worker that retires it", async () => {
    const s = await run(targets({ token: TOKEN }), true);
    try {
        const worker = await call(s.origin, "/_agent/sw.js");
        assert.equal(worker.status, 200, "a browser fetches its worker without credentials");
        assert.equal((await call(s.origin, "/_agent/console", { headers: { accept: "application/json" } })).status, 401);
        const page = await call(s.origin, "/_agent/", { headers: { accept: "text/html" } });
        assert.equal(page.status, 302);
        assert.equal(page.headers.get("location"), "/app/login");
    } finally {
        await s.close();
    }
});
