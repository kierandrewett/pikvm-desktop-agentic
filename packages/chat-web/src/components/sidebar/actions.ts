/**
 * Conversation mutations with optimistic cache updates. Each mutation snapshots the affected query data, applies
 * the change at once, sends the request, and restores the snapshot (plus an error toast) if the server rejects it.
 * The socket broadcast later confirms the change.
 *
 * Changes made from the chat menu offer Undo (ui/undo.ts). Undo of a chat change sends back the values the server
 * reported it replaced (`previous`), so pin and archive times and the title and its source come back exactly.
 * Deletes wait for the Undo toast to go before they are sent (deferCommit).
 */
import type { ConversationSummary } from "@pikvm/chat-protocol";
import { useRouter } from "../../nav";
import { useMemo } from "react";
import { translate } from "../../l10n/runtime";
import { api } from "../../lib/api";
import { openConversationId } from "../../lib/chat-path";
import {
    captureSessionEpoch,
    isSessionEpochCurrent,
    keys,
    queryClient,
    removeConversationFromCache,
} from "../../lib/queries";
import { forkChat } from "../thread/branch-actions";
import { toast } from "../ui/toast";
import { chatTitle, untitledChat } from "./untitled";
import { deferCommit, deleteGone, offerUndo, sendOnUnload } from "../ui/undo";

export interface ConversationPatch {
    title?: string;
    pinned?: boolean;
    archived?: boolean;
    projectId?: string | null;
    /** Exact pin and archive times and the title's source: only Undo sends these (from `previous`). */
    pinnedAt?: number | null;
    archivedAt?: number | null;
    titleSource?: "auto" | "user";
    /** Chat icon (chat-icon/): one emoji or `icon:<Name>`, null removes it. */
    icon?: string | null;
    /** "auto" resets to the automatic icon; the server clears the icon and chooses again. */
    iconSource?: "auto";
}

type Snapshot = [readonly unknown[], unknown][];

function snapshot(): Snapshot {
    const lists = queryClient.getQueriesData({ queryKey: ["conversations"] });
    const single = queryClient.getQueriesData({ queryKey: ["conversation"] });
    return [...lists, ...single];
}

function restore(snap: Snapshot): void {
    for (const [key, data] of snap) queryClient.setQueryData(key, data);
}

function findConversation(id: string): ConversationSummary | undefined {
    for (const archived of [false, true]) {
        const hit = queryClient
            .getQueryData<ConversationSummary[]>(keys.conversations(archived))
            ?.find((c) => c.id === id);
        if (hit) return hit;
    }
    return queryClient.getQueryData<ConversationSummary>(keys.conversation(id));
}

function applyPatch(c: ConversationSummary, patch: ConversationPatch): ConversationSummary {
    const now = Date.now();
    return {
        ...c,
        ...(patch.title !== undefined && { title: patch.title }),
        ...(patch.pinned !== undefined && { pinnedAt: patch.pinned ? now : null }),
        ...(patch.archived !== undefined && { archivedAt: patch.archived ? now : null }),
        ...(patch.projectId !== undefined && { projectId: patch.projectId }),
        ...(patch.pinnedAt !== undefined && { pinnedAt: patch.pinnedAt }),
        ...(patch.archivedAt !== undefined && { archivedAt: patch.archivedAt }),
        ...(patch.icon !== undefined && { icon: patch.icon, iconSource: "user" as const }),
        ...(patch.iconSource === "auto" && { icon: null, iconSource: "auto" as const }),
    };
}

/** Write one summary into every cached list it belongs to, and drop it from the others. */
function writeLocal(next: ConversationSummary): void {
    for (const archived of [false, true]) {
        queryClient.setQueryData<ConversationSummary[]>(keys.conversations(archived), (list) => {
            if (!list) return list;
            const belongs = archived ? next.archivedAt !== null : next.archivedAt === null;
            const idx = list.findIndex((x) => x.id === next.id);
            if (!belongs) return idx === -1 ? list : list.filter((x) => x.id !== next.id);
            if (idx === -1) return [next, ...list].sort((a, b) => b.updatedAt - a.updatedAt);
            const copy = list.slice();
            copy[idx] = next;
            return copy;
        });
    }
    if (queryClient.getQueryData(keys.conversation(next.id)))
        queryClient.setQueryData(keys.conversation(next.id), next);
}

/** Run with a snapshot; on failure put the snapshot back (same account only) and rethrow. */
async function withSnapshot<T>(run: () => Promise<T>): Promise<T> {
    const epoch = captureSessionEpoch();
    await queryClient.cancelQueries({ queryKey: ["conversations"] });
    const snap = snapshot();
    try {
        return await run();
    } catch (err) {
        if (isSessionEpochCurrent(epoch)) restore(snap);
        throw err;
    }
}

async function guarded<T>(failure: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
        return await withSnapshot(run);
    } catch (err) {
        toast.error(failure, { description: err instanceof Error ? err.message : undefined });
        return undefined;
    }
}

/** The values a chat PATCH replaced, as the server reports them. */
interface Previous {
    title: string;
    titleSource: "auto" | "user";
    pinnedAt: number | null;
    archivedAt: number | null;
    projectId: string | null;
}

interface PatchResponse {
    conversation: ConversationSummary;
    previous?: Previous;
}

/** How a patch offers Undo: the toast text and the error title if the undo fails. */
export interface PatchUndo {
    message: string;
    failure: string;
}

/** The patch that puts back what `patch` replaced. */
function reversal(patch: ConversationPatch, prev: Previous): ConversationPatch {
    return {
        ...(patch.title !== undefined && { title: prev.title, titleSource: prev.titleSource }),
        ...((patch.pinned !== undefined || patch.pinnedAt !== undefined) && { pinnedAt: prev.pinnedAt }),
        ...((patch.archived !== undefined || patch.archivedAt !== undefined) && { archivedAt: prev.archivedAt }),
        ...(patch.projectId !== undefined && { projectId: prev.projectId }),
    };
}

/** The fields a patch touches, as a summary shows them: equal before and after Undo means nothing changed since. */
function touched(c: ConversationSummary, patch: ConversationPatch): string {
    const r = reversal(patch, { ...c, titleSource: "user" });
    return JSON.stringify([r.title, r.pinnedAt, r.archivedAt, r.projectId]);
}

function offerPatchUndo(
    id: string,
    patch: ConversationPatch,
    res: Required<PatchResponse>,
    undo: PatchUndo,
    epoch: number,
) {
    const back = reversal(patch, res.previous);
    const after = touched(res.conversation, patch);
    offerUndo({
        epoch,
        message: undo.message,
        description: chatTitle(res.conversation),
        failure: undo.failure,
        changed: () => {
            const now = findConversation(id);
            if (now && touched(now, patch) !== after) return translate("sidebar-undo-chat-changed");
        },
        undo: (alive) =>
            withSnapshot(async () => {
                const cur = findConversation(id);
                if (cur) writeLocal(applyPatch(cur, back));
                const r = await api.patch<PatchResponse>(`/conversations/${id}`, back);
                if (alive()) writeLocal(r.conversation);
            }),
    });
}

export function patchConversation(
    id: string,
    patch: ConversationPatch,
    failure = translate("sidebar-error-update-chat"),
    undo?: PatchUndo,
) {
    const epoch = captureSessionEpoch();
    return guarded(failure, async () => {
        const cur = findConversation(id);
        if (cur) writeLocal(applyPatch(cur, patch));
        const res = await api.patch<PatchResponse>(`/conversations/${id}`, patch);
        if (!isSessionEpochCurrent(epoch)) return undefined;
        writeLocal(res.conversation);
        if (undo && res.previous) offerPatchUndo(id, patch, { ...res, previous: res.previous }, undo, epoch);
        return res.conversation;
    });
}

/** Move a chat out of the archive, with Undo that archives it again at its exact earlier time. */
export function unarchiveConversation(id: string) {
    return patchConversation(id, { archived: false }, translate("sidebar-error-unarchive"), {
        message: translate("sidebar-chat-unarchived"),
        failure: translate("sidebar-undo-archive-again"),
    });
}

/**
 * Delete a chat with Undo: it leaves the lists at once and the DELETE is sent when the toast goes (or with
 * keepalive when the page unloads). Undo puts back its latest summary, in its old place in the lists.
 */
export function deleteConversation(id: string): void {
    const epoch = captureSessionEpoch();
    let latest = findConversation(id);
    deferCommit({
        epoch,
        message: translate("sidebar-chat-deleted"),
        description: latest ? chatTitle(latest) : untitledChat(),
        failure: translate("sidebar-error-delete-chat"),
        hide: () => {
            for (const archived of [false, true]) {
                const list = queryClient.getQueryData<ConversationSummary[]>(keys.conversations(archived));
                const hit = list?.find((c) => c.id === id);
                if (!list || !hit) continue;
                latest = hit;
                queryClient.setQueryData(
                    keys.conversations(archived),
                    list.filter((c) => c.id !== id),
                );
            }
        },
        restore: () => latest && writeLocal(latest),
        commit: async () => {
            await deleteGone(`/conversations/${id}`);
            if (isSessionEpochCurrent(epoch)) removeConversationFromCache(id);
        },
        commitOnUnload: () => sendOnUnload("DELETE", `/conversations/${id}`),
    });
}
/**
 * Bound actions that also handle navigation: archiving or deleting the open chat goes home.
 * The returned object is stable for the life of the router.
 */
export function useChatActions() {
    const router = useRouter();
    return useMemo(() => {
        const leaveIfOpen = (id: string) => {
            if (openConversationId(router) === id) void router.navigate({ to: "/" });
        };
        return {
            rename: (id: string, title: string) =>
                patchConversation(id, { title }, translate("sidebar-error-rename-chat"), {
                    message: translate("sidebar-chat-renamed"),
                    failure: translate("sidebar-undo-rename"),
                }),
            setPinned: (id: string, pinned: boolean) =>
                patchConversation(
                    id,
                    { pinned },
                    pinned ? translate("sidebar-error-pin") : translate("sidebar-error-unpin"),
                    {
                        message: pinned ? translate("sidebar-chat-pinned") : translate("sidebar-chat-unpinned"),
                        failure: pinned ? translate("sidebar-undo-pin") : translate("sidebar-undo-unpin"),
                    },
                ),
            archive: (id: string) => {
                leaveIfOpen(id);
                return patchConversation(id, { archived: true }, translate("sidebar-error-archive"), {
                    message: translate("sidebar-chat-archived"),
                    failure: translate("sidebar-undo-archive"),
                });
            },
            remove: (id: string) => {
                leaveIfOpen(id);
                return deleteConversation(id);
            },
            newChat: () => router.navigate({ to: "/" }),
            /** Fork the whole chat and open the fork (thread/branch-actions.ts). */
            fork: (id: string) => forkChat(router, id),
        };
    }, [router]);
}

export type ChatActions = ReturnType<typeof useChatActions>;
