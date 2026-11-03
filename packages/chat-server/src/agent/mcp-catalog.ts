/**
 * The MCP servers and tools the agent can use, for the composer's @ menu and settings.
 *
 * The runtime is a binary, so there is no loader to ask. Each rendered server (agent/config.ts) is a URL on the agent
 * surface, and its tools are listed the way the agent would: one MCP client session against that URL, with the gateway
 * token. Results are cached by the hash of the rendered mcp.json for 10 minutes. `fresh` skips the cache (settings
 * "Check again").
 */
import type { McpServer, McpServerStatus, McpToolStatus } from "@pikvm/chat-protocol";
import { createHash } from "node:crypto";
import { agentBaseUrl } from "../env.ts";
import { resolveSetting } from "../settings/store.ts";
import { writeAgentConfig } from "./config.ts";
import { mcpToolName } from "./mcp-names.ts";

export type McpToolInfo = McpToolStatus;
export type McpServerInfo = McpServerStatus;

const TTL_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 15_000;
const cache = new Map<string, { hash: string; at: number; servers: McpServerInfo[] }>();
const inflight = new Map<string, Promise<McpServerInfo[]>>();

interface RenderedServer {
    type?: string;
    url?: string;
    headers?: Record<string, string>;
}

interface Listed {
    connected: boolean;
    error?: string;
    tools: (McpToolInfo & { server: string })[];
}

/** A reply body is JSON, or a short SSE stream whose `data:` lines carry it. */
async function readReply(res: Response): Promise<{ result?: Record<string, unknown>; error?: string }> {
    const text = await res.text();
    const payload = (res.headers.get("content-type") ?? "").includes("text/event-stream")
        ? text
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim())
              .filter(Boolean)
              .at(-1)
        : text;
    if (!payload) return { error: `HTTP ${res.status}` };
    const msg = JSON.parse(payload) as { result?: Record<string, unknown>; error?: { message?: string } };
    return msg.error ? { error: msg.error.message ?? "request failed" } : { result: msg.result ?? {} };
}

/** List one server's tools over one session, as the runtime's client would. */
async function listServer(name: string, server: RenderedServer): Promise<Listed> {
    if (!server.url) return { connected: false, error: "No URL", tools: [] };
    const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // The listing is not made from a conversation; the placeholder in the rendered header would be sent verbatim.
        ...Object.fromEntries(Object.entries(server.headers ?? {}).filter(([k]) => k.toLowerCase() !== "x-chat-conversation")),
    };
    const call = async (method: string, params: Record<string, unknown>, id?: number) =>
        fetch(server.url!, {
            method: "POST",
            headers,
            body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
    try {
        const init = await call(
            "initialize",
            { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chat-listing", version: "1.0.0" } },
            1,
        );
        if (!init.ok) return { connected: false, error: `HTTP ${init.status}`, tools: [] };
        const session = init.headers.get("mcp-session-id");
        const first = await readReply(init);
        if (first.error) return { connected: false, error: first.error, tools: [] };
        if (session) headers["mcp-session-id"] = session;
        await call("notifications/initialized", {}).then((r) => r.body?.cancel());
        const listed = await readReply(await call("tools/list", {}, 2));
        if (listed.error) return { connected: true, error: listed.error, tools: [] };
        const tools = ((listed.result?.tools as { name: string; title?: string; description?: string }[]) ?? []).map(
            (t) => ({
                name: mcpToolName(name, t.name) ?? `mcp__${name}_${t.name}`,
                tool: t.name,
                label: `${name}/${t.title ?? t.name}`,
                description: String(t.description ?? "").slice(0, 300),
                server: name,
            }),
        );
        return { connected: true, tools };
    } catch (err) {
        return { connected: false, error: (err as Error).message, tools: [] };
    }
}

export async function listMcp(userId: string, fresh = false): Promise<McpServerInfo[]> {
    const cfg = writeAgentConfig(userId, agentBaseUrl());
    const hash = createHash("sha256").update(JSON.stringify(cfg.mcp)).digest("hex").slice(0, 16);
    const hit = cache.get(userId);
    if (!fresh && hit && hit.hash === hash && Date.now() - hit.at < TTL_MS) return hit.servers;
    const key = `${userId}:${hash}`;
    const running = inflight.get(key);
    if (running) return running;

    const p = (async () => {
        const r = resolveSetting("agent.mcp", userId);
        const configured = r.value as Record<string, McpServer>;
        const rendered = cfg.mcp.mcpServers as Record<string, RenderedServer>;
        const listings = await Promise.all(
            Object.entries(rendered).map(async ([name, s]) => [name, await listServer(name, s)] as const),
        );
        const servers: McpServerInfo[] = listings.map(([name, listing]) => ({
            name,
            type: (configured[name]?.type ?? rendered[name]?.type ?? "http") as McpServerInfo["type"],
            owner: name in configured ? (r.owners?.[name] ?? "user") : "builtin",
            connected: listing.connected,
            error: listing.connected ? undefined : listing.error,
            tools: listing.tools.map(({ name: n, tool, label, description }) => ({ name: n, tool, label, description })),
        }));
        cache.set(userId, { hash, at: Date.now(), servers });
        return servers;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

/** Cached listing only (never calls a server); used to expand mentions while sending. */
export function cachedMcp(userId: string): McpServerInfo[] {
    return cache.get(userId)?.servers ?? [];
}
