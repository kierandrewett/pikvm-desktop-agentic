/**
 * Probe a remote MCP server from the Chat server (settings "Test connection"): initialize, then list its tools.
 *
 * Transports follow the MCP spec (2025-11-25):
 * - Streamable HTTP first: POST `initialize` to the URL, JSON or SSE response, `mcp-session-id` kept.
 * - Legacy HTTP+SSE when the entry says `sse`, or when the POST answers 400, 404 or 405: GET the URL as an event
 *   stream, wait for the `endpoint` event, POST requests there and read the answers from the stream.
 * A 401 with a Bearer challenge reports `auth: "oauth"` so the UI can say the server wants a sign-in.
 *
 * The whole probe has one deadline (the entry's timeout, clamped to 3-60 s, default 15 s). Tool lists are followed
 * through `nextCursor` up to MAX_PAGES and capped at MAX_TOOLS for the browser.
 */
import type { McpServer, McpTestResult, McpToolSummary } from "@pikvm/chat-protocol";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TOOLS = 1000;
const MAX_PAGES = 20;
const MAX_DESCRIPTION = 1000;
const PROTOCOL_VERSION = "2025-06-18";

interface RawTool {
    name?: unknown;
    description?: unknown;
    annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
}

interface Rpc {
    call(method: string, params: unknown): Promise<any>;
    notify(method: string): Promise<void>;
    close(): void;
}

class ProbeError extends Error {
    constructor(
        message: string,
        readonly status?: number,
        readonly challenge?: string,
    ) {
        super(message);
    }
}

export function probeTimeout(server: McpServer): number {
    const t = server.timeout ?? 0;
    return t > 0 ? Math.min(60_000, Math.max(3_000, t)) : DEFAULT_TIMEOUT_MS;
}

const baseHeaders = (headers: Record<string, string>) => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    ...headers,
});

/** Server-sent events from a response body, one `{ event, data }` per blank-line-terminated block. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let event = "message";
    let data: string[] = [];
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl).replace(/\r$/, "");
                buffer = buffer.slice(nl + 1);
                if (line === "") {
                    if (data.length) yield { event, data: data.join("\n") };
                    event = "message";
                    data = [];
                } else if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            }
        }
    } finally {
        reader.releaseLock();
    }
}

function rpcResult(msg: { result?: unknown; error?: { message?: string } }): unknown {
    if (msg.error) throw new ProbeError(msg.error.message ?? "The server returned an error");
    return msg.result;
}

async function failure(res: Response): Promise<ProbeError> {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    return new ProbeError(
        `HTTP ${res.status}${text ? `: ${text}` : ""}`,
        res.status,
        res.headers.get("www-authenticate") ?? undefined,
    );
}

/** Streamable HTTP: every request is a POST; the answer is JSON or an SSE stream that carries it. */
function streamable(url: string, headers: Record<string, string>, signal: AbortSignal): Rpc {
    let session: string | undefined;
    let next = 1;
    const post = (body: unknown) =>
        fetch(url, {
            method: "POST",
            headers: { ...baseHeaders(headers), ...(session ? { "mcp-session-id": session } : {}) },
            body: JSON.stringify(body),
            signal,
        });
    return {
        async call(method, params) {
            const id = next++;
            const res = await post({ jsonrpc: "2.0", id, method, params });
            if (!res.ok) throw await failure(res);
            session = res.headers.get("mcp-session-id") ?? session;
            if (!res.headers.get("content-type")?.includes("text/event-stream"))
                return rpcResult((await res.json()) as never);
            for await (const e of events(res.body!)) {
                const msg = JSON.parse(e.data) as { id?: unknown };
                if (msg.id === id) return rpcResult(msg as never);
            }
            throw new ProbeError("The server closed the stream without an answer");
        },
        async notify(method) {
            await post({ jsonrpc: "2.0", method })
                .then((r) => r.body?.cancel())
                .catch(() => undefined);
        },
        close() {},
    };
}

/** Legacy HTTP+SSE: one long GET stream for answers, requests POSTed to the endpoint it announces. */
async function legacySse(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Rpc> {
    const stop = new AbortController();
    const both = AbortSignal.any([signal, stop.signal]);
    const res = await fetch(url, { headers: { accept: "text/event-stream", ...headers }, signal: both });
    if (!res.ok) throw await failure(res);
    if (!res.headers.get("content-type")?.includes("text/event-stream")) {
        await res.body?.cancel();
        throw new ProbeError("This URL does not answer as an MCP server. Check the address, including the path.");
    }
    const stream = events(res.body!);
    const first = await stream.next();
    if (first.done || first.value.event !== "endpoint")
        throw new ProbeError("The SSE stream did not announce an endpoint");
    const endpoint = new URL(first.value.data.trim(), url).toString();
    const waiting = new Map<unknown, (msg: never) => void>();
    void (async () => {
        try {
            for await (const e of stream) {
                if (e.event !== "message") continue;
                const msg = JSON.parse(e.data) as { id?: unknown };
                waiting.get(msg.id)?.(msg as never);
            }
        } catch {
            // Aborted on close or deadline; pending calls fail through the signal.
        }
    })();
    let next = 1;
    const post = async (body: unknown) => {
        const r = await fetch(endpoint, {
            method: "POST",
            headers: baseHeaders(headers),
            body: JSON.stringify(body),
            signal: both,
        });
        if (!r.ok) throw await failure(r);
        await r.body?.cancel();
    };
    return {
        async call(method, params) {
            const id = next++;
            const answer = new Promise<never>((resolve, reject) => {
                waiting.set(id, resolve);
                both.addEventListener("abort", () => reject(new ProbeError("aborted")), { once: true });
            });
            await post({ jsonrpc: "2.0", id, method, params });
            return rpcResult(await answer);
        },
        notify: (method) => post({ jsonrpc: "2.0", method }).catch(() => undefined),
        close: () => stop.abort(),
    };
}

function summarise(raw: RawTool[]): McpToolSummary[] {
    return raw
        .filter((t): t is RawTool & { name: string } => typeof t.name === "string" && t.name.length > 0)
        .map((t) => ({
            name: t.name,
            description: typeof t.description === "string" ? t.description.slice(0, MAX_DESCRIPTION) : undefined,
            readOnly: t.annotations?.readOnlyHint === true ? true : undefined,
            destructive: t.annotations?.destructiveHint === true ? true : undefined,
        }));
}

async function session(rpc: Rpc, transport: "http" | "sse", started: number): Promise<McpTestResult> {
    try {
        const init = (await rpc.call("initialize", {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "chat-settings", version: "1.0.0" },
        })) as { serverInfo?: { name?: string; version?: string } } | undefined;
        await rpc.notify("notifications/initialized");
        const raw: RawTool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            const list = (await rpc.call("tools/list", cursor ? { cursor } : {})) as
                { tools?: RawTool[]; nextCursor?: string } | undefined;
            raw.push(...(list?.tools ?? []));
            cursor = list?.nextCursor;
            if (!cursor || raw.length > MAX_TOOLS) break;
        }
        const tools = summarise(raw);
        return {
            ok: true,
            latencyMs: Math.round(performance.now() - started),
            serverName: init?.serverInfo?.name,
            serverVersion: init?.serverInfo?.version,
            transport,
            tools: tools.slice(0, MAX_TOOLS),
            truncated: tools.length > MAX_TOOLS ? tools.length - MAX_TOOLS : undefined,
        };
    } finally {
        rpc.close();
    }
}

/** Connect to an http or sse entry and list its tools. Never throws; a failure is `ok: false` with a reason. */
export async function probeRemote(server: McpServer): Promise<McpTestResult> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    if (server.type === "stdio" || !server.url) {
        return {
            ok: false,
            latencyMs: 0,
            tools: [],
            error: "Command servers start in your sandbox, so they are checked after saving",
        };
    }
    const timeout = probeTimeout(server);
    const deadline = AbortSignal.timeout(timeout);
    const headers = server.headers ?? {};
    try {
        if (server.type === "sse") return await session(await legacySse(server.url, headers, deadline), "sse", started);
        try {
            return await session(streamable(server.url, headers, deadline), "http", started);
        } catch (err) {
            // Spec fallback: an old HTTP+SSE server rejects the POST; try its event stream before giving up.
            if (err instanceof ProbeError && [400, 404, 405].includes(err.status ?? 0)) {
                try {
                    return await session(await legacySse(server.url, headers, deadline), "sse", started);
                } catch {
                    throw err;
                }
            }
            throw err;
        }
    } catch (err) {
        if (deadline.aborted) {
            return { ok: false, latencyMs: elapsed(), tools: [], error: `No answer after ${timeout / 1000} s` };
        }
        const e = err instanceof ProbeError ? err : new ProbeError((err as Error).message);
        const bearer = e.status === 401 && /^\s*bearer\b/i.test(e.challenge ?? "");
        const signedIn = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
        const oauth = bearer && (/resource_metadata=/i.test(e.challenge ?? "") || !signedIn);
        return {
            ok: false,
            latencyMs: elapsed(),
            tools: [],
            auth: oauth ? "oauth" : undefined,
            error: e.message,
        };
    }
}
