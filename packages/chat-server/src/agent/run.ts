/**
 * One response: translates the runtime's event stream for a single prompt into a Responses object
 * and Responses-style events.
 *
 * The runtime sends the full partial message on every update; only deltas are forwarded. If a block
 * ends with more text than was streamed (fast providers sometimes skip deltas), the remainder is
 * emitted as one delta before `*.done`, so clients can always rebuild text from deltas.
 *
 * A response that does not complete (failed, stopped, cut off) ends with a `chat.run_end` item, emitted
 * before the terminal event, so the thread can say why it ended. History derives the same note from the
 * session file (conversations/history.ts `runEndOf`).
 *
 * The run ends on the first of: a terminal `agent_end`; the runtime's `prompt_result` for this prompt; a
 * `session_settled` after a non-terminal `agent_end` whose continuation never came; or the session
 * manager ending it (process exit, stop escalation).
 */
import type {
    ApprovalRequestItem,
    AskRequestItem,
    AskResponseItem,
    FunctionCallItem,
    FunctionCallOutputItem,
    McpElicitationItem,
    McpElicitationResponseItem,
    MessageItem,
    OutputItem,
    OutputText,
    ReasoningItem,
    ResponseObject,
    RunEndItem,
    ServerEvent,
    SourceRef,
    SubagentRun,
    TodoPhase,
    Usage,
} from "@pikvm/chat-protocol";
import { basename, dirname, join } from "node:path";
import { uuidv7 } from "../ids.ts";
import { cleanErrorMessage, runEndOf, STOPPED_BY_USER, withChildSteps, type RunEnd } from "../conversations/history.ts";
import { citationsFor, rememberSources, sourcesFromResult } from "./citations.ts";
import { closedByRuntime, questionItem, settleFromResponse, type Settled } from "./questions.ts";
import type { Frame, UiAnswer, UiRequest } from "./rpc.ts";
import { sourcesOfRuns, SubagentTracker } from "./subagents.ts";
import { contextTokens, type ModelUsage } from "./context-usage.ts";
import { toolFacts } from "./tool-facts.ts";
import { todosFromResult } from "./todos.ts";

type Emit = (event: ServerEvent) => void;
type Payload = ServerEvent extends infer E ? (E extends unknown ? Omit<E, "sequence_number"> : never) : never;

interface AssistantEvent {
    type: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
    toolCall?: { id: string; name: string; arguments: unknown };
    partial?: { content?: { type: string; id?: string; name?: string }[] };
    reason?: string;
    error?: { errorMessage?: string };
}

type EndMessage = { role: string; stopReason?: string; errorMessage?: string };

export { STOPPED_BY_USER };
export const AGENT_EXITED: RunEnd = {
    status: "failed",
    code: "agent_exited",
    message: "The agent stopped unexpectedly.",
};
/** Stopped before the prompt was sent: the user's message is not in the session file. */
export const STOPPED_BEFORE_SEND: RunEnd = {
    status: "cancelled",
    code: "stopped_before_send",
    message: "You stopped this response before your message was sent, so it was not kept.",
};
/** The response reached `policy.agent.maxResponseMinutes` and the server stopped it. */
export function timeLimitEnd(minutes: number): RunEnd {
    return {
        status: "cancelled",
        code: "time_limit",
        message: `This response reached the ${minutes}-minute limit set by your administrator, so it was stopped.`,
    };
}
/** The server stopped the process (conversation deleted, user banned, shutdown). */
export const SERVER_STOPPED: RunEnd = {
    status: "cancelled",
    code: "server_stopped",
    message: "The server stopped this response.",
};

const textOfResult = (r: unknown): string => {
    const content = (r as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [];
    return content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
};

export class ResponseRun {
    readonly response: ResponseObject;
    readonly startedAt = Date.now();
    #seq = 0;
    #n = 0;
    /** contentIndex -> output index, for the assistant message currently streaming. */
    #blocks = new Map<number, number>();
    #streamed = new Map<number, number>();
    #toolCalls = new Map<string, number>();
    #toolOutputs = new Map<string, number>();
    #approvals = new Map<string, (answer: UiAnswer) => void>();
    /** Open questions by item id; `uiId` is the runtime's request id (its `cancel` frames name it). */
    #questions = new Map<
        string,
        {
            uiId: string;
            settle: (s: Settled | { outcome: "cancelled" | "timed_out"; answers?: AskRequestItem["answers"] }) => void;
        }
    >();
    /** Web sources found by tools in this response, for `url_citation` annotations. */
    #sources = new Map<string, SourceRef>();
    /** Live subagent state per `task` call id. */
    #tasks = new Map<string, SubagentTracker>();
    /**
     * Host directory of this conversation's session files. Set by the session manager; lets a finished
     * `task` read each subagent's own session for its full list of steps.
     */
    conversationDir?: string;
    /** RPC id of this run's `prompt` command: its `prompt_result` frame carries it. */
    promptId?: string;
    #cancelRequested = false;
    /** Why the stop was requested: the user, or a server limit (`TIME_LIMIT`). Replaces STOPPED_BY_USER in `finish`. */
    #stopReason: RunEnd = STOPPED_BY_USER;
    /** The runtime started a turn for this prompt (`agent_start`): the user's message is in the session file. */
    #agentStarted = false;
    /** Messages of the latest `agent_end`, terminal or not. */
    #lastMessages?: EndMessage[];
    /** A model error seen while streaming (the `error` assistant event). */
    #streamError?: string;
    #usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    #done = false;
    #finished!: () => void;
    readonly finished = new Promise<void>((r) => (this.#finished = r));

    constructor(
        conversationId: string,
        model: string,
        private readonly emitRaw: Emit,
        readonly streamId?: string,
    ) {
        this.response = {
            id: `resp_${uuidv7().replaceAll("-", "")}`,
            object: "response",
            created_at: Math.floor(this.startedAt / 1000),
            status: "in_progress",
            model,
            conversation: { id: conversationId },
            output: [],
            error: null,
        };
    }

    get done(): boolean {
        return this.#done;
    }

    get cancelRequested(): boolean {
        return this.#cancelRequested;
    }

    /**
     * The user asked to stop. Closes open approvals and questions (the runtime cannot abort while it
     * waits on one). False when a stop was already requested or the run is over.
     */
    requestCancel(reason: RunEnd = STOPPED_BY_USER): boolean {
        if (this.#done || this.#cancelRequested) return false;
        this.#cancelRequested = true;
        this.#stopReason = reason;
        this.cancelApprovals();
        this.cancelQuestions();
        return true;
    }

    #stamp(e: Payload, seq: number): ServerEvent {
        return { ...e, sequence_number: seq, ...(this.streamId ? { stream_id: this.streamId } : {}) } as ServerEvent;
    }

    #emit(e: Payload): void {
        this.emitRaw(this.#stamp(e, ++this.#seq));
    }

    /**
     * The response's state for a client that (re)connects: `response.in_progress` while it runs, else its
     * terminal event. Carries the sequence number of the last event sent, so it does not take a new one.
     */
    current(): ServerEvent {
        const type = this.#done ? (`response.${this.response.status}` as "response.completed") : "response.in_progress";
        return this.#stamp({ type, response: this.snapshot() }, this.#seq);
    }

    start(): void {
        this.#emit({ type: "response.created", response: this.snapshot() });
        this.#emit({ type: "response.in_progress", response: this.snapshot() });
    }

    snapshot(): ResponseObject {
        return { ...this.response, output: [...this.response.output], duration_ms: Date.now() - this.startedAt };
    }

    #nextId(): string {
        return `${this.response.id}_${++this.#n}`;
    }

    #add<T extends OutputItem>(item: T): number {
        const index = this.response.output.push(item) - 1;
        this.#emit({ type: "response.output_item.added", response_id: this.response.id, output_index: index, item });
        return index;
    }

    #doneItem(index: number): void {
        const item = this.response.output[index]!;
        if ("status" in item) (item as { status: string }).status = "completed";
        this.#emit({ type: "response.output_item.done", response_id: this.response.id, output_index: index, item });
    }

    /** Feed one runtime event. */
    handle(f: Frame): void {
        if (this.#done) return;
        switch (f.type) {
            case "agent_start":
                this.#agentStarted = true;
                return;
            case "message_start":
                if ((f.message as { role?: string })?.role === "assistant") {
                    this.#blocks.clear();
                    this.#streamed.clear();
                }
                return;
            case "message_update":
                this.#assistantEvent(f.assistantMessageEvent as AssistantEvent);
                return;
            case "message_end": {
                const m = f.message as {
                    role?: string;
                    usage?: ModelUsage;
                };
                if (m?.role === "assistant" && m.usage) {
                    this.#usage.input_tokens += (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0);
                    this.#usage.output_tokens += m.usage.output ?? 0;
                    this.#usage.total_tokens += m.usage.totalTokens ?? 0;
                    const window = contextTokens(m.usage);
                    if (window > 0) this.#usage.context_tokens = window;
                }
                return;
            }
            case "tool_execution_start":
                this.#ensureToolCall(f.toolCallId as string, f.toolName as string, f.args);
                this.#toolStarted(f.toolCallId as string);
                return;
            case "tool_execution_update":
                this.#toolOutput(
                    f.toolCallId as string,
                    textOfResult(f.partialResult),
                    false,
                    false,
                    undefined,
                    this.#subagents(f, false),
                );
                return;
            case "tool_execution_end":
                this.#toolOutput(
                    f.toolCallId as string,
                    textOfResult(f.result),
                    true,
                    f.isError === true,
                    f.isError === true ? undefined : sourcesFromResult(f.toolName as string | undefined, f.result),
                    this.#subagents(f, true),
                    f.isError === true
                        ? undefined
                        : todosFromResult(
                              f.toolName as string | undefined,
                              (f.result as { details?: unknown })?.details,
                          ),
                    {
                        ...toolFacts(f.toolName as string | undefined, (f.result as { details?: unknown })?.details),
                        // An error result that arrives after Stop is the stop itself, not a failure of the tool.
                        ...(f.isError === true && this.#cancelRequested ? { aborted: true } : {}),
                    },
                );
                return;
            case "agent_end":
                this.#lastMessages = f.messages as EndMessage[] | undefined;
                // A non-terminal end is a pause: a retry, reminder or queued input continues the run.
                if (f.isTerminal !== false) this.#complete();
                return;
            case "session_settled":
                // The session went quiet after a non-terminal end whose continuation never started.
                if (this.#lastMessages) this.#complete();
                return;
            case "command_output": {
                // Output of a slash command handled by the runtime itself (no model turn).
                const text = String(f.text ?? "");
                if (!text) return;
                const idx = this.#add({
                    id: this.#nextId(),
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text, annotations: [] }],
                    created_at: Date.now(),
                });
                this.#doneItem(idx);
                return;
            }
            case "prompt_result":
                this.#promptResult(f);
                return;
        }
    }

    /**
     * The runtime's one result per accepted prompt (also sent by the session manager, without an id, when
     * the `prompt` response says a slash command was answered locally). Normally it follows the terminal
     * `agent_end` and changes nothing; it ends runs that would otherwise wait for an end that never comes.
     */
    #promptResult(f: Frame): void {
        if (f.id !== undefined && f.id !== this.promptId) return;
        const error = (f.error as { message?: string } | undefined)?.message;
        if (f.agentInvoked === false) {
            if (f.status === "error")
                return this.finish({
                    status: "failed",
                    code: "prompt_failed",
                    message: cleanErrorMessage(error) || "The agent could not start this response.",
                });
            this.response.local = true;
            return this.finish("completed");
        }
        // Aborted before any turn started: the runtime kept neither the message nor a stopped record.
        if (f.status === "aborted") return this.finish(this.#agentStarted ? STOPPED_BY_USER : STOPPED_BEFORE_SEND);
        if (f.status === "error") return this.#complete(cleanErrorMessage(error));
        // Completed, but background work may still wake the agent: wait for its end or `session_settled`.
        if (f.sessionSettled !== false) this.#complete();
    }

    #assistantEvent(e: AssistantEvent): void {
        const ci = e.contentIndex ?? 0;
        const rid = this.response.id;
        switch (e.type) {
            case "text_start":
            case "thinking_start": {
                const item: MessageItem | ReasoningItem =
                    e.type === "text_start"
                        ? {
                              id: this.#nextId(),
                              type: "message",
                              role: "assistant",
                              status: "in_progress",
                              content: [{ type: "output_text", text: "", annotations: [] }],
                              created_at: Date.now(),
                          }
                        : {
                              id: this.#nextId(),
                              type: "reasoning",
                              status: "in_progress",
                              summary: [],
                              content: [{ type: "reasoning_text", text: "" }],
                          };
                this.#blocks.set(ci, this.#add(item));
                this.#streamed.set(ci, 0);
                return;
            }
            case "text_delta":
            case "thinking_delta": {
                const idx = this.#blocks.get(ci);
                if (idx === undefined || !e.delta) return;
                this.#appendText(idx, ci, e.delta, e.type === "text_delta");
                return;
            }
            case "text_end":
            case "thinking_end": {
                const idx = this.#blocks.get(ci);
                if (idx === undefined) return;
                const full = e.content ?? "";
                const sent = this.#streamed.get(ci) ?? 0;
                const isText = e.type === "text_end";
                if (full.length > sent) this.#appendText(idx, ci, full.slice(sent), isText);
                const item = this.response.output[idx] as MessageItem | ReasoningItem;
                const text = isText
                    ? (item as MessageItem).content[0]!.type === "output_text"
                        ? ((item as MessageItem).content[0] as { text: string }).text
                        : ""
                    : (item as ReasoningItem).content[0]!.text;
                const part = isText ? (item as MessageItem).content[0] : undefined;
                if (part?.type === "output_text") part.annotations = citationsFor(text, this.#sources);
                this.#emit({
                    type: isText ? "response.output_text.done" : "response.reasoning_text.done",
                    response_id: rid,
                    item_id: item.id,
                    output_index: idx,
                    content_index: 0,
                    text,
                });
                this.#doneItem(idx);
                return;
            }
            case "toolcall_start": {
                const block = e.partial?.content?.[ci];
                const idx = this.#ensureToolCall(block?.id ?? `call_${ci}`, block?.name ?? "tool", undefined);
                this.#blocks.set(ci, idx);
                return;
            }
            case "toolcall_delta": {
                const idx = this.#blocks.get(ci);
                if (idx === undefined || !e.delta) return;
                const item = this.response.output[idx] as FunctionCallItem;
                item.arguments += e.delta;
                this.#emit({
                    type: "response.function_call_arguments.delta",
                    response_id: rid,
                    item_id: item.id,
                    output_index: idx,
                    delta: e.delta,
                });
                return;
            }
            case "toolcall_end": {
                if (!e.toolCall) return;
                const idx = this.#ensureToolCall(e.toolCall.id, e.toolCall.name, e.toolCall.arguments);
                const item = this.response.output[idx] as FunctionCallItem;
                item.arguments = JSON.stringify(e.toolCall.arguments ?? {});
                this.#doneItem(idx);
                return;
            }
            case "error":
                // An abort also arrives as an error event; the stop is reported as cancelled, not failed.
                if (e.reason !== "aborted")
                    this.#streamError = cleanErrorMessage(e.error?.errorMessage) || "The model returned an error.";
                return;
        }
    }

    #appendText(idx: number, ci: number, delta: string, isText: boolean): void {
        const item = this.response.output[idx] as MessageItem | ReasoningItem;
        if (isText) ((item as MessageItem).content[0] as { text: string }).text += delta;
        else (item as ReasoningItem).content[0]!.text += delta;
        this.#streamed.set(ci, (this.#streamed.get(ci) ?? 0) + delta.length);
        this.#emit({
            type: isText ? "response.output_text.delta" : "response.reasoning_text.delta",
            response_id: this.response.id,
            item_id: item.id,
            output_index: idx,
            content_index: 0,
            delta,
        });
    }

    #ensureToolCall(callId: string, name: string, args: unknown): number {
        const existing = this.#toolCalls.get(callId);
        if (existing !== undefined) return existing;
        const item: FunctionCallItem = {
            id: this.#nextId(),
            type: "function_call",
            status: "in_progress",
            call_id: callId,
            name,
            arguments: args === undefined ? "" : JSON.stringify(args),
        };
        const idx = this.#add(item);
        this.#toolCalls.set(callId, idx);
        return idx;
    }

    /** The output item of a call that started running: in progress, empty, with its start time for a step clock. */
    #toolStarted(callId: string): void {
        if (this.#toolOutputs.has(callId)) return;
        const item: FunctionCallOutputItem = {
            id: this.#nextId(),
            type: "function_call_output",
            status: "in_progress",
            call_id: callId,
            output: "",
            started_at: Date.now(),
        };
        this.#toolOutputs.set(callId, this.#add(item));
    }

    /** Subagent runs for a `task` frame, or undefined for other tools. */
    #subagents(f: Frame, final: boolean): SubagentRun[] | undefined {
        if (f.toolName !== "task") return undefined;
        const id = f.toolCallId as string;
        let tracker = this.#tasks.get(id);
        if (!tracker) this.#tasks.set(id, (tracker = new SubagentTracker()));
        const details = ((final ? f.result : f.partialResult) as { details?: unknown } | undefined)?.details;
        if (!final) return tracker.update(details);
        const runs = tracker.finish(details);
        // Output paths look like /conversations/<cid>/<session>/<agentId>.md; the session part locates the files.
        const out = (details as { outputPaths?: string[] } | undefined)?.outputPaths?.[0];
        if (runs && out && this.conversationDir)
            withChildSteps(runs, join(this.conversationDir, basename(dirname(out))), this.response.conversation.id);
        return runs;
    }

    #toolOutput(
        callId: string,
        output: string,
        final: boolean,
        isError = false,
        sources?: SourceRef[],
        subagents?: SubagentRun[],
        todos?: TodoPhase[],
        facts?: Pick<FunctionCallOutputItem, "diff" | "exit_code" | "wall_time_ms" | "aborted">,
    ): void {
        let idx = this.#toolOutputs.get(callId);
        if (idx === undefined) {
            const item: FunctionCallOutputItem = {
                id: this.#nextId(),
                type: "function_call_output",
                status: "in_progress",
                call_id: callId,
                output: "",
            };
            idx = this.#add(item);
            this.#toolOutputs.set(callId, idx);
        }
        const item = this.response.output[idx] as FunctionCallOutputItem;
        item.output = output;
        if (isError) item.is_error = true;
        if (subagents) {
            item.subagents = subagents;
            if (final) sources ??= sourcesOfRuns(subagents);
        }
        if (sources) {
            item.sources = sources;
            rememberSources(this.#sources, sources);
        }
        // Final results only (`todo` sends none while it runs); clients read it from `response.output_item.done`.
        if (todos) item.todos = todos;
        if (facts) Object.assign(item, facts);
        this.#emit({
            type: "chat.function_call_output.delta",
            response_id: this.response.id,
            item_id: item.id,
            output_index: idx,
            output,
            ...(subagents ? { subagents } : {}),
        });
        if (final) this.#doneItem(idx);
    }

    /** The runtime asks for approval. Resolves when the client answers or the run ends. */
    requestApproval(req: UiRequest): Promise<UiAnswer> {
        const callIdx = [...this.#toolCalls.values()].at(-1);
        const call = callIdx !== undefined ? (this.response.output[callIdx] as FunctionCallItem) : undefined;
        const item: ApprovalRequestItem = {
            id: `apr_${req.id}`,
            type: "mcp_approval_request",
            server_label: "agent",
            name: call?.name ?? "tool",
            arguments: call?.arguments ?? "{}",
            title: req.title ?? "Allow this action?",
        };
        const idx = this.#add(item);
        return new Promise((resolve) => {
            this.#approvals.set(item.id, (answer) => {
                this.#approvals.delete(item.id);
                this.#doneItem(idx);
                resolve(answer);
            });
        });
    }

    /** Answer every pending approval as cancelled (the runtime cannot abort while it waits on one). */
    cancelApprovals(): void {
        for (const id of [...this.#approvals.keys()]) this.#approvals.get(id)!({ cancelled: true });
        for (const settle of [...this.#elicitations.values()]) settle({ action: "cancel" });
    }

    // MCP gateway bridge (src/mcp/interactions.ts): remote MCP servers ask the user through the running response.

    /** Open elicitations by item id. */
    #elicitations = new Map<string, (r: Pick<McpElicitationResponseItem, "action" | "content">) => void>();

    /** The newest tool call of this response that has not finished and matches; for the MCP gateway. */
    findRunningCall(match: (name: string, args: string) => boolean): FunctionCallItem | undefined {
        for (const idx of [...this.#toolCalls.values()].reverse()) {
            const call = this.response.output[idx] as FunctionCallItem;
            const out = this.#toolOutputs.get(call.call_id);
            if (out !== undefined && (this.response.output[out] as FunctionCallOutputItem).status === "completed")
                continue;
            if (match(call.name, call.arguments)) return call;
        }
        return undefined;
    }

    /** The MCP gateway asks before a tool call (for example a destructive tool). Resolves true when approved. */
    requestGatewayApproval(fields: Omit<ApprovalRequestItem, "id" | "type">, signal?: AbortSignal): Promise<boolean> {
        const item: ApprovalRequestItem = {
            id: `apr_gw_${crypto.randomUUID()}`,
            type: "mcp_approval_request",
            ...fields,
        };
        const idx = this.#add(item);
        return new Promise((resolve) => {
            this.#approvals.set(item.id, (answer) => {
                this.#approvals.delete(item.id);
                this.#doneItem(idx);
                resolve("value" in answer && answer.value === "Approve");
            });
            // The caller gave up (control was released, the call was cancelled): close the card as cancelled.
            const abandon = () => this.#approvals.get(item.id)?.({ cancelled: true });
            if (signal?.aborted) abandon();
            else signal?.addEventListener("abort", abandon, { once: true });
        });
    }

    /** A remote MCP server asks the user for input. Resolves with the user's answer, or cancel when the run stops. */
    requestElicitation(
        fields: Omit<McpElicitationItem, "id" | "type" | "status" | "outcome">,
    ): Promise<Pick<McpElicitationResponseItem, "action" | "content">> {
        const item: McpElicitationItem = {
            id: `eli_${crypto.randomUUID()}`,
            type: "chat.mcp_elicitation",
            status: "in_progress",
            ...fields,
        };
        const idx = this.#add(item);
        return new Promise((resolve) => {
            this.#elicitations.set(item.id, (r) => {
                this.#elicitations.delete(item.id);
                item.outcome = r.action;
                this.#doneItem(idx);
                resolve(r);
            });
        });
    }

    answerElicitation(r: McpElicitationResponseItem): boolean {
        const settle = this.#elicitations.get(r.elicitation_id);
        if (!settle) return false;
        settle({ action: r.action, content: r.action === "accept" ? r.content : undefined });
        return true;
    }

    /** MCP progress for a running tool call (relayed by the MCP gateway). */
    toolProgress(itemId: string, progress: number, total?: number, message?: string): void {
        this.#emit({
            type: "chat.tool_progress",
            response_id: this.response.id,
            item_id: itemId,
            progress,
            total,
            message,
        });
    }

    answerApproval(approvalId: string, approve: boolean): boolean {
        const fn = this.#approvals.get(approvalId);
        if (!fn) return false;
        fn({ value: approve ? "Approve" : "Deny" });
        return true;
    }

    /** The runtime asks the user something. Resolves when the client answers or the question closes. */
    requestQuestion(req: UiRequest): Promise<UiAnswer> {
        const callIdx = [...this.#toolCalls.values()].at(-1);
        const call = callIdx !== undefined ? (this.response.output[callIdx] as FunctionCallItem) : undefined;
        const item = questionItem(req, req.method === "ask" && call?.name === "ask" ? call.call_id : undefined);
        const idx = this.#add(item);
        return new Promise((resolve) => {
            this.#questions.set(item.id, {
                uiId: req.id,
                settle: (s) => {
                    this.#questions.delete(item.id);
                    const it = this.response.output[idx] as AskRequestItem;
                    it.outcome = s.outcome;
                    if (s.answers) it.answers = s.answers;
                    this.#doneItem(idx);
                    resolve("answer" in s ? s.answer : { cancelled: true });
                },
            });
        });
    }

    /** False when no such question is open; undefined when the answer does not fit the question. */
    answerQuestion(r: AskResponseItem): boolean | undefined {
        const q = this.#questions.get(r.ask_request_id);
        if (!q) return false;
        const idx = this.response.output.findIndex((i) => i.id === r.ask_request_id);
        const settled = settleFromResponse(this.response.output[idx] as AskRequestItem, r);
        if (!settled) return undefined;
        q.settle(settled);
        return true;
    }

    /** The runtime closed a question itself (`cancel` frame): its timeout, or an abort. */
    closeQuestion(uiId: string): void {
        for (const [id, q] of this.#questions) {
            if (q.uiId !== uiId) continue;
            q.settle(closedByRuntime(this.response.output.find((i) => i.id === id) as AskRequestItem));
        }
    }

    /** Close every open question as cancelled (the run is stopping). */
    cancelQuestions(): void {
        for (const q of [...this.#questions.values()]) q.settle({ outcome: "cancelled" });
    }

    /** End from the latest `agent_end`. `error`: a failure the runtime reported without a failed message. */
    #complete(error?: string): void {
        const last = this.#lastMessages?.findLast((m) => m.role === "assistant");
        const end = runEndOf(last);
        if (end) return this.finish(end);
        const failure = error || this.#streamError;
        if (failure) return this.finish({ status: "failed", code: "model_error", message: failure });
        // A stop that lands between turns (during a tool) can leave a tool call as the last message.
        if (this.#cancelRequested && last?.stopReason !== "stop") return this.finish(STOPPED_BY_USER);
        this.finish("completed");
    }

    /**
     * End the response: completed, or with a run end note as its last item (failed, stopped, cut off).
     * Also used by the session manager when the process exits, a stop escalates or the prompt is rejected.
     */
    finish(outcome: "completed" | RunEnd): void {
        if (this.#done) return;
        // Every stop path reports STOPPED_BY_USER; a stop the server asked for says its own reason instead.
        if (outcome === STOPPED_BY_USER) outcome = this.#stopReason;
        this.#done = true;
        this.cancelApprovals();
        this.cancelQuestions();
        for (const item of this.response.output)
            if ("status" in item && item.status === "in_progress") item.status = "incomplete";
        const status = outcome === "completed" ? "completed" : outcome.status;
        this.response.error =
            outcome !== "completed" && outcome.status === "failed"
                ? { code: outcome.code, message: outcome.message }
                : null;
        if (outcome !== "completed") {
            const item: RunEndItem = { id: `${this.response.id}_end`, type: "chat.run_end", ...outcome };
            // Not #doneItem: that would overwrite the item's own status.
            const index = this.#add(item);
            this.#emit({ type: "response.output_item.done", response_id: this.response.id, output_index: index, item });
        }
        this.response.status = status;
        this.response.usage = this.#usage;
        this.response.duration_ms = Date.now() - this.startedAt;
        this.#emit({ type: `response.${status}`, response: this.snapshot() });
        this.#finished();
    }
}
