/**
 * Composer drafts in localStorage, so a typed prompt survives a reload, a closed tab, navigation and switching
 * conversations. The composer is the only writer; the sidebar reads `hasDraft` for its "Draft" marker.
 *
 * Keys include the signed-in user id, followed by one entry per context:
 * - `chat.draft.<userId>:<conversationId>` for a conversation
 * - `chat.draft.<userId>:home` for home, `chat.draft.<userId>:home.<projectId>` for a project's home screen
 * - temporary chats are never stored (`draftKey` returns null): nothing about them is meant to outlive them, and
 *   a draft on disk would be the one trace left behind. The composer keeps their drafts in memory only.
 *
 * Value: a versioned JSON `Draft`. Readers drop entries with an unknown version instead of guessing.
 *
 * Clearing writes an empty local copy after a successful send or manual empty. This copy prevents a delayed
 * server read from restoring old text. Reloads, navigation, model changes and blur never clear drafts.
 *
 * Budget: at most `MAX_DRAFTS` entries (oldest dropped first) and `MAX_IMAGE_BYTES` of inline images per
 * draft. When storage is full, the oldest other drafts go first, then this draft's images, and if it still does
 * not fit the write is skipped (the composer keeps working; only persistence is lost).
 */

import { apiUrl } from "./config";
import type { DraftAttachment, DraftList, ServerDraft } from "@pikvm/chat-protocol";
import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { api, ApiError } from "./api";
import { useBootstrap } from "./queries";
import { registerSessionReset } from "./session-reset";

export const DRAFT_VERSION = 1;
const PREFIX = "chat.draft.";
const MAX_DRAFTS = 200;
/** Data-URL characters of images kept per draft (about 1.5 MB of base64). Larger images are not persisted. */
const MAX_IMAGE_BYTES = 1_500_000;
/** In-tab change signal; other tabs get the native `storage` event. */
const CHANGE_EVENT = "chat:drafts";

export type DraftImage = DraftAttachment;

export interface Draft {
    v: typeof DRAFT_VERSION;
    text: string;
    /** Selection start and end in `text` (equal for a caret). */
    selection: readonly [number, number];
    /** The composer was in its multi-line layout (it stays there until emptied). */
    multi: boolean;
    /** Images attached but not sent. Files are not kept: their contents never leave the device before sending. */
    attachments: DraftImage[];
    /** Full-screen editor state, so a reload reopens it. */
    editor?: { open: boolean; view: "write" | "preview" };
    /** Server copy (cross-device layer): `updatedAt` of the server draft this copy last matched. */
    serverAt?: number;
    /** True when the text and attachments equal that server copy (nothing to push). */
    synced?: boolean;
    updatedAt: number;
}

export interface DraftContext {
    conversationId?: string;
    projectId?: string;
    temporary?: boolean;
    userId?: string;
}

/** Storage key for a context, or null when drafts there must not be persisted (temporary chats). */
export function draftKey({ conversationId, projectId, temporary, userId }: DraftContext): string | null {
    if (temporary || !userId) return null;
    const prefix = `${PREFIX}${userId}:`;
    if (conversationId) return `${prefix}${conversationId}`;
    return projectId ? `${prefix}home.${projectId}` : `${prefix}home`;
}

export const isEmptyDraft = (d: Pick<Draft, "text" | "attachments">) => !d.text.trim() && !d.attachments.length;

function storage(): Storage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

function parse(raw: string | null): Draft | null {
    if (!raw) return null;
    try {
        const d = JSON.parse(raw) as Partial<Draft>;
        if (d.v !== DRAFT_VERSION || typeof d.text !== "string") return null;
        const sel = Array.isArray(d.selection) ? d.selection : [d.text.length, d.text.length];
        const clamp = (n: unknown) => Math.max(0, Math.min(typeof n === "number" ? n : 0, d.text!.length));
        return {
            v: DRAFT_VERSION,
            text: d.text,
            selection: [clamp(sel[0]), clamp(sel[1])],
            multi: !!d.multi,
            attachments: Array.isArray(d.attachments)
                ? d.attachments.filter(
                      (a): a is DraftImage =>
                          !!a &&
                          ((a.kind === "image" && typeof a.url === "string") ||
                              (a.kind === "file" && typeof a.uploadId === "string")),
                  )
                : [],
            editor: d.editor,
            serverAt: typeof d.serverAt === "number" ? d.serverAt : undefined,
            synced: !!d.synced,
            updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : 0,
        };
    } catch {
        return null;
    }
}

export function readDraft(key: string | null): Draft | null {
    if (!key) return null;
    try {
        return parse(storage()?.getItem(key) ?? null);
    } catch {
        return null;
    }
}

/** All stored drafts, newest first. */
function entries(): { key: string; updatedAt: number }[] {
    const s = storage();
    if (!s) return [];
    try {
        const out: { key: string; updatedAt: number }[] = [];
        for (let i = 0; i < s.length; i++) {
            const key = s.key(i);
            if (!key?.startsWith(PREFIX)) continue;
            const d = parse(s.getItem(key));
            if (d) out.push({ key, updatedAt: d.updatedAt });
            else s.removeItem(key); // unknown version or corrupt
        }
        return out.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
        return [];
    }
}

function notify(key: string) {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: key }));
}

/** Keep the newest `MAX_DRAFTS` drafts (plus `keep`), or drop `extra` more of the oldest to free space. */
function prune(keep?: string, extra = 0): number {
    const s = storage();
    if (!s) return 0;
    const all = entries().filter((e) => e.key !== keep);
    const limit = Math.max(0, MAX_DRAFTS - 1 - extra);
    const drop = all.slice(limit);
    for (const e of drop) {
        try {
            s.removeItem(e.key);
        } catch {}
    }
    return drop.length;
}

function trimImages(attachments: DraftImage[]): DraftImage[] {
    let budget = MAX_IMAGE_BYTES;
    return attachments.filter((a) => {
        if (a.kind === "file") return true;
        if (a.url.length > budget) return false;
        budget -= a.url.length;
        return true;
    });
}

/**
 * Store a draft. Empty copies retain a deletion marker until the server confirms the clear. Never
 * throws: a full or blocked storage only costs persistence.
 */
export function writeDraft(key: string | null, draft: Omit<Draft, "v" | "updatedAt"> | null): boolean {
    const s = storage();
    if (!key || !s) return false;
    if (!draft) draft = { text: "", selection: [0, 0], multi: false, attachments: [], synced: false };
    const full: Draft = {
        ...draft,
        attachments: trimImages(draft.attachments),
        v: DRAFT_VERSION,
        updatedAt: Date.now(),
    };
    const attempts: (() => void)[] = [
        () => {},
        () => prune(key, 20),
        () => {
            full.attachments = [];
        },
        () => prune(key, MAX_DRAFTS),
    ];
    for (const before of attempts) {
        before();
        try {
            s.setItem(key, JSON.stringify(full));
            prune(key);
            notify(key);
            return true;
        } catch {
            // QuotaExceededError or a blocked storage: free space and try again.
        }
    }
    return false;
}

export function removeDraft(key: string | null): void {
    writeDraft(key, null);
}

/** Remove a forbidden persistent copy. Normal clears must retain their deletion marker. */
export function purgeDraft(key: string | null): void {
    if (!key) return;
    try {
        storage()?.removeItem(key);
        notify(key);
    } catch {
        // Blocked storage cannot be changed.
    }
}

/** Drop drafts of conversations that no longer exist (call with the ids the client knows about). */
export function pruneMissing(liveConversationIds: ReadonlySet<string>, userId: string): void {
    const s = storage();
    if (!s) return;
    for (const { key } of entries()) {
        const prefix = `${PREFIX}${userId}:`;
        if (!key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        if (id === "home" || id.startsWith("home.")) continue;
        if (!liveConversationIds.has(id)) {
            try {
                s.removeItem(key);
            } catch {}
        }
    }
}

/** Whether a conversation has a non-empty stored draft (sidebar "Draft" marker). */
export function hasDraft(conversationId: string, userId?: string): boolean {
    const d = readDraft(draftKey({ conversationId, userId }));
    return !!d && !isEmptyDraft(d);
}

/**
 * Subscribe to draft changes from this tab (`chat:drafts`) and other tabs (`storage`). The callback gets the
 * changed key, or null when everything may have changed (storage cleared).
 */
export function subscribeDrafts(cb: (key: string | null) => void): () => void {
    if (typeof window === "undefined") return () => {};
    const onLocal = (e: Event) => cb((e as CustomEvent<string>).detail);
    const onStorage = (e: StorageEvent) => {
        if (e.key === null || e.key.startsWith(PREFIX)) cb(e.key);
    };
    window.addEventListener(CHANGE_EVENT, onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
        window.removeEventListener(CHANGE_EVENT, onLocal);
        window.removeEventListener("storage", onStorage);
    };
}

/** React: whether a conversation has an unsent draft, live across tabs. */
export function useHasDraft(conversationId: string): boolean {
    const { data } = useBootstrap();
    const userId = data?.user?.id;
    return useSyncExternalStore(
        (fn) => subscribeDrafts((key) => (key === null || key === draftKey({ conversationId, userId })) && fn()),
        () => hasDraft(conversationId, userId),
        () => false,
    );
}

// Server copy (/api/drafts): the cross-device layer. localStorage above stays the instant, keystroke-safe
// layer; the composer reconciles the two when a draft is opened (see `reconcile`).

/** Server scope for a context, or null when it must not be stored (temporary chats). */
export function serverScope({ conversationId, projectId, temporary }: DraftContext): string | null {
    if (temporary) return null;
    if (conversationId) return `conv:${conversationId}`;
    return projectId ? `home:${projectId}` : "home";
}

export const draftListKey = ["drafts", "list"] as const;

interface SyncState {
    revision?: number;
    tail: Promise<unknown>;
    pending: number;
}
const syncStates = new Map<string, SyncState>();
let syncEpoch = 0;
const unregisterDraftSync = registerSessionReset("draft-sync", () => {
    syncEpoch++;
    syncStates.clear();
});
import.meta.hot?.dispose(unregisterDraftSync);
function syncState(scope: string, userId: string): SyncState {
    const key = `${userId}:${scope}`;
    let state = syncStates.get(key);
    if (!state) syncStates.set(key, (state = { tail: Promise.resolve(), pending: 0 }));
    return state;
}

async function draftRequest<T>(
    method: string,
    scope: string,
    userId: string,
    body?: unknown,
    keepalive = false,
): Promise<T> {
    const response = await fetch(apiUrl(`/drafts?scope=${encodeURIComponent(scope)}&revision=1`), {
        method,
        credentials: "same-origin",
        keepalive,
        headers: {
            "x-chat-request": "1",
            "x-chat-draft-user": userId,
            ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new ApiError("Could not synchronise draft", response.status, "draft_sync");
    return (await response.json()) as T;
}

/** Undefined means the request failed; null means no draft has ever been stored. */
export async function fetchServerDraft(scope: string, userId: string): Promise<ServerDraft | null | undefined> {
    const epoch = syncEpoch;
    try {
        const draft = await draftRequest<ServerDraft | null>("GET", scope, userId);
        if (epoch !== syncEpoch) return undefined;
        const state = syncState(scope, userId);
        if (!draft) {
            state.revision ??= 0;
            return null;
        }
        state.revision = Math.max(state.revision ?? 0, draft.updatedAt);
        return draft;
    } catch (error) {
        if (epoch !== syncEpoch) return undefined;
        console.warn("[drafts] fetch failed", error);
        return undefined;
    }
}

/** Writes for one account and scope run in order. A changed server revision is never overwritten. */
export async function pushServerDraft(
    scope: string,
    draft: Pick<Draft, "text" | "attachments">,
    userId: string,
): Promise<ServerDraft | undefined> {
    const epoch = syncEpoch;
    const state = syncState(scope, userId);
    const snapshot = { text: draft.text, attachments: [...draft.attachments] };
    state.pending++;
    const write = state.tail
        .then(async () => {
            if (epoch !== syncEpoch) return undefined;
            if (state.revision === undefined && (await fetchServerDraft(scope, userId)) === undefined) return undefined;
            if (epoch !== syncEpoch) return undefined;
            try {
                const result = await draftRequest<ServerDraft>("PUT", scope, userId, {
                    scope,
                    ...snapshot,
                    baseUpdatedAt: state.revision,
                });
                if (epoch !== syncEpoch) return undefined;
                state.revision = result.updatedAt;
                return result;
            } catch (error) {
                console.warn("[drafts] push failed; local copy retained", error);
                return undefined;
            }
        })
        .finally(() => state.pending--);
    state.tail = write;
    return write;
}

/** Only send an unload write when it cannot race an earlier write from this tab. */
export function beaconServerDraft(scope: string, draft: Pick<Draft, "text" | "attachments">, userId: string): void {
    const state = syncState(scope, userId);
    if (state.pending || state.revision === undefined) return;
    const body = { scope, text: draft.text, attachments: draft.attachments, baseUpdatedAt: state.revision };
    if (new TextEncoder().encode(JSON.stringify(body)).length > 60_000) return;
    void draftRequest<ServerDraft>("PUT", scope, userId, body, true).catch(() => undefined);
}

export function sameDraft(a: Pick<Draft, "text" | "attachments">, b: Pick<Draft, "text" | "attachments">): boolean {
    return a.text === b.text && JSON.stringify(a.attachments) === JSON.stringify(b.attachments);
}

/**
 * What to do when a draft is opened, given the local copy, the server copy and whether the user typed since.
 * - `take`: the server copy is newer than what this device last synced and the user has not typed: use it.
 * - `push`: local has edits the server has not seen (or the user is typing): keep local and send it.
 * - `drop`: the server copy is gone and local was in sync with it (sent or emptied elsewhere): clear local.
 * - `keep`: nothing to do.
 */
export function reconcile(
    local: Pick<Draft, "text" | "attachments" | "serverAt" | "synced" | "updatedAt"> | null,
    server: ServerDraft | null,
    typed: boolean,
): "take" | "push" | "drop" | "keep" {
    const localEmpty = !local || isEmptyDraft(local);
    if (local && !local.synced && isEmptyDraft(local)) return server && !isEmptyDraft(server) ? "push" : "keep";
    if (!server || isEmptyDraft(server)) {
        if (localEmpty) return "keep";
        return local.synced && local.serverAt !== undefined && !typed ? "drop" : "push";
    }
    if (!localEmpty && sameDraft(local, server)) return "keep";
    if (typed) return "push";
    if (localEmpty || local.synced || (local.serverAt ?? 0) < server.updatedAt) {
        // Unsynced local edits older than the server copy lose to it only when the server copy is newer than
        // the local edit itself (clocks differ between devices, so this is a best effort).
        if (!localEmpty && !local.synced && local.updatedAt > server.updatedAt) return "push";
        return "take";
    }
    return "push";
}

/** The caller's conversations with a server draft (sidebar marker across devices). */
export function useServerDraftIds(): ReadonlySet<string> {
    const { data: boot } = useBootstrap();
    const { data } = useQuery({
        queryKey: [...draftListKey, boot?.user?.id],
        enabled: !!boot?.user,
        queryFn: () => api.get<DraftList>("/drafts"),
        staleTime: 30_000,
    });
    const ids = new Set<string>();
    for (const d of data?.drafts ?? []) if (d.conversationId) ids.add(d.conversationId);
    return ids;
}
