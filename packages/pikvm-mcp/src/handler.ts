import { assess, describeCall, needsApproval } from "./risk";
import { tools, type Tool, type ToolBlock } from "./tools";
import {
    DeskError,
    defaultPolicy,
    type ApprovalDecision,
    type Approver,
    type Desk,
    type DeskSession,
    type PikvmPolicy,
} from "./types";

/**
 * The MCP request handler: the JSON-RPC methods of a tools-only server, in the stateless
 * streamable-HTTP style (every POST one message, answered with one JSON body).
 *
 * It does not authenticate and does not listen. The host's agent surface checks the bearer token,
 * reads the `X-Chat-Conversation` header and hands the conversation id in; this decides what
 * the call means.
 */

export const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface JsonRpcRequest {
    readonly jsonrpc: "2.0";
    readonly id?: string | number | null;
    readonly method: string;
    readonly params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
    readonly jsonrpc: "2.0";
    readonly id: string | number | null;
    readonly result?: unknown;
    readonly error?: { readonly code: number; readonly message: string };
}

export interface McpCaller {
    /** From `X-Chat-Conversation`. Without it the desk tools refuse: control belongs to a conversation. */
    readonly conversationId: string | undefined;
    /** Aborts when the HTTP request does. */
    readonly signal?: AbortSignal;
}

export interface PikvmMcpOptions {
    readonly desk: Desk;
    readonly approver: Approver;
    /** Read on every call, so a change in Settings applies to the next one. */
    readonly policy?: () => PikvmPolicy;
    readonly version?: string;
    /** Told about anything that is not a DeskError. The model only sees "failed unexpectedly", so the host must log it. */
    readonly onError?: (error: unknown) => void;
}

export interface PikvmMcp {
    /** Answer one request; undefined for a notification, which has no reply. */
    handle(caller: McpCaller, message: JsonRpcRequest): Promise<JsonRpcResponse | undefined>;
}

const INSTRUCTIONS = [
    "You drive a remote computer through a PiKVM: you see its screen and press its keys and mouse.",
    "Start with `screenshot`. Every coordinate you send is a pixel of that screenshot, never of a zoom or of the real screen.",
    "After any action that may change the screen, take another screenshot before the next one. Do not guess where things are.",
    "If a result says control_released, a person took over the mouse or keyboard: stop, and ask them to hand control back. Do not try again.",
    "If a result says approval_denied, the person said no: do not repeat the same action.",
].join("\n");

const rpcResult = (message: JsonRpcRequest, result: unknown): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id: message.id ?? null,
    result,
});
const rpcError = (message: JsonRpcRequest, code: number, text: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id: message.id ?? null,
    error: { code, message: text },
});

function failure(error: DeskError): { content: ToolBlock[]; isError: true } {
    return { content: [{ type: "text", text: `${error.code}: ${error.message}` }], isError: true };
}

/** The reason a released session carries: the DeskError control_released, or a plain abort. */
function abortError(signal: AbortSignal): DeskError | null {
    return signal.reason instanceof DeskError ? signal.reason : null;
}

function defaultOnError(error: unknown): void {
    console.error("[pikvm-mcp]", error);
}

export function createPikvmMcp(options: PikvmMcpOptions): PikvmMcp {
    const policy = options.policy ?? (() => defaultPolicy);
    const version = options.version ?? "0.0.0";

    const advertised = (): Tool[] => tools.filter((t) => t.enabled(policy()));

    async function ask(tool: Tool, args: Readonly<Record<string, unknown>>, session: DeskSession): Promise<void> {
        const risk = assess(tool.name, args, { lookAgeMs: session.lookAgeMs });
        if (!needsApproval(risk, policy().approval)) return;
        const { title, summary } = describeCall(tool.name, args);
        options.desk.approving?.(session, tool.name, true);
        let decision: ApprovalDecision;
        try {
            decision = await options.approver.ask({
                conversationId: session.conversationId,
                tool: tool.name,
                title,
                summary,
                reasons: risk.reasons,
                arguments: args,
                signal: session.signal,
            });
        } finally {
            options.desk.approving?.(session, tool.name, false);
        }
        // Control may have ended while the person was deciding; that outranks their answer.
        const released = abortError(session.signal);
        if (released) throw released;
        if (decision === "approved") return;
        throw new DeskError(
            "approval_denied",
            decision === "unavailable"
                ? "Nobody could be asked to approve this, so it was not done. Do not retry it; ask the person in your reply."
                : "The person declined this action. Do not retry the same action; ask them what they would prefer.",
        );
    }

    async function callTool(caller: McpCaller, name: string, rawArgs: unknown): Promise<{ content: ToolBlock[]; isError?: true }> {
        const tool = advertised().find((t) => t.name === name) ?? undefined;
        if (!tool) throw new DeskError("invalid_arguments", `there is no tool named ${name}`);
        try {
            const args = tool.parse(rawArgs);
            if (!caller.conversationId) {
                throw new DeskError("no_conversation", "this tool works inside a conversation, and none was named");
            }
            const session = await options.desk.open(
                { conversationId: caller.conversationId, signal: caller.signal ?? new AbortController().signal },
                tool.intent,
            );
            await ask(tool, args, session);
            return { content: await tool.run(options.desk, session, args) };
        } catch (error) {
            if (error instanceof DeskError) return failure(error);
            throw error;
        }
    }

    return {
        async handle(caller, message) {
            if (message.id === undefined) return undefined;
            switch (message.method) {
                case "initialize": {
                    const asked = message.params?.["protocolVersion"];
                    const protocolVersion = SUPPORTED_PROTOCOLS.find((v) => v === asked) ?? SUPPORTED_PROTOCOLS[0];
                    return rpcResult(message, {
                        protocolVersion,
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: { name: "pikvm", title: "PiKVM computer use", version },
                        instructions: INSTRUCTIONS,
                    });
                }
                case "ping":
                    return rpcResult(message, {});
                case "tools/list":
                    return rpcResult(message, {
                        tools: advertised().map((t) => ({
                            name: t.name,
                            title: t.title,
                            description: t.description,
                            inputSchema: t.inputSchema,
                            annotations: t.annotations,
                        })),
                    });
                case "tools/call": {
                    const name = message.params?.["name"];
                    if (typeof name !== "string") return rpcError(message, -32602, "tools/call needs a tool name");
                    try {
                        return rpcResult(message, await callTool(caller, name, message.params?.["arguments"]));
                    } catch (error) {
                        if (error instanceof DeskError) return rpcError(message, -32602, error.message);
                        // -32800 is MCP's "request cancelled"; the agent that cancelled it is not listening anyway.
                        if (caller.signal?.aborted) return rpcError(message, -32800, "the request was cancelled");
                        (options.onError ?? defaultOnError)(error);
                        return rpcError(message, -32603, "the PiKVM tool failed unexpectedly");
                    }
                }
                default:
                    return rpcError(message, -32601, `method not found: ${message.method}`);
            }
        },
    };
}

