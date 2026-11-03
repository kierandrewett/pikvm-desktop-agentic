/**
 * `/api/drafts`: the signed-in user's unsent composer drafts, so a prompt follows them across devices.
 * Contract: packages/protocol/src/drafts.ts. Strictly per user: every query is keyed by the caller's id, and a
 * conversation scope must be one of the caller's own, non-temporary conversations.
 *
 * - GET /drafts?scope=...   one draft, or null (200: "none yet" is an answer, not a failed request)
 * - GET /drafts             the caller's drafts without content (sidebar marker)
 * - PUT /drafts             upsert { scope, text, attachments, baseUpdatedAt? }
 * - DELETE /drafts?scope=... clear the content and retain its revision
 * Empty rows prevent stale conditional writes from restoring cleared text. Public reads and lists omit them;
 * GET with revision=1 returns them for synchronisation. User/conversation deletion removes rows by cascade.
 * Home/project revision rows have no expiry. Draft storage currently has per-body limits, not a total quota.
 */
import {
    DRAFT_ATTACHMENTS_MAX,
    DRAFT_SCOPE,
    DRAFT_TEXT_MAX,
    type DraftImageAttachment,
    type DraftList,
    type ServerDraft,
} from "@pikvm/chat-protocol";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { getConversation } from "../conversations/service.ts";
import { db, now, schema } from "../db/index.ts";
import { body, requireUser, type Env } from "./context.ts";

const Attachment = z.discriminatedUnion("kind", [
    z.object({
        id: z.string().max(128),
        kind: z.literal("image"),
        name: z.string().max(512),
        url: z.string().startsWith("data:image/"),
        marker: z.string().max(64).optional(),
    }),
    z.object({
        id: z.string().max(128),
        kind: z.literal("file"),
        name: z.string().max(512),
        size: z.number().int().min(0),
        uploadId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        marker: z.string().max(64).optional(),
    }),
]);

const Write = z.object({
    scope: z.string().regex(DRAFT_SCOPE),
    text: z.string().max(DRAFT_TEXT_MAX),
    attachments: z.array(Attachment).max(20).default([]),
    baseUpdatedAt: z.number().int().nonnegative().optional(),
});

const ScopeQuery = z.object({ scope: z.string().regex(DRAFT_SCOPE) });

/** The conversation a scope names (checked to be the caller's), or null for home scopes. */
function conversationOf(userId: string, scope: string): string | null {
    if (!scope.startsWith("conv:")) return null;
    const id = scope.slice(5);
    getConversation(userId, id); // 404 for a missing conversation
    return id;
}

function view(row: typeof schema.drafts.$inferSelect): ServerDraft {
    let attachments: DraftImageAttachment[] = [];
    try {
        attachments = JSON.parse(row.attachments) as DraftImageAttachment[];
    } catch {
        // A damaged row loses its attachments, not its text.
    }
    return { scope: row.scope, text: row.text, attachments, updatedAt: row.updatedAt };
}

/** Empty rows retain the revision so an older request cannot recreate a cleared draft. */
function saveDraft(
    userId: string,
    scope: string,
    text: string,
    attachments: string,
    baseUpdatedAt?: number,
): ServerDraft {
    const conversationId = conversationOf(userId, scope);
    const where = and(eq(schema.drafts.userId, userId), eq(schema.drafts.scope, scope));
    const current = db.select().from(schema.drafts).where(where).get();
    if (baseUpdatedAt !== undefined && baseUpdatedAt !== (current?.updatedAt ?? 0)) {
        throw new HTTPException(409, { message: "Draft changed on another device" });
    }
    const row = {
        userId,
        scope,
        conversationId,
        text,
        attachments,
        updatedAt: Math.max(now(), (current?.updatedAt ?? 0) + 1),
    };
    db.insert(schema.drafts)
        .values(row)
        .onConflictDoUpdate({
            target: [schema.drafts.userId, schema.drafts.scope],
            set: { text, attachments, updatedAt: row.updatedAt },
        })
        .run();
    return view(row);
}

export const draftRoutes = new Hono<Env>()
    .use("/drafts", async (c, next) => {
        const expectedUser = c.req.header("x-chat-draft-user");
        if (expectedUser && requireUser(c).id !== expectedUser) {
            throw new HTTPException(409, { message: "Draft belongs to another account" });
        }
        await next();
    })
    .get("/drafts", (c) => {
        const user = requireUser(c);
        const scope = c.req.query("scope");
        if (scope !== undefined) {
            const q = ScopeQuery.parse({ scope });
            const row = db
                .select()
                .from(schema.drafts)
                .where(and(eq(schema.drafts.userId, user.id), eq(schema.drafts.scope, q.scope)))
                .get();
            if (!row) return c.json(null);
            if (!row.text.trim() && row.attachments === "[]" && c.req.query("revision") !== "1") {
                return c.json(null);
            }
            return c.json(view(row));
        }
        const rows = db
            .select({
                scope: schema.drafts.scope,
                conversationId: schema.drafts.conversationId,
                updatedAt: schema.drafts.updatedAt,
            })
            .from(schema.drafts)
            .where(
                and(
                    eq(schema.drafts.userId, user.id),
                    sql`(trim(${schema.drafts.text}) <> '' OR ${schema.drafts.attachments} <> '[]')`,
                ),
            )
            .orderBy(desc(schema.drafts.updatedAt))
            .all();
        return c.json({ drafts: rows } satisfies DraftList);
    })
    .put("/drafts", async (c) => {
        const user = requireUser(c);
        const w = await body(c, Write);
        const attachments = JSON.stringify(w.attachments);
        if (attachments.length > DRAFT_ATTACHMENTS_MAX)
            throw new HTTPException(413, { message: "Attachments too large" });
        const row = saveDraft(user.id, w.scope, w.text, attachments, w.baseUpdatedAt);
        return !w.text.trim() && !w.attachments.length && w.baseUpdatedAt === undefined
            ? c.body(null, 204)
            : c.json(row);
    })
    .delete("/drafts", (c) => {
        const user = requireUser(c);
        const q = ScopeQuery.parse({ scope: c.req.query("scope") });
        // Deleting an unknown scope is harmless, including another user's conversation scope.
        const current = db
            .select()
            .from(schema.drafts)
            .where(and(eq(schema.drafts.userId, user.id), eq(schema.drafts.scope, q.scope)))
            .get();
        if (current) saveDraft(user.id, q.scope, "", "[]");
        return c.body(null, 204);
    });
