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
 *   agent/        the Desk the agent drives the PiKVM through, who is at the target, what the agent is doing
 *   chat/         the chat server in this process and the PiKVM MCP server on it
 *   proxy/        kvmd, daemon and harness passthroughs
 *   static.ts     the console bundle; workspace.ts the agent workspace bundle
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { DEFAULT_MAX_EDGE } from "@pikvm/kvm-engine/agent";
import type { ImageOps } from "../image-ops";
import { MacroStore } from "../macros";
import { MouseJiggler } from "../mouse-jiggler";
import type { PiKvmControl } from "../pikvm-control";
import type { SettingsStore } from "../settings";
import { createActivity } from "./agent/activity";
import { createDesk } from "./agent/desk";
import { createPresence } from "./agent/presence";
import { createAgentRoutes } from "./agent/routes";
import { createApi } from "./api";
import type { TargetEditor } from "./api";
import { startChat, type ChatHost, type ChatHostOptions } from "./chat";
import { createRouter } from "./routes";
import { createDaemonProxy } from "./proxy/daemon";
import { createCursorRelay, createHarnessProxy, HARNESS_PREFIX } from "./proxy/harness";
import { createPiKvmProxy } from "./proxy/kvmd";
import { appAssets, webAssets } from "./static";
import { workspaceAssets } from "./workspace";

export interface ServerDeps {
    /** PiKVM control core — the proxy reads its target (origin + auth) from here, and
     *  the idle jiggler nudges the cursor through it. */
    control: PiKvmControl;
    settings: SettingsStore;
    /** Crops and scales the screenshots the agent sees: Electron's nativeImage on the desktop, sharp on the web host. */
    images: ImageOps;
    /** Where the build copied the chat migrations. Unset when running from source. */
    migrationsDir?: string;
    /** The packaged desktop's resources directory; the agent binary is `omp/omp` in it. */
    resourcesDir?: string;
    /** Test seam: how the chat server is created. */
    createChat?: ChatHostOptions["create"];
    /** The web host behind an authenticating proxy: a loopback peer is not the proxy, so it is refused. */
    refuseLoopback?: boolean;
    /** Lets Settings change the PiKVM. Only the desktop app passes it. */
    target?: TargetEditor;
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
     *  for a harness reached directly (the desktop app's own, or the web host's
     *  deploy/agent sidecar). The web host reaching the DESKTOP's console server
     *  instead passes "": that server mounts the harness at the same path and
     *  injects the operator capability itself, so the path stays whole and the
     *  token is the desktop's access token, not the harness's. */
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
    /* Who is at the target and what the agent is doing with it. The proxy below sees a person's input and only a
     * person's (the agent has its own link to the Pi), which is how a person moving the mouse takes control. */
    const presence = createPresence();
    const activity = createActivity();
    let chat: ChatHost | undefined;
    const desk = createDesk({
        target: () => control.proxyTarget(),
        images: deps.images,
        presence,
        activity,
        maxEdge: () => chat?.maxEdge() ?? DEFAULT_MAX_EDGE,
        // The idle jiggler returns to where the agent left the pointer, not to a stale spot.
        onPointer: (norm) => control.noteObservedMouse(norm.x, norm.y),
    });

    const jiggler = new MouseJiggler({
        control,
        enabled: () => settings.get().jiggler,
        isAgentBusy: () => desk.busy(),
        log: (line) => console.log(line),
    });
    jiggler.start();

    const kvmd = createPiKvmProxy({
        control,
        onHidActivity: () => jiggler.noteUserActivity(),
        onHidInput: (kind) => presence.note(kind),
        // Track the user's real cursor so the nudge returns it exactly, instead of
        // jogging off a stale position we only ever updated from our own moves.
        onHidMouseMove: (x, y) => control.noteObservedMouse(x, y),
    });


    /* The same reverse proxy pointed at the harness, so the conversation can be
     * served from this origin and still reach its own API.
     *
     * Only mounted when both an origin and a token are supplied: half a
     * configuration would put an UNAUTHENTICATED route to the operator API on
     * this server, which is worse than no route at all. */
    const harness =
        deps.harnessOrigin && deps.harnessToken
            ? createHarnessProxy({
                  origin: deps.harnessOrigin,
                  token: deps.harnessToken,
                  prefix: deps.harnessPrefix ?? HARNESS_PREFIX,
              })
            : null;

    /* The desktop has the daemon itself. A host with only an agent relays the one daemon route a
     * page uses (the cursor report) to it; see createCursorRelay. */
    const daemon =
        !deps.daemonOrigin && harness
            ? createCursorRelay(harness)
            : createDaemonProxy({
                  origin: deps.daemonOrigin ?? "http://127.0.0.1:47615",
                  bearerToken: deps.daemonToken,
              });

    chat = startChat({
        dataDir: settings.dir(),
        desk,
        migrationsDir: deps.migrationsDir,
        resourcesDir: deps.resourcesDir,
        create: deps.createChat,
    });
    const agent = createAgentRoutes(activity, chat.controls);

    const api = createApi({
        control,
        settings,
        macros,
        jigglerStatus: () => jiggler.status(),
        /* What this host actually serves: Chat when the chat server in this process is up, and whether
         * the agent program it starts was found, so the tab can say what is missing. */
        features: () => chat!.features(),
        version: readVersion(),
        ...(deps.target ? { target: deps.target } : {}),
    });

    const router = createRouter({
        accessToken: () => settings.get().accessToken,
        kvmd,
        daemon,
        harness,
        chat,
        agent,
        ...(deps.refuseLoopback ? { refuseLoopback: true } : {}),
        api,
        workspace: workspaceAssets,
        assets: webAssets,
        app: appAssets,
    });

    const server = createServer((req, res) => router.onRequest(req, res));
    server.on("upgrade", (req, socket, head) => router.onUpgrade(req, socket, head));
    server.on("close", () => {
        jiggler.stop();
        void api.dispose();
        void chat?.stop().then(() => desk.dispose());
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
        if (onListenError) onListenError(err);
        else console.error(`[control] server error: ${err.message}`);
    });
    server.listen(port, host);
    return server;
}
