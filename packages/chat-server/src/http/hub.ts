/**
 * Fan-out of server events to every open WebSocket (tabs, devices) of a user.
 *
 * Application events (conversation lists, sync) carry `app_seq`, a counter per user. A client that reconnects
 * compares it with the one in `chat.hello` and refetches when it missed events. Response events are not counted:
 * a client re-asks for them with `chat.resume`.
 */
import type { ChatSyncEvent, ServerEvent, SyncScope } from "@pikvm/chat-protocol";
import type { WebSocket } from "ws";

export interface SocketData {
    userId: string;
}

/** An open `ws` socket with the data the hub keeps for it. */
export type ChatSocket = WebSocket & { data: SocketData };

type Outgoing = ServerEvent | Omit<ServerEvent, "sequence_number">;

/** Changes with every server start, so a client can tell "the server restarted" from "I missed events". */
export const SERVER_ID = crypto.randomUUID();

const COUNTED = new Set<string>([
    "chat.conversation.created",
    "chat.conversation.updated",
    "chat.conversation.deleted",
    "chat.models.updated",
    "chat.sync",
]);

const sockets = new Map<string, Set<ChatSocket>>();
const counters = new Map<string, number>();

export function appSeq(userId: string): number {
    return counters.get(userId) ?? 0;
}

function encode(userId: string | undefined, event: Outgoing): string {
    if (userId && COUNTED.has(event.type)) {
        const next = appSeq(userId) + 1;
        counters.set(userId, next);
        return JSON.stringify({ sequence_number: 0, app_seq: next, ...event });
    }
    return JSON.stringify({ sequence_number: 0, ...event });
}

export function addSocket(ws: ChatSocket): void {
    let set = sockets.get(ws.data.userId);
    if (!set) sockets.set(ws.data.userId, (set = new Set()));
    set.add(ws);
    // The first event of every socket. Sent before any other event can reach it (this function is synchronous).
    sendTo(ws, { type: "chat.hello", user_id: ws.data.userId, server_id: SERVER_ID, app_seq: appSeq(ws.data.userId) });
}

export function removeSocket(ws: ChatSocket): void {
    const set = sockets.get(ws.data.userId);
    set?.delete(ws);
    if (set && set.size === 0) sockets.delete(ws.data.userId);
}

/** The user has at least one open socket. */
export function hasSockets(userId: string): boolean {
    return (sockets.get(userId)?.size ?? 0) > 0;
}

export function sendTo(ws: ChatSocket, event: Outgoing): void {
    ws.send(JSON.stringify({ sequence_number: 0, ...event }));
}

export function broadcast(userId: string, event: Outgoing): void {
    const set = sockets.get(userId);
    // Nobody is connected: the counter still moves, so a client that reconnects later sees it missed events.
    const data = encode(userId, event);
    if (!set) return;
    for (const ws of set) ws.send(data);
}

/**
 * Send one event to every connected user, one by one, so counted events move each user's counter and a tab that
 * misses the event can tell. A user with no open socket is not reached; a tab that connects later refetches.
 */
export function broadcastEach(event: Outgoing): void {
    for (const userId of [...sockets.keys()]) broadcast(userId, event);
}

/** Send one event to every connected user (events without user data). */
export function broadcastAll(event: Outgoing): void {
    const data = JSON.stringify({ sequence_number: 0, ...event });
    for (const set of sockets.values()) for (const ws of set) ws.send(data);
}

/** Tell every tab of one user that `scope` changed. */
export function emitSync(
    userId: string,
    scope: SyncScope,
    extra: Pick<ChatSyncEvent, "conversation_id" | "origin"> = {},
): void {
    broadcast(userId, { type: "chat.sync", scope, ...extra });
}

/** Tell every connected user that `scope` changed (a global setting). The event holds no value. */
export function emitSyncAll(scope: SyncScope): void {
    for (const userId of sockets.keys()) emitSync(userId, scope);
}
