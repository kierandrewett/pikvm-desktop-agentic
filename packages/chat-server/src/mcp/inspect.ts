/**
 * Settings-side views of a remote MCP server, made from the Chat server with the user's own credential:
 * - `discover`: what an unsaved address offers (era, auth, server identity, tools when listed without a sign-in);
 * - `inventory`: tools, prompts, resources and resource templates of a saved server;
 * - `readResource`: one resource's text, for browsing and attaching;
 * - `beginConnect`: the authorisation URL for Connect / Reconnect (step-up scopes included).
 * Every list is followed through `nextCursor` up to MAX_PAGES and capped at MAX_ITEMS.
 */
import type { McpDiscovery, McpInventory, McpServer, McpToolSummary } from "@pikvm/chat-protocol";
import { guardFor, stepUpScope, type ResolvedServer } from "./credentials.ts";
import { summariseTool } from "./gateway.ts";
import { BlockedUrlError, guardedFetch } from "./net.ts";
import { authNeeds, beginAuthorization, OAuthError, withinResource } from "./oauth.ts";
import { answerOf, openConn, post, postNoReply, UpstreamFailure, type Conn } from "./upstream.ts";

const MAX_PAGES = 20;
const MAX_ITEMS = 1000;
const MAX_RESOURCE_CHARS = 200_000;
const TIMEOUT_MS = 20_000;

async function request(
    conn: Conn,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
): Promise<Record<string, unknown>> {
    const id = `chat-${method}-${Math.random().toString(36).slice(2, 8)}`;
    const reply = await post(conn, { jsonrpc: "2.0", id, method, params }, signal);
    const { msg, failure } = await answerOf(reply, id);
    if (failure) throw new UpstreamFailure(`HTTP ${failure.status}`, failure);
    if (msg?.error) throw new Error(msg.error.message);
    return msg?.result ?? {};
}

async function list<T>(conn: Conn, method: string, key: string, signal: AbortSignal): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES && out.length < MAX_ITEMS; page++) {
        const r = await request(conn, method, cursor ? { cursor } : {}, signal);
        out.push(...((r[key] as T[] | undefined) ?? []));
        cursor = typeof r.nextCursor === "string" ? r.nextCursor : undefined;
        if (!cursor) break;
    }
    return out.slice(0, MAX_ITEMS);
}

async function opened(userId: string, s: ResolvedServer, signal: AbortSignal) {
    const o = await openConn(userId, s, guardFor(s), signal);
    if (o.conn.era === "stateful") await postNoReply(o.conn, { jsonrpc: "2.0", method: "notifications/initialized" });
    return o;
}

function close(conn: Conn): void {
    if (conn.era !== "stateful" || !conn.session) return;
    void guardedFetch(
        conn.server.entry.url!,
        { method: "DELETE", headers: { "mcp-session-id": conn.session }, signal: AbortSignal.timeout(5000) },
        conn.guard,
    )
        .then((r) => r.body?.cancel())
        .catch(() => undefined);
}

function describe(err: unknown): { text: string; status?: number } {
    if (err instanceof UpstreamFailure && err.reply)
        return { text: `The server answered HTTP ${err.reply.status}`, status: err.reply.status };
    if (err instanceof BlockedUrlError || err instanceof OAuthError) return { text: err.message };
    if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError")
        return { text: "The server did not answer in time" };
    return { text: (err as Error).message };
}

export async function inventory(userId: string, s: ResolvedServer): Promise<McpInventory> {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const empty = { server: s.id, tools: [], prompts: [], resources: [], resourceTemplates: [] };
    let o: Awaited<ReturnType<typeof opened>>;
    try {
        o = await opened(userId, s, signal);
    } catch (err) {
        const d = describe(err);
        return { ...empty, error: d.text, needsAuth: d.status === 401 || d.status === 403 };
    }
    const caps = (o.result.capabilities ?? {}) as Record<string, unknown>;
    const info = (o.result.serverInfo ?? {}) as { name?: string; version?: string };
    try {
        const [tools, prompts, resources, templates] = await Promise.all([
            caps.tools ? list<Record<string, unknown>>(o.conn, "tools/list", "tools", signal) : [],
            caps.prompts ? list<McpInventory["prompts"][number]>(o.conn, "prompts/list", "prompts", signal) : [],
            caps.resources
                ? list<McpInventory["resources"][number]>(o.conn, "resources/list", "resources", signal)
                : [],
            caps.resources
                ? list<McpInventory["resourceTemplates"][number]>(
                      o.conn,
                      "resources/templates/list",
                      "resourceTemplates",
                      signal,
                  ).catch(() => [])
                : [],
        ]);
        return {
            server: s.id,
            serverName: info.name,
            serverVersion: info.version,
            protocolVersion: o.conn.protocolVersion,
            era: o.conn.era,
            tools: tools.map(summariseTool).filter((t): t is McpToolSummary => !!t),
            prompts: prompts.map((p) => ({
                name: p.name,
                title: p.title,
                description: p.description?.slice(0, 1000),
                arguments: p.arguments?.map((a) => ({ name: a.name, required: a.required })),
            })),
            resources: resources.map((r) => ({
                uri: r.uri,
                name: r.name,
                title: r.title,
                description: r.description?.slice(0, 1000),
                mimeType: r.mimeType,
            })),
            resourceTemplates: templates.map((t) => ({
                uriTemplate: t.uriTemplate,
                name: t.name,
                title: t.title,
                description: t.description?.slice(0, 1000),
            })),
        };
    } catch (err) {
        return { ...empty, serverName: info.name, error: describe(err).text };
    } finally {
        close(o.conn);
    }
}

export async function readResource(
    userId: string,
    s: ResolvedServer,
    uri: string,
): Promise<{ uri: string; mimeType?: string; text?: string; truncated?: boolean; binary?: boolean }> {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const o = await opened(userId, s, signal);
    try {
        const r = await request(o.conn, "resources/read", { uri }, signal);
        const c = ((r.contents as { uri?: string; mimeType?: string; text?: string; blob?: string }[] | undefined) ??
            [])[0];
        if (!c) return { uri };
        if (typeof c.text !== "string") return { uri, mimeType: c.mimeType, binary: true };
        return {
            uri,
            mimeType: c.mimeType,
            text: c.text.slice(0, MAX_RESOURCE_CHARS),
            truncated: c.text.length > MAX_RESOURCE_CHARS || undefined,
        };
    } finally {
        close(o.conn);
    }
}

/** Probe an address before it is saved. `owner` decides the SSRF rules (an administrator's address is trusted). */
export async function discover(userId: string, url: string, owner: "user" | "global"): Promise<McpDiscovery> {
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    const entry: McpServer = { type: "http", url, enabled: true };
    const s: ResolvedServer = { id: "__discover", entry, owner };
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
        const o = await opened(userId, s, signal);
        const info = (o.result.serverInfo ?? {}) as { name?: string; title?: string; version?: string };
        const caps = (o.result.capabilities ?? {}) as Record<string, unknown>;
        let tools: McpToolSummary[] | undefined;
        try {
            tools = caps.tools
                ? (await list<Record<string, unknown>>(o.conn, "tools/list", "tools", signal))
                      .map(summariseTool)
                      .filter((t): t is McpToolSummary => !!t)
                : [];
        } catch {
            tools = undefined;
        } finally {
            close(o.conn);
        }
        return {
            ok: true,
            url,
            era: o.conn.era,
            protocolVersion: o.conn.protocolVersion,
            transport: "http",
            auth: "none",
            serverName: info.name,
            serverTitle: info.title,
            serverVersion: info.version,
            instructions: typeof o.result.instructions === "string" ? o.result.instructions.slice(0, 2000) : undefined,
            tools,
            latencyMs: ms(),
        };
    } catch (err) {
        const reply = err instanceof UpstreamFailure ? err.reply : undefined;
        if (reply?.status === 401) {
            try {
                const needs = await authNeeds(url, reply.challenge, guardFor(s));
                return {
                    ok: true,
                    url,
                    transport: "http",
                    auth: "oauth",
                    oauth: {
                        issuer: needs.issuer,
                        scopes: needs.challengeScope?.split(" ") ?? needs.resourceMeta?.scopes_supported,
                        resourceName: needs.resourceMeta?.resource_name,
                        registration: needs.meta.client_id_metadata_document_supported
                            ? "metadata"
                            : needs.meta.registration_endpoint
                              ? "dynamic"
                              : "none",
                    },
                    latencyMs: ms(),
                };
            } catch (e) {
                return { ok: false, url, auth: "oauth", latencyMs: ms(), error: describe(e).text };
            }
        }
        return { ok: false, url, auth: "unknown", latencyMs: ms(), error: describe(err).text };
    }
}

/** The authorisation URL for Connect (or Reconnect with the scopes a 403 asked for). */
export async function beginConnect(userId: string, s: ResolvedServer, redirectUri: string): Promise<string> {
    const guard = guardFor(s);
    let challenge: Record<string, string> | undefined;
    // Ask without a token: the 401 challenge names the metadata and the scopes the server wants.
    try {
        const probe: ResolvedServer = { ...s, id: `__connect_${s.id}` };
        const o = await openConn(userId, probe, guard, AbortSignal.timeout(TIMEOUT_MS));
        close(o.conn);
    } catch (err) {
        if (err instanceof UpstreamFailure && err.reply?.status === 401) challenge = err.reply.challenge;
        else if (err instanceof BlockedUrlError) throw err;
    }
    const needs = await authNeeds(s.entry.url!, challenge, guard);
    if (!withinResource(s.entry.url!, needs.resource))
        throw new OAuthError("The server's metadata names another address");
    return beginAuthorization(
        { userId, serverId: s.id, entry: s.entry, guard },
        needs,
        redirectUri,
        stepUpScope(userId, s.id),
    );
}
