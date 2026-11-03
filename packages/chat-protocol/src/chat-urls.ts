/**
 * Conversation URLs: `/c/<slug>-<short>` (docs/spec/chat-urls.md). The server and the web app both build and
 * split paths with these functions, so the format has one definition. Only the browser URL uses refs; the API
 * and the socket keep using UUIDs.
 */

/** A conversation id (UUID, any version). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored short id: lowercase hex, 6 to 32 characters (see conversations/slug.ts on the server). */
export const SHORT_ID_RE = /^[0-9a-f]{6,32}$/;

/** The parts of a conversation summary a path needs. */
export interface ConversationPathParts {
    id: string;
    slug?: string;
    shortId?: string | null;
}

/** The `/c/<ref>` segment for a conversation: `<slug>-<short>`, or the UUID while the short id is missing. */
export function conversationRef(c: ConversationPathParts): string {
    return c.slug && c.shortId ? `${c.slug}-${c.shortId}` : c.id;
}

/** Canonical browser path for a conversation. */
export function conversationPath(c: ConversationPathParts): string {
    return `/c/${conversationRef(c)}`;
}

export interface SplitRef {
    /** Set when the whole ref is a UUID. */
    uuid?: string;
    /** The trailing short-id-like part: after the last `-`, or the whole ref when it has no `-`. */
    shortId?: string;
    /**
     * Slug candidates for a history lookup, in order: the whole ref (a slug-only URL), then the ref without its
     * last `-` segment (a slug whose suffix was mangled, hex or not). Whole first, so `/c/top-10` never matches
     * a chat once titled "top".
     */
    slugs: string[];
}

/** Split an incoming `/c/<ref>` for resolution. Pure; it does not know whether any part exists. */
export function splitConversationRef(raw: string): SplitRef {
    const ref = raw.trim().toLowerCase();
    if (UUID_RE.test(ref)) return { uuid: ref, slugs: [] };
    const dash = ref.lastIndexOf("-");
    const tail = dash === -1 ? ref : ref.slice(dash + 1);
    const shortId = SHORT_ID_RE.test(tail) ? tail : undefined;
    const slugs: string[] = [];
    if (ref) slugs.push(ref);
    if (dash > 0) slugs.push(ref.slice(0, dash));
    return { ...(shortId ? { shortId } : {}), slugs };
}
