/**
 * Sources of `chat.sync` events (packages/protocol/src/realtime.ts, docs/spec/realtime.md).
 *
 * - `syncMutations`: Hono middleware. After a successful write to a route that has no specific socket event of
 *   its own, it tells the user's other tabs what changed. One table (`ROUTE_SCOPES`) is the whole mapping.
 * - `watchSettings`: every committed settings write, whoever made it.
 *
 * Events name a scope and never carry values. A user key change (`users.<id>.`) reaches that user only. A global
 * key change reaches every connected user, because it can change their effective values; the event still holds
 * no key and no value. Admin routes (`/admin/*`) emit nothing themselves.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { USERS_PREFIX, type SyncScope } from "@pikvm/chat-protocol";
import type { MiddlewareHandler } from "hono";
import { onSettingsChange } from "../settings/store.ts";
import type { Env } from "./context.ts";
import { emitSync, emitSyncAll } from "./hub.ts";

/** Header a tab sends so it can skip the sync event for its own write. */
export const TAB_HEADER = "x-chat-tab";

interface Rule {
    /** Matches the path after `/api`. */
    path: RegExp;
    scope: SyncScope;
    /** Capture group 1 of `path` is the conversation id. */
    conversation?: boolean;
}

/** Conversation metadata keeps its specific events; these are the writes that have none. */
const ROUTE_SCOPES: readonly Rule[] = [
    { path: /^\/uploads(\/|$)/, scope: "uploads" },
    { path: /^\/drafts(\/|$)/, scope: "drafts" },
    {
        path: /^\/conversations\/([^/]+)\/(fork|rewind|rewind\/undo)$/,
        scope: "conversation",
        conversation: true,
    },
    { path: /^\/conversations\/([^/]+)\/mcp$/, scope: "settings" },
    { path: /^\/mcp\/servers(\/|$)/, scope: "settings" },
];

export function scopesFor(method: string, path: string): { scope: SyncScope; conversationId?: string }[] {
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return [];
    const rest = path.replace(/^\/api/, "");
    return ROUTE_SCOPES.flatMap((rule) => {
        const m = rule.path.exec(rest);
        if (!m) return [];
        return [
            { scope: rule.scope, ...(rule.conversation ? { conversationId: decodeURIComponent(m[1]!) } : {}) },
        ];
    });
}

/** Merge bursts (typing in a draft) into one event per user, scope and chat. */
const COALESCE_MS = 150;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function queueSync(userId: string, scope: SyncScope, conversationId?: string, origin?: string): void {
    const key = `${userId}\n${scope}\n${conversationId ?? ""}\n${origin ?? ""}`;
    if (pending.has(key)) return;
    pending.set(
        key,
        setTimeout(() => {
            pending.delete(key);
            emitSync(userId, scope, {
                ...(conversationId ? { conversation_id: conversationId } : {}),
                ...(origin ? { origin } : {}),
            });
        }, COALESCE_MS),
    );
}

/** An origin id is opaque to the server. Only a short, plain value is echoed back. */
const ORIGIN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The tab behind the request being handled. A settings write reaches `watchSettings` through a store listener, far from
 * the request, so the origin travels in async context instead of through every settings call.
 */
const requestOrigin = new AsyncLocalStorage<string | undefined>();

export const syncMutations: MiddlewareHandler<Env> = async (c, next) => {
    const tab = c.req.header(TAB_HEADER);
    const origin = tab && ORIGIN.test(tab) ? tab : undefined;
    await requestOrigin.run(origin, next);
    const user = c.get("user");
    if (!user || c.res.status >= 400) return;
    const rules = scopesFor(c.req.method, c.req.path);
    if (!rules.length) return;
    for (const r of rules) queueSync(user.id, r.scope, r.conversationId, origin);
};

/** Split `users.<id>.<rest>` keys; a key without the prefix is global. */
function ownerOf(key: string): string | undefined {
    const [head, id] = key.split(".");
    return head === USERS_PREFIX && id ? id : undefined;
}

const settingsPending = new Map<string, ReturnType<typeof setTimeout>>();

/** Emit `settings` for each committed settings write. Call once at server start. */
export function watchSettings(): void {
    onSettingsChange((key) => {
        const owner = ownerOf(key);
        // Only a user key can name its writer's tab: a global change reaches every user, and one tab id means
        // nothing to another user. The origin is part of the key so two tabs' writes stay two events.
        const origin = owner ? requestOrigin.getStore() : undefined;
        const target = `${owner ?? "*"}\n${origin ?? ""}`;
        if (settingsPending.has(target)) return;
        settingsPending.set(
            target,
            setTimeout(() => {
                settingsPending.delete(target);
                if (owner) emitSync(owner, "settings", origin ? { origin } : {});
                else emitSyncAll("settings");
            }, COALESCE_MS),
        );
    });
}
