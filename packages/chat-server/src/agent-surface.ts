/**
 * The agent surface: the only listener the agent can reach.
 *
 * A separate `http.Server`, not a path on the host's listener. It serves `/gw/*` (the LLM gateway), `/mcp/s/*` (remote
 * MCP servers, credentials kept here), `/mcp/conversations` and the built-in servers the host mounted (`/mcp/<name>`),
 * and nothing else: no app, no PiKVM proxy, no static files. Every request needs `Authorization: Bearer <gateway
 * token>`; the token opens this surface and nothing else. `X-Chat-Conversation` names the conversation a call belongs
 * to, so approvals reach the right thread.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { keyFromRequest, verifyGatewayToken } from "./agent/providers.ts";
import { handleGateway } from "./http/gateway.ts";
import { handleConversationsMcp } from "./http/mcp-conversations.ts";
import { toRequest, sendResponse } from "./http/node-adapter.ts";
import { builtinContext, builtinMcp } from "./mcp/builtin.ts";
import { ownedConversation } from "./mcp/chat-servers.ts";
import { handleMcpGateway } from "./mcp/gateway.ts";

const text = (status: number, message: string) => new Response(message, { status });

export async function handleAgentRequest(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const userId = verifyGatewayToken(keyFromRequest(req.headers));
    if (!userId) return text(401, "Invalid gateway token");
    if (path.startsWith("/gw/")) return handleGateway(req);
    if (path === "/mcp/conversations") return handleConversationsMcp(req);
    if (path.startsWith("/mcp/s/")) return handleMcpGateway(req);
    const name = /^\/mcp\/([a-z][a-z0-9_]*)$/.exec(path)?.[1];
    const server = name ? builtinMcp(name) : undefined;
    if (!server) return text(404, "Not found");
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const conversationId = ownedConversation(userId, req.headers.get("x-chat-conversation"));
    return server.handle(req, builtinContext(userId, conversationId));
}

export interface AgentSurface {
    /** `http://127.0.0.1:<port>`. */
    readonly url: string;
    close(): Promise<void>;
}

export async function listenAgentSurface(options: { host?: string; port?: number } = {}): Promise<AgentSurface> {
    const host = options.host ?? "127.0.0.1";
    const server: Server = createServer((incoming, outgoing) => {
        const request = toRequest(incoming, `http://${host}`);
        handleAgentRequest(request)
            .catch((err: Error) => {
                console.error("[agent-surface] request failed", err);
                return text(500, "Internal error");
            })
            .then((response) => sendResponse(outgoing, response));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 0, host, resolve);
    });
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://${host === "::1" ? "[::1]" : host}:${port}`,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
