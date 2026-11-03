/**
 * Human conversation URLs (docs/spec/chat-urls.md): the title slug, the short id taken from the UUID, the
 * slug history that keeps old URLs working, and resolution of an incoming `/c/<ref>`. Every function is
 * scoped to one user; nothing here reads another user's rows.
 */
import { conversationPath, splitConversationRef } from "@pikvm/chat-protocol/chat-urls";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, now, schema } from "../db/index.ts";

const { conversations, conversationSlugs } = schema;

/** Slug of an untitled chat. */
export const UNTITLED_SLUG = "new-chat";
/** Slug of a titled chat whose title has no Latin letters or digits (emoji, CJK, Cyrillic). */
export const UNSLUGGABLE_SLUG = "chat";
/** Slugs shared by many chats. They are never written to the history, so they never resolve on their own. */
const NEUTRAL = new Set([UNTITLED_SLUG, UNSLUGGABLE_SLUG]);

const MAX_SLUG = 60;

/** Letters that NFKD does not split into a base letter plus a mark. */
const FOLD: Record<string, string> = {
    ß: "ss",
    æ: "ae",
    ø: "o",
    œ: "oe",
    ł: "l",
    đ: "d",
    ð: "d",
    þ: "th",
    ı: "i",
};
const FOLD_RE = new RegExp(`[${Object.keys(FOLD).join("")}]`, "g");

/** Slug for a title: lowercase ASCII words joined by `-`, at most 60 characters, cut on a word boundary. */
export function titleSlug(title: string): string {
    if (!title.trim()) return UNTITLED_SLUG;
    let s = title
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(FOLD_RE, (ch) => FOLD[ch]!)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (s.length > MAX_SLUG) {
        const cut = s.lastIndexOf("-", MAX_SLUG);
        s = cut > 0 ? s.slice(0, cut) : s.slice(0, MAX_SLUG);
    }
    return s || UNSLUGGABLE_SLUG;
}

/** The slug a conversation shows in its URL. */
export function conversationSlug(row: { title: string }): string {
    return titleSlug(row.title);
}

/**
 * Short id candidates for a conversation id, shortest first. A UUIDv7 starts with a millisecond timestamp,
 * so ids created close together share a prefix; the candidates come from the random tail instead. Ids that
 * are not UUIDs (rows from seed scripts) use a hash of the id, so the candidates are still hex.
 */
export function shortIdCandidates(id: string): string[] {
    const plain = id.replace(/-/g, "").toLowerCase();
    const hex = /^[0-9a-f]{32}$/.test(plain) ? plain : createHash("sha256").update(id).digest("hex").slice(0, 32);
    return [6, 8, 10, 12, 32].map((n) => hex.slice(-n));
}

/** First candidate no other conversation of this user holds. The unique index backs this up. */
export function pickShortId(userId: string, id: string): string {
    const candidates = shortIdCandidates(id);
    const taken = new Set(
        db
            .select({ shortId: conversations.shortId })
            .from(conversations)
            .where(and(eq(conversations.userId, userId), inArray(conversations.shortId, candidates)))
            .all()
            .map((r) => r.shortId),
    );
    const free = candidates.find((c) => !taken.has(c));
    // The 32-character form is the whole id, which only this conversation has.
    return free ?? candidates.at(-1)!;
}

/**
 * Record that a conversation took a slug. Taking it again moves its time forward, so the newest holder wins
 * a slug-only lookup. Neutral slugs are never recorded.
 */
export function recordSlug(userId: string, row: { id: string; title: string }): void {
    const slug = conversationSlug(row);
    if (NEUTRAL.has(slug)) return;
    db.insert(conversationSlugs)
        .values({ userId, conversationId: row.id, slug, createdAt: now() })
        .onConflictDoUpdate({
            target: [conversationSlugs.userId, conversationSlugs.slug, conversationSlugs.conversationId],
            set: { createdAt: now() },
        })
        .run();
}

/**
 * Give every conversation without a short id one, oldest first, and seed its slug history with the current
 * title. Runs at startup: it covers rows from before the column existed and rows inserted outside the service.
 */
export function backfillShortIds(): number {
    const rows = db
        .select({
            id: conversations.id,
            userId: conversations.userId,
            title: conversations.title,
        })
        .from(conversations)
        .where(isNull(conversations.shortId))
        .orderBy(asc(conversations.createdAt), asc(conversations.id))
        .all();
    for (const r of rows) {
        db.update(conversations)
            .set({ shortId: pickShortId(r.userId, r.id) })
            .where(eq(conversations.id, r.id))
            .run();
        recordSlug(r.userId, r);
    }
    if (rows.length) console.log(`[chat-urls] assigned short ids to ${rows.length} conversations`);
    return rows.length;
}

export interface ResolvedRef {
    id: string;
    path: string;
    /** How the ref matched, for tests and logs. */
    via: "uuid" | "short" | "slug";
}

/**
 * Resolve `/c/<ref>` for one user: UUID, then the trailing short id, then the slug history. Undefined when
 * nothing of this user's matches.
 */
export function resolveConversationRef(userId: string, ref: string): ResolvedRef | undefined {
    const parts = splitConversationRef(ref);
    const select = () =>
        db
            .select({
                id: conversations.id,
                title: conversations.title,
                    shortId: conversations.shortId,
            })
            .from(conversations);
    const found = (
        row: { id: string; title: string; shortId: string | null } | undefined,
        via: ResolvedRef["via"],
    ): ResolvedRef | undefined =>
        row && {
            id: row.id,
            path: conversationPath({ id: row.id, slug: conversationSlug(row), shortId: row.shortId }),
            via,
        };

    if (parts.uuid) {
        return found(
            select()
                .where(and(eq(conversations.userId, userId), eq(conversations.id, parts.uuid)))
                .get(),
            "uuid",
        );
    }
    if (parts.shortId) {
        const hit = select()
            .where(and(eq(conversations.userId, userId), eq(conversations.shortId, parts.shortId)))
            .get();
        if (hit) return found(hit, "short");
    }
    for (const slug of parts.slugs) {
        const hist = db
            .select({ conversationId: conversationSlugs.conversationId })
            .from(conversationSlugs)
            .where(and(eq(conversationSlugs.userId, userId), eq(conversationSlugs.slug, slug)))
            .orderBy(desc(conversationSlugs.createdAt))
            .get();
        if (!hist) continue;
        const hit = select()
            .where(and(eq(conversations.userId, userId), eq(conversations.id, hist.conversationId)))
            .get();
        if (hit) return found(hit, "slug");
    }
    return undefined;
}
