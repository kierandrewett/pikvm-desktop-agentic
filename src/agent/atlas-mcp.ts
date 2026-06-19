/**
 * Atlas MCP bridge.
 *
 * Spawns the Atlas MCP stdio server (`atlas mcp <vault>`) and exposes its tools
 * (atlas_page, atlas_search, atlas_query, ...) to the Pi agent as AgentTools, so
 * the agent's long-term memory lives as markdown pages in a git-backed Atlas vault
 * rather than a JSON blob. Connecting is best-effort: if Atlas is missing or the
 * vault is bad, the agent runs without it (it still has the JSON remember/recall).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export interface AtlasBridge {
    tools: AgentTool<any>[];
    toolNames: string[];
    close: () => Promise<void>;
}

/** Flatten an MCP tool result into plain text for the agent. */
function resultText(res: any): string {
    const content = res?.content;
    if (Array.isArray(content)) {
        const text = content
            .filter((c: any) => c?.type === "text")
            .map((c: any) => c.text)
            .join("\n");
        if (text) return text;
    }
    return typeof content === "string" ? content : JSON.stringify(res ?? {});
}

export async function connectAtlas(opts: { atlasBin: string; vault: string }): Promise<AtlasBridge | null> {
    let client: Client;
    try {
        const transport = new StdioClientTransport({ command: opts.atlasBin, args: ["mcp", opts.vault] });
        client = new Client({ name: "pikvm-agent", version: "1.0.0" });
        await client.connect(transport);
    } catch (e) {
        console.error("[atlas] connect failed:", (e as Error)?.message ?? e);
        return null;
    }

    let listed: Awaited<ReturnType<Client["listTools"]>>;
    try {
        listed = await client.listTools();
    } catch (e) {
        console.error("[atlas] listTools failed:", (e as Error)?.message ?? e);
        await client.close().catch(() => {});
        return null;
    }

    const tools: AgentTool<any>[] = listed.tools.map((t) => ({
        name: t.name,
        label: t.name,
        description: t.description ?? `Atlas vault tool ${t.name}`,
        // The MCP input schema is already a JSON schema; Type.Unsafe wraps it as a
        // TSchema so the harness can serialise it without us re-authoring it.
        parameters: Type.Unsafe<Record<string, unknown>>(t.inputSchema ?? { type: "object" }),
        async execute(_id: string, params: unknown): Promise<AgentToolResult<null>> {
            try {
                const res = await client.callTool({ name: t.name, arguments: (params as Record<string, unknown>) ?? {} });
                return { content: [{ type: "text", text: resultText(res) }], details: null };
            } catch (e) {
                return { content: [{ type: "text", text: `Atlas error: ${(e as Error)?.message ?? e}` }], details: null };
            }
        },
    }));

    console.log(`[atlas] connected — ${tools.length} tools from vault ${opts.vault}`);
    return { tools, toolNames: tools.map((t) => t.name), close: () => client.close() };
}
