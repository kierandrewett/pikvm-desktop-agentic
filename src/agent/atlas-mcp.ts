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
    /**
     * Mirror a quick-capture fact (from the `remember` tool / recap saves) into
     * the vault as a markdown page under `memory/notes/`, so Atlas stays the
     * single source of truth for the agent's memory. Best-effort.
     */
    remember: (text: string, tags?: string[], id?: string) => Promise<void>;
    close: () => Promise<void>;
}

/** Turn a fact into a short, file-safe slug for the page path. */
function slugify(text: string): string {
    const s = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .split("-")
        .slice(0, 8)
        .join("-")
        .slice(0, 60);
    return s || "note";
}

/** A human-readable title: the first sentence/clause, trimmed to a sane length. */
function titleOf(text: string): string {
    const first = (text.split(/[.\n]/)[0] ?? "").trim();
    const t = (first.length >= 8 ? first : text.trim()).slice(0, 80);
    return t || "Note";
}

/**
 * Tools that mutate the vault on disk. After one of these runs we rebuild the
 * derived index (atlas_health) so a separately-running `atlas web` frontend —
 * which reads a shared on-disk index and does NOT watch for external git writes —
 * reflects the new page straight away instead of serving a stale view.
 */
const WRITE_TOOLS = new Set([
    "atlas_page",
    "atlas_object",
    "atlas_statement",
    "atlas_schema",
    "atlas_import",
    "atlas_propose",
    "atlas_command",
]);
const REINDEX_TOOL = "atlas_health";

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

    const canReindex = listed.tools.some((t) => t.name === REINDEX_TOOL);
    // Debounce reindexing so a burst of writes (create page + several edits)
    // coalesces into a single rebuild shortly after the agent stops writing.
    let reindexTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReindex = () => {
        if (!canReindex) return;
        if (reindexTimer) clearTimeout(reindexTimer);
        reindexTimer = setTimeout(() => {
            reindexTimer = null;
            client
                .callTool({ name: REINDEX_TOOL, arguments: {} })
                .catch((e) => console.error("[atlas] auto-reindex failed:", (e as Error)?.message ?? e));
        }, 800);
    };

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
                // A successful write means the frontend's index is now stale; refresh it.
                if (WRITE_TOOLS.has(t.name) && res?.isError !== true) scheduleReindex();
                return { content: [{ type: "text", text: resultText(res) }], details: null };
            } catch (e) {
                return { content: [{ type: "text", text: `Atlas error: ${(e as Error)?.message ?? e}` }], details: null };
            }
        },
    }));

    const hasPageTool = listed.tools.some((t) => t.name === "atlas_page");
    const remember = async (text: string, tags: string[] = [], id?: string): Promise<void> => {
        if (!hasPageTool || !text.trim()) return;
        const suffix = (id ?? `${Date.now().toString(36)}`).replace(/[^a-z0-9]+/gi, "").slice(-8);
        const path = `memory/notes/${slugify(text)}-${suffix}`;
        const body = [text.trim(), "", tags.length ? `Tags: ${tags.join(", ")}` : ""].join("\n").trimEnd() + "\n";
        try {
            await client.callTool({ name: "atlas_page", arguments: { action: "create", path, title: titleOf(text) } });
            await client.callTool({ name: "atlas_page", arguments: { action: "update", path, body } });
            scheduleReindex();
        } catch (e) {
            console.error("[atlas] mirror remember failed:", (e as Error)?.message ?? e);
        }
    };

    console.log(`[atlas] connected — ${tools.length} tools from vault ${opts.vault}`);
    return { tools, toolNames: tools.map((t) => t.name), remember, close: () => client.close() };
}
