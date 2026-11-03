/**
 * Conversations: relational metadata in the database, content in the agent session
 * JSONL under users/<id>/conversations/<cid>/. Every function takes the owner's user id and only
 * touches that user's rows.
 */
import type { ConversationSummary, OutputItem } from "@pikvm/chat-protocol";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { db, newId, now, schema } from "../db/index.ts";
import { paths } from "../paths.ts";
import { readSessionItems, forgetSession } from "./history.ts";
import { conversationSlug, pickShortId, recordSlug } from "./slug.ts";

const { conversations } = schema;

export type ConversationRow = typeof conversations.$inferSelect;

export class NotFoundError extends Error {}

export function toSummary(r: ConversationRow, active = false): ConversationSummary {
    return {
        id: r.id,
        title: r.title,
        projectId: null,
        model: r.model,
        pinnedAt: r.pinnedAt,
        archivedAt: r.archivedAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        ...(active ? { active } : {}),
        slug: conversationSlug(r),
        shortId: r.shortId,
        ...(r.forkedFrom ? { forkedFrom: r.forkedFrom } : {}),
        ...(r.snippet ? { snippet: r.snippet } : {}),
        ...(r.hasAttachments ? { hasAttachments: true } : {}),
    };
}

/** The user's conversations, newest first. */
export function listConversations(userId: string, opts: { archived?: boolean } = {}): ConversationRow[] {
    return db
        .select()
        .from(conversations)
        .where(
            and(
                eq(conversations.userId, userId),
                opts.archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt),
            ),
        )
        .orderBy(desc(conversations.updatedAt))
        .all();
}

export function getConversation(userId: string, id: string): ConversationRow {
    const r = db
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
        .get();
    if (!r) throw new NotFoundError("Conversation not found");
    return r;
}

export function createConversation(
    userId: string,
    init: {
        model?: string;
        thinking?: string;
        title?: string;
        /** A fork (branching.ts): its title stays automatic, and the row names its source. */
        fork?: { from: string };
    },
): ConversationRow {
    const id = newId();
    const t = now();
    db.insert(conversations)
        .values({
            id,
            userId,
            shortId: pickShortId(userId, id),
            title: init.title ?? "",
            titleSource: init.title && !init.fork ? "user" : "auto",
            model: init.model ?? "",
            thinking: init.thinking ?? "",
            ...(init.fork ? { forkedFrom: init.fork.from } : {}),
            createdAt: t,
            updatedAt: t,
        })
        .run();
    const row = getConversation(userId, id);
    recordSlug(userId, row);
    return row;
}

export interface ConversationPatch {
    title?: string;
    titleSource?: "auto" | "user";
    pinned?: boolean;
    archived?: boolean;
    /** Exact pin or archive time (undo). Wins over `pinned` / `archived`. */
    pinnedAt?: number | null;
    archivedAt?: number | null;
    model?: string;
    thinking?: string;
    sessionFile?: string;
    touch?: boolean;
    /** Start of the last assistant reply (snippet.ts). */
    snippet?: string;
    hasAttachments?: boolean;
}

export function updateConversation(userId: string, id: string, patch: ConversationPatch): ConversationRow {
    const cur = getConversation(userId, id);
    const t = now();
    db.update(conversations)
        .set({
            title: patch.title ?? cur.title,
            titleSource: patch.titleSource ?? (patch.title !== undefined ? "user" : cur.titleSource),
            pinnedAt:
                patch.pinnedAt !== undefined
                    ? patch.pinnedAt
                    : patch.pinned === undefined
                      ? cur.pinnedAt
                      : patch.pinned
                        ? (cur.pinnedAt ?? t)
                        : null,
            archivedAt:
                patch.archivedAt !== undefined
                    ? patch.archivedAt
                    : patch.archived === undefined
                      ? cur.archivedAt
                      : patch.archived
                        ? (cur.archivedAt ?? t)
                        : null,
            model: patch.model ?? cur.model,
            thinking: patch.thinking ?? cur.thinking,
            sessionFile: patch.sessionFile ?? cur.sessionFile,
            snippet: patch.snippet ?? cur.snippet,
            hasAttachments: patch.hasAttachments ?? cur.hasAttachments,
            updatedAt: patch.touch ? t : cur.updatedAt,
        })
        .where(eq(conversations.id, id))
        .run();
    const next = getConversation(userId, id);
    // A new slug goes into the history, so URLs with the old title keep resolving (docs/spec/chat-urls.md).
    if (conversationSlug(next) !== conversationSlug(cur)) recordSlug(userId, next);
    return next;
}

/** Delete metadata and files. The caller stops any running agent first. */
export function deleteConversation(userId: string, id: string): void {
    const row = getConversation(userId, id);
    const u = paths.user(userId);
    if (row.sessionFile) forgetSession(join(u.conversation(id), row.sessionFile));
    db.delete(conversations).where(eq(conversations.id, id)).run();
    rmSync(u.conversation(id), { recursive: true, force: true });
    rmSync(u.chatWorkspace(id), { recursive: true, force: true });
}

export function sessionFilePath(userId: string, row: ConversationRow): string | undefined {
    return row.sessionFile ? join(paths.user(userId).conversation(row.id), row.sessionFile) : undefined;
}

export async function conversationItems(
    userId: string,
    id: string,
    page: { before?: string; limit?: number } = {},
): Promise<{ items: OutputItem[]; hasMore: boolean }> {
    const row = getConversation(userId, id);
    const file = sessionFilePath(userId, row);
    const all = file ? await readSessionItems(file, id) : [];
    let end = all.length;
    if (page.before) {
        const i = all.findIndex((it) => it.id === page.before);
        if (i >= 0) end = i;
    }
    const limit = page.limit ?? end;
    const start = Math.max(0, end - limit);
    return { items: all.slice(start, end), hasMore: start > 0 };
}
