/**
 * Tool summaries the MCP gateway saw in `tools/list`, per user and server, in memory. The config generator reads them
 * for read-only approval rules (agent/config.ts) and the settings pages show them. Kept apart from gateway.ts so the
 * config generator does not import the session manager through the gateway.
 */
import type { McpToolSummary } from "@pikvm/chat-protocol";

const seen = new Map<string, McpToolSummary[]>();
const key = (userId: string, serverId: string) => `${userId}\u0000${serverId}`;

export function toolsSeen(userId: string, serverId: string): McpToolSummary[] | undefined {
    return seen.get(key(userId, serverId));
}

export function rememberToolsSeen(userId: string, serverId: string, tools: McpToolSummary[]): void {
    seen.set(key(userId, serverId), tools);
}
