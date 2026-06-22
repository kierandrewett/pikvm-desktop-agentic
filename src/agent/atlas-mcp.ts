/**
 * Atlas MCP bridge (back-compat shim).
 *
 * Atlas is no longer special-cased: it is one entry in the generic, config-driven
 * MCP registry (see `mcp-servers.ts`). This module is kept as a thin wrapper so
 * the existing smoke tests and any old call sites keep working — `connectAtlas`
 * simply configures the Atlas stdio server and hands it to the generic manager.
 */

import { connectMcpServers, type McpServerConfig, type McpRegistry } from "./mcp-servers";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface AtlasBridge {
    tools: AgentTool<any>[];
    toolNames: string[];
    remember: (text: string, tags?: string[], id?: string) => Promise<void>;
    close: () => Promise<void>;
}

/** The Atlas server config the generic manager understands. */
export function atlasServerConfig(opts: { atlasBin: string; vault: string }): McpServerConfig {
    return {
        id: "atlas",
        name: "Atlas memory vault",
        enabled: true,
        transport: "stdio",
        command: opts.atlasBin,
        args: ["mcp", opts.vault],
        rawToolNames: true,
        skill: "atlas-vault",
    };
}

/**
 * Connect just the Atlas vault via the generic MCP manager. Returns null if it
 * failed to connect (binary missing / bad vault), exactly as before.
 */
export async function connectAtlas(opts: { atlasBin: string; vault: string }): Promise<AtlasBridge | null> {
    const registry: McpRegistry = await connectMcpServers([atlasServerConfig(opts)]);
    if (!registry.connections.length) return null;
    return {
        tools: registry.tools,
        toolNames: registry.tools.map((t) => t.name),
        remember: registry.remember,
        close: registry.close,
    };
}
