/**
 * Sending a message: optimistic user message + live placeholder, then response.create over the socket.
 * New conversations get a temporary id that is re-keyed when chat.conversation.created arrives.
 *
 * Socket `error` events carry no conversation id. Only the sending socket gets them, so the oldest send that has
 * not started yet owns the next error that a send can cause (`isSendError`). A rejected send ends its live turn as
 * failed with the reason (live.ts `failLive`), so the thread shows it instead of a toast.
 *
 * Stop: `stopResponse` marks the live turn as stopping at once, then cancels. A stop asked for while a new chat
 * has no real id yet waits for chat.conversation.created. A stop that reaches the server before the run exists
 * (the sandbox is still starting, `no_active_response`) is sent again when the response starts.
 */
import type {
    InputFile,
    InputImage,
    InputText,
    McpElicitationValue,
    MessageItem,
    ServerEvent,
    ThinkingSelector,
} from "@pikvm/chat-protocol";
import { failLive, getLive, markStopping, rekey, startOptimistic } from "./live";
import { markConversationIdle } from "./queries";
import { socket } from "./socket";

export interface SendOptions {
    conversationId?: string;
    text: string;
    attachments?: (InputImage | InputFile)[];
    model?: string;
    effort?: ThinkingSelector;
    permission?: "default" | "full";
    /** Temporary id for a new conversation; the caller passes it to `stopResponse` before the real id exists. */
    tempId?: string;
    /** Send as a new version of this stored user message (thread/branch-actions.ts `sendEdit`). */
    editOf?: string;
}

export interface SendHooks {
    /** The server started the response. */
    onAccepted?: () => void;
    /** The server rejected the send before a response started. The live turn already shows the reason. */
    onRejected?: (message: string) => void;
}

/** Errors from approval, question, cancel and resume requests. They never belong to a send. */
const NOT_SEND_ERRORS = new Set([
    "approval_not_found",
    "question_not_found",
    "invalid_answer",
    "missing_conversation",
    "no_active_response",
]);

/** True for a socket error that a `response.create` with a message can cause. */
export function isSendError(e: ServerEvent): e is Extract<ServerEvent, { type: "error" }> {
    if (e.type !== "error" || NOT_SEND_ERRORS.has(e.error.code)) return false;
    // chat.resume of a deleted chat answers conversation_not_found without a param; a send names the field.
    return !(e.error.code === "conversation_not_found" && !e.error.param);
}

/** How long a send waits for the conversation to be created, and for the response to start. */
const CREATE_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 180_000;

interface Flight {
    /** Live key: the temporary id until the conversation exists, then the real id. */
    key: string;
    created: boolean;
    stop: boolean;
}

/** Sends that have not started yet, oldest first. */
const flights: Flight[] = [];
/** Conversations with a stop request the server has not confirmed yet. */
const stops = new Set<string>();
/** Stops the server answered with no_active_response while the response was still starting: sent again once it starts. */
const early = new Set<string>();
let listening = false;

function listen(): void {
    if (listening) return;
    listening = true;
    socket.on((e) => {
        if (e.type === "response.created" || e.type === "response.in_progress") {
            // The run exists now: a stop the server could not apply yet is sent again (once; both events arrive).
            const cid = e.response.conversation.id;
            if (stops.has(cid) && early.delete(cid)) socket.send({ type: "response.cancel", conversation: cid });
        } else if (/^response\.(completed|failed|cancelled|incomplete)$/.test(e.type) && "response" in e) {
            stops.delete(e.response.conversation.id);
            early.delete(e.response.conversation.id);
        } else if (e.type === "error" && e.error.code === "no_active_response") {
            // Nothing was running. Keep the request where a response is still on its way; drop it elsewhere.
            for (const cid of [...stops]) {
                const s = getLive(cid);
                if (s && !s.done) {
                    early.add(cid);
                    continue;
                }
                stops.delete(cid);
                markStopping(cid, false);
            }
        }
    });
}

/** Resolves with the real conversation id (immediately for existing conversations). */
export function sendMessage(o: SendOptions, hooks: SendHooks = {}): Promise<string> {
    listen();
    const content: MessageItem["content"] = [];
    if (o.text.trim()) content.push({ type: "input_text", text: o.text } satisfies InputText);
    content.push(...(o.attachments ?? []));
    const tempId = o.conversationId ?? o.tempId ?? `tmp_${crypto.randomUUID()}`;
    const input: MessageItem = {
        id: `local_${crypto.randomUUID()}`,
        type: "message",
        role: "user",
        status: "completed",
        content,
        created_at: Date.now(),
    };
    startOptimistic(tempId, input, o.model ?? "");
    // A new send replaces the live turn, so an older stop request no longer applies.
    stops.delete(tempId);
    early.delete(tempId);
    const flight: Flight = { key: tempId, created: !!o.conversationId, stop: false };
    flights.push(flight);

    return new Promise((resolve, reject) => {
        let createTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
            off();
            clearTimeout(createTimer);
            clearTimeout(startTimer);
            const at = flights.indexOf(flight);
            if (at >= 0) flights.splice(at, 1);
        };
        const fail = (code: string, message: string) => {
            finish();
            failLive(flight.key, { code, message });
            if (flight.created) markConversationIdle(flight.key);
            hooks.onRejected?.(message);
            if (!flight.created) reject(new Error(message));
        };
        // Registered per send (after the socket is wired), so tests that wrap socket.on see this listener.
        const off = socket.on((e: ServerEvent) => {
            if (e.type === "chat.conversation.created" && !flight.created && e.client_conversation_id === tempId) {
                clearTimeout(createTimer);
                flight.created = true;
                flight.key = e.conversation.id;
                rekey(tempId, e.conversation.id);
                resolve(e.conversation.id);
                if (flight.stop) stopResponse(e.conversation.id);
            } else if (
                (e.type === "response.created" || e.type === "response.in_progress") &&
                flight.created &&
                e.response.conversation.id === flight.key
            ) {
                finish();
                hooks.onAccepted?.();
            } else if (isSendError(e) && flights[0] === flight) {
                fail(e.error.code, e.error.message);
            }
        });
        if (!flight.created) {
            createTimer = setTimeout(
                () => fail("timeout", "The server did not create the conversation. Try again."),
                CREATE_TIMEOUT_MS,
            );
        }
        // Stop listening for a start that never comes; the live turn stays as the server left it.
        const startTimer = setTimeout(finish, START_TIMEOUT_MS);
        if (o.conversationId) resolve(o.conversationId);

        socket.send({
            type: "response.create",
            conversation: o.conversationId,
            model: o.model,
            reasoning: o.effort ? { effort: o.effort } : undefined,
            input: [{ type: "message", role: "user", content: content as (InputText | InputImage | InputFile)[] }],
            metadata: {
                permission: o.permission,
                client_conversation_id: o.conversationId ? undefined : tempId,
                edit_of: o.conversationId ? o.editOf : undefined,
            },
        });
    });
}

/**
 * Stop the running response of a conversation. `key` may be the temporary id of a new chat: the stop then waits
 * for the real id. Calling it again while stopping sends the cancel again.
 */
export function stopResponse(key: string): void {
    listen();
    markStopping(key);
    const pending = flights.find((f) => f.key === key && !f.created);
    if (pending) {
        pending.stop = true;
        return;
    }
    stops.add(key);
    socket.send({ type: "response.cancel", conversation: key });
}

export function answerApproval(conversationId: string, approvalId: string, approve: boolean): void {
    socket.send({
        type: "response.create",
        conversation: conversationId,
        input: [{ type: "mcp_approval_response", approval_request_id: approvalId, approve }],
    });
}

/** Answer an MCP elicitation (a form or a link request from an MCP server). */
export function answerElicitation(
    conversationId: string,
    elicitationId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, McpElicitationValue>,
): void {
    socket.send({
        type: "response.create",
        conversation: conversationId,
        input: [{ type: "chat.mcp_elicitation_response", elicitation_id: elicitationId, action, content }],
    });
}
