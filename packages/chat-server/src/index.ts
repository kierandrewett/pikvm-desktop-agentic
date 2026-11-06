/**
 * The chat server, as a library: the host process creates it, mounts `handleRest` and `handleUpgrade` behind its own
 * gate, and starts the agent runtime through it.
 *
 * Ported from an upstream chat project (Bun) to Node and cut down to one operator. It has no sign-in, no static files and no knowledge
 * of PiKVM: the computer-use server arrives as a `BuiltinMcp` and the host's hooks, so this package never imports PiKVM
 * code.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { listenAgentSurface, type AgentSurface } from "./agent-surface.ts";
import { cancelAll, setEventSink, stopAll } from "./agent/sessions.ts";
import { runtimeStatus, setResourcesDir } from "./agent/launch.ts";
import { seedOperator } from "./auth/operator.ts";
import { closeDb, openDb, setMigrationsDir } from "./db/index.ts";
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
import { sendResponse, toRequest } from "./http/node-adapter.ts";
import { acceptSocket } from "./http/ws.ts";
import { registerBuiltinMcp, type BuiltinMcp } from "./mcp/builtin.ts";
import { askApproval, type ApprovalDecision } from "./mcp/interactions.ts";
import { ensureCatalog } from "./models/catalog.ts";
import { configurePaths, OPERATOR_ID, paths } from "./paths.ts";
import { setting, type SettingKey, type SettingValue } from "./settings/store.ts";
import { decide, hasDecisionModel, type Decision, type DecideRequest } from "./models/decisions.ts";
import { hasSmallModel, smallText } from "./models/small-text.ts";

export type { BuiltinMcp, BuiltinMcpContext } from "./mcp/builtin.ts";
export type { Decision, DecideRequest } from "./models/decisions.ts";
export type { ApprovalDecision } from "./mcp/interactions.ts";
export type { RunHooks } from "./env.ts";
export { OPERATOR_ID } from "./paths.ts";

export interface ChatServerOptions {
    /** The host's data directory. Everything the chat server keeps goes under `<dataDir>/chat`. */
    dataDir: string;
    /** Where the browser reaches the REST routes. `handleRest` expects this prefix on every path. Default `/api`. */
    apiPath?: string;
    /** The page the OAuth redirect returns to after connecting an MCP server. Default `/settings/mcp`. */
    settingsPath?: string;
    /** The address the browser uses, for OAuth redirects (`https://kvm.example.org`). Optional. */
    publicUrl?: string;
    /** The migrations folder a bundled host copied beside itself. Default: the package's own, or `CHAT_MIGRATIONS_DIR`. */
    migrationsDir?: string;
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
    /** `handleRest` for a `node:http` request: reads it, answers it, streams the reply. */
    handleNode(req: IncomingMessage, res: ServerResponse): Promise<void>;
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
    /** Stop every running response, as the person pressing Stop in the thread would. Returns how many. */
    stopResponses(): number;
    /** An effective setting, for the host's own switches (`agent.pikvm.*`). */
    setting(key: "agent.pikvm.approval"): SettingValue<"agent.pikvm.approval">;
    setting(key: "agent.pikvm.allowPower"): SettingValue<"agent.pikvm.allowPower">;
    setting(key: "agent.pikvm.maxEdge"): SettingValue<"agent.pikvm.maxEdge">;
    /** One small text request on the user's own chat model (the Small tasks role, else the default model), through the provider and credential the chat already has. Undefined when there is no model that can be called. */
    smallText(userId: string, system: string, user: string, options: { maxTokens?: number; json?: boolean; timeoutMs: number }): Promise<string | undefined>;
    hasSmallModel(userId: string): boolean;
    /** One yes/no question to the Decisions role model (Jev on OpenRouter, or a chat model). Undefined when no decisions model is set or it cannot be called. Rejects on a failed call. */
    decide(userId: string, request: DecideRequest): Promise<Decision | undefined>;
    hasDecisionModel(userId: string): boolean;
    /** `<data>/chat/users/<id>`: where this user's files live. Not created. */
    userDir(userId: string): string;
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
    setMigrationsDir(options.migrationsDir);
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

    const server: ChatServer = {
        handleRest(req) {
            const url = new URL(req.url);
            if (url.pathname !== apiPath && !url.pathname.startsWith(`${apiPath}/`)) {
                return Promise.resolve(new Response("Not found", { status: 404 }));
            }
            url.pathname = `/api${url.pathname.slice(apiPath.length)}`;
            return Promise.resolve(app.fetch(new Request(url, req)));
        },
        async handleNode(req, res) {
            const response = await server.handleRest(toRequest(req, `http://${req.headers.host ?? "localhost"}`));
            await sendResponse(res, response);
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
        stopResponses: () => cancelAll(OPERATOR_ID),
        smallText: (userId, system, user, options) => smallText(userId, system, user, options),
        hasSmallModel: (userId) => hasSmallModel(userId),
        decide: (userId, request) => decide(userId, request),
        hasDecisionModel: (userId) => hasDecisionModel(userId),
        userDir: (userId) => paths.user(userId).root,
        setting: ((key: SettingKey) => setting(key)) as ChatServer["setting"],
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
    return server;
}
