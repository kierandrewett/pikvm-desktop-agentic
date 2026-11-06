import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createChatServer, type BuiltinMcp, type ChatServer } from "@pikvm/chat-server";
import type { Features } from "@pikvm/contracts/api";
import { createPikvmMcp, defaultPolicy, tools, type JsonRpcRequest, type PikvmMcp, type PikvmPolicy } from "@pikvm/mcp";
import { DEFAULT_MAX_EDGE } from "@pikvm/kvm-engine/agent";
import type { AgentDesk } from "../agent/desk";
import type { AgentControls } from "../agent/routes";
import { json } from "../http";

/**
 * The chat server, in this process: conversations, providers and the agent runtime behind the Chat tab, with the
 * PiKVM computer-use MCP server mounted on its agent listener.
 *
 * Nothing here is configured from outside. The data directory is the host's, the agent binary is found by
 * `OMP_BIN` or the packaged resources, and the PiKVM's address and credentials never leave `PiKvmControl`: the
 * Desk reaches the Pi with them, and the agent only ever calls tools.
 */

/** What the agent is told about the tools it has, appended to its system prompt. */
export const INSTRUCTIONS =
    "You are the operator's assistant for a remote computer reached through a PiKVM. " +
    "Its screen and keyboard are your `mcp__pikvm_*` tools: take a screenshot before you act and after each action, " +
    "and never guess coordinates. Anything you want to say to the person goes in your reply.";

export interface ChatHostOptions {
    /** The host's data directory; chat keeps everything under `<dataDir>/chat`. */
    dataDir: string;
    desk: AgentDesk;
    /** Where the build copied the chat migrations, when the host is bundled. */
    migrationsDir?: string | undefined;
    /** A packaged desktop's resources directory, where the agent binary is `omp/omp`. */
    resourcesDir?: string | undefined;
    log?: (line: string) => void;
    /** The running response waits for the person (an approval, a question or a form): the host may notify them. */
    needsAnswer?: ((userId: string, conversationId: string, kind: "approval" | "question" | "input") => void) | undefined;
    /** Test seam. */
    create?: typeof createChatServer | undefined;
}

export interface ChatHost {
    /** Answer a request under /app/chat/api. */
    handleRest(req: IncomingMessage, res: ServerResponse): Promise<void>;
    /** Hand an authorised upgrade to the chat socket. False when the chat server is not up. */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    features(): Features;
    /** What the KVM tab's Stop and Hand back do. */
    readonly controls: AgentControls;
    /** The long edge of the screenshots the agent sees, from Settings. */
    maxEdge(): number;
    /** One small text request on the user's chat model. Undefined when there is no model to ask, or while chat is not up. */
    smallText(userId: string, system: string, user: string, options: { maxTokens?: number; json?: boolean; timeoutMs: number }): Promise<string | undefined>;
    /** Whether a small text request has a model to ask right now. False while chat is not up. */
    hasSmallModel(userId: string): boolean;
    /** One yes/no question to the Decisions model. Undefined when none is set, or while chat is not up. Rejects on failure. */
    decide(userId: string, request: { state: Record<string, string>; instructions: string; timeoutMs: number }): Promise<{ probability: number; backend: "decisions" | "chat" } | undefined>;
    /** Whether a Decisions model is set and can be called. False while chat is not up. */
    hasDecisionModel(userId: string): boolean;
    /** `<data>/chat/users/<id>`, where that user's files live. Throws while chat is not up. */
    userDir(userId: string): string;
    /** Resolves when the first start attempt has finished, whichever way. */
    readonly ready: Promise<void>;
    stop(): Promise<void>;
}

/** One JSON-RPC message in, one reply out; a notification gets 202 and no body. */
export function pikvmBuiltin(mcp: PikvmMcp): BuiltinMcp {
    return {
        name: "pikvm",
        tools: tools.map((tool) => tool.name),
        async handle(req, ctx) {
            let message: JsonRpcRequest;
            try {
                message = (await req.json()) as JsonRpcRequest;
            } catch {
                return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
            }
            // The chat server keeps the screenshots (per conversation, bounded); the agent's own copy goes to the model.
            const reply = await mcp.handle(
                { conversationId: ctx.conversationId, signal: req.signal, frames: { save: ctx.saveFrame } },
                message,
            );
            return reply ? Response.json(reply) : new Response(null, { status: 202 });
        },
    };
}

export function startChat(options: ChatHostOptions): ChatHost {
    const log = options.log ?? ((line: string) => console.log(line));
    const { desk } = options;
    let chat: ChatServer | null = null;
    let failure: string | null = null;
    let stopping: Promise<void> | undefined;

    const policy = (): PikvmPolicy =>
        chat
            ? {
                  approval: chat.setting("agent.pikvm.approval"),
                  allowPower: chat.setting("agent.pikvm.allowPower"),
                  ocr: defaultPolicy.ocr,
              }
            : defaultPolicy;

    const mcp = createPikvmMcp({
        desk,
        // Chat asks in the thread of the conversation whose call it is. Before the server is up nobody can be asked.
        approver: { ask: async (request) => (chat ? chat.askApproval("pikvm", request) : "unavailable") },
        policy,
        onError: (error) => log(`[pikvm-mcp] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`),
    });

    const ready = (options.create ?? createChatServer)({
        dataDir: options.dataDir,
        apiPath: "/app/chat/api",
        settingsPath: "/app/settings",
        instructions: INSTRUCTIONS,
        mcp: [pikvmBuiltin(mcp)],
        runs: {
            beginRun: (conversationId) => desk.beginRun(conversationId),
            endRun: (conversationId) => desk.endRun(conversationId),
            ...(options.needsAnswer ? { needsAnswer: options.needsAnswer } : {}),
        },
        ...(options.migrationsDir ? { migrationsDir: options.migrationsDir } : {}),
        ...(options.resourcesDir ? { resourcesDir: options.resourcesDir } : {}),
    }).then(
        (server) => {
            chat = server;
            const { runtime } = server.status();
            log(
                runtime.found
                    ? `[chat] up, agent ${runtime.binary ?? "found"}`
                    : `[chat] up, but the agent runtime was not found: ${runtime.reason ?? "unknown"}`,
            );
        },
        (err: unknown) => {
            failure = err instanceof Error ? err.message : String(err);
            log(`[chat] did not start: ${failure}`);
        },
    );

    return {
        async handleRest(req, res) {
            if (!chat) return json(res, 503, { error: failure ? `Chat did not start: ${failure}` : "Chat is starting" });
            await chat.handleNode(req, res);
        },
        handleUpgrade(req, socket, head) {
            if (!chat) return false;
            chat.handleUpgrade(req, socket, head);
            return true;
        },
        features() {
            if (!chat) return { chat: false, agent: { found: false, reason: failure ?? "Chat is starting" } };
            const { runtime } = chat.status();
            return { chat: true, agent: { found: runtime.found, ...(runtime.reason ? { reason: runtime.reason } : {}) } };
        },
        controls: {
            stop() {
                desk.stop();
                chat?.stopResponses();
            },
            handBack: () => desk.handBack(),
        },
        maxEdge: () => chat?.setting("agent.pikvm.maxEdge") ?? DEFAULT_MAX_EDGE,
        smallText: async (userId, system, user, options) => chat?.smallText(userId, system, user, options),
        hasSmallModel: (userId) => chat?.hasSmallModel(userId) ?? false,
        decide: async (userId, request) => chat?.decide(userId, request),
        hasDecisionModel: (userId) => chat?.hasDecisionModel(userId) ?? false,
        userDir(userId) {
            if (!chat) throw new Error("Chat is not up");
            return chat.userDir(userId);
        },
        ready,
        stop() {
            // Once: the server's close event and a quitting app may both ask.
            stopping ??= (async () => {
                await ready;
                const server = chat;
                chat = null;
                await server?.stop();
            })();
            return stopping;
        },
    };
}
