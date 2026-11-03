/**
 * Live responses, keyed by conversation. Server events mutate a per-conversation ResponseObject;
 * subscribers are notified at most once per animation frame so streaming stays at 60fps.
 *
 * When a response ends, the conversation's history query is refetched and the live entry is dropped
 * once the history contains it, so the thread never flickers between live and stored items.
 *
 * Every response that ends without completing carries a `chat.run_end` item as its last output item. The
 * server adds it; `endItem` adds one here when the server did not, so the thread draws one note for every
 * stopped, failed or cut-off turn, live or stored.
 */
import type {
    FunctionCallItem,
    FunctionCallOutputItem,
    MessageItem,
    OutputItem,
    ReasoningItem,
    ResponseObject,
    RunEndItem,
    ServerEvent,
} from "@pikvm/chat-protocol";
import { useSyncExternalStore } from "react";

/** Latest MCP progress of one running tool call (`chat.tool_progress`). */
export interface ToolProgress {
    progress: number;
    total?: number;
    message?: string;
}

/** A warning or message the runtime raised during the response (`chat.notice`), for example a retry or compaction. */
export interface LiveNotice {
    level: "info" | "warning" | "error";
    message: string;
}

export interface LiveState {
    response: ResponseObject;
    /** Runtime notices for this response, oldest first, without repeats. They end with the response's live entry. */
    notices?: LiveNotice[];
    /** Latest progress by `function_call` item id. Only the latest report is kept. */
    progress?: Record<string, ToolProgress>;
    /** User message shown immediately, before the server confirms. */
    pendingInput?: MessageItem;
    done: boolean;
    /** The user asked to stop; the server has not ended the response yet. */
    stopping?: boolean;
    /** The prompt waits for a free agent (`chat.queue`): 1 is next. Gone once the response starts or ends. */
    queue?: number;
}

const END_MESSAGES: Record<RunEndItem["status"], string> = {
    failed: "The response failed.",
    cancelled: "You stopped this response.",
    incomplete: "The response was cut off before it finished.",
};

/** The run-end item of an ended response: the server's, else one built from the response status and error. */
export function endItem(r: ResponseObject): RunEndItem | undefined {
    if (r.status !== "failed" && r.status !== "cancelled" && r.status !== "incomplete") return undefined;
    const last = r.output.at(-1);
    if (last?.type === "chat.run_end") return last;
    return {
        id: `run_end_${r.id}`,
        type: "chat.run_end",
        status: r.status,
        code: r.error?.code ?? (r.status === "cancelled" ? "stopped" : r.status),
        message: r.error?.message || END_MESSAGES[r.status],
    };
}

/** The response with its run-end item last, when it ended without completing. */
function withEnd(r: ResponseObject): ResponseObject {
    const end = r.local ? undefined : endItem(r);
    if (!end || r.output.at(-1) === end) return r;
    return { ...r, output: [...r.output, end] };
}

const live = new Map<string, LiveState>();
const byResponse = new Map<string, string>();
const subs = new Map<string, Set<() => void>>();
const dirty = new Set<string>();
let frame = 0;
let fallback: ReturnType<typeof setTimeout> | undefined;

/** Browsers pause animation frames in a hidden or covered tab, so a timer backs the frame up and the stream keeps moving. */
const FALLBACK_MS = 250;

function flush() {
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(fallback);
    frame = 0;
    fallback = undefined;
    for (const id of dirty) for (const fn of subs.get(id) ?? []) fn();
    dirty.clear();
}

function touch(conversationId: string) {
    const cur = live.get(conversationId);
    // New object identity per frame so React sees the change; items mutate in place.
    if (cur) live.set(conversationId, { ...cur, response: { ...cur.response, output: [...cur.response.output] } });
    dirty.add(conversationId);
    if (!frame) {
        frame = requestAnimationFrame(flush);
        fallback = setTimeout(flush, FALLBACK_MS);
    }
}

export function subscribeLive(conversationId: string, fn: () => void): () => void {
    let set = subs.get(conversationId);
    if (!set) subs.set(conversationId, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
}

export function useLive(conversationId: string | undefined): LiveState | undefined {
    return useSyncExternalStore(
        (fn) => (conversationId ? subscribeLive(conversationId, fn) : () => {}),
        () => (conversationId ? live.get(conversationId) : undefined),
    );
}

/** Latest progress report of one running tool call, if the server sent one. */
export function useToolProgress(conversationId: string | undefined, itemId: string): ToolProgress | undefined {
    return useLive(conversationId)?.progress?.[itemId];
}

export function getLive(conversationId: string): LiveState | undefined {
    return live.get(conversationId);
}

/** Show the user's message and a placeholder response before the server answers. */
export function startOptimistic(conversationId: string, input: MessageItem, model: string): void {
    live.set(conversationId, {
        response: {
            id: `pending_${input.id}`,
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "queued",
            model,
            conversation: { id: conversationId },
            output: [],
        },
        pendingInput: input,
        done: false,
    });
    touch(conversationId);
}

/** Move optimistic state from a temporary id to the real conversation id. */
export function rekey(fromId: string, toId: string): void {
    const s = live.get(fromId);
    if (!s) return;
    live.delete(fromId);
    live.set(toId, { ...s, response: { ...s.response, conversation: { id: toId } } });
    touch(toId);
    touch(fromId);
}

/**
 * End the live response as failed before it started (the server rejected the send). The user's message stays on
 * screen with the reason, so the failure shows in the thread instead of somewhere else.
 */
export function failLive(conversationId: string, error: { code: string; message: string }): void {
    const s = live.get(conversationId);
    if (!s || s.done) return;
    const response: ResponseObject = { ...s.response, status: "failed", error };
    live.set(conversationId, { ...s, response: withEnd(response), done: true, stopping: false, queue: undefined });
    touch(conversationId);
}

/** Mark a stop request on the live response, so the composer and the thread can show it at once. */
export function markStopping(conversationId: string, stopping = true): void {
    const s = live.get(conversationId);
    if (!s || s.done || !!s.stopping === stopping) return;
    live.set(conversationId, { ...s, stopping });
    touch(conversationId);
}

export function clearLive(conversationId: string): void {
    if (!live.delete(conversationId)) return;
    touch(conversationId);
}

/** Remove private response state when the authenticated account changes. */
export function clearAllLive(): void {
    const affected = new Set([...live.keys(), ...dirty]);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    live.clear();
    byResponse.clear();
    dirty.clear();
    for (const id of affected) for (const fn of subs.get(id) ?? []) fn();
}

function item<T extends OutputItem>(s: LiveState, index: number): T | undefined {
    return s.response.output[index] as T | undefined;
}

/** Apply one server event. Returns the conversation id it touched, if any. */
export function applyEvent(e: ServerEvent): string | undefined {
    switch (e.type) {
        case "response.created":
        case "response.in_progress": {
            const cid = e.response.conversation.id;
            const prev = live.get(cid);
            byResponse.set(e.response.id, cid);
            // A stop asked for before the response started still applies to it (lib/send.ts sends it again).
            const stopping = !!prev?.stopping && !prev.done;
            live.set(cid, { response: e.response, pendingInput: prev?.pendingInput, done: false, stopping });
            touch(cid);
            return cid;
        }
        case "response.completed":
        case "response.failed":
        case "response.cancelled":
        case "response.incomplete": {
            const cid = e.response.conversation.id;
            const prev = live.get(cid);
            // `chat.resume` replays the last run's end. Without a live entry for it (a fresh page load) stored
            // history already shows that end, and a repeat of an end already applied changes nothing.
            if (!prev || (prev.done && prev.response.id === e.response.id)) return undefined;
            live.set(cid, {
                response: withEnd(e.response),
                pendingInput: prev.pendingInput,
                done: true,
                notices: prev.notices,
            });
            touch(cid);
            return cid;
        }
    }
    if (e.type === "chat.queue") {
        // Only a prompt this client shows has a live entry; the position is cleared when the response starts or ends.
        const cur = live.get(e.conversation_id);
        const queue = e.position ?? undefined;
        if (!cur || cur.done || cur.queue === queue) return undefined;
        live.set(e.conversation_id, { ...cur, queue });
        touch(e.conversation_id);
        return e.conversation_id;
    }
    if (e.type === "chat.notice") {
        // Only a running response shows notices; one with no live response has no turn to put them in.
        const cid = e.conversation_id;
        const cur = cid ? live.get(cid) : undefined;
        if (!cid || !cur || cur.done || !e.message) return undefined;
        if (cur.notices?.some((n) => n.message === e.message && n.level === e.level)) return undefined;
        live.set(cid, { ...cur, notices: [...(cur.notices ?? []), { level: e.level, message: e.message }] });
        touch(cid);
        return cid;
    }
    if (!("response_id" in e)) return undefined;
    const cid = byResponse.get(e.response_id);
    const s = cid ? live.get(cid) : undefined;
    if (!cid || !s) return undefined;
    switch (e.type) {
        case "response.output_item.added":
        case "response.output_item.done":
            s.response.output[e.output_index] = structuredClone(e.item);
            break;
        case "response.output_text.delta": {
            const it = item<MessageItem>(s, e.output_index);
            const part = it?.content[e.content_index];
            if (part && part.type === "output_text") part.text += e.delta;
            break;
        }
        case "response.reasoning_text.delta": {
            const it = item<ReasoningItem>(s, e.output_index);
            if (it?.content[0]) it.content[0].text += e.delta;
            break;
        }
        case "response.function_call_arguments.delta": {
            const it = item<FunctionCallItem>(s, e.output_index);
            if (it) it.arguments += e.delta;
            break;
        }
        case "chat.function_call_output.delta": {
            const it = item<FunctionCallOutputItem>(s, e.output_index);
            if (it) {
                it.output = e.output;
                // A new array each time, so memoised subagent views see the change.
                if (e.subagents) it.subagents = e.subagents;
            }
            break;
        }
        case "chat.tool_progress":
            // A new object per report, so subscribers see the change; reports are small and replace each other.
            s.progress = { ...s.progress, [e.item_id]: { progress: e.progress, total: e.total, message: e.message } };
            break;
        default:
            return undefined;
    }
    touch(cid);
    return cid;
}
