/**
 * Control server + PiKVM reverse proxy.
 *
 * One port hosts our own surface under `/app` and proxies everything else to
 * the PiKVM target. This file only builds the pieces and wires them to a Node
 * http server; which request reaches which piece is decided in routes.ts.
 *
 *   routes.ts     the route table and the single place the gate is applied
 *   auth.ts       the gate, the session cookie and the sign-in page
 *   api/          the HttpApi implementation for /app/api/v1/*
 *   proxy/        kvmd, daemon and harness passthroughs
 *   static.ts     the console bundle; workspace.ts the agent workspace bundle
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { MacroStore } from "../macros";
import { MouseJiggler } from "../mouse-jiggler";
import type { PiKvmControl } from "../pikvm-control";
import type { SettingsStore } from "../settings";
import type { TerminalSessions } from "../terminal-server";
import { createApi } from "./api";
import { createRouter } from "./routes";
import { createDaemonProxy } from "./proxy/daemon";
import { createPiKvmProxy } from "./proxy/kvmd";
import { appAssets, webAssets } from "./static";
import { createTerminalSocket } from "./terminal-socket";
import { workspaceAssets } from "./workspace";

export interface ServerDeps {
    /** PiKVM control core — the proxy reads its target (origin + auth) from here, and
     *  the idle jiggler nudges the cursor through it. */
    control: PiKvmControl;
    settings: SettingsStore;
    /** Server-hosted terminal sessions, streamed to all devices over /app/terminal. */
    terminalSessions?: TerminalSessions;
    /** Base URL of the pikvm-agent daemon, reverse-proxied at /app/daemon/* so the
     *  same-origin console can reach its HTTP API without CORS. */
    daemonOrigin?: string;
    /** Desktop-owned daemon action capability injected by the reverse proxy. */
    daemonToken: string;
    /** Base URL of the first-party harness, reverse-proxied at /app/harness/*.
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
    /** Prefix stripped before forwarding to harnessOrigin. Default "/app/harness",
     *  for a harness reached directly. The headless web host instead forwards to
     *  the DESKTOP's console server, which mounts the harness at that same path
     *  and injects the operator capability itself, so it passes "" to keep the
     *  path whole and its token is the desktop's access token, not the harness's. */
    harnessPrefix?: string;
}

/** The app's version, from the package.json the build copies beside the bundle. */
function readVersion(): string {
    try {
        const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8")) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : "unknown";
    } catch {
        return "unknown";
    }
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
): Server {
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

    const kvmd = createPiKvmProxy({
        control,
        onHidActivity: () => jiggler.noteUserActivity(),
        // Track the user's real cursor so the nudge returns it exactly, instead of
        // jogging off a stale position we only ever updated from our own moves.
        onHidMouseMove: (x, y) => control.noteObservedMouse(x, y),
    });

    const daemon = createDaemonProxy({
        origin: deps.daemonOrigin ?? "http://127.0.0.1:47615",
        bearerToken: deps.daemonToken,
    });

    /* The same reverse proxy pointed at the harness, so the conversation can be
     * served from this origin and still reach its own API.
     *
     * Only mounted when both an origin and a token are supplied: half a
     * configuration would put an UNAUTHENTICATED route to the operator API on
     * this server, which is worse than no route at all. */
    const harness =
        deps.harnessOrigin && deps.harnessToken
            ? createDaemonProxy({
                  origin: deps.harnessOrigin,
                  bearerToken: deps.harnessToken,
                  prefix: deps.harnessPrefix ?? "/app/harness",
              })
            : null;

    const api = createApi({
        control,
        settings,
        macros,
        jigglerStatus: () => jiggler.status(),
        /* What this host actually serves. The headless web host has no shared
         * terminal, and the console should not frame a panel whose socket would
         * only ever close. */
        features: () => ({ terminal: !!deps.terminalSessions, chat: !!harness }),
        version: readVersion(),
    });

    const terminal = createTerminalSocket(deps.terminalSessions);

    const router = createRouter({
        accessToken: () => settings.get().accessToken,
        kvmd,
        daemon,
        harness,
        api,
        workspace: workspaceAssets,
        assets: webAssets,
        app: appAssets,
        terminal,
    });

    const server = createServer((req, res) => router.onRequest(req, res));
    server.on("upgrade", (req, socket, head) => router.onUpgrade(req, socket, head));
    server.on("close", () => {
        jiggler.stop();
        terminal.close();
        void api.dispose();
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
        if (onListenError) onListenError(err);
        else console.error(`[control] server error: ${err.message}`);
    });
    server.listen(port, host);
    return server;
}
