/**
 * Realtime sync: keeps the query cache of every tab current with changes made in other tabs and devices of the
 * same account (docs/spec/realtime.md). Specific changes (chat created, renamed, deleted, reacted to, streaming)
 * already arrive as their own events and are applied by queries.ts and live.ts. This module handles the rest:
 *
 * - `chat.sync`: a scope changed (projects, memories, uploads, settings ...). The matching queries are marked
 *   stale and the mounted ones refetch. The event holds no data, so the REST route's access check still applies.
 * - `chat.hello` and `app_seq`: resync after a missed event. A reconnect to another server instance, or a counter
 *   ahead of the last one seen, refetches everything. This is the full refetch fallback.
 * - A response started in another tab: its stored history is refetched, so this tab shows the user message.
 * - `chat.hello.user_id` must match the signed-in user, else the socket is dropped and the session is checked.
 *
 * Account safety: all state here is private to one account and is cleared by the session reset registry.
 */
import type { ServerEvent, SyncScope } from "@pikvm/chat-protocol";
import { TAB_ID } from "./api";
import { getLive } from "./live";
import { keys, queryClient } from "./queries";
import { registerSessionReset } from "./session-reset";
import { socket } from "./socket";
import type { Bootstrap } from "./types";

type Key = readonly unknown[];

/** Query keys each scope marks stale. `conversation` and `everything` are handled in `applySync`. */
const SCOPE_KEYS: Record<Exclude<SyncScope, "conversation" | "everything">, readonly Key[]> = {
    settings: [keys.settings, keys.bootstrap, ["avatar"], ["mcp"], ["speech"]],
    projects: [["conversations"]],
    memories: [["memories"]],
    uploads: [["uploads"], ["files"]],
    files: [["files"], ["uploads"]],
    agents: [["agents"]],
    drafts: [["drafts", "list"]],
    search: [["search"]],
};

let serverId: string | undefined;
let lastSeq = 0;
let started = false;
/** Responses started elsewhere whose stored history this tab has not refetched yet, by response id. */
const awaitingItem = new Map<string, string>();

registerSessionReset("realtime", () => {
    serverId = undefined;
    lastSeq = 0;
    awaitingItem.clear();
});

function refetchAll(): void {
    void queryClient.invalidateQueries();
}

export function applySync(scope: SyncScope, conversationId?: string): void {
    if (scope === "everything") return refetchAll();
    if (scope === "conversation") {
        if (conversationId) {
            void queryClient.invalidateQueries({ queryKey: keys.items(conversationId) });
            void queryClient.invalidateQueries({ queryKey: keys.conversation(conversationId) });
        }
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        void queryClient.invalidateQueries({ queryKey: ["search"] });
        return;
    }
    for (const queryKey of SCOPE_KEYS[scope]) void queryClient.invalidateQueries({ queryKey });
}

function onHello(e: Extract<ServerEvent, { type: "chat.hello" }>): void {
    const user = queryClient.getQueryData<Bootstrap>(keys.bootstrap)?.user;
    if (user && user.id !== e.user_id) {
        // This socket belongs to another account than the one on screen. Drop it and let the session check decide.
        socket.disconnect();
        void queryClient.invalidateQueries({ queryKey: keys.bootstrap });
        return;
    }
    const first = serverId === undefined;
    const missed = !first && (serverId !== e.server_id || e.app_seq > lastSeq);
    serverId = e.server_id;
    lastSeq = e.app_seq;
    // The first hello of a page load has nothing to compare with; mounted queries fetch on their own.
    if (missed) refetchAll();
}

function onEvent(e: ServerEvent): void {
    if (e.type === "chat.hello") return onHello(e);
    if (e.app_seq !== undefined) {
        if (e.app_seq > lastSeq + 1 && serverId !== undefined) refetchAll();
        lastSeq = Math.max(lastSeq, e.app_seq);
    }
    switch (e.type) {
        case "chat.sync":
            if (e.scope === "search" || e.origin !== TAB_ID) applySync(e.scope, e.conversation_id);
            return;
        case "chat.conversation.created":
        case "chat.conversation.updated":
        case "chat.conversation.deleted":
            applySync("search");
            return;
        case "response.created": {
            // A turn another tab started: the live entry has no optimistic message, so fetch the stored one.
            const cid = e.response.conversation.id;
            const live = getLive(cid);
            if (live && !live.pendingInput && !live.done) awaitingItem.set(e.response.id, cid);
            return;
        }
        case "response.output_item.added": {
            // The first output means the runtime stored the user message.
            const cid = awaitingItem.get(e.response_id);
            if (!cid) return;
            awaitingItem.delete(e.response_id);
            void queryClient.invalidateQueries({ queryKey: keys.items(cid) });
            return;
        }
        case "response.completed":
        case "response.failed":
        case "response.cancelled":
        case "response.incomplete":
            awaitingItem.delete(e.response.id);
            return;
    }
}

/** Idempotent. Call after `wireSocket()` so the cache bridge sees each event first. */
export function startRealtime(): void {
    if (started) return;
    started = true;
    socket.on(onEvent);
}
