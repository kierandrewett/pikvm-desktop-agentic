// Smoke test for the reverse proxy + agent-asset serving against a mock PiKVM.
// Bundle to dist/ (so web-assets resolves dist/views) and run with node.
//   esbuild scripts/smoke-proxy.ts --bundle --platform=node --format=cjs --outfile=dist/smoke-proxy.cjs && node dist/smoke-proxy.cjs

import { createServer, type AddressInfo } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { PiKvmControl } from "../src/pikvm-control";
import { createPiKvmProxy } from "../src/proxy";
import { webAssets } from "../src/web-assets";
import { isAuthed, sessionValue, loginPage, SESSION_COOKIE } from "../src/web-auth";
import { ChatBroadcast } from "../src/agent/broadcast";

/**
 * Load the pure helpers from the browser console bundle without bundling its DOM
 * code: console.js returns early when `window` is undefined, exporting only its
 * pure key-map / coordinate / stream-URL helpers via module.exports.
 */
function loadConsolePure(): {
    charToKey: (ch: string, layout: string) => { code: string; shift: boolean } | null;
    fracToNorm: (f: number) => number;
    streamPath: (key: string, ua: string) => string;
} {
    const src = readFileSync(resolve(__dirname, "../src/views/console.js"), "utf8");
    const mod = { exports: {} as Record<string, unknown> };
    new Function("module", "exports", src)(mod, mod.exports);
    return mod.exports as ReturnType<typeof loadConsolePure>;
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
}

async function main(): Promise<void> {
    // 1. Mock PiKVM target.
    const pi = createServer((req, res) => {
        const piPath = new URL(req.url ?? "/", "http://x").pathname;
        if (piPath === "/") {
            res.writeHead(200, {
                "content-type": "text/html",
                "set-cookie": "auth_token=abc; Domain=pi.local; Secure; Path=/",
            });
            res.end("<html><head><title>Pi</title></head><body>PIKVM-UI</body></html>");
        } else if (piPath === "/x.txt") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("plain-passthrough");
        } else {
            res.writeHead(404);
            res.end("nope");
        }
    });
    const piPort = await listen(pi);

    // 2. Control + proxy pointing at the mock, then our minimal server shell.
    const control = new PiKvmControl({ origin: `http://127.0.0.1:${piPort}` });
    const proxy = createPiKvmProxy({ control, htmlInjection: (req) => webAssets.htmlInjection(req) });
    const srv = createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://x");
        let path = u.pathname;
        // Mirror server.ts: the bare root serves the console by default; the Pi UI
        // is at /?native=1; the desktop shell keeps the proxied Pi UI.
        const isDesktopShell = (req.headers.cookie ?? "").includes("agent_shell=desktop");
        if (req.method === "GET" && path === "/" && u.searchParams.get("native") !== "1" && !isDesktopShell) {
            if (webAssets.serve("console.html", res)) return;
        }
        if (path === "/_agent" || path.startsWith("/_agent/")) {
            path = path.slice("/_agent".length) || "/";
            // Mirror server.ts: `/_agent`, `/_agent/` and `/_agent/console` -> console.
            if (req.method === "GET" && (path === "/" || path === "/console") && webAssets.serve("console.html", res)) return;
            if (req.method === "GET" && webAssets.serve(path, res)) return;
            res.writeHead(404);
            res.end("agent-404");
            return;
        }
        void proxy.handleHttp(req, res);
    });
    const port = await listen(srv);
    const base = `http://127.0.0.1:${port}`;

    // 3. Assertions.
    const checks: Array<[string, boolean]> = [];

    // The bare root is now OUR console by default (better on mobile than the Pi UI).
    const rootRes = await fetch(`${base}/`);
    const rootBody = await rootRes.text();
    checks.push(["root / serves the console by default", rootRes.status === 200 && rootBody.includes('id="screen-pane"')]);

    // The Pi's own UI is one tap away at /?native=1 (and still gets our injection).
    const htmlRes = await fetch(`${base}/?native=1`);
    const html = await htmlRes.text();
    checks.push(["/?native=1 proxies the Pi HTML", html.includes("PIKVM-UI")]);
    checks.push(["head injection (viewport)", html.includes("data-pikvm-agent")]);
    checks.push(["body injection (FAB)", html.includes("pikvm-agent-fab")]);
    checks.push(["head inject is before </head>", html.indexOf("data-pikvm-agent") < html.indexOf("</head>")]);
    checks.push(["body inject is before </body>", html.indexOf("pikvm-agent-fab") < html.indexOf("</body>")]);

    const setCookie = htmlRes.headers.getSetCookie().join("; ");
    checks.push(["Set-Cookie Domain stripped", setCookie.length > 0 && !/Domain=/i.test(setCookie)]);
    checks.push(["Set-Cookie Secure stripped on http", !/Secure/i.test(setCookie)]);

    const txt = await (await fetch(`${base}/x.txt`)).text();
    checks.push(["non-HTML passthrough", txt === "plain-passthrough"]);

    checks.push(["touch.js script injected", html.includes('src="/_agent/touch.js"')]);
    checks.push(["FAB panel has an in-panel close button", html.includes("pikvm-agent-close")]);

    // Desktop shell (cookie) keeps the proxied Pi UI at root, viewport but no FAB.
    const desktopHtml = await (await fetch(`${base}/`, { headers: { cookie: "agent_shell=desktop" } })).text();
    checks.push(["desktop shell: proxied Pi UI at root", desktopHtml.includes("PIKVM-UI")]);
    checks.push(["desktop shell: no FAB", !desktopHtml.includes("pikvm-agent-fab")]);
    checks.push(["desktop shell: viewport kept", desktopHtml.includes("data-pikvm-agent")]);

    const sidebar = await fetch(`${base}/_agent/sidebar.html`);
    checks.push(["/_agent/sidebar.html served", sidebar.status === 200 && (await sidebar.text()).includes("root")]);

    const touch = await fetch(`${base}/_agent/touch.js`);
    checks.push(["/_agent/touch.js served", touch.status === 200 && (await touch.text()).includes("pinch")]);

    // Web/mobile console: page + assets served, and reachable at the clean paths.
    const consoleHtml = await fetch(`${base}/_agent/console`);
    const consoleBody = await consoleHtml.text();
    checks.push([
        "/_agent/console serves the console page",
        consoleHtml.status === 200 && consoleBody.includes('id="screen"') && consoleBody.includes("console.js"),
    ]);
    checks.push(["console has the chat iframe slot", consoleBody.includes('id="chat-frame"')]);
    checks.push(["console has the manual key bar", consoleBody.includes('data-key="Enter"') && consoleBody.includes('id="cad"')]);
    const consoleRoot = await fetch(`${base}/_agent/`);
    checks.push(["/_agent/ lands on the console", consoleRoot.status === 200 && (await consoleRoot.text()).includes('id="screen-pane"')]);
    const consoleJs = await fetch(`${base}/_agent/console.js`);
    const consoleJsBody = await consoleJs.text();
    checks.push(["console.js embeds the agent chat", consoleJsBody.includes("/_agent/sidebar.html")]);
    checks.push([
        "/_agent/console.js served + speaks the HID protocol",
        consoleJs.status === 200 && consoleJsBody.includes("mouse_move") && consoleJsBody.includes("/api/ws"),
    ]);
    checks.push(["console.js streams via /streamer/stream", consoleJsBody.includes("/streamer/stream")]);
    checks.push(["console.js polls /streamer/state for health/resilience", consoleJsBody.includes("/streamer/state")]);
    checks.push(["console consolidated bar (status + controls drawer)", consoleBody.includes('id="conn-text"') && consoleBody.includes('id="drawer"')]);
    const consoleCss = await fetch(`${base}/_agent/console.css`);
    checks.push([
        "/_agent/console.css served with a light theme",
        consoleCss.status === 200 && (await consoleCss.text()).includes('[data-theme="light"]'),
    ]);

    // Pure input helpers (key map, coordinate maths, stream URL).
    const cp = loadConsolePure();
    checks.push(["charToKey: 'a' -> KeyA (unshifted)", cp.charToKey("a", "us")?.code === "KeyA" && cp.charToKey("a", "us")?.shift === false]);
    checks.push(["charToKey: 'A' -> KeyA + shift", cp.charToKey("A", "us")?.code === "KeyA" && cp.charToKey("A", "us")?.shift === true]);
    checks.push(["charToKey: US '@' -> Digit2 + shift", cp.charToKey("@", "us")?.code === "Digit2" && cp.charToKey("@", "us")?.shift === true]);
    checks.push(["charToKey: UK '@' -> Quote + shift", cp.charToKey("@", "uk")?.code === "Quote" && cp.charToKey("@", "uk")?.shift === true]);
    checks.push(['charToKey: UK \'"\' -> Digit2 + shift', cp.charToKey('"', "uk")?.code === "Digit2" && cp.charToKey('"', "uk")?.shift === true]);
    checks.push(["charToKey: ' ' -> Space", cp.charToKey(" ", "us")?.code === "Space"]);
    checks.push(["fracToNorm: 0 -> -32767", cp.fracToNorm(0) === -32767]);
    checks.push(["fracToNorm: 0.5 -> 0", cp.fracToNorm(0.5) === 0]);
    checks.push(["fracToNorm: 1 -> 32767", cp.fracToNorm(1) === 32767]);
    checks.push(["streamPath: iOS quirk", cp.streamPath("k", "iPhone Safari").includes("dual_final_frames=1")]);
    checks.push(["streamPath: chrome quirk", cp.streamPath("k", "Chrome/120").includes("advance_headers=1")]);

    // PWA: manifest + icon + service worker served with the right content-types,
    // and the install metadata injected into proxied pages.
    checks.push(["manifest link injected", html.includes('rel="manifest"') && html.includes("/_agent/manifest.webmanifest")]);
    checks.push(["apple-touch-icon injected", html.includes('rel="apple-touch-icon"') && html.includes("/_agent/icon.png")]);
    checks.push(["standalone meta injected", html.includes('name="apple-mobile-web-app-capable"')]);
    const manifest = await fetch(`${base}/_agent/manifest.webmanifest`);
    const manifestBody = await manifest.json().catch(() => null);
    checks.push([
        "/_agent/manifest.webmanifest served as manifest+json",
        manifest.status === 200 && (manifest.headers.get("content-type") ?? "").includes("manifest+json") && manifestBody?.display === "standalone",
    ]);
    const sw = await fetch(`${base}/_agent/sw.js`);
    checks.push([
        "/_agent/sw.js served as javascript",
        sw.status === 200 && (sw.headers.get("content-type") ?? "").includes("javascript") && (await sw.text()).includes("pikvm-agent-v1"),
    ]);
    const icon = await fetch(`${base}/_agent/icon.png`);
    checks.push(["/_agent/icon.png served as image/png", icon.status === 200 && (icon.headers.get("content-type") ?? "") === "image/png"]);

    // 4. Auth helpers (unit-level).
    const TOKEN = "s3cret";
    const mkReq = (h: Record<string, string>) => ({ headers: h, url: "/" }) as unknown as Parameters<typeof isAuthed>[0];
    checks.push(["empty token -> open", isAuthed(mkReq({}), "")]);
    checks.push(["no creds -> denied", !isAuthed(mkReq({}), TOKEN)]);
    checks.push(["valid cookie -> allowed", isAuthed(mkReq({ cookie: `${SESSION_COOKIE}=${sessionValue(TOKEN)}` }), TOKEN)]);
    checks.push(["bearer token -> allowed", isAuthed(mkReq({ authorization: `Bearer ${TOKEN}` }), TOKEN)]);
    checks.push(["login page renders", loginPage().includes("Access token")]);
    // Login page is part of the installable PWA shell + has the signed-out notice.
    const loginHtml = loginPage(false, true);
    checks.push(["login page is PWA shell", loginHtml.includes('rel="manifest"') && loginHtml.includes('name="theme-color"') && loginHtml.includes('name="apple-mobile-web-app-capable"')]);
    checks.push(["login page shows signed-out notice", loginHtml.includes("Signed out")]);
    checks.push(["login error precedes signed-out", loginPage(true, true).includes("Wrong token") && !loginPage(true, true).includes("Signed out")]);

    // 5. Auth flow against a token-gated shell (mirrors the server gate).
    const gated = createServer((req, res) => {
        let p = new URL(req.url ?? "/", "http://x").pathname;
        if (TOKEN && !isAuthed(req, TOKEN) && p !== "/_agent/login" && p !== "/_agent/auth") {
            if (String(req.headers.accept ?? "").includes("text/html")) {
                res.writeHead(302, { location: "/_agent/login" });
                return res.end();
            }
            res.writeHead(401);
            return res.end("no");
        }
        if (p === "/_agent/login") {
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(loginPage());
        }
        if (p === "/_agent/logout") {
            res.writeHead(302, { location: "/_agent/login?bye=1", "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0` });
            return res.end();
        }
        if (p === "/_agent/auth" && req.method === "POST") {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const submitted = new URLSearchParams(Buffer.concat(chunks).toString()).get("token") ?? "";
                if (submitted === TOKEN) {
                    res.writeHead(302, { location: "/", "set-cookie": `${SESSION_COOKIE}=${sessionValue(TOKEN)}; Path=/` });
                    return res.end();
                }
                res.writeHead(302, { location: "/_agent/login?error=1" });
                return res.end();
            });
            return;
        }
        res.writeHead(200);
        res.end("authed-ok");
    });
    const gport = await listen(gated);
    const gbase = `http://127.0.0.1:${gport}`;

    const navNoCreds = await fetch(`${gbase}/`, { headers: { accept: "text/html" }, redirect: "manual" });
    checks.push(["nav without token -> 302 login", navNoCreds.status === 302 && navNoCreds.headers.get("location") === "/_agent/login"]);
    const apiNoCreds = await fetch(`${gbase}/x`, { headers: { accept: "application/json" }, redirect: "manual" });
    checks.push(["api without token -> 401", apiNoCreds.status === 401]);
    const authRes = await fetch(`${gbase}/_agent/auth`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${TOKEN}`,
        redirect: "manual",
    });
    const cookie = (authRes.headers.getSetCookie()[0] ?? "").split(";")[0];
    checks.push(["correct token -> session cookie", authRes.status === 302 && cookie.startsWith(SESSION_COOKIE)]);
    const withCookie = await fetch(`${gbase}/`, { headers: { accept: "text/html", cookie }, redirect: "manual" });
    checks.push(["request with session cookie -> allowed", withCookie.status === 200 && (await withCookie.text()) === "authed-ok"]);
    // Logout: reachable without re-auth, clears the cookie, returns to login.
    const logout = await fetch(`${gbase}/_agent/logout`, { headers: { cookie }, redirect: "manual" });
    const cleared = logout.headers.getSetCookie()[0] ?? "";
    checks.push([
        "logout clears cookie + redirects to login",
        logout.status === 302 && logout.headers.get("location") === "/_agent/login?bye=1" && /Max-Age=0/.test(cleared),
    ]);
    gated.close();

    // 6. WebSocket proxy (the HID / stream-info path). Mock Pi WS echoes on /ws; a
    // client connects through our proxy and must get the echo back. On any other
    // path the mock Pi refuses to upgrade and returns a normal HTTP response - the
    // proxy must relay that and close, never leave the client WS hanging.
    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (s) => s.on("message", (m) => s.send(`echo:${m.toString()}`)));
    pi.on("upgrade", (req, socket, head) => {
        if (req.url === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
        else socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 6\r\n\r\ndenied");
    });
    srv.on("upgrade", (req, socket, head) => void proxy.handleUpgrade(req, socket, head as Buffer));
    const wsOk = await new Promise<boolean>((resolve) => {
        const c = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const t = setTimeout(() => {
            resolve(false);
            c.terminate();
        }, 3000);
        c.on("open", () => c.send("ping"));
        c.on("message", (m) => {
            clearTimeout(t);
            resolve(m.toString() === "echo:ping");
            c.close();
        });
        c.on("error", () => {
            clearTimeout(t);
            resolve(false);
        });
    });
    checks.push(["WebSocket proxied (HID path)", wsOk]);

    // Non-upgrade upstream response: the client must be told (unexpected-response
    // / error) promptly, not hang until timeout.
    const noHang = await new Promise<boolean>((resolve) => {
        const c = new WebSocket(`ws://127.0.0.1:${port}/denied-ws`);
        const t = setTimeout(() => {
            resolve(false);
            c.terminate();
        }, 3000);
        const done = () => {
            clearTimeout(t);
            resolve(true);
        };
        c.on("unexpected-response", done);
        c.on("error", done);
        c.on("open", () => {
            clearTimeout(t);
            resolve(false);
            c.close();
        });
    });
    checks.push(["WS non-upgrade response relayed (no hang)", noHang]);
    wss.close();

    // Live chat broadcast hub: fans UI chunks out to all subscribers as SSE.
    {
        const hub = new ChatBroadcast();
        const a: string[] = [];
        const b: string[] = [];
        const mk = (sink: string[]) => ({ write: (s: string) => sink.push(s), on: () => {} }) as unknown as Parameters<typeof hub.add>[0];
        hub.add(mk(a));
        hub.add(mk(b));
        hub.send({ type: "begin", clientId: "c1" });
        hub.writer().write({ type: "text-delta", id: "t0", delta: "hi" });
        checks.push(["broadcast fans out to all subscribers", a.length === 2 && b.length === 2]);
        checks.push(["broadcast frames are SSE data lines", a[0].startsWith("data: ") && a[0].endsWith("\n\n")]);
        checks.push(["broadcast begin chunk carries clientId", JSON.parse(a[0].slice(6)).clientId === "c1"]);
        checks.push(["broadcast writer adapter emits chunks", JSON.parse(a[1].slice(6)).type === "text-delta"]);
    }

    let ok = true;
    for (const [name, pass] of checks) {
        console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
        if (!pass) ok = false;
    }
    srv.close();
    pi.close();
    process.exit(ok ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
