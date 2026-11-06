/**
 * Live agent processes, one per active conversation.
 *
 * A process is spawned on the first prompt, resumes the conversation's session file, and is stopped
 * after `system.agent.idleTimeoutSec` without a running response. It is restarted on the next prompt
 * when the user's rendered config or the permission mode changed. Process limits are per user
 * (`system.agent.maxProcessesPerUser`) and global (`system.agent.maxProcesses`); the least recently used
 * idle process is evicted to make room. When every slot runs a response, the prompt waits in a fair queue
 * (slots.ts) for up to `system.agent.queueTimeoutSec`.
 *
 * Run lifecycle per conversation: reserved (`reserve`, from the WebSocket handler) -> queued (only when no slot
 * is free; the client gets `chat.queue` events) -> starting (process spawn, model switch) -> running
 * (`ResponseRun`) -> done. Only one run or start per conversation. A stop is honoured in every state: while
 * queued or starting, the prompt is not sent and the run ends as stopped before send; while running, the runtime
 * gets an abort, and if the run has not ended after STOP_GRACE_MS the server ends it and stops the process.
 */
import type { AskResponseItem, ConversationSummary, McpElicitationResponseItem, ServerEvent } from "@pikvm/chat-protocol";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import { agentBaseUrl, env, hostInstructions, runLifecycle } from "../env.ts";
import { paths } from "../paths.ts";
import { hasAttachment, snippetOf } from "../conversations/snippet.ts";
import { maybeGenerateTitle } from "../conversations/titles.ts";
import { setting } from "../settings/store.ts";
import {
    getConversation,
    NotFoundError,
    sessionFilePath,
    toSummary,
    updateConversation,
    type ConversationRow,
} from "../conversations/service.ts";
import { cleanErrorMessage, type RunEnd } from "../conversations/history.ts";
import { computerArgs, writeAgentConfig } from "./config.ts";
import { RpcClient, type Frame } from "./rpc.ts";
import { MAX_TURN_RETRIES } from "./retry-limits.ts";
import {
    AGENT_EXITED,
    ResponseRun,
    SERVER_STOPPED,
    STOPPED_BEFORE_SEND,
    STOPPED_BY_USER,
    timeLimitEnd,
} from "./run.ts";
import { buildSpawn, locateRuntime } from "./launch.ts";
import {
    abortUserWaits,
    abortWait,
    acquireSlot,
    changed as slotsChanged,
    queuePosition,
    setSlotHost,
    SlotAbort,
    SlotTimeout,
    waitingCount,
    type Slot,
} from "./slots.ts";

export type Permission = "default" | "full";

export class AgentBusyError extends Error {
    constructor(
        message: string,
        readonly code: "conversation_busy" | "process_limit",
    ) {
        super(message);
    }
}

interface Live {
    userId: string;
    conversationId: string;
    rpc: RpcClient;
    hash: string;
    /** Instructions and agent overlay the process started with (launchSpec); a change restarts it on the next turn. */
    launch: string;
    permission: Permission;
    model: string;
    thinking: string;
    lastUsed: number;
    run?: ResponseRun;
    /** The session file name in the conversation row is the one this process writes. */
    sessionKnown: boolean;
    /** Auto-retry was turned off to end a failing run (see giveUpRetry); turned on again for the next prompt. */
    retryOff?: boolean;
}

type Sink = (userId: string, event: Omit<ServerEvent, "sequence_number"> | ServerEvent) => void;

/**
 * A response being started: from the WebSocket handler accepting it until its run exists. Holds the
 * conversation so a second prompt is refused, keeps the idle reaper and eviction off its process, and
 * records a stop that arrives before there is a run to stop.
 */
export interface StartTicket {
    readonly userId: string;
    readonly conversationId: string;
    cancelled: boolean;
}

/**
 * How long a stop waits for the runtime to end the run before the server ends it and stops the process.
 * An abort normally ends a run in well under a second; the bound only matters when the runtime is stuck.
 * A constant, not a setting: it is a safety limit, not a preference.
 */
const STOP_GRACE_MS = 5000;

const live = new Map<string, Live>();
const starting = new Map<string, StartTicket>();
/** Processes being stopped, by conversation: a new process waits so two never share a session file. */
const stopping = new Map<string, Promise<void>>();
let sink: Sink = () => {};

export function setEventSink(fn: Sink): void {
    sink = fn;
}

export function activeRun(conversationId: string): ResponseRun | undefined {
    const l = live.get(conversationId);
    return l?.run && !l.run.done ? l.run : undefined;
}

/** The conversation's latest run while its process lives, running or finished (for chat.resume). */
export function latestRun(userId: string, conversationId: string): ResponseRun | undefined {
    const l = live.get(conversationId);
    return l?.userId === userId ? l.run : undefined;
}

/** A response is running or starting. */
export function isActive(conversationId: string): boolean {
    return !!activeRun(conversationId) || starting.has(conversationId);
}

/** Hold the conversation for a new response. Throws when one is already running or starting. */
export function reserve(userId: string, conversationId: string): StartTicket {
    if (isActive(conversationId)) throw new AgentBusyError("This conversation is already running", "conversation_busy");
    const ticket: StartTicket = { userId, conversationId, cancelled: false };
    starting.set(conversationId, ticket);
    return ticket;
}

/** Give up a reservation (its run started, or the start failed). Safe to call more than once. */
export function release(ticket: StartTicket): void {
    if (starting.get(ticket.conversationId) === ticket) starting.delete(ticket.conversationId);
}

function summary(userId: string, conversationId: string): ConversationSummary {
    return toSummary(getConversation(userId, conversationId), isActive(conversationId));
}

/** The agent's working directory for a conversation. Empty: the computer profile has no tool that reads files. */
function cwdFor(userId: string, row: ConversationRow): string {
    return paths.user(userId).chatWorkspace(row.id);
}

/** Appended system prompt, general to specific: what the host says about its tools, then the operator's own. */
function instructionsFor(userId: string): string {
    return [hostInstructions(), setting("agent.instructions", userId).trim()].filter(Boolean).join("\n\n");
}

/** Everything a process gets at start that settings hashes do not cover: the instructions. */
function launchSpec(userId: string) {
    const instructions = instructionsFor(userId);
    const key = createHash("sha256").update(JSON.stringify([instructions])).digest("hex").slice(0, 16);
    return { instructions, key };
}

/** Stop a process; its run (if any) ends with `end`. Safe to call more than once. */
function stop(l: Live, end = SERVER_STOPPED): Promise<void> {
    const id = l.conversationId;
    if (live.get(id) === l) live.delete(id);
    l.run?.finish(end);
    slotsChanged();
    const closing: Promise<void> = l.rpc.close().finally(() => {
        if (stopping.get(id) === closing) stopping.delete(id);
    });
    stopping.set(id, closing);
    return closing;
}

setSlotHost({
    processes: () =>
        [...live.values()].map((l) => ({
            userId: l.userId,
            conversationId: l.conversationId,
            lastUsed: l.lastUsed,
            active: isActive(l.conversationId),
        })),
    evict: async (conversationId) => {
        const l = live.get(conversationId);
        if (l) await stop(l);
    },
    announce: (userId, conversationId, position) =>
        sink(userId, { type: "chat.queue", conversation_id: conversationId, position }),
});

/** A slot for a new process. Waits in the queue when none is free; a timeout becomes `process_limit`. */
async function takeSlot(userId: string, conversationId: string): Promise<Slot> {
    try {
        return await acquireSlot(userId, conversationId);
    } catch (err) {
        if (err instanceof SlotTimeout)
            throw new AgentBusyError(
                err.scope === "user"
                    ? `You can run at most ${err.max} conversations at once`
                    : "The server is at its agent limit, try again shortly",
                "process_limit",
            );
        throw err;
    }
}

/** The notice for an automatic compaction frame, or undefined when there is nothing to say. */
function compactionNotice(f: Frame): { level: "info" | "warning"; message: string } | undefined {
    if (f.type === "auto_compaction_start")
        return { level: "info", message: "The chat is near the model's context limit. Summarising earlier messages." };
    if (f.skipped || f.aborted) return undefined;
    if (f.errorMessage) return { level: "warning", message: "Earlier messages could not be summarised." };
    return { level: "info", message: "Earlier messages were summarised to make room." };
}

/**
 * The runtime announces each MCP server it mounts as an xd:// device ("xd://: mounted mcp__..."). That is runtime
 * plumbing, not something the reader acts on: the tools show in the composer's @ menu instead. Both notice paths
 * in onFrame use this filter (kept since 627df2a).
 */
function isRuntimePlumbing(message: string): boolean {
    return /^xd:\/\//.test(message);
}

function onFrame(l: Live, f: Frame): void {
    l.lastUsed = Date.now();
    if (env.agentDebug)
        console.error(
            `[agent:${l.conversationId}] frame ${f.type}${f.type === "message_update" ? `:${(f.assistantMessageEvent as { type?: string })?.type}` : ""}`,
        );
    if (f.type === "session_info_update" && typeof f.title === "string" && f.title) {
        const row = getConversation(l.userId, l.conversationId);
        if (row.titleSource === "auto" && row.title !== f.title) {
            updateConversation(l.userId, l.conversationId, { title: f.title, titleSource: "auto" });
            sink(l.userId, { type: "chat.conversation.updated", conversation: summary(l.userId, l.conversationId) });
        }
        return;
    }
    if (f.type === "extension_ui_request") {
        // Dialogs that need no answer: the runtime closed a question itself, or a toast.
        if (f.method === "cancel" && typeof f.targetId === "string") l.run?.closeQuestion(f.targetId);
        else if (f.method === "notify" && typeof f.message === "string" && f.message) {
            if (isRuntimePlumbing(f.message)) return;
            const level = (
                ["info", "warning", "error"].includes(f.notifyType as string) ? f.notifyType : "info"
            ) as "info";
            sink(l.userId, { type: "chat.notice", level, message: f.message, conversation_id: l.conversationId });
        }
        return;
    }
    if (f.type === "auto_retry_start") {
        const run = l.run && !l.run.done && !l.run.cancelRequested ? l.run : undefined;
        if (run && Number(f.attempt) > MAX_TURN_RETRIES) giveUpRetry(l, run, String(f.errorMessage ?? ""));
        return;
    }
    if (f.type === "notice" && typeof f.message === "string") {
        // The runtime can send the same mount line as a `notice` frame as well as a notify request.
        if (isRuntimePlumbing(f.message)) return;
        const level = (["info", "warning", "error"].includes(f.level as string) ? f.level : "info") as "info";
        sink(l.userId, { type: "chat.notice", level, message: f.message, conversation_id: l.conversationId });
        return;
    }
    // Automatic compaction (`agent.compaction`) pauses the reply; say why, and say when it failed. History shows the
    // summary marker (history.ts). A compaction the runtime skipped changed nothing, so it says nothing.
    if (f.type === "auto_compaction_start" || f.type === "auto_compaction_end") {
        const notice = compactionNotice(f);
        if (notice) sink(l.userId, { type: "chat.notice", ...notice, conversation_id: l.conversationId });
        return;
    }
    l.run?.handle(f);
}

async function spawn(userId: string, row: ConversationRow, permission: Permission): Promise<Live> {
    // Fail before queueing when there is no runtime to start.
    locateRuntime();
    const slot = await takeSlot(userId, row.id);
    try {
        return await spawnWithSlot(userId, row, permission, slot);
    } finally {
        slot.release();
    }
}

async function spawnWithSlot(userId: string, row: ConversationRow, permission: Permission, slot: Slot): Promise<Live> {
    const cfg = writeAgentConfig(userId, agentBaseUrl());
    const cwd = cwdFor(userId, row);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(paths.user(userId).conversation(row.id), { recursive: true });

    // No --no-ui: under it the runtime skips tool approval prompts, and approvals are how
    // "default" permission is enforced. rpc-ui (not rpc) gives the session a UI, which is what makes the
    // runtime offer its `ask` tool; questions then arrive as `ask` dialogs (see set_ask_dialog below).
    const args = ["--mode", "rpc-ui", "--session-dir", paths.user(userId).conversation(row.id), ...computerArgs(userId)];
    // The runtime writes its session file lazily: a process killed during the first response leaves a
    // name with no file, and resuming it fails on every later spawn. Without the file, start a new one.
    const file = sessionFilePath(userId, row);
    const resume = !!file && existsSync(file);
    if (file && !resume)
        console.warn(`[agent] ${row.id}: session file ${row.sessionFile} is missing, starting a new one`);
    if (resume) args.push("--resume", file!);
    if (row.model) args.push("--model", row.model);
    if (row.thinking) args.push("--thinking", row.thinking);
    args.push("--approval-mode", permission === "full" ? "yolo" : "write");
    const launch = launchSpec(userId);
    if (launch.instructions) args.push("--append-system-prompt", launch.instructions);

    const rpc = new RpcClient(
        // The conversation id reaches the MCP gateway as a header (agent/config.ts, src/mcp/gateway.ts).
        buildSpawn(userId, cwd, args, { CHAT_CONVERSATION_ID: row.id }),
        `${userId}/${row.id}`,
    );
    const l: Live = {
        userId,
        conversationId: row.id,
        rpc,
        hash: cfg.hash,
        launch: launch.key,
        permission,
        model: row.model,
        thinking: row.thinking,
        lastUsed: Date.now(),
        sessionKnown: resume,
    };
    rpc.onEvent = (f) => onFrame(l, f);
    rpc.onUiRequest = async (req) => {
        // Nothing new is asked once a stop was requested: the run is ending.
        const run = l.run && !l.run.done && !l.run.cancelRequested ? l.run : undefined;
        if (!run) return { cancelled: true };
        if (req.method === "select" && req.options?.includes("Approve")) return run.requestApproval(req);
        return run.requestQuestion(req);
    };
    rpc.exited.then((code) => {
        if (live.get(row.id) === l) live.delete(row.id);
        if (l.run && !l.run.done) console.warn(`[agent] ${row.id} exited with ${code} during a response`);
        l.run?.finish(l.run.cancelRequested ? STOPPED_BY_USER : AGENT_EXITED);
        slotsChanged();
    });
    live.set(row.id, l);
    // The process counts as live now; the claim would count it twice.
    slot.release();
    try {
        await rpc.ready();
        // One `ask` dialog with every question, instead of the runtime's one-select-per-question fallback.
        await rpc.request("set_ask_dialog", { enabled: true }).catch(() => undefined);
    } catch (err) {
        live.delete(row.id);
        rpc.kill();
        throw err;
    }
    console.log(`[agent] started ${row.id} for ${userId} (${permission})`);
    return l;
}

async function acquire(userId: string, row: ConversationRow, permission: Permission): Promise<Live> {
    const existing = live.get(row.id);
    if (existing) {
        const cfg = writeAgentConfig(userId, agentBaseUrl());
        const launch = launchSpec(userId);
        if (
            existing.hash === cfg.hash &&
            existing.launch === launch.key &&
            existing.permission === permission &&
            !existing.rpc.closed
        ) {
            existing.lastUsed = Date.now();
            return existing;
        }
        await stop(existing);
    }
    // A process still shutting down (after a stop escalation) may write the session file until it exits.
    await stopping.get(row.id);
    return spawn(userId, row, permission);
}

export interface PromptRequest {
    userId: string;
    conversationId: string;
    message: string;
    images: { type: "image"; data: string; mimeType: string }[];
    model?: string;
    thinking?: string;
    permission: Permission;
    streamId?: string;
    /** The reservation made by the caller (see `reserve`); taken here when absent. */
    ticket?: StartTicket;
}

/**
 * Start a response. Returns once it has started; progress arrives through the sink. Errors thrown here
 * come before the run exists (the caller reports them); after that, every failure ends the run.
 */
export async function prompt(req: PromptRequest): Promise<ResponseRun> {
    const ticket = req.ticket ?? reserve(req.userId, req.conversationId);
    try {
        return await startRun(req, ticket);
    } finally {
        release(ticket);
    }
}

/** Titles that arrived before the conversation's process was up; sent to it once it is (see nameSession). */
const pendingNames = new Map<string, string>();

/** Tell the runtime the session's name now, or as soon as the process exists. Best effort. */
function nameSession(conversationId: string, name: string): Promise<unknown> {
    const l = live.get(conversationId);
    if (!l) {
        pendingNames.set(conversationId, name);
        return Promise.resolve();
    }
    return l.rpc.request("set_session_name", { name });
}

async function startRun(req: PromptRequest, ticket: StartTicket): Promise<ResponseRun> {
    let row = getConversation(req.userId, req.conversationId);
    // The runtime does not name sessions in RPC mode; the server does (conversations/titles.ts). The call starts
    // now, beside the run: it never waits for the reply and the run never waits for it.
    void maybeGenerateTitle({
        userId: req.userId,
        conversationId: req.conversationId,
        message: req.message,
        rename: (name) => nameSession(req.conversationId, name),
        updated: (agentic) =>
            sink(req.userId, {
                type: "chat.conversation.updated",
                conversation: summary(req.userId, req.conversationId),
                agentic,
            }),
    });
    let l: Live;
    try {
        // Start the process on the requested model, not the chat's stored one. The stored model can be gone (a
        // provider or model removed since), and the runtime exits at startup on an unknown --model, before the
        // set_model switch below could ever run. The same applies to the stored thinking level.
        const start = { ...row, model: req.model || row.model, thinking: req.thinking || row.thinking };
        l = await acquire(req.userId, start, req.permission);
    } catch (err) {
        if (err instanceof SlotAbort) return endUnqueued(req, ticket, row, err);
        throw err;
    }

    const pendingName = pendingNames.get(row.id);
    if (pendingName) {
        pendingNames.delete(row.id);
        void l.rpc.request("set_session_name", { name: pendingName }).catch(() => undefined);
    }
    if (!ticket.cancelled && req.model && req.model !== l.model) {
        const slash = req.model.indexOf("/");
        await l.rpc.request("set_model", { provider: req.model.slice(0, slash), modelId: req.model.slice(slash + 1) });
        l.model = req.model;
    }
    if (!ticket.cancelled && req.thinking && req.thinking !== l.thinking) {
        await l.rpc.request("set_thinking_level", { level: req.thinking });
        l.thinking = req.thinking;
    }
    if (!ticket.cancelled && l.retryOff) {
        await l.rpc.request("set_auto_retry", { enabled: true });
        l.retryOff = false;
    }
    if (!ticket.cancelled && !l.model) {
        const state = await l.rpc.request<{ model?: { provider: string; id: string } }>("get_state");
        if (state.model) l.model = `${state.model.provider}/${state.model.id}`;
    }

    const run = new ResponseRun(row.id, l.model || row.model, (e) => sink(req.userId, e), req.streamId);
    run.conversationDir = paths.user(req.userId).conversation(row.id);
    run.attention = (kind) => {
        // A notification is never worth a failed run: the host's hook may throw, and the card is already on screen.
        try {
            runLifecycle()?.needsAnswer?.(req.userId, row.id, kind);
        } catch {
            /* nothing to do */
        }
    };
    l.run = run;
    // The run holds the conversation from here (activeRun); a later stop goes to the run.
    release(ticket);
    l.lastUsed = Date.now();
    // Control of the computer is granted to this response and ends with it, however it ends.
    runLifecycle()?.beginRun(row.id);
    void run.finished.then(() => runLifecycle()?.endRun(row.id));
    run.start();
    limitResponse(l, run, setting("system.agent.maxResponseMinutes"));
    let sent = false;
    run.finished.then(() => {
        afterRun(req, l, run, sent);
        // The process is idle now: a queued prompt may take its slot.
        slotsChanged();
    });

    // Stopped while starting: the prompt never reaches the model or the session file. The note says so,
    // so the client can offer the text again (sending it to abort it at once would cost a model request).
    if (ticket.cancelled) {
        run.finish(STOPPED_BEFORE_SEND);
        return run;
    }
    try {
        row = updateConversation(req.userId, row.id, { model: l.model, thinking: l.thinking, touch: true });
        sink(req.userId, { type: "chat.conversation.updated", conversation: toSummary(row, true) });
    } catch (err) {
        console.error(`[agent] ${row.id}: could not start the response`, err);
        run.finish({ status: "failed", code: "server_error", message: "The server could not start this response." });
        return run;
    }

    sent = true;
    const images = req.images.length ? { images: req.images } : {};
    l.rpc
        .request<{ agentInvoked?: boolean } | undefined>(
            "prompt",
            { message: req.message, ...images },
            (id) => (run.promptId = id),
        )
        .then(
            async (data) => {
                // A slash command the runtime answered itself: no model turn, so no agent_end will follow.
                if (data?.agentInvoked === false) run.handle({ type: "prompt_result", agentInvoked: false });
                if (l.sessionKnown) return;
                // Not a failure of the response: the file name is read again after the next prompt.
                const state = await l.rpc.request<{ sessionFile?: string }>("get_state").catch(() => undefined);
                if (!state?.sessionFile) return;
                updateConversation(req.userId, row.id, { sessionFile: basename(state.sessionFile) });
                l.sessionKnown = true;
            },
            (err: Error) => {
                // The process exiting rejects every pending request; its own handler reports it plainly.
                if (run.cancelRequested) return run.finish(STOPPED_BY_USER);
                if (l.rpc.closed) return run.finish(AGENT_EXITED);
                const message = cleanErrorMessage(err.message) || "The agent could not start this response.";
                run.finish({ status: "failed", code: "prompt_failed", message });
            },
        )
        .catch((err: Error) => console.error(`[agent] ${row.id}: could not record the session file`, err));
    return run;
}

/**
 * A queued prompt left the queue without a slot because it was stopped, its conversation or account went, or its
 * user disconnected. The prompt is never sent. The run ends like a stop before send, so the client can offer the
 * text again; when the conversation or account is gone nobody is told.
 */
function endUnqueued(req: PromptRequest, ticket: StartTicket, row: ConversationRow, abort: SlotAbort): ResponseRun {
    const gone = abort.reason === "deleted" || abort.reason === "account";
    const run = new ResponseRun(row.id, req.model || row.model, (e) => !gone && sink(req.userId, e), req.streamId);
    release(ticket);
    run.start();
    run.finish(STOPPED_BEFORE_SEND);
    if (!gone) {
        try {
            sink(req.userId, { type: "chat.conversation.updated", conversation: summary(req.userId, row.id) });
        } catch (err) {
            if (!(err instanceof NotFoundError)) console.error(`[agent] ${row.id}: after queue`, err);
        }
    }
    return run;
}

/** Bookkeeping once a run ends: conversation state. */
function afterRun(req: PromptRequest, l: Live, run: ResponseRun, sent: boolean): void {
    l.lastUsed = Date.now();
    try {
        const snippet = sent ? snippetOf(run.response.output) : undefined;
        const after = updateConversation(req.userId, req.conversationId, {
            touch: sent,
            ...(snippet ? { snippet } : {}),
            ...(sent && hasAttachment(req.message, req.images) ? { hasAttachments: true } : {}),
        });
        sink(req.userId, {
            type: "chat.conversation.updated",
            conversation: toSummary(after, isActive(req.conversationId)),
        });
    } catch (err) {
        // The conversation was deleted while it ran.
        if (!(err instanceof NotFoundError)) console.error(`[agent] ${req.conversationId}: after run`, err);
        return;
    }
}

/**
 * Stop the conversation's response. True when there was one to stop (running or starting). Idempotent:
 * a second stop for the same response changes nothing. `responseId`, when given, must name the running
 * response or the one that just ended (then the stop is already done).
 */
export function cancel(userId: string, conversationId: string, responseId?: string): boolean {
    const l = live.get(conversationId);
    const run = activeRun(conversationId);
    if (l && run && l.userId === userId) {
        if (responseId && responseId !== run.response.id) return false;
        if (run.requestCancel()) escalate(l, run);
        return true;
    }
    // A stop for a response that already ended (a repeated stop) is done, not an error.
    if (responseId && l?.userId === userId && l.run?.response.id === responseId) return true;
    const ticket = starting.get(conversationId);
    if (ticket?.userId !== userId || responseId) return false;
    ticket.cancelled = true;
    // Queued for a slot: leave the queue; the prompt is never sent.
    abortWait(conversationId, "stopped");
    return true;
}

/** Stop every running or starting response of a user, as their Stop does. Returns how many were stopped. */
export function cancelAll(userId: string): number {
    let stopped = 0;
    for (const id of new Set([...live.keys(), ...starting.keys()])) if (cancel(userId, id)) stopped++;
    return stopped;
}

/**
 * `system.agent.maxResponseMinutes`: stop the run when it is still going after `minutes`, the same way as a user
 * stop, with its own end note. The runtime's `--max-time` cannot do this: it is one deadline for the whole process,
 * which serves many responses. 0 means no limit.
 */
function limitResponse(l: Live, run: ResponseRun, minutes: number): void {
    if (minutes <= 0) return;
    const timer = setTimeout(() => {
        if (run.done || !run.requestCancel(timeLimitEnd(minutes))) return;
        console.warn(`[agent] ${l.conversationId}: response reached the ${minutes}-minute limit, stopping it`);
        escalate(l, run);
    }, minutes * 60_000);
    void run.finished.then(() => clearTimeout(timer));
}

/** Ask the runtime to abort the run; `deadline` ends it here when the runtime does not. */
function escalate(l: Live, run: ResponseRun): void {
    void l.rpc.request("abort").catch(() => undefined);
    deadline(l, run, STOPPED_BY_USER, "abort");
}

/**
 * Stop the runtime's retries of a failing model request: the turn then ends with the model's error, as
 * the runtime records it (so history shows the same note).
 */
function giveUpRetry(l: Live, run: ResponseRun, error: string): void {
    console.warn(`[agent] ${l.conversationId}: model error, not retrying: ${error.split("\n")[0]}`);
    l.retryOff = true;
    void l.rpc.request("set_auto_retry", { enabled: false }).catch(() => undefined);
    void l.rpc.request("abort_retry").catch(() => undefined);
    const message = cleanErrorMessage(error) || "The model returned an error.";
    deadline(l, run, { status: "failed", code: "model_error", message }, "abort_retry");
}

/**
 * If the run has not ended STOP_GRACE_MS after `command` (stuck tool, wedged process, a command the
 * runtime ignores), end it with `end` and stop the process so the conversation is usable again.
 */
function deadline(l: Live, run: ResponseRun, end: RunEnd, command: string): void {
    const timer = setTimeout(() => {
        if (run.done) return;
        console.warn(`[agent] ${l.conversationId}: no end ${STOP_GRACE_MS} ms after ${command}, stopping the process`);
        void stop(l, end);
    }, STOP_GRACE_MS);
    void run.finished.then(() => clearTimeout(timer));
}

/** False when no such question is open; undefined when the answer does not fit the question. */
export function answerQuestion(userId: string, conversationId: string, r: AskResponseItem): boolean | undefined {
    const l = live.get(conversationId);
    if (!l || l.userId !== userId || !l.run) return false;
    return l.run.answerQuestion(r);
}

export function answerApproval(userId: string, conversationId: string, approvalId: string, approve: boolean): boolean {
    const l = live.get(conversationId);
    if (!l || l.userId !== userId || !l.run) return false;
    return l.run.answerApproval(approvalId, approve);
}

/** Answer an MCP elicitation the gateway put in the running response (src/mcp/interactions.ts). */
export function answerElicitation(userId: string, conversationId: string, r: McpElicitationResponseItem): boolean {
    const l = live.get(conversationId);
    if (!l || l.userId !== userId || !l.run) return false;
    return l.run.answerElicitation(r);
}

/** Stop the agent for a conversation (before delete, or when its files move). */
export async function stopConversation(conversationId: string): Promise<void> {
    const ticket = starting.get(conversationId);
    if (ticket) ticket.cancelled = true;
    abortWait(conversationId, "deleted");
    const l = live.get(conversationId);
    if (l) await stop(l);
}

/**
 * Run `fn` while the conversation is held for a change to its session file (rewind and its undo, version
 * switch; conversations/branching.ts). Throws AgentBusyError while a response runs or starts, and a prompt sent
 * during `fn` is refused the same way. The live process is stopped first: it keeps the session tree in
 * memory and would go on writing from its old leaf. The next prompt starts a process that loads the file.
 */
export async function withSessionHeld<T>(userId: string, conversationId: string, fn: () => Promise<T>): Promise<T> {
    const ticket = reserve(userId, conversationId);
    try {
        await stopIdleProcess(conversationId);
        return await fn();
    } finally {
        release(ticket);
    }
}

/**
 * Stop a conversation's idle process and wait until it has gone, so the next prompt starts one that loads the
 * session file again. The caller holds the conversation (`reserve`): an edit does this before it changes the leaf.
 */
export async function stopIdleProcess(conversationId: string): Promise<void> {
    const l = live.get(conversationId);
    if (l) await stop(l);
    await stopping.get(conversationId);
}

/** The agent's working directory for a conversation (the session header's `cwd`). */
export function agentCwd(userId: string, row: ConversationRow): string {
    return cwdFor(userId, row);
}

/** Stop every process of a user (account deleted or banned). */
export async function stopUser(userId: string): Promise<void> {
    abortUserWaits(userId, "account");
    await Promise.all([...live.values()].filter((l) => l.userId === userId).map((l) => stop(l)));
}

/** Running agent processes per user, for the admin overview. */
export function processCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const l of live.values()) counts.set(l.userId, (counts.get(l.userId) ?? 0) + 1);
    return counts;
}

/** Prompts waiting for a free agent slot, for the admin overview. */
export function queuedCount(): number {
    return waitingCount();
}

/** Where a conversation stands in the slot queue (1 is next), or undefined when it is not queued. */
export function queuedPosition(userId: string, conversationId: string): number | undefined {
    return queuePosition(userId, conversationId);
}

export async function stopAll(): Promise<void> {
    await Promise.all([...live.values()].map((l) => stop(l)));
}

// Idle reaper. It is created with this module, before any database exists (and after a failed start there never is
// one), so with no live process it must not read a setting.
setInterval(() => {
    if (live.size === 0) return;
    const limit = setting("system.agent.idleTimeoutSec") * 1000;
    const t = Date.now();
    for (const l of live.values()) {
        // isActive includes a response still starting on this process.
        if (!isActive(l.conversationId) && t - l.lastUsed > limit) {
            console.log(`[agent] stopping idle ${l.conversationId}`);
            void stop(l);
        }
    }
}, 30_000).unref();
