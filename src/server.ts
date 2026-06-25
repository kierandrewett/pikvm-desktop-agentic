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
import type { PiKvmControl } from "./pikvm-control";
import { createPiKvmProxy } from "./proxy";
import { WebSocketServer } from "ws";
import type { TerminalSessions, ClientMsg } from "./terminal-server";
import { MouseJiggler } from "./mouse-jiggler";
import { webAssets, DESKTOP_SHELL_COOKIE } from "./web-assets";
import { isAuthed, isLoopback, sessionValue, loginPage, SESSION_COOKIE } from "./web-auth";
import type { SettingsStore } from "./settings";

export interface ServerDeps {
    /** PiKVM control core — the proxy reads its target (origin + auth) from here, and
     *  the idle jiggler nudges the cursor through it. */
    control: PiKvmControl;
    settings: SettingsStore;
    /** Server-hosted terminal sessions, streamed to all devices over /_agent/terminal. */
    terminalSessions?: TerminalSessions;
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

export function startControlServer(deps: ServerDeps, port: number, host = "127.0.0.1"): ReturnType<typeof createServer> {
    const { control, settings } = deps;
    // Idle mouse-jiggler: keeps the target awake when nobody's driving. It tracks the
    // user's cursor off the proxied HID socket (onHidActivity) and restores the exact
    // position. With no agent there is nothing to hold off for, so it's never "busy".
    const jiggler = new MouseJiggler({
        control,
        enabled: () => settings.get().jiggler,
        isAgentBusy: () => false,
    });
    jiggler.start();

    const proxy = createPiKvmProxy({
        control,
        htmlInjection: (req) => webAssets.htmlInjection(req),
        onHidActivity: () => jiggler.noteUserActivity(),
    });

    /** Thin server state: just what the web/desktop console reads (the PiKVM
     *  keyboard layout, the jiggler toggle). No agent surface. */
    const state = () => {
        const s = settings.get();
        return {
            settings: {
                keyboardLayout: s.keyboardLayout,
                jiggler: s.jiggler,
                bindHost: s.bindHost,
            },
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

    server.listen(port, host);
    return server;
}
