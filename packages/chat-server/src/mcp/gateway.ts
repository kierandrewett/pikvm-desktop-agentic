/**
 * The Chat MCP gateway: `/mcp/s/<serverId>`, the address the runtime's mcp.json uses for every remote (`http`) MCP
 * server (agent/config.ts). Design and the reasons for it: docs/spec/mcp-support.md sections 3 and 4.
 *
 * Downstream (the runtime, in its sandbox) it is a stateful Streamable HTTP server of the 2025-11-25 era: it mints
 * its own `Mcp-Session-Id` on `initialize`, answers every request with one JSON body, answers GET with 405 (no
 * server stream) and DELETE by closing the upstream session. Batches are refused.
 *
 * Upstream it is the client (upstream.ts), in whichever era the server speaks, with the user's credential. On the way
 * it does what the runtime cannot:
 * - elicitation (stateful server requests, or stateless `input_required` rounds) goes to the user's thread;
 * - `tools/call` gets a progress token; progress notifications move the running tool row;
 * - a tool the server marks destructive asks the user first (`agent.mcpApprovals.confirmDestructive`);
 * - a downstream abort (Stop) sends `notifications/cancelled` (stateful) and aborts the upstream request;
 * - 401 refreshes once; a dead refresh marks the connection expired; 403 `insufficient_scope` records the scopes a
 *   reconnect must ask for; an expired upstream session (404) is reopened once.
 *
 * Authentication is the user's gateway token (as for /gw). The optional `X-Chat-Conversation` header names the
 * conversation, checked against the token's user; it routes interactions and applies per-chat switches.
 */
import type { McpToolSummary } from "@pikvm/chat-protocol";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { keyFromRequest, verifyGatewayToken } from "../agent/providers.ts";
import { agentCwd } from "../agent/sessions.ts";
import { getConversation } from "../conversations/service.ts";
import { db, schema } from "../db/index.ts";
import { setting } from "../settings/store.ts";
import { chatServerEnabled, ownedConversation } from "./chat-servers.ts";
import {
    guardFor,
    markExpired,
    markMissingScope,
    resolveServer,
    ServerUnavailable,
    type ResolvedServer,
} from "./credentials.ts";
import { guardedFetch } from "./net.ts";
import { rememberToolsSeen } from "./tool-cache.ts";
import { confirmDestructive, elicit, progress, type ElicitParams } from "./interactions.ts";
import { answerOf, openConn, post, postNoReply, UpstreamFailure, type Conn, type Msg, type Reply } from "./upstream.ts";

const SESSION_IDLE_MS = 60 * 60_000;
const MAX_INPUT_ROUNDS = 8;

interface GwSession {
    id: string;
    userId: string;
    serverId: string;
    conn: Conn;
    /** Tool hints from the last tools/list, by tool name. */
    tools: Map<string, McpToolSummary>;
    lastUsed: number;
}

const sessions = new Map<string, GwSession>();

function sweep(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [k, s] of sessions) if (s.lastUsed < cutoff) sessions.delete(k);
}

const rpcError = (id: Msg["id"], code: number, message: string): Msg => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
});
const toolError = (id: Msg["id"], text: string): Msg => ({
    jsonrpc: "2.0",
    id: id ?? null,
    result: { content: [{ type: "text", text }], isError: true },
});

function json(msg: Msg, session?: GwSession, status = 200): Response {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (session) {
        headers["mcp-session-id"] = session.id;
        headers["mcp-protocol-version"] = "2025-11-25";
    }
    return new Response(JSON.stringify(msg), { status, headers });
}

/** Tool summary from a tools/list entry (hints, title and MCP Apps resource). */
export function summariseTool(t: Record<string, unknown>): McpToolSummary | undefined {
    if (typeof t.name !== "string" || !t.name) return undefined;
    const a = (t.annotations ?? {}) as Record<string, unknown>;
    const ui = ((t._meta as Record<string, unknown> | undefined)?.ui ?? {}) as Record<string, unknown>;
    const flag = (v: unknown) => (typeof v === "boolean" ? v : undefined);
    return {
        name: t.name,
        title: typeof t.title === "string" ? t.title : typeof a.title === "string" ? a.title : undefined,
        description: typeof t.description === "string" ? t.description.slice(0, 1000) : undefined,
        readOnly: flag(a.readOnlyHint),
        destructive: flag(a.destructiveHint),
        idempotent: flag(a.idempotentHint),
        openWorld: flag(a.openWorldHint),
        uiResource: typeof ui.resourceUri === "string" ? ui.resourceUri : undefined,
    };
}

function rememberTools(gs: GwSession, list: unknown): void {
    const tools = Array.isArray(list) ? list : [];
    for (const t of tools) {
        const s = summariseTool(t as Record<string, unknown>);
        if (s) gs.tools.set(s.name, s);
    }
    rememberToolsSeen(gs.userId, gs.serverId, [...gs.tools.values()]);
}

interface Ctx {
    conversationId?: string;
    signal: AbortSignal;
}

/** The roots a server may see: the conversation's working folder as the agent sees it. */
function roots(gs: GwSession, ctx: Ctx): { roots: { uri: string; name: string }[] } {
    if (!ctx.conversationId) return { roots: [] };
    try {
        const row = getConversation(gs.userId, ctx.conversationId);
        return { roots: [{ uri: `file://${agentCwd(gs.userId, row)}`, name: "workspace" }] };
    } catch {
        return { roots: [] };
    }
}

/** Answer one server-to-client request. Undefined result means "not supported" (-32601). */
async function serverRequest(
    gs: GwSession,
    m: { method: string; params?: Record<string, unknown> },
    ctx: Ctx,
    tool?: string,
) {
    if (m.method === "elicitation/create")
        return {
            result: await elicit(gs.userId, ctx.conversationId, gs.serverId, tool, (m.params ?? {}) as ElicitParams),
        };
    if (m.method === "roots/list") return { result: roots(gs, ctx) };
    if (m.method === "ping") return { result: {} };
    return { error: { code: -32601, message: `Chat does not support ${m.method}` } };
}

/** What a failed upstream HTTP answer means for the runtime, and what to remember about the connection. */
function failure(gs: GwSession, msg: Msg, r: Extract<Reply, { kind: "status" }>): Msg {
    const name = gs.conn.server.entry.url ? new URL(gs.conn.server.entry.url).host : gs.serverId;
    let text: string;
    if (r.status === 401) {
        markExpired(gs.userId, gs.serverId);
        text = `${gs.serverId} needs you to sign in. Open Settings, MCP servers, ${gs.serverId}, and choose Connect.`;
    } else if (r.status === 403 && r.challenge?.error === "insufficient_scope") {
        markMissingScope(gs.userId, gs.serverId, r.challenge.scope ?? "");
        text = `${gs.serverId} needs more access for this. Open Settings, MCP servers, ${gs.serverId}, and choose Reconnect.`;
    } else text = r.message?.error?.message ?? `${name} answered HTTP ${r.status}`;
    if (r.status >= 500 || r.status === 401) console.warn(`[mcp-gw] ${gs.serverId} ${msg.method} HTTP ${r.status}`);
    return msg.method === "tools/call" ? toolError(msg.id, text) : rpcError(msg.id, -32001, text);
}

/** Forward one request upstream and bring back its answer, answering whatever the server asks on the way. */
async function relay(gs: GwSession, msg: Msg, ctx: Ctx, reopened = false): Promise<Msg> {
    const tool = msg.method === "tools/call" ? String(msg.params?.name ?? "") : undefined;
    let current: Msg = msg;
    if (tool) {
        if (!chatServerEnabled(ctx.conversationId, gs.serverId))
            return toolError(msg.id, `${gs.serverId} is turned off in this chat.`);
        const hints = gs.tools.get(tool);
        const rules = setting("agent.mcpApprovals", gs.userId);
        // Conflicting read-only hints cannot remove a destructive approval, including with full access.
        if (rules.confirmDestructive && hints?.destructive === true) {
            const ok = await confirmDestructive(
                gs.userId,
                ctx.conversationId,
                gs.serverId,
                tool,
                msg.params?.arguments,
                hints,
            );
            if (!ok) return toolError(msg.id, "The user did not allow this action.");
        }
        current = {
            ...msg,
            params: {
                ...msg.params,
                _meta: { ...msg.params?._meta, progressToken: `chat-${randomBytes(8).toString("hex")}` },
            },
        };
    }
    const progressToken = current.params?._meta?.progressToken;
    for (let round = 0; round <= MAX_INPUT_ROUNDS; round++) {
        const sentId = current.id;
        // Stop in the runtime aborts this request: tell a stateful server, abort the stream for a stateless one.
        const onAbort = () => {
            if (gs.conn.era === "stateful")
                void postNoReply(gs.conn, {
                    jsonrpc: "2.0",
                    method: "notifications/cancelled",
                    params: { requestId: sentId, reason: "Stopped by the user" },
                });
        };
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        try {
            const reply = await post(gs.conn, current, ctx.signal);
            if (reply.kind === "status") {
                if (reply.status === 404 && gs.conn.era === "stateful" && gs.conn.session && !reopened) {
                    const opened = await openConn(
                        gs.userId,
                        gs.conn.server,
                        gs.conn.guard,
                        ctx.signal,
                        gs.conn.protocolVersion,
                        gs.conn.clientCapabilities,
                    );
                    gs.conn = opened.conn;
                    await postNoReply(gs.conn, { jsonrpc: "2.0", method: "notifications/initialized" });
                    return relay(gs, msg, ctx, true);
                }
                return failure(gs, msg, reply);
            }
            const { msg: answer } = await answerOf(reply, sentId, async (m) => {
                if (m.method && m.id !== undefined && m.id !== null) {
                    // Answer while the stream stays open: the result usually waits for this answer.
                    void serverRequest(gs, { method: m.method, params: m.params }, ctx, tool).then((r) =>
                        postNoReply(gs.conn, { jsonrpc: "2.0", id: m.id, ...r } as Msg),
                    );
                } else if (m.method === "notifications/progress" && tool && m.params?.progressToken === progressToken) {
                    const p = m.params as { progress?: number; total?: number; message?: string };
                    if (typeof p.progress === "number")
                        progress(gs.userId, ctx.conversationId, gs.serverId, tool, p.progress, p.total, p.message);
                }
            });
            if (!answer) return rpcError(msg.id, -32603, "The server closed the connection without an answer");
            const result = answer.result as (Record<string, unknown> & { resultType?: string }) | undefined;
            if (gs.conn.era === "stateless" && result?.resultType === "input_required") {
                const requests = (result.inputRequests ?? {}) as Record<
                    string,
                    { method: string; params?: Record<string, unknown> }
                >;
                const responses: Record<string, unknown> = {};
                for (const [key, req] of Object.entries(requests)) {
                    const r = await serverRequest(gs, req, ctx, tool);
                    if ("error" in r)
                        return toolError(msg.id, `The server asked for ${req.method}, which Chat does not support.`);
                    responses[key] = r.result;
                }
                current = {
                    ...current,
                    id: `${String(msg.id)}~${round + 1}`,
                    params: {
                        ...current.params,
                        inputResponses: responses,
                        ...(result.requestState !== undefined ? { requestState: result.requestState } : {}),
                    },
                };
                continue;
            }
            if (msg.method === "tools/list" && result) {
                rememberTools(gs, result.tools);
                if (!chatServerEnabled(ctx.conversationId, gs.serverId))
                    return { jsonrpc: "2.0", id: msg.id, result: { ...result, tools: [] } };
            }
            // The runtime does not know `resultType`; everything that reaches it is complete.
            if (result && "resultType" in result) delete result.resultType;
            return { ...answer, id: msg.id };
        } finally {
            ctx.signal.removeEventListener("abort", onAbort);
        }
    }
    return toolError(msg.id, "The server kept asking for more input; Chat stopped after several rounds.");
}

function sessionFor(req: Request, userId: string, serverId: string): GwSession | undefined {
    const id = req.headers.get("mcp-session-id");
    const s = id ? sessions.get(id) : undefined;
    return s && s.userId === userId && s.serverId === serverId ? s : undefined;
}

export async function handleMcpGateway(req: Request): Promise<Response> {
    sweep();
    const serverId = decodeURIComponent(new URL(req.url).pathname.slice("/mcp/s/".length));
    const userId = verifyGatewayToken(keyFromRequest(req.headers));
    if (!userId) return new Response("Invalid gateway token", { status: 401 });

    let server: ResolvedServer;
    try {
        server = resolveServer(userId, serverId);
    } catch (err) {
        if (err instanceof ServerUnavailable) return new Response(err.message, { status: err.status });
        throw err;
    }
    const conversationId = ownedConversation(userId, req.headers.get("x-chat-conversation"));

    if (req.method === "GET") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
    if (req.method === "DELETE") {
        const s = sessionFor(req, userId, serverId);
        if (s) {
            sessions.delete(s.id);
            if (s.conn.era === "stateful" && s.conn.session)
                await guardedFetch(
                    server.entry.url!,
                    {
                        method: "DELETE",
                        headers: { "mcp-session-id": s.conn.session },
                        signal: AbortSignal.timeout(5000),
                    },
                    guardFor(server),
                )
                    .then((r) => r.body?.cancel())
                    .catch(() => undefined);
        }
        return new Response(null, { status: 200 });
    }
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });

    let msg: Msg;
    try {
        msg = (await req.json()) as Msg;
    } catch {
        return json(rpcError(null, -32700, "Parse error"), undefined, 400);
    }
    if (Array.isArray(msg)) return json(rpcError(null, -32600, "Batches are not supported"), undefined, 400);
    const ctx: Ctx = { conversationId, signal: req.signal };

    if (msg.method === "initialize") {
        try {
            const p = msg.params ?? {};
            const opened = await openConn(
                userId,
                server,
                guardFor(server),
                req.signal,
                String(p.protocolVersion ?? "2025-11-25"),
                (p.capabilities ?? {}) as Record<string, unknown>,
            );
            const gs: GwSession = {
                id: randomBytes(24).toString("base64url"),
                userId,
                serverId,
                conn: opened.conn,
                tools: new Map(),
                lastUsed: Date.now(),
            };
            sessions.set(gs.id, gs);
            return json({ jsonrpc: "2.0", id: msg.id ?? null, result: opened.result }, gs);
        } catch (err) {
            const e = err as UpstreamFailure & { reply?: Extract<Reply, { kind: "status" }> };
            if (e.reply?.status === 401) markExpired(userId, serverId);
            const text =
                e.reply?.status === 401
                    ? `${serverId} needs you to sign in. Connect it in Settings, MCP servers.`
                    : e.message;
            console.warn(`[mcp-gw] ${serverId} initialize failed: ${e.reply ? `HTTP ${e.reply.status}` : e.message}`);
            return json(rpcError(msg.id, -32001, text));
        }
    }

    const gs = sessionFor(req, userId, serverId);
    if (!gs) return json(rpcError(msg.id, -32001, "Session not found"), undefined, 404);
    gs.lastUsed = Date.now();

    if (msg.id === undefined || msg.id === null) {
        // Notifications. `initialized` and `cancelled` only mean something to a stateful server.
        if (gs.conn.era === "stateful" && msg.method) await postNoReply(gs.conn, msg);
        return new Response(null, { status: 202, headers: { "mcp-session-id": gs.id } });
    }
    if (msg.method === undefined) return new Response(null, { status: 202, headers: { "mcp-session-id": gs.id } });
    if (msg.method === "ping" && gs.conn.era === "stateless")
        return json({ jsonrpc: "2.0", id: msg.id, result: {} }, gs);

    try {
        return json(await relay(gs, msg, ctx), gs);
    } catch (err) {
        if (req.signal.aborted) return new Response(null, { status: 499 });
        console.warn(`[mcp-gw] ${serverId} ${msg.method} failed: ${(err as Error).message}`);
        return json(
            msg.method === "tools/call"
                ? toolError(msg.id, `${serverId} could not be reached: ${(err as Error).message}`)
                : rpcError(msg.id, -32603, (err as Error).message),
            gs,
        );
    }
}
