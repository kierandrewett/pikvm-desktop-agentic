/**
 * Per-chat MCP server switches (`mcp_chat_servers`). A server is on in a chat unless a row turns it off. The gateway
 * reads this on every `tools/list` and `tools/call`, so a switch applies to the next call without a restart.
 */
import { and, eq } from "drizzle-orm";
import { getConversation } from "../conversations/service.ts";
import { db, now, schema } from "../db/index.ts";

const t = schema.mcpChatServers;

export function chatServerEnabled(conversationId: string | undefined, serverId: string): boolean {
    if (!conversationId) return true;
    const row = db
        .select({ enabled: t.enabled })
        .from(t)
        .where(and(eq(t.conversationId, conversationId), eq(t.serverId, serverId)))
        .get();
    return row?.enabled ?? true;
}

/** Switches for one of the user's conversations, by server id. Throws NotFoundError for someone else's chat. */
export function chatServers(userId: string, conversationId: string): Record<string, boolean> {
    getConversation(userId, conversationId);
    return Object.fromEntries(
        db
            .select()
            .from(t)
            .where(eq(t.conversationId, conversationId))
            .all()
            .map((r) => [r.serverId, r.enabled]),
    );
}

export function setChatServer(userId: string, conversationId: string, serverId: string, enabled: boolean): void {
    getConversation(userId, conversationId);
    if (enabled) {
        db.delete(t)
            .where(and(eq(t.conversationId, conversationId), eq(t.serverId, serverId)))
            .run();
        return;
    }
    const row = { conversationId, serverId, enabled, updatedAt: now() };
    db.insert(t)
        .values(row)
        .onConflictDoUpdate({ target: [t.conversationId, t.serverId], set: row })
        .run();
}

/** The conversation id from the gateway header, when it is one of this user's conversations. */
export function ownedConversation(userId: string, id: string | null): string | undefined {
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return undefined;
    try {
        getConversation(userId, id);
        return id;
    } catch {
        return undefined;
    }
}
