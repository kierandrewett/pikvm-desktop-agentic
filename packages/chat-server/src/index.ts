/**
 * The chat server, as a library: the host process creates it, mounts `handleRest` and `handleUpgrade` behind its own
 * gate, and starts the agent runtime through it.
 *
 * Ported from ~/dev/chat (Bun) to Node and cut down to one operator. It has no sign-in, no static files and no knowledge
 * of PiKVM: the computer-use server arrives as a `BuiltinMcp` and the host's hooks, so this package never imports PiKVM
 * code.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { mkdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { listenAgentSurface, type AgentSurface } from "./agent-surface.ts";
import { setEventSink, stopAll } from "./agent/sessions.ts";
import { runtimeStatus, setResourcesDir } from "./agent/launch.ts";
import { seedOperator } from "./auth/operator.ts";
import { closeDb, openDb } from "./db/index.ts";
import { backfillShortIds } from "./conversations/slug.ts";
import { setAgentBaseUrl, setHostInstructions, setHostPaths, setPublicUrl, setRunHooks, type RunHooks } from "./env.ts";
import { agentRoutes } from "./http/agent-routes.ts";
import { bootstrapRoutes } from "./http/bootstrap-routes.ts";
import { catalogRoutes } from "./http/catalog-routes.ts";
import { csrf, loadUser, onError, type Env } from "./http/context.ts";
import { conversationRoutes } from "./http/conversation-routes.ts";
import { draftRoutes } from "./http/draft-routes.ts";
import { broadcast } from "./http/hub.ts";
import { mcpRoutes } from "./http/mcp-routes.ts";
import { modelsRoutes } from "./http/models-routes.ts";
import { adminSettingsRoutes, settingsRoutes } from "./http/settings-routes.ts";
import { syncMutations, watchSettings } from "./http/sync.ts";
import { uploadRoutes } from "./http/upload-routes.ts";
import { acceptSocket } from "./http/ws.ts";
import { registerBuiltinMcp, type BuiltinMcp } from "./mcp/builtin.ts";
import { askApproval, type ApprovalDecision } from "./mcp/interactions.ts";
import { ensureCatalog } from "./models/catalog.ts";
import { configurePaths, OPERATOR_ID, paths } from "./paths.ts";
import { setting, type SettingKey, type SettingValue } from "./settings/store.ts";

export type { BuiltinMcp, BuiltinMcpContext } from "./mcp/builtin.ts";
export type { ApprovalDecision } from "./mcp/interactions.ts";
export type { RunHooks } from "./env.ts";

export interface ChatServerOptions {
    /** The host's data directory. Everything the chat server keeps goes under `<dataDir>/chat`. */
    dataDir: string;
    /** Where the browser reaches the REST routes. `handleRest` expects this prefix on every path. Default `/api`. */
    apiPath?: string;
    /** The page the OAuth redirect returns to after connecting an MCP server. Default `/settings/mcp`. */
    settingsPath?: string;
    /** The address the browser uses, for OAuth redirects (`https://kvm.example.org`). Optional. */
    publicUrl?: string;
    /** A packaged host's resources directory; the agent binary is looked up at `<resources>/omp/omp`. */
    resourcesDir?: string;
    /** What the host tells the agent about its tools, appended to the system prompt. */
    instructions?: string;
    /** Built-in MCP servers mounted on the agent surface (`/mcp/<name>`) and offered to the agent. */
    mcp?: readonly BuiltinMcp[];
    /** Told when a response starts and ends. */
    runs?: RunHooks;
    /** The agent surface's address. Default `127.0.0.1` and a free port. */
    agentSurface?: { host?: string; port?: number };
    /** Fetch the models.dev catalogue (names, logos, limits) at start. Default true; tests turn it off. */
    refreshCatalog?: boolean;
}

export interface ChatServerStatus {
    /** The database is open and the agent surface listens. */
    ready: boolean;
    runtime: { found: boolean; binary?: string; reason?: string };
    /** The tool profile the agent runs. */
    profile: SettingValue<"system.agent.profile">;
    /** The agent surface's address (`http://127.0.0.1:<port>`). Never given to a browser. */
    agentSurface: string;
}

export interface ChatServer {
    /** Answer a REST request. The path must start with `apiPath`. */
    handleRest(req: Request): Promise<Response>;
    /**
     * Take over an upgrade request the host has already authorised (its gate and an Origin check). The host must not
     * call this for a request it did not authorise.
     */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
    /**
     * A built-in server asks for approval of one action, in the thread of the conversation whose call it is.
     * `unavailable` when nobody can be asked.
     */
    askApproval(
        server: string,
        ask: {
            conversationId: string | undefined;
            tool: string;
            title: string;
            summary: string;
            reasons: readonly string[];
            arguments: Readonly<Record<string, unknown>>;
            signal?: AbortSignal;
        },
    ): Promise<ApprovalDecision>;
    /** An effective setting, for the host's own switches (`agent.pikvm.*`). */
    setting<K extends SettingKey>(key: K): SettingValue<K>;
    status(): ChatServerStatus;
    /** Stop every agent process, close the sockets and the agent surface, and close the database. */
    stop(): Promise<void>;
}

function buildApp(): Hono<Env> {
    const api = new Hono<Env>()
        .use(loadUser, csrf, syncMutations)
        .route("/", bootstrapRoutes)
        .route("/", settingsRoutes)
        .route("/", conversationRoutes)
        .route("/", modelsRoutes)
        .route("/", uploadRoutes)
        .route("/", catalogRoutes)
        .route("/", mcpRoutes)
        .route("/", draftRoutes)
        .route("/", agentRoutes)
        .route("/admin", adminSettingsRoutes)
        .all("*", () => {
            throw new HTTPException(404, { message: "Not found" });
        });
    return new Hono<Env>().route("/api", api).onError(onError);
}

export async function createChatServer(options: ChatServerOptions): Promise<ChatServer> {
    const apiPath = (options.apiPath ?? "/api").replace(/\/+$/, "");
    configurePaths(options.dataDir);
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    openDb();
    seedOperator();
    setResourcesDir(options.resourcesDir);
    setHostInstructions(options.instructions ?? "");
    setRunHooks(options.runs);
    setHostPaths({ api: apiPath, settings: options.settingsPath ?? "/settings/mcp" });
    setPublicUrl(options.publicUrl ?? "");
    const unmount = (options.mcp ?? []).map(registerBuiltinMcp);

    backfillShortIds();
    if (options.refreshCatalog !== false) void ensureCatalog();
    setEventSink((userId, event) => broadcast(userId, event));
    watchSettings();

    const surface: AgentSurface = await listenAgentSurface(options.agentSurface);
    setAgentBaseUrl(surface.url);

    const app = buildApp();
    const sockets = new WebSocketServer({ noServer: true });

    return {
        handleRest(req) {
            const url = new URL(req.url);
            if (url.pathname !== apiPath && !url.pathname.startsWith(`${apiPath}/`)) {
                return Promise.resolve(new Response("Not found", { status: 404 }));
            }
            url.pathname = `/api${url.pathname.slice(apiPath.length)}`;
            return Promise.resolve(app.fetch(new Request(url, req)));
        },
        handleUpgrade(req, socket, head) {
            sockets.handleUpgrade(req, socket, head, (ws) => acceptSocket(ws));
        },
        askApproval: (server, ask) =>
            askApproval(OPERATOR_ID, ask.conversationId, server, {
                tool: ask.tool,
                title: ask.title,
                summary: ask.summary,
                reasons: ask.reasons,
                arguments: ask.arguments,
                signal: ask.signal,
            }),
        setting: (key) => setting(key),
        status: () => ({
            ready: true,
            runtime: runtimeStatus(),
            profile: setting("system.agent.profile"),
            agentSurface: surface.url,
        }),
        async stop() {
            await stopAll();
            for (const ws of sockets.clients) ws.terminate();
            sockets.close();
            await surface.close();
            for (const off of unmount) off();
            setRunHooks(undefined);
            closeDb();
        },
    };
}
