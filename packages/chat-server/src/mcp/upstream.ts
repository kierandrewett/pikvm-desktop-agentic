/**
 * Chat's own Streamable HTTP client for remote MCP servers, used by the gateway (gateway.ts) and by the settings
 * pages (inventory, discovery). It speaks both spec eras:
 *
 * - stateful (2025-11-25 and older): `initialize`, `Mcp-Session-Id`, server-to-client requests on the SSE answer.
 * - stateless (2026-07-28): no `initialize`; every request carries `_meta` protocol version, client capabilities and
 *   client info, plus `Mcp-Method` / `Mcp-Name` headers; `server/discover` replaces `initialize`.
 *
 * Era detection: `initialize` first; when the server refuses it with a JSON-RPC error (method not found, unsupported
 * version) or a 4xx carrying one, try `server/discover`. The answer is cached per server URL.
 *
 * Credentials: the entry's static headers, then the user's OAuth access token as `Authorization: Bearer`. A 401 with
 * a token forces one refresh and one retry. The runtime's gateway token is never sent upstream.
 */
import type { McpServer } from "@pikvm/chat-protocol";
import { accessToken, type ResolvedServer } from "./credentials.ts";
import { guardedFetch, type GuardOptions } from "./net.ts";
import { parseChallenge } from "./oauth.ts";

export const STATEFUL_VERSION = "2025-11-25";
export const STATELESS_VERSION = "2026-07-28";
export const CLIENT_INFO = { name: "chat-mcp-gateway", version: "1.0.0" };
/** What Chat answers itself on behalf of the runtime. Sampling is not offered (docs/spec/mcp-support.md 2.4). */
export const GATEWAY_CAPABILITIES = { elicitation: { form: {}, url: {} }, roots: {} };

export type Era = "stateful" | "stateless";

export interface Msg {
    jsonrpc: "2.0";
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: unknown };
}

export interface Conn {
    userId: string;
    server: ResolvedServer;
    guard: GuardOptions;
    era: Era;
    protocolVersion: string;
    session?: string;
    clientCapabilities: Record<string, unknown>;
}

export type Reply =
    | { kind: "status"; status: number; challenge?: Record<string, string>; message?: Msg; text: string }
    | { kind: "accepted" }
    | { kind: "messages"; messages: AsyncGenerator<Msg>; session?: string };

const eraCache = new Map<string, { era: Era; version: string }>();

export function cachedEra(url: string): { era: Era; version: string } | undefined {
    return eraCache.get(url);
}

/** JSON-RPC messages from a JSON body or an SSE stream. Comment lines and non-JSON data are skipped. */
async function* readMessages(res: Response): AsyncGenerator<Msg> {
    if (!res.headers.get("content-type")?.includes("text/event-stream")) {
        const body = (await res.json().catch(() => undefined)) as Msg | Msg[] | undefined;
        for (const m of Array.isArray(body) ? body : body ? [body] : []) yield m;
        return;
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl).replace(/\r$/, "");
                buffer = buffer.slice(nl + 1);
                if (line === "") {
                    if (data.length) {
                        try {
                            yield JSON.parse(data.join("\n")) as Msg;
                        } catch {}
                    }
                    data = [];
                } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            }
        }
    } finally {
        reader.releaseLock();
        await res.body?.cancel().catch(() => undefined);
    }
}

/** Add the stateless `_meta` fields to a request. */
export function statelessParams(msg: Msg, conn: Pick<Conn, "protocolVersion" | "clientCapabilities">): Msg {
    if (msg.method === undefined) return msg;
    return {
        ...msg,
        params: {
            ...msg.params,
            _meta: {
                ...msg.params?._meta,
                "io.modelcontextprotocol/protocolVersion": conn.protocolVersion,
                "io.modelcontextprotocol/clientCapabilities": conn.clientCapabilities,
                "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
            },
        },
    };
}

function headersFor(conn: Conn, msg: Msg, token: string | undefined): Record<string, string> {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(conn.server.entry.headers ?? {})) h[k] = v;
    if (token) {
        for (const k of Object.keys(h)) if (k.toLowerCase() === "authorization") delete h[k];
        h.authorization = `Bearer ${token}`;
    }
    h["content-type"] = "application/json";
    h.accept = "application/json, text/event-stream";
    if (conn.era === "stateful") {
        if (msg.method !== "initialize") h["mcp-protocol-version"] = conn.protocolVersion;
        if (conn.session) h["mcp-session-id"] = conn.session;
    } else {
        h["mcp-protocol-version"] = conn.protocolVersion;
        if (msg.method) h["mcp-method"] = msg.method;
        const name = msg.params?.name ?? msg.params?.uri;
        if (typeof name === "string" && /^(tools\/call|prompts\/get|resources\/read)$/.test(msg.method ?? ""))
            h["mcp-name"] = /^[\x20-\x7e]*$/.test(name) ? name : `=?base64?${Buffer.from(name).toString("base64")}?=`;
    }
    return h;
}

async function postOnce(conn: Conn, msg: Msg, signal: AbortSignal, token: string | undefined): Promise<Reply> {
    const body = conn.era === "stateless" ? statelessParams(msg, conn) : msg;
    const res = await guardedFetch(
        conn.server.entry.url!,
        { method: "POST", headers: headersFor(conn, msg, token), body: JSON.stringify(body), signal },
        conn.guard,
    );
    if (res.status === 202) {
        await res.body?.cancel();
        return { kind: "accepted" };
    }
    if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 2000);
        let message: Msg | undefined;
        try {
            const j = JSON.parse(text) as Msg;
            if (j && typeof j === "object" && j.error) message = j;
        } catch {}
        return {
            kind: "status",
            status: res.status,
            challenge: parseChallenge(res.headers.get("www-authenticate")),
            message,
            text: text.slice(0, 300),
        };
    }
    return { kind: "messages", messages: readMessages(res), session: res.headers.get("mcp-session-id") ?? undefined };
}

/** POST one message with the user's credential, refreshing once on 401. */
export async function post(conn: Conn, msg: Msg, signal: AbortSignal): Promise<Reply> {
    const token = await accessToken(conn.server, conn.userId);
    const first = await postOnce(conn, msg, signal, token);
    if (first.kind !== "status" || first.status !== 401 || !token) return first;
    const again = await accessToken(conn.server, conn.userId, true);
    if (!again || again === token) return first;
    return postOnce(conn, msg, signal, again);
}

/** Send a response or notification to a stateful server (answers to its requests, `initialized`, `cancelled`). */
export async function postNoReply(conn: Conn, msg: Msg): Promise<void> {
    const r = await post(conn, msg, AbortSignal.timeout(15_000)).catch(() => undefined);
    if (r?.kind === "messages") for await (const _ of r.messages) break;
}

/** The answer to request `id` from a reply, or the HTTP failure. Other messages go to `onOther`. */
export async function answerOf(
    reply: Reply,
    id: Msg["id"],
    onOther?: (m: Msg) => Promise<void> | void,
): Promise<{ msg?: Msg; failure?: Extract<Reply, { kind: "status" }> }> {
    if (reply.kind === "status") return { failure: reply };
    if (reply.kind === "accepted") return {};
    for await (const m of reply.messages) {
        if (m.id === id && (m.result !== undefined || m.error !== undefined)) return { msg: m };
        await onOther?.(m);
    }
    return {};
}

function refusesInitialize(r: Reply, msg?: Msg): boolean {
    const code = (r.kind === "status" ? r.message?.error?.code : msg?.error?.code) ?? 0;
    if ([-32601, -32022, -32602].includes(code)) return true;
    return r.kind === "status" && [400, 404, 405].includes(r.status) && !!r.message;
}

export interface Opened {
    conn: Conn;
    /** The initialize result to give the runtime (synthesised from server/discover for stateless servers). */
    result: Record<string, unknown>;
}

export class UpstreamFailure extends Error {
    constructor(
        message: string,
        readonly reply?: Extract<Reply, { kind: "status" }>,
    ) {
        super(message);
    }
}

/**
 * Open a connection: initialize (stateful) or server/discover (stateless). `requested` is the version the runtime
 * asked for; `caps` its capabilities (the gateway adds elicitation).
 */
export async function openConn(
    userId: string,
    server: ResolvedServer,
    guard: GuardOptions,
    signal: AbortSignal,
    requested = STATEFUL_VERSION,
    caps: Record<string, unknown> = {},
): Promise<Opened> {
    const clientCapabilities = { ...caps, ...GATEWAY_CAPABILITIES };
    const conn: Conn = { userId, server, guard, era: "stateful", protocolVersion: requested, clientCapabilities };
    const known = eraCache.get(server.entry.url!);
    if (known?.era !== "stateless") {
        const id = "chat-init";
        const reply = await post(
            conn,
            {
                jsonrpc: "2.0",
                id,
                method: "initialize",
                params: { protocolVersion: requested, capabilities: clientCapabilities, clientInfo: CLIENT_INFO },
            },
            signal,
        );
        const { msg, failure } = await answerOf(reply, id);
        if (msg?.result) {
            conn.session = reply.kind === "messages" ? reply.session : undefined;
            conn.protocolVersion = String(msg.result.protocolVersion ?? requested);
            eraCache.set(server.entry.url!, { era: "stateful", version: conn.protocolVersion });
            return { conn, result: msg.result };
        }
        if (failure && !refusesInitialize(failure)) throw new UpstreamFailure(`HTTP ${failure.status}`, failure);
        if (!failure && !refusesInitialize(reply, msg))
            throw new UpstreamFailure(msg?.error?.message ?? "The server did not answer initialize");
    }
    conn.era = "stateless";
    conn.protocolVersion = STATELESS_VERSION;
    const id = "chat-discover";
    const reply = await post(conn, { jsonrpc: "2.0", id, method: "server/discover", params: {} }, signal);
    const { msg, failure } = await answerOf(reply, id);
    if (failure) throw new UpstreamFailure(`HTTP ${failure.status}`, failure);
    if (!msg?.result)
        throw new UpstreamFailure(msg?.error?.message ?? "The server answered neither initialize nor server/discover");
    const versions = (msg.result.supportedVersions as string[] | undefined) ?? [];
    conn.protocolVersion = versions.includes(STATELESS_VERSION)
        ? STATELESS_VERSION
        : (versions.at(-1) ?? STATELESS_VERSION);
    eraCache.set(server.entry.url!, { era: "stateless", version: conn.protocolVersion });
    const meta = (msg.result._meta ?? {}) as Record<string, unknown>;
    return {
        conn,
        result: {
            // The runtime speaks the stateful era; it gets the version it asked for, and the gateway translates.
            protocolVersion: requested,
            capabilities: msg.result.capabilities ?? {},
            serverInfo: meta["io.modelcontextprotocol/serverInfo"] ?? { name: server.id, version: "0" },
            ...(typeof msg.result.instructions === "string" ? { instructions: msg.result.instructions } : {}),
        },
    };
}

/** A synthetic entry for probing an address that is not saved yet (settings "Add by URL"). */
export function unsavedServer(id: string, entry: McpServer, owner: "user" | "global"): ResolvedServer {
    return { id, entry, owner };
}
