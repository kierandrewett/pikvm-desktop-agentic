/**
 * Control server + PiKVM reverse proxy.
 *
 * One port hosts our own surface under `/_agent` and proxies everything else to
 * the PiKVM target (so web and desktop clients use the Pi's own UI):
 *  - /_agent/<asset>   : our own static bundle (the console + terminal renderer)
 *  - /_agent/terminal  : the shared terminal WebSocket (server-hosted PTYs)
 *  - /_agent/api/state : a thin state read (PiKVM origin, layout, jiggler)
 *  - everything else   : proxied to PiKVM (UI, MJPEG stream, HID WebSocket, login)
 *
 * The in-app AI agent (chat/approval/MCP/ambient) has been removed: this is now a
 * pure PiKVM client host — reverse proxy + shared terminal + static assets.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { resolve } from "node:path";
import type { PiKvmControl } from "./pikvm-control";
import { createPiKvmProxy } from "./proxy";
import { createDaemonProxy } from "./daemon-proxy";
import { WebSocketServer } from "ws";
import type { TerminalSessions, ClientMsg } from "./terminal-server";
import { MouseJiggler } from "./mouse-jiggler";
import { webAssets, DESKTOP_SHELL_COOKIE } from "./web-assets";
import { workspaceAssets } from "./workspace-assets";
import { isAuthed, isLoopback, sessionValue, loginPage, SESSION_COOKIE } from "./web-auth";
import type { SettingsStore } from "./settings";
import { MacroStore } from "./macros";

/** Marks a request as coming from our own workspace bundle. Its only job is to
 *  be un-settable by a cross-origin request without a preflight. */
const WORKSPACE_HEADER = "x-pikvm-workspace";

export interface ServerDeps {
    /** PiKVM control core — the proxy reads its target (origin + auth) from here, and
     *  the idle jiggler nudges the cursor through it. */
    control: PiKvmControl;
    settings: SettingsStore;
    /** Server-hosted terminal sessions, streamed to all devices over /_agent/terminal. */
    terminalSessions?: TerminalSessions;
    /** Base URL of the pikvm-agent daemon, reverse-proxied at /_agent/daemon/* so the
     *  same-origin Agent panel can reach its HTTP API without CORS. */
    daemonOrigin?: string;
    /** Desktop-owned daemon action capability injected by the reverse proxy. */
    daemonToken: string;
    /** Base URL of the first-party harness, reverse-proxied at /_agent/harness/*.
     *
     *  This is what lets the conversation be served from OUR origin instead of
     *  being loaded from the harness into a native view: its API comes back
     *  same-origin, so /api/* on this server can stay the kvmd proxy the console
     *  needs for HID and streaming. Omit it and no harness route is mounted. */
    harnessOrigin?: string;
    /** Desktop-owned OPERATOR capability. Stronger than the daemon token — it
     *  authorises computer input and approvals — and, like it, injected by the
     *  proxy so it never exists in renderer JavaScript. */
    harnessToken?: string;
}

function json(res: ServerResponse, status: number, body: unknown) {
    const data = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(data);
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}

export function startControlServer(
    deps: ServerDeps,
    port: number,
    host = "127.0.0.1",
    /* Told, not thrown.
     *
     * server.listen() reports asynchronously through an "error" event, and with
     * nothing listening for it Node re-raises it as an uncaught exception. In
     * the main process of an Electron app that is the raw "A JavaScript error
     * occurred in the main process" box with a node:net stack in it, which
     * tells the user nothing they can act on. The caller owns the UI, so it
     * gets to say what a failure to bind means. */
    onListenError?: (err: NodeJS.ErrnoException) => void,
): ReturnType<typeof createServer> {
    const { control, settings } = deps;
    // User macros live beside the other settings so they can be hand-edited and
    // copied between machines. Served here so web and desktop share one list.
    const macros = new MacroStore(resolve(settings.dir(), "macros.json"));
    // Idle mouse-jiggler: keeps the target awake when nobody's driving. It tracks the
    // user's cursor off the proxied HID socket (onHidActivity) and restores the exact
    // position. With no agent there is nothing to hold off for, so it's never "busy".
    const jiggler = new MouseJiggler({
        control,
        enabled: () => settings.get().jiggler,
        isAgentBusy: () => false,
        log: (line) => console.log(line),
    });
    jiggler.start();

    const proxy = createPiKvmProxy({
        control,
        htmlInjection: (req) => webAssets.htmlInjection(req),
        onHidActivity: () => jiggler.noteUserActivity(),
        // Track the user's real cursor so the nudge returns it exactly, instead of
        // jogging off a stale position we only ever updated from our own moves.
        onHidMouseMove: (x, y) => control.noteObservedMouse(x, y),
    });

    // The native Agent panel reaches the pikvm-agent daemon's HTTP API through here.
    const daemonProxy = createDaemonProxy({
        origin: deps.daemonOrigin ?? "http://127.0.0.1:47615",
        bearerToken: deps.daemonToken,
    });

    /* The same reverse proxy pointed at the harness, so the conversation can be
     * served from this origin and still reach its own API.
     *
     * Only mounted when both an origin and a token are supplied: half a
     * configuration would put an UNAUTHENTICATED route to the operator API on
     * this server, which is worse than no route at all. */
    const harnessProxy =
        deps.harnessOrigin && deps.harnessToken
            ? createDaemonProxy({
                  origin: deps.harnessOrigin,
                  bearerToken: deps.harnessToken,
                  prefix: "/_agent/harness",
              })
            : null;

    /** Thin server state: just what the web/desktop console reads (the PiKVM
     *  keyboard layout, the jiggler toggle). No agent surface. `jigglerStatus` is the
     *  evidence trail — last nudge, count, last error — so a target that went to sleep
     *  can be diagnosed instead of guessed at. */
    const state = () => {
        const s = settings.get();
        return {
            settings: {
                keyboardLayout: s.keyboardLayout,
                jiggler: s.jiggler,
                bindHost: s.bindHost,
            },
            /* What this host actually serves. The headless web host has no
             * shared terminal, and the console should not frame a panel whose
             * socket would only ever close. */
            features: { terminal: !!deps.terminalSessions },
            jigglerStatus: jiggler.status(),
        };
    };

    const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        let path = url.pathname;

        // Single-token gate (no-op when no token is configured). The login + auth
        // endpoints must stay reachable; everything else needs a valid session.
        const token = settings.get().accessToken;
        if (token && !isLoopback(req) && !isAuthed(req, token) && path !== "/_agent/login" && path !== "/_agent/auth" && path !== "/_agent/logout") {
            if (String(req.headers.accept ?? "").includes("text/html")) {
                res.writeHead(302, { location: "/_agent/login" });
                return res.end();
            }
            return json(res, 401, { error: "Unauthorized" });
        }

        // Default experience: the bare root serves OUR console (better on mobile
        // than the Pi's native UI). The Pi's own UI stays one tap away at
        // `/?native=1`; the desktop shell (its own native view) is never swapped.
        const isDesktopShell = (req.headers.cookie ?? "").includes(`${DESKTOP_SHELL_COOKIE}=desktop`);
        if (req.method === "GET" && path === "/" && url.searchParams.get("native") !== "1" && !isDesktopShell) {
            if (webAssets.serve("console.html", res)) return;
        }

        // Our surface is `/_agent/*`. Everything else is the PiKVM target.
        if (path !== "/_agent" && !path.startsWith("/_agent/")) {
            void proxy.handleHttp(req, res);
            return;
        }
        // Strip the namespace so the existing route table matches unchanged.
        path = path.slice("/_agent".length) || "/";

        // The pikvm-agent daemon is reverse-proxied under /_agent/daemon/* so the
        // same-origin Agent panel can reach its API (sessions/frames/approvals) with
        // no CORS. All methods + binary frames stream straight through.
        if (path === "/daemon" || path.startsWith("/daemon/")) {
            daemonProxy.handleHttp(req, res);
            return;
        }

        /* The conversation workspace, served from this origin so it can be part
         * of the page rather than another origin in a native view. Its API comes
         * back through the harness proxy below, which is same-origin from here. */
        if (req.method === "GET" && workspaceAssets.handles("/_agent" + path)) {
            if (workspaceAssets.serve("/_agent" + path, res)) return;
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            return res.end("workspace build not found");
        }

        /* Same idea for the harness API, behind the same /_agent/* auth gate —
         * plus a header no cross-origin request can set without a preflight.
         *
         * The gate above exempts loopback, which is right for a desktop app
         * talking to itself and wrong for a PAGE in the user's browser: it can
         * POST to 127.0.0.1 cross-origin, and the operator capability would be
         * attached server-side. CORS hides the reply, which is no comfort when
         * the point of the request was its side effect — this route can start a
         * run or answer an approval. A custom header forces a preflight, and
         * this server answers preflights for nobody, so the request never
         * arrives. It costs the workspace one header. */
        if (path === "/harness" || path.startsWith("/harness/")) {
            if (!harnessProxy) {
                res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
                return res.end("harness proxy not configured");
            }
            if (req.headers[WORKSPACE_HEADER] !== "1") {
                return json(res, 403, { error: "Missing workspace header" });
            }
            harnessProxy.handleHttp(req, res);
            return;
        }

        // Auth pages (only meaningful when a token is configured).
        if (path === "/login" && req.method === "GET") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(loginPage(url.searchParams.get("error") === "1", url.searchParams.get("bye") === "1"));
        }
        // Logout: clear the session cookie and return to the login screen.
        if (path === "/logout") {
            res.writeHead(302, {
                location: "/_agent/login?bye=1",
                "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
            });
            return res.end();
        }
        if (path === "/auth" && req.method === "POST") {
            void readBody(req).then((b) => {
                const submitted = new URLSearchParams(b).get("token") ?? "";
                if (token && submitted === token) {
                    res.writeHead(302, {
                        // Land on our own clean console (screen + manual control).
                        location: "/_agent/console",
                        "set-cookie": `${SESSION_COOKIE}=${sessionValue(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000`,
                    });
                    return res.end();
                }
                res.writeHead(302, { location: "/_agent/login?error=1" });
                return res.end();
            });
            return;
        }

        // The web/mobile console (live screen + manual keyboard/mouse).
        // `/_agent`, `/_agent/` and `/_agent/console` all land here.
        if (req.method === "GET" && (path === "/" || path === "/console")) {
            if (webAssets.serve("console.html", res)) return;
        }

        // Static agent assets (the UI bundle), served under `/_agent/...`.
        if (req.method === "GET" && webAssets.serve(path, res)) return;

        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
                "Access-Control-Allow-Headers": "content-type",
            });
            return res.end();
        }

        if (path === "/api/state" && req.method === "GET") return json(res, 200, state());

        if (path === "/api/macros" && req.method === "GET") return json(res, 200, { macros: macros.list() });
        if (path === "/api/macros" && req.method === "PUT") {
            void readBody(req).then((body) => {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(body);
                } catch {
                    return json(res, 400, { error: "Invalid JSON" });
                }
                const list = Array.isArray(parsed) ? parsed : (parsed as { macros?: unknown })?.macros;
                // An empty array is a legitimate "I deleted them all". A body we
                // cannot read as a list is a client bug, and saving it would wipe
                // every macro and report success while doing it.
                if (!Array.isArray(list)) return json(res, 400, { error: "Expected a macros array" });
                return json(res, 200, { macros: macros.replace(list) });
            });
            return;
        }

        json(res, 404, { error: "Not found" });
    });

    // The shared terminal lives on a WebSocket: every device subscribes and drives the same
    // server-hosted sessions. Handled here; everything else proxies to PiKVM.
    const termWss = new WebSocketServer({ noServer: true });
    termWss.on("connection", (ws) => {
        const sessions = deps.terminalSessions;
        if (!sessions) return ws.close();
        sessions.ensurePrimary();
        const send = (msg: unknown) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
        };
        const unsub = sessions.subscribe(send);
        ws.on("message", (raw) => {
            let msg: ClientMsg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }
            sessions.handle(msg, send);
        });
        ws.on("close", unsub);
        ws.on("error", unsub);
    });

    // PiKVM uses WebSockets for HID and stream-info; proxy every upgrade to it
    // (subject to the same token gate as HTTP).
    server.on("upgrade", (req, socket, head) => {
        const token = settings.get().accessToken;
        if (token && !isLoopback(req) && !isAuthed(req, token)) {
            socket.destroy();
            return;
        }
        // Our shared-terminal channel (mounted at /_agent/terminal and the bare /terminal).
        const upgradePath = (req.url || "").split("?")[0];
        if (upgradePath === "/_agent/terminal" || upgradePath === "/terminal") {
            termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit("connection", ws, req));
            return;
        }
        void proxy.handleUpgrade(req, socket, head);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
        if (onListenError) onListenError(err);
        else console.error(`[control] server error: ${err.message}`);
    });
    server.listen(port, host);
    return server;
}
