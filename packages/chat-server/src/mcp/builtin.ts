/**
 * MCP servers the host mounts on the agent surface (`/mcp/<name>`). The PiKVM computer-use server is one: it runs in
 * the host process, so its credentials never leave it, and the agent reaches it with the same bearer token as the
 * gateway. Chat's own `/mcp/conversations` is mounted separately.
 */
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

/** Mount a server. Returns the function that unmounts it. */
export function registerBuiltinMcp(server: BuiltinMcp): () => void {
    if (!NAME_RE.test(server.name)) throw new Error(`[mcp] invalid built-in server name: ${server.name}`);
    if (server.name === "conversations") throw new Error("[mcp] the name `conversations` is taken by the chat server");
    servers.set(server.name, server);
    return () => {
        if (servers.get(server.name) === server) servers.delete(server.name);
    };
}

export function builtinMcp(name: string): BuiltinMcp | undefined {
    return servers.get(name);
}

export function listBuiltinMcp(): BuiltinMcp[] {
    return [...servers.values()];
}

export const builtinContext = (conversationId: string | undefined): BuiltinMcpContext => ({
    userId: OPERATOR_ID,
    conversationId,
});
