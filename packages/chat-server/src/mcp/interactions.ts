/**
 * Bridge from the MCP gateway to the user: elicitation forms and links, destructive-tool confirmations and progress,
 * all shown in the conversation whose runtime made the call (the `X-Chat-Conversation` header).
 *
 * Nothing waits on a user who is not there: without a running response for that conversation, elicitations are
 * cancelled and confirmations are refused. Stopping the response cancels every open request (ResponseRun).
 */
import type { FunctionCallItem, McpElicitationValue } from "@pikvm/chat-protocol";
import { mcpToolName } from "../agent/mcp-names.ts";
import type { ResponseRun } from "../agent/run.ts";
import { latestRun } from "../agent/sessions.ts";

export function runFor(userId: string, conversationId: string | undefined): ResponseRun | undefined {
    if (!conversationId) return undefined;
    const run = latestRun(userId, conversationId);
    return run && !run.done && !run.cancelRequested ? run : undefined;
}

/** The running tool call for `server`/`tool`. */
export function callFor(run: ResponseRun, server: string, tool: string): FunctionCallItem | undefined {
    const name = mcpToolName(server, tool);
    return run.findRunningCall((n) => n === name);
}

export interface ElicitParams {
    mode?: "form" | "url";
    message?: string;
    requestedSchema?: { type?: string; properties?: Record<string, Record<string, unknown>>; required?: string[] };
    url?: string;
}

export type ElicitResult = { action: "accept" | "decline" | "cancel"; content?: Record<string, McpElicitationValue> };

/**
 * Values that fit the form schema: known properties only, the declared type, enum members, string limits and required
 * fields. Undefined when they do not fit (the request is then answered as cancelled rather than sent half-valid).
 */
export function checkForm(
    schema: ElicitParams["requestedSchema"],
    content: Record<string, McpElicitationValue> | undefined,
): Record<string, McpElicitationValue> | undefined {
    const props = schema?.properties ?? {};
    const out: Record<string, McpElicitationValue> = {};
    for (const [key, value] of Object.entries(content ?? {})) {
        const p = props[key];
        if (!p) return undefined;
        const type = p.type;
        const options = (p.enum ?? (p.oneOf as { const?: unknown }[] | undefined)?.map((o) => o.const)) as
            unknown[] | undefined;
        if (type === "string") {
            if (typeof value !== "string") return undefined;
            if (typeof p.minLength === "number" && value.length < p.minLength) return undefined;
            if (typeof p.maxLength === "number" && value.length > p.maxLength) return undefined;
            if (options && !options.includes(value)) return undefined;
        } else if (type === "number" || type === "integer") {
            if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
            if (type === "integer" && !Number.isInteger(value)) return undefined;
            if (typeof p.minimum === "number" && value < p.minimum) return undefined;
            if (typeof p.maximum === "number" && value > p.maximum) return undefined;
        } else if (type === "boolean") {
            if (typeof value !== "boolean") return undefined;
        } else if (type === "array") {
            const items = p.items as { enum?: unknown[]; anyOf?: { const?: unknown }[] } | undefined;
            const allowed = items?.enum ?? items?.anyOf?.map((o) => o.const);
            if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || (allowed && !allowed.includes(v))))
                return undefined;
        } else return undefined;
        out[key] = value;
    }
    for (const key of schema?.required ?? []) if (!(key in out)) return undefined;
    return out;
}

/** Only web addresses: a server must not send the user to `javascript:`, `file:` or a data URL. */
function safeUrl(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    try {
        const u = new URL(raw);
        return u.protocol === "https:" ||
            (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
            ? u.toString()
            : undefined;
    } catch {
        return undefined;
    }
}

/** Ask the user (elicitation/create). Without a running response the request is cancelled. */
export async function elicit(
    userId: string,
    conversationId: string | undefined,
    server: string,
    tool: string | undefined,
    params: ElicitParams,
): Promise<ElicitResult> {
    const run = runFor(userId, conversationId);
    if (!run) return { action: "cancel" };
    const mode = params.mode === "url" ? "url" : "form";
    const url = mode === "url" ? safeUrl(params.url) : undefined;
    if (mode === "url" && !url) return { action: "decline" };
    const call = tool ? callFor(run, server, tool) : undefined;
    const answer = await run.requestElicitation({
        server_label: server,
        mode,
        message: String(params.message ?? "").slice(0, 4000),
        requested_schema: mode === "form" ? (params.requestedSchema as Record<string, unknown> | undefined) : undefined,
        url,
        call_id: call?.call_id,
    });
    if (answer.action !== "accept" || mode === "url") return { action: answer.action };
    const content = checkForm(params.requestedSchema, answer.content);
    return content ? { action: "accept", content } : { action: "cancel" };
}

/** Confirm a destructive tool call in the thread. False when nobody is there to answer. */
export async function confirmDestructive(
    userId: string,
    conversationId: string | undefined,
    server: string,
    tool: string,
    args: unknown,
    hints: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean; openWorld?: boolean },
): Promise<boolean> {
    const run = runFor(userId, conversationId);
    if (!run) return false;
    const call = callFor(run, server, tool);
    return run.requestGatewayApproval({
        server_label: server,
        name: tool,
        arguments: JSON.stringify(args ?? {}),
        title: `${tool} can change or delete data. Allow it?`,
        reason: "destructive",
        hints,
        call_id: call?.call_id,
    });
}

export type ApprovalDecision = "approved" | "denied" | "unavailable";

/**
 * A built-in server asks for approval of one action it judged risky, in the thread of the conversation whose call it
 * is. `unavailable` when nobody can be asked (no running response): the action is then refused, never queued.
 * `signal` abandons the question, which closes its card as cancelled.
 */
export async function askApproval(
    userId: string,
    conversationId: string | undefined,
    server: string,
    ask: {
        tool: string;
        title: string;
        summary: string;
        reasons: readonly string[];
        arguments: Readonly<Record<string, unknown>>;
        signal?: AbortSignal;
    },
): Promise<ApprovalDecision> {
    const run = runFor(userId, conversationId);
    if (!run) return "unavailable";
    const call = callFor(run, server, ask.tool);
    const approved = await run.requestGatewayApproval(
        {
            server_label: server,
            name: ask.tool,
            arguments: JSON.stringify(ask.arguments),
            title: ask.title.slice(0, 300),
            reason: "risky",
            summary: ask.summary.slice(0, 1000),
            reasons: ask.reasons.slice(0, 8).map((r) => r.slice(0, 200)),
            call_id: call?.call_id,
        },
        ask.signal,
    );
    return approved ? "approved" : "denied";
}

/** Relay MCP progress onto the running tool row. */
export function progress(
    userId: string,
    conversationId: string | undefined,
    server: string,
    tool: string,
    value: number,
    total?: number,
    message?: string,
): void {
    const run = runFor(userId, conversationId);
    if (!run) return;
    const call = callFor(run, server, tool);
    if (call) run.toolProgress(call.id, value, total, message?.slice(0, 300));
}
