/**
 * MCP servers the host mounts on the agent surface (`/mcp/<name>`). The PiKVM computer-use server is one: it runs in
 * the host process, so its credentials never leave it, and the agent reaches it with the same bearer token as the
 * gateway. Chat's own `/mcp/conversations` is mounted separately.
 */
import { mcpToolName } from "../agent/mcp-names.ts";
import { OPERATOR_ID } from "../paths.ts";

export interface BuiltinMcpContext {
    userId: string;
    /** From `X-Chat-Conversation`; absent when the agent did not send it. */
    conversationId: string | undefined;
}

export interface BuiltinMcp {
    /** Server name: the path segment and the `mcp__<name>_` prefix the model sees. */
    name: string;
    /** Tool names the server offers. The runtime's own approval gate lets these through; the server asks for itself. */
    tools: readonly string[];
    handle(req: Request, ctx: BuiltinMcpContext): Promise<Response>;
}

const servers = new Map<string, BuiltinMcp>();

const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

type Rpc = {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: { name?: unknown };
};

const rpcResult = (id: unknown, result: unknown) =>
    Response.json({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: unknown, code: number, message: string) =>
    Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export const unsupportedToolMessage = (server: string, tool: string) =>
    `unsupported_tool: ${server}/${tool.slice(0, 40)} has a name the agent runtime cannot key a policy to (the name the model sees is over 64 characters), so it is not offered and not run.`;

/**
 * Fail closed on tool names the runtime would hash. The runtime names a tool `mcp__<server>_<tool>`, and keeps only a
 * prefix and a hash of a name over 64 characters; the per-tool policy cannot be keyed to that name (agent/mcp-names.ts),
 * so such a tool would run under no policy at all. The server never lists one and an attempt to call one is refused with
 * an explicit error before it reaches the server. A batch or an unreadable body is refused too: the guard must see
 * every call.
 */
export function guardToolNames(server: BuiltinMcp): BuiltinMcp {
    return {
        ...server,
        async handle(req, ctx) {
            let msg: Rpc | undefined;
            try {
                msg = (await req.clone().json()) as Rpc;
            } catch {
                return rpcError(null, -32700, "Parse error");
            }
            if (!msg || typeof msg !== "object" || Array.isArray(msg))
                return rpcError(null, -32600, "Batches are not supported");
            if (msg.method === "tools/call") {
                const tool = String(msg.params?.name ?? "");
                if (mcpToolName(server.name, tool) === undefined) {
                    return rpcResult(msg.id, {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: unsupportedToolMessage(server.name, tool),
                            },
                        ],
                    });
                }
            }
            const response = await server.handle(req, ctx);
            if (msg.method !== "tools/list") return response;
            let listed: { result?: { tools?: { name?: unknown }[] } } & Record<
                string,
                unknown
            >;
            try {
                listed = (await response.clone().json()) as typeof listed;
            } catch {
                return rpcError(
                    msg.id,
                    -32603,
                    "The tool list could not be checked",
                );
            }
            const tools = listed.result?.tools;
            if (!Array.isArray(tools)) return response;
            return Response.json({
                ...listed,
                result: {
                    ...listed.result,
                    tools: tools.filter(
                        (t) =>
                            mcpToolName(server.name, String(t.name)) !==
                            undefined,
                    ),
                },
            });
        },
    };
}

/** Mount a server. Returns the function that unmounts it. */
export function registerBuiltinMcp(server: BuiltinMcp): () => void {
    if (!NAME_RE.test(server.name))
        throw new Error(`[mcp] invalid built-in server name: ${server.name}`);
    if (server.name === "conversations")
        throw new Error(
            "[mcp] the name `conversations` is taken by the chat server",
        );
    const long = server.tools.find(
        (tool) => mcpToolName(server.name, tool) === undefined,
    );
    if (long !== undefined)
        throw new Error(
            `[mcp] ${server.name}/${long}: ${unsupportedToolMessage(server.name, long)}`,
        );
    const guarded = guardToolNames(server);
    servers.set(server.name, guarded);
    return () => {
        if (servers.get(server.name) === guarded) servers.delete(server.name);
    };
}

export function builtinMcp(name: string): BuiltinMcp | undefined {
    return servers.get(name);
}

export function listBuiltinMcp(): BuiltinMcp[] {
    return [...servers.values()];
}

export const builtinContext = (
    conversationId: string | undefined,
): BuiltinMcpContext => ({
    userId: OPERATOR_ID,
    conversationId,
});
