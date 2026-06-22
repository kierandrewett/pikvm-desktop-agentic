/**
 * Generic, config-driven MCP server registry.
 *
 * Given a list of server configs (stdio: {command, args, env}; http: {url,
 * headers}), connects to each, lists its tools, and exposes them to the Pi agent
 * as AgentTools — namespaced per server so two servers can't collide. Connecting
 * is best-effort and isolated: a server that fails to connect (binary missing,
 * URL unreachable, bad handshake) is logged and skipped, never crashing startup.
 *
 * Atlas (the markdown memory vault) is no longer special-cased here — it is just
 * one configured stdio server. The two behaviours Atlas relies on are preserved
 * generically: (1) the `remember` write-through (any connected server whose tools
 * look like an Atlas vault gets the mirror), and (2) auto-reindex after a vault
 * write so a separately-running `atlas web` frontend reflects new pages.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

/** One configured MCP server. Either stdio (a local process) or http (a URL). */
export interface McpServerConfig {
    /** Stable id, used to namespace tools and as the React key. */
    id: string;
    /** Human-readable label for the UI/logs. */
    name: string;
    /** Whether to connect at startup. */
    enabled: boolean;
    /** Transport: spawn a process ("stdio") or talk to a URL ("http"). */
    transport: "stdio" | "http";
    /** stdio: the executable to run. */
    command?: string;
    /** stdio: arguments passed to the command. */
    args?: string[];
    /** stdio: extra environment variables for the child process. */
    env?: Record<string, string>;
    /** http: the server URL (Streamable HTTP / SSE endpoint). */
    url?: string;
    /** http: extra headers (e.g. Authorization) sent with every request. */
    headers?: Record<string, string>;
    /**
     * Keep this server's tool names verbatim instead of namespacing them with
     * `<id>_`. Used for back-compat (Atlas's tools are already `atlas_*`).
     */
    rawToolNames?: boolean;
    /** Optional skill name documenting how to use this server (shown to the agent). */
    skill?: string;
}

/** A live connection to one MCP server plus the agent tools it contributed. */
export interface McpServerConnection {
    id: string;
    name: string;
    tools: AgentTool<any>[];
    toolNames: string[];
    close: () => Promise<void>;
}

/** The whole registry: every connected server, flattened tools, and a memory mirror. */
export interface McpRegistry {
    connections: McpServerConnection[];
    tools: AgentTool<any>[];
    /**
     * Mirror a quick-capture fact (from the `remember` tool / recap saves) into
     * any connected Atlas-style vault as a markdown page under `memory/notes/`,
     * so the vault stays the single source of truth. No-op if no vault is present.
     */
    remember: (text: string, tags?: string[], id?: string) => Promise<void>;
    /** Skills named by connected servers (so the prompt can point the agent at them). */
    skills: string[];
    close: () => Promise<void>;
}

/* ---------------------------- Atlas-vault helpers --------------------------- */

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
 * Tools that mutate an Atlas vault on disk. After one of these runs we rebuild
 * the derived index (atlas_health) so a separately-running `atlas web` frontend —
 * which reads a shared on-disk index and does NOT watch for external git writes —
 * reflects the new page straight away instead of serving a stale view.
 */
const ATLAS_WRITE_TOOLS = new Set([
    "atlas_page",
    "atlas_object",
    "atlas_statement",
    "atlas_schema",
    "atlas_import",
    "atlas_propose",
    "atlas_command",
]);
const ATLAS_REINDEX_TOOL = "atlas_health";

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

/** Build the transport for a server config, or null if the config is incomplete.
 *  Exported for unit testing transport selection / validation. */
export function makeTransport(cfg: McpServerConfig): Transport | null {
    if (cfg.transport === "http") {
        if (!cfg.url?.trim()) return null;
        let url: URL;
        try {
            url = new URL(cfg.url.trim());
        } catch {
            return null;
        }
        const headers = cfg.headers && Object.keys(cfg.headers).length ? cfg.headers : undefined;
        // The SDK's StreamableHTTPClientTransport types `sessionId` as optional,
        // which trips exactOptionalPropertyTypes against the Transport interface;
        // it satisfies Transport structurally, so narrow it explicitly.
        return new StreamableHTTPClientTransport(url, headers ? { requestInit: { headers } } : {}) as unknown as Transport;
    }
    // stdio
    if (!cfg.command?.trim()) return null;
    return new StdioClientTransport({
        command: cfg.command.trim(),
        args: cfg.args ?? [],
        // Inherit the parent env and layer the config's overrides on top, so a
        // server still finds PATH/HOME etc. while getting its own secrets.
        ...(cfg.env && Object.keys(cfg.env).length
            ? { env: { ...(process.env as Record<string, string>), ...cfg.env } }
            : {}),
    });
}

/** Namespace a tool name for the agent: `<id>_<tool>`, unless rawToolNames is set.
 *  Exported for unit testing the namespacing rules. */
export function namespaceTool(cfg: McpServerConfig, toolName: string): string {
    if (cfg.rawToolNames) return toolName;
    const prefix = cfg.id.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
    // Avoid double-prefixing if the tool already starts with the id (e.g. atlas_*).
    if (prefix && toolName.startsWith(`${prefix}_`)) return toolName;
    return prefix ? `${prefix}_${toolName}` : toolName;
}

/** Connect to a single server config and return its connection (or null on failure). */
async function connectServer(cfg: McpServerConfig): Promise<{
    connection: McpServerConnection;
    remember?: (text: string, tags?: string[], id?: string) => Promise<void>;
} | null> {
    const transport = makeTransport(cfg);
    if (!transport) {
        console.error(`[mcp] ${cfg.id}: incomplete config (missing ${cfg.transport === "http" ? "url" : "command"}); skipped`);
        return null;
    }

    let client: Client;
    try {
        client = new Client({ name: "pikvm-agent", version: "1.0.0" });
        await client.connect(transport);
    } catch (e) {
        console.error(`[mcp] ${cfg.id}: connect failed:`, (e as Error)?.message ?? e);
        return null;
    }

    let listed: Awaited<ReturnType<Client["listTools"]>>;
    try {
        listed = await client.listTools();
    } catch (e) {
        console.error(`[mcp] ${cfg.id}: listTools failed:`, (e as Error)?.message ?? e);
        await client.close().catch(() => {});
        return null;
    }

    // Atlas-style vault behaviours, enabled only when the relevant tools exist.
    const canReindex = listed.tools.some((t) => t.name === ATLAS_REINDEX_TOOL);
    const hasPageTool = listed.tools.some((t) => t.name === "atlas_page");
    let reindexTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReindex = (): void => {
        if (!canReindex) return;
        if (reindexTimer) clearTimeout(reindexTimer);
        reindexTimer = setTimeout(() => {
            reindexTimer = null;
            client
                .callTool({ name: ATLAS_REINDEX_TOOL, arguments: {} })
                .catch((e) => console.error(`[mcp] ${cfg.id}: auto-reindex failed:`, (e as Error)?.message ?? e));
        }, 800);
    };

    const tools: AgentTool<any>[] = listed.tools.map((t) => {
        const exposedName = namespaceTool(cfg, t.name);
        return {
            name: exposedName,
            label: exposedName,
            description: t.description ?? `${cfg.name} tool ${t.name}`,
            // The MCP input schema is already a JSON schema; Type.Unsafe wraps it as
            // a TSchema so the harness can serialise it without us re-authoring it.
            parameters: Type.Unsafe<Record<string, unknown>>(t.inputSchema ?? { type: "object" }),
            async execute(_id: string, params: unknown): Promise<AgentToolResult<null>> {
                try {
                    const res = await client.callTool({
                        name: t.name,
                        arguments: (params as Record<string, unknown>) ?? {},
                    });
                    // A successful vault write means the frontend's index is now stale.
                    if (ATLAS_WRITE_TOOLS.has(t.name) && res?.isError !== true) scheduleReindex();
                    return { content: [{ type: "text", text: resultText(res) }], details: null };
                } catch (e) {
                    return { content: [{ type: "text", text: `${cfg.name} error: ${(e as Error)?.message ?? e}` }], details: null };
                }
            },
        };
    });

    const remember = hasPageTool
        ? async (text: string, tags: string[] = [], id?: string): Promise<void> => {
              if (!text.trim()) return;
              const suffix = (id ?? `${Date.now().toString(36)}`).replace(/[^a-z0-9]+/gi, "").slice(-8);
              const path = `memory/notes/${slugify(text)}-${suffix}`;
              const body = [text.trim(), "", tags.length ? `Tags: ${tags.join(", ")}` : ""].join("\n").trimEnd() + "\n";
              try {
                  await client.callTool({ name: "atlas_page", arguments: { action: "create", path, title: titleOf(text) } });
                  await client.callTool({ name: "atlas_page", arguments: { action: "update", path, body } });
                  scheduleReindex();
              } catch (e) {
                  console.error(`[mcp] ${cfg.id}: mirror remember failed:`, (e as Error)?.message ?? e);
              }
          }
        : undefined;

    console.log(`[mcp] ${cfg.id} (${cfg.name}) connected — ${tools.length} tools`);
    const connection: McpServerConnection = {
        id: cfg.id,
        name: cfg.name,
        tools,
        toolNames: tools.map((t) => t.name),
        close: () => {
            if (reindexTimer) clearTimeout(reindexTimer);
            return client.close();
        },
    };
    return remember ? { connection, remember } : { connection };
}

/**
 * Connect to every enabled server config. Failures are isolated: one bad server
 * never prevents the others (or the agent) from starting. Returns the flattened
 * tool set plus a `remember` mirror that fans out to all Atlas-style vaults.
 */
export async function connectMcpServers(configs: McpServerConfig[]): Promise<McpRegistry> {
    const enabled = configs.filter((c) => c.enabled);
    const results = await Promise.all(
        enabled.map((cfg) =>
            connectServer(cfg).catch((e) => {
                console.error(`[mcp] ${cfg.id}: unexpected error:`, (e as Error)?.message ?? e);
                return null;
            }),
        ),
    );

    const connections: McpServerConnection[] = [];
    const mirrors: ((text: string, tags?: string[], id?: string) => Promise<void>)[] = [];
    for (const r of results) {
        if (!r) continue;
        connections.push(r.connection);
        if (r.remember) mirrors.push(r.remember);
    }

    const tools = connections.flatMap((c) => c.tools);
    const skills = enabled.filter((c) => c.skill?.trim() && connections.some((conn) => conn.id === c.id)).map((c) => c.skill!.trim());

    const remember = async (text: string, tags?: string[], id?: string): Promise<void> => {
        await Promise.all(mirrors.map((m) => m(text, tags, id).catch(() => {})));
    };
    const close = async (): Promise<void> => {
        await Promise.all(connections.map((c) => c.close().catch(() => {})));
    };

    return { connections, tools, remember, skills, close };
}
