import { assess, describeCall, FREE_TOOLS, needsApproval } from "./risk";
import { tools, type Tool, type ToolBlock, type ToolOutput } from "./tools";
import {
    DeskError,
    FRAME_META_KEY,
    defaultPolicy,
    type ApprovalDecision,
    type Approver,
    type Desk,
    type DeskSession,
    type FrameRef,
    type FrameSink,
    type PikvmPolicy,
    type Judge,
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

/** A tool result as the MCP `tools/call` reply carries it. */
interface ToolResult {
    content: ToolBlock[];
    isError?: true;
    _meta?: Record<string, unknown>;
}

/** The tools whose arguments are a pixel of the latest screenshot. */
const POINTER_TOOLS: ReadonlySet<string> = new Set(["click", "mouse_move", "drag", "scroll"]);

/** Conversations whose latest frame is remembered; the oldest is forgotten past this. */
const MAX_REMEMBERED = 64;

export interface McpCaller {
    /** From `X-Chat-Conversation`. Without it the desk tools refuse: control belongs to a conversation. */
    readonly conversationId: string | undefined;
    /** Aborts when the HTTP request does. */
    readonly signal?: AbortSignal;
    /** Where this conversation's screenshots are kept for the person to see; none when the host keeps nothing. */
    readonly frames?: FrameSink;
}

export interface PikvmMcpOptions {
    readonly desk: Desk;
    readonly approver: Approver;
    /** Additional checks for smart mode. Absence requires approval for unreviewed input. */
    readonly judge?: Judge;
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
    "To wait for something to appear (a notification, a message, a finished build), use `watch_screen` with a yes/no question instead of taking screenshots in a loop.",
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

    /** Each conversation's latest whole-screen frame: the picture a pointer tool's coordinates refer to. Bounded, oldest out. */
    const reference = new Map<string, FrameRef>();

    /**
     * The frame a result names. A screenshot's is the picture it took, kept through the caller's sink; a zoom is kept
     * too but is not a frame coordinates refer to. A pointer tool's is the latest whole-screen frame, so the person
     * sees where the agent clicked on what it was looking at.
     */
    function frameOf(caller: McpCaller, tool: Tool, out: ToolOutput): FrameRef | undefined {
        const conversationId = caller.conversationId;
        if (!conversationId) return undefined;
        if (out.shot) {
            const { jpeg, width, height, region } = out.shot;
            const ref = caller.frames?.save(jpeg, { width, height });
            if (ref && !region) {
                reference.delete(conversationId);
                reference.set(conversationId, ref);
                if (reference.size > MAX_REMEMBERED) reference.delete(reference.keys().next().value!);
            }
            return ref;
        }
        return POINTER_TOOLS.has(tool.name) ? reference.get(conversationId) : undefined;
    }

    async function ask(tool: Tool, args: Readonly<Record<string, unknown>>, session: DeskSession): Promise<void> {
        const currentPolicy = policy();
        const risk = assess(tool.name, args, { lookAgeMs: session.lookAgeMs });
        const reasons = [...risk.reasons];
        let required = needsApproval(risk, currentPolicy.approval);
        if (currentPolicy.approval === "smart" && risk.level !== "observe" && !FREE_TOOLS.has(tool.name)) {
            // Fixed risks cannot be cleared by a model, and their arguments do not need to reach a provider.
            if (!required) {
                try {
                    const verdict = await options.judge?.review({
                        tool: tool.name,
                        args,
                        screenText: async () => currentPolicy.ocr ? options.desk.readText(session) : undefined,
                        textAround: async (point) => {
                            if (!currentPolicy.ocr) return undefined;
                            const { reference } = await options.desk.info(session);
                            if (!reference) return undefined;
                            const x = Math.max(0, point.x - 100);
                            const y = Math.max(0, point.y - 30);
                            const width = Math.min(200, reference.width - x);
                            const height = Math.min(60, reference.height - y);
                            if (width <= 0 || height <= 0) return undefined;
                            return options.desk.readText(session, { x, y, width, height });
                        },
                    }, session.signal);
                    if (verdict?.guidance) throw new DeskError("try_another_way", verdict.guidance);
                    required = verdict?.ask !== false;
                    reasons.push(...(verdict?.reasons ?? ["the action could not be reviewed"]));
                } catch (error) {
                    if (error instanceof DeskError && error.code === "try_another_way") throw error;
                    session.signal.throwIfAborted();
                    required = true;
                    reasons.push("the action review failed");
                }
            }
        }
        if (!required) return;
        session.signal.throwIfAborted();
        const { title, summary } = describeCall(tool.name, args);
        options.desk.approving?.(session, tool.name, true);
        let decision: ApprovalDecision;
        try {
            decision = await options.approver.ask({
                conversationId: session.conversationId,
                tool: tool.name,
                title,
                summary,
                reasons,
                arguments: args,
                signal: session.signal,
            });
        } finally {
            options.desk.approving?.(session, tool.name, false);
        }
        // Control may have ended while the person was deciding; that outranks their answer.
        const released = abortError(session.signal);
        if (released) throw released;
        session.signal.throwIfAborted();
        if (decision === "approved") return;
        throw new DeskError(
            "approval_denied",
            decision === "unavailable"
                ? "Nobody could be asked to approve this, so it was not done. Do not retry it; ask the person in your reply."
                : "The person declined this action. Do not retry the same action; ask them what they would prefer.",
        );
    }

    async function callTool(caller: McpCaller, name: string, rawArgs: unknown): Promise<ToolResult> {
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
            const out = await tool.run(options.desk, session, args);
            const frame = frameOf(caller, tool, out);
            return { content: out.content, ...(frame ? { _meta: { [FRAME_META_KEY]: frame } } : {}) };
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

