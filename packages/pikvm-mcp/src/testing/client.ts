import type { JsonRpcRequest, JsonRpcResponse, McpCaller, PikvmMcp } from "../handler";
import type { ToolBlock } from "../tools";

/**
 * A small MCP client for tests: initialize, list tools, call one, read the answer as text and image.
 * It talks to the handler in process, or to a URL over HTTP (the host's agent surface), by the same calls.
 */

export type Transport = (message: JsonRpcRequest) => Promise<JsonRpcResponse | undefined>;

export interface CallResult {
    readonly isError: boolean;
    readonly content: readonly ToolBlock[];
    /** All text blocks joined. */
    readonly text: string;
    /** The first image block, if any. */
    readonly image: { readonly data: string; readonly mimeType: string } | undefined;
}

export interface TestClient {
    initialize(): Promise<Record<string, unknown>>;
    listTools(): Promise<{ name: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> }[]>;
    /** Call a tool. A protocol error (an unknown tool, a bad request) throws; a tool failure is an isError result. */
    call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
    /** Any request, for the protocol-level cases. */
    request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse | undefined>;
}

export function inProcessTransport(mcp: PikvmMcp, caller: McpCaller): Transport {
    return (message) => mcp.handle(caller, message);
}

/** POST each message as JSON, as omp does. A 202 is a notification with no body. */
export function httpTransport(url: string, headers: Record<string, string>): Transport {
    return async (message) => {
        const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
            body: JSON.stringify(message),
        });
        if (response.status === 202) return undefined;
        return (await response.json()) as JsonRpcResponse;
    };
}

export function createTestClient(transport: Transport): TestClient {
    let id = 0;
    const request: TestClient["request"] = (method, params) =>
        transport({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) });
    const need = async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const response = await request(method, params);
        if (!response) throw new Error(`${method} got no response`);
        if (response.error) throw new Error(`${method}: ${response.error.code} ${response.error.message}`);
        return response.result as Record<string, unknown>;
    };
    return {
        request,
        async initialize() {
            const result = await need("initialize", {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "test", version: "0" },
            });
            await transport({ jsonrpc: "2.0", method: "notifications/initialized" });
            return result;
        },
        async listTools() {
            return (await need("tools/list")).tools as Awaited<ReturnType<TestClient["listTools"]>>;
        },
        async call(name, args) {
            const result = await need("tools/call", { name, arguments: args ?? {} });
            const content = result.content as ToolBlock[];
            const image = content.find((b) => b.type === "image");
            return {
                isError: result.isError === true,
                content,
                text: content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"),
                image: image && image.type === "image" ? { data: image.data, mimeType: image.mimeType } : undefined,
            };
        },
    };
}
