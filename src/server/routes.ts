/**
 * The whole route table, in the order it is evaluated.
 *
 * Read it top to bottom: the first route that matches handles the request, and
 * the last one forwards to kvmd. Our surface lives under `/app`; kvmd owns `/`,
 * `/kvm/`, `/login/`, `/api/`, `/streamer/`, `/janus/`, `/share/` and `/extras/`
 * and everything else.
 *
 *   /                          redirect to /app/ (kvmd's own page for ?native=1
 *                              and for the desktop shell)
 *   /app/login, /logout, /auth sign-in (public)
 *   /app/{manifest,sw.js,icons} PWA files (public, see auth.ts)
 *   /app/daemon/*              agent daemon proxy       (needs the workspace header)
 *   /app/harness/*             harness proxy            (needs the workspace header)
 *   /app/chat/api/*            the chat server's REST routes (its own request header on mutations)
 *   /app/chat/ws (upgrade)     its socket: the gate, then a same-origin check
 *   /app/api/v1/agent/*        what the agent is doing (SSE), Stop, Hand back
 *   /app/workspace/*           agent workspace bundle
 *   /app/api/v1/*              our HttpApi
 *   /app/, /app/kvm, /chat, /settings/*   the web app's index.html (the console at
 *                              /app/ until the app is built); /app/legacy/ the console
 *   /app/<file>                the app's build (hashed /app/assets/*), then the console bundle
 *   anything else              kvmd (HTTP and WebSocket upgrades alike)
 *
 * The gate (auth.ts) runs before the table, once, for HTTP and for upgrades;
 * no route below checks a token itself.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
    gate,
    hasWorkspaceHeader,
    isLoopback,
    loginPage,
    PUBLIC_PATHS,
    sameOrigin,
    sessionValue,
    SESSION_COOKIE,
    tokenMatches,
} from "./auth";
import type { AgentRoutes } from "./agent/routes";
import { json, readBody } from "./http";
import { RETIRE_WORKER } from "./legacy-prefix";

/** A proxy that forwards a whole request to somewhere else. */
export interface HttpForwarder {
    handleHttp(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
}

/** Everything a route can dispatch to. The server builds these; the table only
 *  decides which one a request reaches. */
export interface RouteTargets {
    /** The access token, read per request so a change takes effect at once. */
    accessToken: () => string;
    kvmd: HttpForwarder & {
        handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void | Promise<void>;
    };
    daemon: HttpForwarder;
    /** The chat server in this process, or what answers while it is not up. */
    chat: {
        handleRest(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
        /** False when the chat server is not up (the upgrade is then refused). */
        handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    };
    /** What the agent is doing with the PiKVM, Stop and Hand back. */
    agent: AgentRoutes;
    /** Refuse a peer on loopback (except the public paths): the host sits behind an authenticating proxy that
     *  connects over the network, so a loopback peer is another process in the same container, such as the agent. */
    refuseLoopback?: boolean;
    /** Null when the harness is not configured: no route to it exists. */
    harness: HttpForwarder | null;
    api: { handle(req: IncomingMessage, res: ServerResponse): Promise<void> };
    workspace: {
        handles(path: string): boolean;
        serve(path: string, res: ServerResponse): boolean;
    };
    assets: { serve(path: string, res: ServerResponse): boolean };
    /** The built web app (apps/web/dist); `has` is false until it is built. */
    app: { has(path: string): boolean; serve(path: string, res: ServerResponse): boolean };
}

/** One request, parsed once. */
interface Hit {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    /** The pathname, e.g. `/app/api/v1/state`. */
    path: string;
    method: string;
}

interface Route {
    /** Shown in tests and logs; says what the route is for. */
    name: string;
    match(hit: Hit): boolean;
    run(hit: Hit): void | Promise<void>;
}

const CONSOLE_PAGE = "console.html";
const CHAT_API = "/app/chat/api";
export const CHAT_SOCKET = "/app/chat/ws";

/** `/app/x` matches prefix `/app/x` and `/app/x/...`, never `/app/xy`. */
function under(path: string, prefix: string): boolean {
    return path === prefix || path.startsWith(prefix + "/");
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
    res.writeHead(302, { location, ...headers });
    res.end();
}

/** The client-side routes of the web app: the shell, KVM, Chat and Settings. */
function isAppPage(path: string): boolean {
    return path === "/app/" || path === "/app/kvm" || path === "/app/chat" || under(path, "/app/settings");
}

export function createRoutes(t: RouteTargets): Route[] {
    return [
        {
            // `/?native=1` is the Full-UI frame, which loads the Pi's own page by
            // design; it is not ours to redirect.
            name: "kvmd's own front page",
            match: ({ method, path, url }) => method === "GET" && path === "/" && url.searchParams.get("native") === "1",
            run: ({ req, res }) => void t.kvmd.handleHttp(req, res),
        },
        {
            name: "root -> /app/",
            match: ({ method, path }) => (method === "GET" || method === "HEAD") && path === "/",
            run: ({ res }) => redirect(res, "/app/"),
        },
        {
            name: "/app -> /app/",
            match: ({ method, path }) => method === "GET" && path === "/app",
            run: ({ res }) => redirect(res, "/app/"),
        },

        /* Sign-in. Public: auth.ts lets these three through the gate. */
        {
            name: "login page",
            match: ({ method, path }) => method === "GET" && path === "/app/login",
            run: ({ res, url }) => {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                res.end(loginPage(url.searchParams.get("error") === "1", url.searchParams.get("bye") === "1"));
            },
        },
        {
            name: "logout",
            match: ({ path }) => path === "/app/logout",
            run: ({ res }) =>
                redirect(res, "/app/login?bye=1", {
                    "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
                }),
        },
        {
            name: "sign in",
            match: ({ method, path }) => method === "POST" && path === "/app/auth",
            run: async ({ req, res }) => {
                const submitted = new URLSearchParams(await readBody(req)).get("token") ?? "";
                const token = t.accessToken();
                if (tokenMatches(submitted, token)) {
                    redirect(res, "/app/", {
                        "set-cookie": `${SESSION_COOKIE}=${sessionValue(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000`,
                    });
                    return;
                }
                redirect(res, "/app/login?error=1");
            },
        },

        /* The two capability proxies. Each attaches a credential the page never
         * holds, and the gate exempts loopback, so each also demands a header no
         * cross-origin page can set without a preflight (and no preflight is ever
         * answered). Without it a web page could POST to 127.0.0.1 and have the
         * credential attached for it: a run started, an approval given, the
         * daemon's panic-stop or session routes driven. */
        {
            name: "agent daemon proxy",
            match: ({ path }) => under(path, "/app/daemon"),
            run: ({ req, res }) => {
                if (!hasWorkspaceHeader(req)) return json(res, 403, { error: "Missing workspace header" });
                void t.daemon.handleHttp(req, res);
            },
        },
        {
            name: "harness proxy",
            match: ({ path }) => under(path, "/app/harness"),
            run: ({ req, res }) => {
                // Mounted only with both an origin and a token: half a configuration
                // would expose an UNAUTHENTICATED route to the operator API.
                if (!t.harness) {
                    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
                    res.end("harness proxy not configured");
                    return;
                }
                if (!hasWorkspaceHeader(req)) return json(res, 403, { error: "Missing workspace header" });
                void t.harness.handleHttp(req, res);
            },
        },

        {
            name: "chat REST",
            match: ({ path }) => under(path, CHAT_API),
            // Chat's own routes require its request header on every mutation, which no other site can send.
            run: ({ req, res }) => void t.chat.handleRest(req, res),
        },
        {
            name: "agent activity, stop and hand back",
            match: ({ path }) => t.agent.handles(path),
            run: ({ req, res, path, method }) => {
                const mutating = method !== "GET" && method !== "HEAD";
                if (mutating && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
                    return json(res, 415, { error: "Expected application/json" });
                }
                t.agent.handle(req, res, path);
            },
        },

        {
            name: "agent workspace bundle",
            match: ({ method, path }) => method === "GET" && t.workspace.handles(path),
            run: ({ path, res }) => {
                if (t.workspace.serve(path, res)) return;
                res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
                res.end("workspace build not found");
            },
        },

        {
            name: "our API",
            match: ({ path }) => under(path, "/app/api"),
            run: ({ req, res, method }) => {
                // A cross-site page can send a text/plain POST without a preflight,
                // and loopback skips the gate; requiring JSON forces the preflight,
                // which this server never answers. So the API is same-origin only.
                const mutating = method !== "GET" && method !== "HEAD";
                if (mutating && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
                    return json(res, 415, { error: "Expected application/json" });
                }
                void t.api.handle(req, res);
            },
        },

        {
            // The web app's pages. Its router lives in the browser, so each client
            // route answers with the same index.html. Only when the app has been
            // built: without it /app/ is still the console (below).
            name: "web app page",
            match: ({ method, path }) => method === "GET" && isAppPage(path) && t.app.has("index.html"),
            run: ({ res }) => void t.app.serve("index.html", res),
        },
        {
            // The console that predates the app. It stays at /app/legacy/ for the
            // app's KVM tab to frame, and is /app/ itself while there is no app build.
            name: "console page",
            match: ({ method, path }) =>
                method === "GET" && (path === "/app/" || path === "/app/legacy" || path === "/app/legacy/"),
            run: ({ res }) => {
                if (!t.assets.serve(CONSOLE_PAGE, res)) json(res, 404, { error: "Not found" });
            },
        },
        {
            name: "static bundle",
            match: ({ method, path }) => method === "GET" && path.startsWith("/app/"),
            // The app's build (hashed /app/assets/*, icons) first, then the console's
            // files. A missing file is a 404 of ours, not a fall-through to kvmd: the
            // whole of /app belongs to this server.
            run: ({ path, res }) => {
                const file = path.slice("/app/".length);
                if (t.app.serve(file, res) || t.assets.serve(file, res)) return;
                json(res, 404, { error: "Not found" });
            },
        },
        {
            name: "unknown /app path",
            match: ({ path }) => under(path, "/app"),
            run: ({ res }) => json(res, 404, { error: "Not found" }),
        },

        {
            // The only remnant of the old /_agent/ prefix; see legacy-prefix.ts for
            // why it exists and when to delete it.
            name: "retire the old service worker",
            match: ({ method, path }) => method === "GET" && path === "/_agent/sw.js",
            run: ({ res }) => {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
                res.end(RETIRE_WORKER);
            },
        },
        {
            name: "old /_agent/ paths -> /app/",
            match: ({ method, path }) => (method === "GET" || method === "HEAD") && under(path, "/_agent"),
            run: ({ res }) => redirect(res, "/app/"),
        },
        {
            name: "kvmd passthrough",
            match: () => true,
            run: ({ req, res }) => void t.kvmd.handleHttp(req, res),
        },
    ];
}

export interface Router {
    onRequest(req: IncomingMessage, res: ServerResponse): void;
    onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function createRouter(targets: RouteTargets): Router {
    const routes = createRoutes(targets);
    const refused = (req: IncomingMessage, path: string): boolean =>
        targets.refuseLoopback === true && isLoopback(req) && !Object.hasOwn(PUBLIC_PATHS, path);

    return {
        onRequest(req, res) {
            const url = new URL(req.url ?? "/", "http://localhost");
            const path = url.pathname;

            if (refused(req, path)) return json(res, 403, { error: "Not reachable from this address" });
            const verdict = gate(req, path, targets.accessToken());
            if (verdict === "login") return redirect(res, "/app/login");
            if (verdict === "deny") return json(res, 401, { error: "Unauthorized" });

            const hit: Hit = { req, res, url, path, method: req.method ?? "GET" };
            // The final route matches everything, so there is always one.
            const route = routes.find((r) => r.match(hit))!;
            void Promise.resolve(route.run(hit)).catch((err: unknown) => {
                console.error(`[server] route "${route.name}" failed:`, err);
                if (!res.headersSent) json(res, 500, { error: "Internal error" });
                else res.end();
            });
        },

        /* WebSocket upgrades. The same gate, then kvmd (the HID/event socket and
         * Janus). An unknown `/app/*`
         * upgrade is refused here; it used to be forwarded to the Pi as a path
         * the Pi has never heard of. */
        onUpgrade(req, socket, head) {
            const path = new URL(req.url ?? "/", "http://localhost").pathname;
            if (refused(req, path) || gate(req, path, targets.accessToken()) !== "allow") {
                socket.destroy();
                return;
            }
            if (path === CHAT_SOCKET) {
                // Not from another site, whatever the gate let through.
                if (!sameOrigin(req)) {
                    socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
                    return;
                }
                if (!targets.chat.handleUpgrade(req, socket, head)) {
                    socket.end("HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n");
                }
                return;
            }
            if (under(path, "/app")) {
                socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
                return;
            }
            void targets.kvmd.handleUpgrade(req, socket, head);
        },
    };
}
