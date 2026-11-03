/**
 * Realtime sync events (docs/spec/realtime.md).
 *
 * The server sends these on the same `/v1/responses` socket as response events. They never carry user data:
 * a `chat.sync` event only names what changed, and the client refetches it through the normal REST route, so
 * the access checks of that route apply. Events go to the sockets of one user only (`broadcast` in the server
 * hub); the single instance-wide case is a change to a global setting, and it carries no value.
 */

/** What changed. Each scope maps to a group of client queries (apps/web/src/lib/realtime.ts). */
export const SYNC_SCOPES = [
    "settings",
    "projects",
    "memories",
    "uploads",
    "files",
    "agents",
    "drafts",
    "conversation",
    "search",
    "everything",
] as const;
export type SyncScope = (typeof SYNC_SCOPES)[number];

/**
 * Sent once when a socket opens. `server_id` changes when the server restarts. `app_seq` is the user's current
 * application event counter: a client that last saw a lower number, or another `server_id`, missed events and
 * refetches everything (the full refetch fallback).
 */
export interface ChatHelloEvent {
    type: "chat.hello";
    user_id: string;
    server_id: string;
    app_seq: number;
}

/**
 * Something changed outside the specific events (`chat.conversation.*`, `chat.reactions.updated`).
 * `conversation_id` is set for the `conversation` scope: that chat's stored history changed (rewind, undo).
 * `origin` echoes the `x-chat-tab` request header of the tab that made the change. That tab skips other scopes,
 * but applies `search` because a source mutation does not update its search query.
 */
export interface ChatSyncEvent {
    type: "chat.sync";
    scope: SyncScope;
    conversation_id?: string;
    origin?: string;
}
