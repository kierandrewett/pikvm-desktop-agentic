/**
 * Message versions over the session tree (docs/spec/thread-branching.md section 6).
 *
 * The session file is the only store of versions and of the active one. A marker (a `branch_summary` entry with
 * an empty summary) moves the leaf and adds nothing to the model's context. Versions of a user message are the
 * user messages with the same logical parent, less the ones a rewind removed. The logical parent is the nearest
 * ancestor that is a message: markers and the runtime's own metadata entries (model and thinking changes,
 * `custom`, `session_init` and others, which a new process may write before the prompt) are links between them. A `chat-rewind` marker removes every message under its cut that is older than the
 * marker; a `chat-rewind-undo` marker that names it cancels that.
 *
 * Pure: no file or database access, so history.ts and branching.ts can both use it.
 */

export interface TreeEntry {
    type: string;
    id?: string;
    parentId?: string | null;
    message?: { role?: string };
    summary?: string;
    details?: unknown;
}

/** Marker kinds Chat writes (`details.kind`). */
export type MarkerKind = "chat-rewind" | "chat-rewind-undo" | "chat-edit" | "chat-edit-revert" | "chat-switch";

/** The runtime's own marker for an entry it dropped (session-manager.ts DISCARDED_ENTRY_BRANCH_MARKER). */
const RUNTIME_DISCARD = "discarded-entry-branch";
const ROOT = "";

export const isMarker = (e: TreeEntry): boolean => e.type === "branch_summary" && !e.summary;
/** Entries between messages: they never start a version group. */
const isLink = (e: TreeEntry): boolean => e.type !== "message";
export const isUserMessage = (e: TreeEntry): boolean => e.type === "message" && e.message?.role === "user";

function detail(e: TreeEntry, key: string): unknown {
    const d = e.details;
    return d && typeof d === "object" ? (d as Record<string, unknown>)[key] : undefined;
}

const kindOf = (e: TreeEntry): unknown => (isMarker(e) ? detail(e, "kind") : undefined);

export interface VersionIndex {
    /** The ids of the versions of user message `entryId`, oldest first, when it has more than one. */
    group(entryId: string): string[] | undefined;
    /** True when a rewind removed this entry (it is in no version group). */
    removed(entryId: string): boolean;
    /** The entry to make the leaf when version `entryId` becomes active: where that version was last left. */
    leafFor(entryId: string): string;
}

/** Index the versions in a session's entries, given in file order. Entries without an id are ignored. */
export function indexVersions(entries: readonly TreeEntry[]): VersionIndex {
    const byId = new Map<string, TreeEntry>();
    const order = new Map<string, number>();
    for (const e of entries) {
        if (typeof e.id !== "string") continue;
        byId.set(e.id, e);
        order.set(e.id, order.size);
    }
    const children = new Map<string, string[]>();
    for (const e of byId.values()) {
        const p = e.parentId ?? ROOT;
        const list = children.get(p);
        if (list) list.push(e.id!);
        else children.set(p, [e.id!]);
    }

    // Logical parent: the nearest ancestor that is a message (ROOT at the top). Memoised: chains are long.
    const logical = new Map<string, string>();
    function logicalParent(id: string): string {
        const hit = logical.get(id);
        if (hit !== undefined) return hit;
        const walked: string[] = [];
        let p = byId.get(id)?.parentId ?? null;
        let found = ROOT;
        const seen = new Set<string>([id]);
        while (p !== null && !seen.has(p)) {
            const cached = logical.get(p);
            const e = byId.get(p);
            if (!e) break;
            if (!isLink(e)) {
                found = p;
                break;
            }
            if (cached !== undefined) {
                found = cached;
                break;
            }
            seen.add(p);
            walked.push(p);
            p = e.parentId ?? null;
        }
        logical.set(id, found);
        for (const w of walked) logical.set(w, found);
        return found;
    }
    const logicalNode = (id: string | null | undefined): string => {
        if (!id) return ROOT;
        const e = byId.get(id);
        return e && !isLink(e) ? id : e ? logicalParent(id) : ROOT;
    };

    // Rewinds in force: the newest one at each logical node removes the older messages under it.
    const undone = new Set<string>();
    for (const e of byId.values()) {
        const target = kindOf(e) === "chat-rewind-undo" ? detail(e, "rewindLeafId") : undefined;
        if (typeof target === "string") undone.add(target);
    }
    const removedBefore = new Map<string, number>();
    const dropped = new Set<string>();
    for (const e of byId.values()) {
        const kind = kindOf(e);
        if (kind === "chat-rewind" && !undone.has(e.id!)) {
            const node = logicalNode(e.parentId);
            removedBefore.set(node, Math.max(removedBefore.get(node) ?? -1, order.get(e.id!)!));
        } else if (kind === RUNTIME_DISCARD) {
            const target = detail(e, "discardedEntryId");
            if (typeof target === "string") dropped.add(target);
        }
    }
    const removed = (id: string): boolean => {
        const e = byId.get(id);
        if (!e || isLink(e)) return false;
        if (dropped.has(id)) return true;
        const limit = removedBefore.get(logicalParent(id));
        return limit !== undefined && order.get(id)! < limit;
    };

    // Version groups by logical parent, built once on first use.
    let groups: Map<string, string[]> | undefined;
    function groupsByParent(): Map<string, string[]> {
        if (groups) return groups;
        groups = new Map();
        for (const e of byId.values()) {
            if (!isUserMessage(e) || removed(e.id!)) continue;
            const key = logicalParent(e.id!);
            const list = groups.get(key);
            if (list) list.push(e.id!);
            else groups.set(key, [e.id!]);
        }
        return groups;
    }

    return {
        group(entryId) {
            const e = byId.get(entryId);
            if (!e || !isUserMessage(e)) return undefined;
            const list = groupsByParent().get(logicalParent(entryId)) ?? [];
            // The active message always belongs to its own group, even if older data says otherwise.
            const ids = list.includes(entryId)
                ? list
                : [...list, entryId].sort((a, b) => order.get(a)! - order.get(b)!);
            return ids.length > 1 ? ids : undefined;
        },
        removed,
        leafFor(entryId) {
            // Depth-first over the version's subtree, skipping removed entries; the newest entry in file order wins.
            let best = entryId;
            const stack = [entryId];
            while (stack.length) {
                const id = stack.pop()!;
                const e = byId.get(id)!;
                const deadEdit = kindOf(e) === "chat-edit" && !children.get(id)?.length;
                if (!deadEdit && order.get(id)! > order.get(best)!) best = id;
                for (const c of children.get(id) ?? []) if (!removed(c)) stack.push(c);
            }
            const leaf = byId.get(best)!;
            return kindOf(leaf) === "chat-switch" && leaf.parentId ? leaf.parentId : best;
        },
    };
}
