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
 *   proxy/        the kvmd passthrough
 *   static.ts     the app and legacy console bundles
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { OPERATOR_ID } from "@pikvm/chat-server";
import { CURSOR_AGENT_SOURCE } from "@pikvm/contracts/api";
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
import { createServerSync } from "./sync";
import { createLiveConnections } from "./live";
import type { PikvmEditor } from "./api";
import { startChat, type ChatHost, type ChatHostOptions } from "./chat";
import { createRouter } from "./routes";
import type { WebAuth } from "./web-auth";
import { limitsFromEnv } from "./watch/limits";
import { createWatchRoutes } from "./watch/routes";
import { createWatchService } from "./watch/service";
import { createPiKvmProxy } from "./proxy/kvmd";
import { createCursorHub } from "./cursor/hub";
import { createCursorRoutes } from "./cursor/routes";
import { appAssets, webAssets } from "./static";

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
    /** The web host's own sign-in (src/server/web-auth). Only the web host passes it; the desktop has the token gate. */
    webAuth?: WebAuth;
    /** Lets Settings manage the PiKVMs. Only the desktop app passes it. */
    pikvms?: PikvmEditor;
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

/** The control server, and the way to stop it with everything it started: the chat server, its agent processes and the Desk. */
export type ControlServer = Server & { shutdown(): Promise<void> };

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
): ControlServer {
    const { control, settings } = deps;

    // User macros live beside the other settings so they can be hand-edited and
    // copied between machines. Served here so web and desktop share one list.
    const macros = new MacroStore(resolve(settings.dir(), "macros.json"));

    // Idle mouse-jiggler: keeps the target awake when nobody's driving. It tracks the
    // user's cursor off the proxied HID socket (onHidActivity) and restores the exact
    // position. With no agent there is nothing to hold off for, so it's never "busy".
    /* One cursor for every page and the agent: the proxy reports each client's moves, the Desk the agent's. */
    const cursor = createCursorHub({
        mode: () => {
            // The mouse mode and the screen come from the Pi's event socket, which is otherwise opened only when something is sent.
            control.warm();
            return control.getMouseMode();
        },
        resolution: () => control.getResolution(),
    });
    const cursorRoutes = createCursorRoutes(cursor);

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
        onPointer: (norm, absolute) => {
            if (absolute) control.noteObservedMouse(norm.x, norm.y);
            cursor.place(CURSOR_AGENT_SOURCE, norm.x, norm.y);
        },
    });

    /* The sockets and event streams served here: ended when the server in use changes (see sync/index.ts). */
    const live = createLiveConnections();
    /* The state server this app may be connected to: only where the host owns its PiKVM list (the desktop). */
    const serverSync = deps.pikvms
        ? createServerSync({ dir: settings.dir(), live })
        : undefined;

    const jiggler = new MouseJiggler({
        control,
        enabled: () => settings.get().jiggler && !serverSync?.connected(),
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
        onHidMouseMove: (x, y, source) => {
            control.noteObservedMouse(x, y);
            cursor.absolute(source, x, y);
        },
        onHidMouseRelative: (dx, dy, source) => cursor.relative(source, dx, dy),
    });


    chat = startChat({
        dataDir: settings.dir(),
        desk,
        migrationsDir: deps.migrationsDir,
        resourcesDir: deps.resourcesDir,
        create: deps.createChat,
    });
    const agent = createAgentRoutes(activity, chat.controls);

    // The screen watch: one poller on the PiKVM for everyone who switched theirs on. It needs the chat server's stored
    // key, so it starts once chat is up (or has failed to start, when it simply finds nothing to resume).
    const watch = createWatchService({
        chat,
        target: () => control.proxyTarget(),
        images: deps.images,
        dataDir: settings.dir(),
        limits: limitsFromEnv(),
        allowLocalPush: process.env["PIKVM_PUSH_ALLOW_LOCAL"] === "1",
        subject: process.env["PIKVM_PUSH_SUBJECT"] || undefined,
        log: (line) => console.log(line),
    });
    const watchRoutes = createWatchRoutes(watch, OPERATOR_ID);
    void chat.ready.then(() => {
        try {
            watch.start();
        } catch (error) {
            console.error("[watch] could not resume:", error);
        }
    });


    const api = createApi({
        control,
        settings,
        macros,
        jigglerStatus: () => jiggler.status(),
        /* What this host actually serves: Chat when the chat server in this process is up, and whether
         * the agent program it starts was found, so the tab can say what is missing. */
        features: () => chat!.features(),
        version: readVersion(),
        ...(deps.pikvms ? { pikvms: deps.pikvms } : {}),
        ...(serverSync ? { servers: serverSync.editor } : {}),
    });

    const router = createRouter({
        accessToken: () => settings.get().accessToken,
        kvmd,
        chat,
        agent,
        cursor: cursorRoutes,
        live,
        watch: watchRoutes,
        ...(deps.webAuth ? { webAuth: deps.webAuth } : {}),
        api,
        ...(serverSync ? { forward: serverSync.forwarder } : {}),
        assets: webAssets,
        app: appAssets,
    });

    const server = createServer((req, res) => router.onRequest(req, res));
    server.on("upgrade", (req, socket, head) => router.onUpgrade(req, socket, head));
    server.on("close", () => {
        watch.stop();
        jiggler.stop();
        cursor.dispose();
        void api.dispose();
        void chat?.stop().then(() => desk.dispose());
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
        if (onListenError) onListenError(err);
        else console.error(`[control] server error: ${err.message}`);
    });
    server.listen(port, host);
    return Object.assign(server, {
        async shutdown() {
            watch.stop();
            jiggler.stop();
            cursor.dispose();
            server.closeAllConnections();
            await new Promise<void>((done) => (server.listening ? server.close(() => done()) : done()));
            await chat?.stop();
            await desk.dispose();
        },
    });
}
