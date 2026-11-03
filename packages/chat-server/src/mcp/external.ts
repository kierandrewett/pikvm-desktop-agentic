/**
 * External MCP servers: none, by rule.
 *
 * External integrations reach the agent through one gateway (Executor, https://executor.example.com/mcp), never as MCP
 * servers a client configures directly. So the app offers no way to add one: the `agent.mcp` setting refuses writes
 * (settings/store.ts), the probe routes refuse (`externalMcpRefusal`), and the agent's config, the tool listing and the
 * gateway read their servers from this table instead of from settings. A row an older build left in the database is
 * never read.
 *
 * Allowing Executor later is one entry here, nothing else:
 *
 *     executor: { enabled: true, type: "http", url: "https://executor.example.com/mcp" },
 *
 * It is then rendered into the agent's `mcp.json` through the credential-holding gateway (`/mcp/s/executor`), like any
 * remote server, and its OAuth sign-in and per-tool policies work as they do for chat.
 */
import type { McpServer } from "@pikvm/chat-protocol";
import { HTTPException } from "hono/http-exception";

export const EXTERNAL_MCP: Readonly<Record<string, McpServer>> = {};

export const EXTERNAL_MCP_REFUSAL =
    "External MCP servers are not configurable here. Integrations go through the Executor gateway.";

/** The servers the agent may be given, in the shape `resolveSetting("agent.mcp")` had. */
export function externalMcp(): {
    value: Record<string, McpServer>;
    owners: Record<string, "global">;
} {
    const value = { ...EXTERNAL_MCP };
    return {
        value,
        owners: Object.fromEntries(
            Object.keys(value).map((id) => [id, "global" as const]),
        ),
    };
}

/** The answer to a route that would probe or add a server the user typed in. */
export function externalMcpRefusal(): HTTPException {
    return new HTTPException(403, { message: EXTERNAL_MCP_REFUSAL });
}

/** Is this settings key (full, user-twin or not) the list of external servers? */
export function isExternalMcpKey(fullKey: string): boolean {
    return /(^|\.)agent\.mcp(\.|$)/.test(fullKey);
}
