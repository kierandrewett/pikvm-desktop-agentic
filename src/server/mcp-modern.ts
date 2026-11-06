/**
 * The MCP endpoint's two eras (specification 2026-07-28, "Versioning and Compatibility"). A client that opens with an `initialize`
 * handshake gets the legacy behaviour (packages/pikvm-mcp, versions 2025-11-25 and earlier). A client whose request carries
 * `_meta["io.modelcontextprotocol/protocolVersion"]` is modern: there is no handshake, every request names its version, and the
 * HTTP headers `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` must match the body. This module judges a modern request
 * and says what to answer; it does not run a tool. The host's `mcp` method (chat/index.ts) does that, in the legacy shape, and the
 * result is given the modern wrapper (`resultType`, and the cache hints a list may carry).
 *
 * What is NOT done, on purpose: `subscriptions/listen` and server-initiated input (MRTR), because this server sends neither a list
 * change nor a question to the client. Its capabilities say so (tools only, no `listChanged`). Resources, prompts and logging are not
 * offered, so those methods answer -32601 as the specification asks.
 */

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const SUPPORTED_VERSIONS: readonly string[] = [MODERN_VERSION, ...LEGACY_VERSIONS];

const META = "io.modelcontextprotocol/protocolVersion";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** How long a client may keep the tool list: it only changes with a new build of this server. */
const LIST_TTL_MS = 300_000;

export type Verdict =
    /** Not modern: the legacy path takes it. */
    | { kind: "legacy" }
    /** Answer this and stop. */
    | { kind: "answer"; status: number; body: unknown }
    /** Run the request as the legacy handler would, then wrap the result. */
    | { kind: "run"; message: Json; wrap(reply: unknown): unknown };

const error = (id: unknown, code: number, message: string, data?: unknown): Json => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });

/** `Mcp-Name` may carry a name as `=?base64?...?=` when it is not plain ASCII. */
function decodeName(raw: string): string | undefined {
    const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(raw);
    if (!m) return raw;
    try {
        return Buffer.from(m[1]!, "base64").toString("utf-8");
    } catch {
        return undefined;
    }
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export interface Describe {
    /** The legacy `initialize` answer's capabilities, serverInfo and instructions: one source for what the server is. */
    capabilities: unknown;
    serverInfo: unknown;
    instructions: unknown;
}

export function judgeModern(message: unknown, headers: Record<string, string | string[] | undefined>, describe: () => Promise<Describe>): Verdict | Promise<Verdict> {
    if (!isObject(message)) return { kind: "legacy" };
    const params = isObject(message.params) ? message.params : undefined;
    const meta = params && isObject(params._meta) ? params._meta : undefined;
    const version = meta?.[META];
    const header = one(headers["mcp-protocol-version"]);
    if (typeof version !== "string") {
        // The header alone names the modern version, with nothing in the body to match it: the body and the header disagree.
        if (header === MODERN_VERSION && message.method !== "initialize") {
            return { kind: "answer", status: 400, body: error(message.id, -32020, `Header mismatch: the request names ${MODERN_VERSION} in its header and carries no ${META} in its body`) };
        }
        return { kind: "legacy" };
    }
    const id = message.id;
    if (header !== version) {
        return { kind: "answer", status: 400, body: error(id, -32020, `Header mismatch: MCP-Protocol-Version is ${header === undefined ? "missing" : `'${header.slice(0, 20)}'`} and the body says '${version.slice(0, 20)}'`) };
    }
    if (version !== MODERN_VERSION) {
        return { kind: "answer", status: 400, body: error(id, -32022, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested: version.slice(0, 40) }) };
    }
    const method = message.method;
    if (typeof method !== "string") return { kind: "answer", status: 400, body: error(id, -32600, "Invalid request") };
    const methodHeader = one(headers["mcp-method"]);
    if (methodHeader !== method) {
        return { kind: "answer", status: 400, body: error(id, -32020, `Header mismatch: Mcp-Method is ${methodHeader === undefined ? "missing" : `'${methodHeader.slice(0, 40)}'`} and the body says '${method.slice(0, 40)}'`) };
    }
    // A notification has no reply and nothing to run in this era.
    if (message.id === undefined) return { kind: "answer", status: 202, body: undefined };
    const named = method === "tools/call" ? params?.name : undefined;
    if (method === "tools/call") {
        const nameHeader = one(headers["mcp-name"]);
        const decoded = nameHeader === undefined ? undefined : decodeName(nameHeader);
        if (typeof named !== "string" || decoded !== named) {
            return { kind: "answer", status: 400, body: error(id, -32020, "Header mismatch: Mcp-Name does not match the tool named in the body") };
        }
    }

    const complete = (result: unknown): unknown => ({ resultType: "complete", ...(isObject(result) ? result : {}) });
    const wrapped =
        (extra: Json = {}) =>
        (reply: unknown): unknown => {
            if (!isObject(reply) || !("result" in reply)) return reply;
            return { ...reply, result: { ...(complete(reply.result) as Json), ...extra } };
        };

    if (method === "ping") return { kind: "answer", status: 200, body: { jsonrpc: "2.0", id, result: { resultType: "complete" } } };
    if (method === "server/discover") {
        return describe().then((d) => ({
            kind: "answer" as const,
            status: 200,
            body: {
                jsonrpc: "2.0",
                id,
                result: {
                    resultType: "complete",
                    supportedVersions: [MODERN_VERSION],
                    capabilities: d.capabilities,
                    _meta: { "io.modelcontextprotocol/serverInfo": d.serverInfo },
                    ...(typeof d.instructions === "string" ? { instructions: d.instructions } : {}),
                    ttlMs: 3_600_000,
                    cacheScope: "public",
                },
            },
        }));
    }
    if (method === "tools/list" || method === "tools/call") {
        // Strip the era's metadata before the legacy handler sees the request; it knows nothing of it.
        const { _meta: _drop, ...rest } = params ?? {};
        void _drop;
        return { kind: "run", message: { ...message, params: rest }, wrap: wrapped(method === "tools/list" ? { ttlMs: LIST_TTL_MS, cacheScope: "public" } : {}) };
    }
    return { kind: "answer", status: 404, body: error(id, -32601, "Method not found") };
}
