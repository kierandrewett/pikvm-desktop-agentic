/**
 * The HTTP shell for Chat's own MCP endpoints: streamable HTTP in stateless mode, every POST one JSON-RPC message
 * (or batch) answered with a JSON body, authenticated with the per-user gateway token.
 *
 * Used by /mcp/plugins (plugins/mcp.ts) and /mcp/conversations (http/mcp-conversations.ts).
 */
import { verifyGatewayToken } from "../agent/providers.ts";
import { ownedConversation } from "../mcp/chat-servers.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpRpcRequest {
    jsonrpc: "2.0";
    id?: string | number | null;
    method: string;
    params?: Record<string, unknown>;
}

export interface McpCaller {
    userId: string;
    /** From `X-Chat-Conversation`, only when that conversation belongs to the token's user. */
    conversationId: string | undefined;
}

export const rpcResult = (msg: McpRpcRequest, result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
export const rpcError = (msg: McpRpcRequest, code: number, message: string) => ({
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: { code, message },
});

export async function serveMcp(
    req: Request,
    opts: {
        /** False answers 403: the endpoint is off for this user. */
        enabled: (userId: string) => boolean;
        /** One request; undefined for a notification. */
        handle: (caller: McpCaller, msg: McpRpcRequest) => unknown | Promise<unknown>;
    },
): Promise<Response> {
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const auth = req.headers.get("authorization");
    const userId = verifyGatewayToken(auth?.startsWith("Bearer ") ? auth.slice(7) : undefined);
    if (!userId) return new Response("Unauthorized", { status: 401 });
    if (!opts.enabled(userId)) return new Response("Disabled", { status: 403 });
    let body: McpRpcRequest | McpRpcRequest[];
    try {
        body = (await req.json()) as McpRpcRequest | McpRpcRequest[];
    } catch {
        return Response.json(
            { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
            { status: 400 },
        );
    }
    const caller: McpCaller = {
        userId,
        conversationId: ownedConversation(userId, req.headers.get("x-chat-conversation")),
    };
    const batch = Array.isArray(body) ? body : [body];
    const results = (
        await Promise.all(batch.map((m) => (m.id === undefined ? undefined : opts.handle(caller, m))))
    ).filter((r) => r !== undefined);
    if (!results.length) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? results : results[0], {
        headers: { "mcp-protocol-version": MCP_PROTOCOL_VERSION },
    });
}
