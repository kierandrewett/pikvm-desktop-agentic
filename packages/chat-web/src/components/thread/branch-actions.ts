/**
 * Fork, rewind and message versions from the thread, the message sheet and the chat menu
 * (docs/spec/thread-branching.md).
 *
 *   forkChat(router, conversationId, itemId?)
 *       New chat with the history up to `itemId` (the whole chat without it), opened at once. Undo deletes the
 *       fork and returns to the source message if the fork is still open.
 *   rewindTo(conversationId, itemId)
 *       Remove everything after the answer `itemId` in this chat. The server keeps the old branch, so Undo
 *       returns to it unless a message was sent since.
 *   startEditing / useEditing / stopEditing
 *       Which of your messages shows the inline editor (one at a time, per page).
 *   sendEdit(conversationId, itemId, text, ...)
 *       Send the edited text as a new version of your message. The old version stays; the arrows reach it.
 *   switchToVersion(conversationId, itemId)
 *       Make another version active. The next turn's context follows it.
 *
 * The cached history is cut at once (rewind and edit keep a prefix of the old list) and then refreshed from the
 * server, so the thread changes without waiting. Undo puts the exact old list back, then refreshes too.
 * The server refuses all of these while a response runs; the controls are disabled then as well (useBranchState).
 */
import type {
    ForkResponse,
    InputFile,
    InputImage,
    OutputItem,
    RewindResponse,
    RewindUndoResponse,
    ThinkingSelector,
    VersionSwitchResponse,
} from "@pikvm/chat-protocol";
import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { useRouter } from "../../nav";
import { api } from "../../lib/api";
import { chatParams, openConversationId, useConversationSummary } from "../../lib/chat-path";
import { draftKey, readDraft, writeDraft } from "../../lib/drafts";
import { translate } from "../../l10n/runtime";
import { clearLive, useLive } from "../../lib/live";
import {
    captureSessionEpoch,
    isSessionEpochCurrent,
    itemsQuery,
    keys,
    queryClient,
    removeConversationFromCache,
} from "../../lib/queries";
import { sendMessage } from "../../lib/send";
import { errorDescription, toast } from "../ui/toast";
import { deleteGone, offerUndo } from "../ui/undo";

type Router = ReturnType<typeof useRouter>;

const isUser = (i: OutputItem) => i.type === "message" && i.role === "user";

/**
 * The history a cut at `itemId` keeps, as the server cuts it (conversations/branching.ts): before a user
 * message, or through the end of any other item's turn. Undefined when the item is not in the list.
 */
export function cutItems(items: readonly OutputItem[], itemId: string): OutputItem[] | undefined {
    const at = items.findIndex((i) => i.id === itemId);
    if (at < 0) return undefined;
    if (isUser(items[at]!)) return items.slice(0, at);
    let end = at;
    while (end + 1 < items.length && !isUser(items[end + 1]!)) end++;
    return items.slice(0, end + 1);
}

function signedInUser(): string | undefined {
    return queryClient.getQueryData<{ user?: { id: string } }>(keys.bootstrap)?.user?.id;
}

/** The composer's stored draft for a chat, or null for temporary chats (they keep no draft on disk). */
const composerKey = (conversationId: string, temporary?: boolean) =>
    draftKey({ conversationId, userId: signedInUser(), temporary });

/** Put text in a chat's composer through its stored draft (the composer follows draft changes), then focus it. */
function fillComposer(conversationId: string, text: string): void {
    const key = composerKey(conversationId);
    const ok = writeDraft(key, {
        text,
        selection: [text.length, text.length],
        multi: text.includes("\n"),
        attachments: [],
        synced: false,
    });
    if (!ok) return;
    requestAnimationFrame(() =>
        document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus({ preventScroll: true }),
    );
}

/**
 * Text from an interactive answer. It only fills the composer; the reader presses Send. Text already typed stays:
 * the new text goes after it, and attachments stay too.
 */
export function prefillComposer(conversationId: string, text: string): void {
    const key = composerKey(conversationId);
    const old = readDraft(key);
    if (!old || !old.text.trim()) return fillComposer(conversationId, text);
    if (old.text.includes(text)) return fillComposer(conversationId, old.text);
    const joined = `${old.text.replace(/\s+$/, "")}\n\n${text}`;
    const ok = writeDraft(key, {
        text: joined,
        selection: [joined.length, joined.length],
        multi: true,
        attachments: old.attachments,
        synced: false,
    });
    if (ok)
        requestAnimationFrame(() =>
            document
                .querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
                ?.focus({ preventScroll: true }),
        );
}

const itemsOf = (conversationId: string) => queryClient.getQueryData<OutputItem[]>(keys.items(conversationId));
const lastId = (conversationId: string) => itemsOf(conversationId)?.at(-1)?.id;

function refreshItems(conversationId: string): void {
    void queryClient.refetchQueries({ queryKey: keys.items(conversationId) });
}

/** Fork a chat (the whole chat without `itemId`) and open the fork. */
export async function forkChat(router: Router, conversationId: string, itemId?: string): Promise<void> {
    const epoch = captureSessionEpoch();
    const sourceSearch = itemId
        ? { m: itemId }
        : openConversationId(router) === conversationId
          ? router.state.location.search
          : {};
    let r: ForkResponse;
    try {
        r = await api.post<ForkResponse>(`/conversations/${conversationId}/fork`, itemId ? { itemId } : {});
    } catch (e) {
        toast.error(translate("branch-fork-failed"), { id: "fork-failed", description: errorDescription(e) });
        return;
    }
    if (!isSessionEpochCurrent(epoch)) return;
    const fork = r.conversation;
    queryClient.setQueryData(keys.conversation(fork.id), fork);
    if (r.draft) fillComposer(fork.id, r.draft);
    void router.navigate({ to: "/c/$conversationId", params: chatParams(fork) });
    offerUndo({
        epoch,
        message: translate("branch-forked"),
        description: fork.title || translate("branch-fork-untitled"),
        failure: translate("branch-fork-undo-failed"),
        undo: async (alive) => {
            await deleteGone(`/conversations/${fork.id}`);
            if (!alive()) return;
            writeDraft(composerKey(fork.id), null);
            if (openConversationId(router) === fork.id) {
                await router.navigate({
                    to: "/c/$conversationId",
                    params: chatParams(conversationId),
                    // Message links use the shared search host until this route declares `m`.
                    search: sourceSearch as never,
                });
            }
            if (alive()) removeConversationFromCache(fork.id);
        },
    });
}

/** Rewind a chat to the answer `itemId` (see the module comment). */
export async function rewindTo(conversationId: string, itemId: string): Promise<void> {
    const epoch = captureSessionEpoch();
    const key = keys.items(conversationId);
    const before = itemsOf(conversationId);
    let r: RewindResponse;
    try {
        r = await api.post<RewindResponse>(`/conversations/${conversationId}/rewind`, { itemId });
    } catch (e) {
        toast.error(translate("branch-rewind-failed"), { id: "rewind-failed", description: errorDescription(e) });
        return;
    }
    if (!isSessionEpochCurrent(epoch)) return;
    const cut = before && cutItems(before, itemId);
    if (cut) queryClient.setQueryData(key, cut);
    refreshItems(conversationId);
    const after = cut?.at(-1)?.id;
    offerUndo({
        epoch,
        message: translate("branch-rewound"),
        description: translate("branch-rewound-detail"),
        failure: translate("branch-rewind-undo-failed"),
        changed: () => {
            if (lastId(conversationId) !== after) return translate("branch-rewind-undo-changed");
        },
        undo: async (alive) => {
            await api.post<RewindUndoResponse>(`/conversations/${conversationId}/rewind/undo`, {
                leaf: r.leaf,
                previousLeaf: r.previousLeaf,
            });
            if (!alive()) return;
            if (before) queryClient.setQueryData(key, before);
            refreshItems(conversationId);
        },
    });
}

// Inline editing: which message shows the editor. One at a time, so opening another closes the first.

let editing: { conversationId: string; itemId: string } | null = null;
const editListeners = new Set<() => void>();

function setEditing(next: typeof editing): void {
    editing = next;
    for (const fn of editListeners) fn();
}

export const startEditing = (conversationId: string, itemId: string) => setEditing({ conversationId, itemId });
export const stopEditing = () => setEditing(null);

export function useEditing(conversationId: string, itemId: string): boolean {
    return useSyncExternalStore(
        (fn) => {
            editListeners.add(fn);
            return () => editListeners.delete(fn);
        },
        () => editing?.conversationId === conversationId && editing.itemId === itemId,
    );
}

export interface EditChoice {
    model?: string;
    effort?: ThinkingSelector;
    permission?: "default" | "full";
}

/**
 * Send `text` as a new version of your message `itemId`, with the attachments it keeps. The thread drops the old
 * version and what came after it at once, and shows the new one streaming. A refused send (for example a
 * response started meanwhile) puts the old list back and says why.
 */
export function sendEdit(
    conversationId: string,
    itemId: string,
    text: string,
    attachments: (InputImage | InputFile)[],
    choice: EditChoice,
): void {
    const key = keys.items(conversationId);
    const before = itemsOf(conversationId);
    // A refetch in flight would bring the old version back before the server has the edit.
    void queryClient.cancelQueries({ queryKey: key });
    const cut = before && cutItems(before, itemId);
    if (cut) queryClient.setQueryData(key, cut);
    stopEditing();
    void sendMessage(
        { conversationId, text, attachments, ...choice, editOf: itemId },
        {
            onRejected: (message) => {
                clearLive(conversationId);
                if (before) queryClient.setQueryData(key, before);
                refreshItems(conversationId);
                toast.error(translate("branch-edit-failed"), { id: "edit-failed", description: message });
            },
        },
    );
}

/** Make version `itemId` active, then load the thread it leads to. False when the server refused. */
export async function switchToVersion(conversationId: string, itemId: string): Promise<boolean> {
    const epoch = captureSessionEpoch();
    try {
        await api.post<VersionSwitchResponse>(`/conversations/${conversationId}/versions`, { itemId });
    } catch (e) {
        toast.error(translate("branch-version-failed"), { id: "version-failed", description: errorDescription(e) });
        return false;
    }
    if (!isSessionEpochCurrent(epoch)) return false;
    await queryClient.refetchQueries({ queryKey: keys.items(conversationId) });
    return true;
}

interface HistoryIndex {
    at: Map<string, number>;
    lastUser: number;
}

/** One index per cached items array, so each message's lookup is O(1) even in a 5,000-turn chat. */
const indexes = new WeakMap<readonly OutputItem[], HistoryIndex>();

function historyIndex(items: readonly OutputItem[]): HistoryIndex {
    let hit = indexes.get(items);
    if (!hit) {
        hit = { at: new Map(items.map((i, n) => [i.id, n])), lastUser: items.findLastIndex(isUser) };
        indexes.set(items, hit);
    }
    return hit;
}

/**
 * What the branch actions may do for one message now. `stored`: the message is in the saved history (a live
 * turn's items get their saved ids once the response is stored). `latest`: it is in the newest turn, so
 * nothing comes after it. `busy`: a response runs (the server refuses then too). `temporary`: no fork (its
 * content must not outlive it).
 */
export function useBranchState(
    conversationId: string,
    itemId: string,
): { stored: boolean; latest: boolean; busy: boolean; temporary: boolean } {
    const live = useLive(conversationId);
    const summary = useConversationSummary(conversationId);
    const { data: place = 0 } = useQuery({
        ...itemsQuery(conversationId),
        enabled: !!conversationId,
        select: (items: OutputItem[]) => {
            const { at, lastUser } = historyIndex(items);
            const n = at.get(itemId);
            return n === undefined ? 0 : n > lastUser ? 2 : 1;
        },
    });
    return { stored: place > 0, latest: place === 2, busy: !!live && !live.done, temporary: !!summary?.temporary };
}
