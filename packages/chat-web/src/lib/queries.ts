/**
 * Server state: TanStack Query hooks plus the bridge that keeps the cache in sync with socket events.
 */
import type { ConversationSummary, OutputItem, ServerEvent } from "@pikvm/chat-protocol";
import { MutationCache, QueryCache, QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { resetSessionState } from "./session-reset";
import { api, ApiError } from "./api";
import { applyEvent, clearAllLive, clearLive, getLive, type LiveState } from "./live";
import { announceRunFinished, type RunFinished } from "./run-end";
import { resetSocketSession, socket } from "./socket";
import type { Bootstrap, SettingView } from "./types";

/** A 401 from any request means the session is gone: drop it, and the app layout redirects to /login. */
const onError = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) forgetSession();
};

export const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({
        onError: (error, variables) => {
            // Cache removal does not cancel mutation callbacks. Ignore errors from the previous account.
            if (
                variables &&
                typeof variables === "object" &&
                "sessionEpoch" in variables &&
                typeof variables.sessionEpoch === "number" &&
                !isSessionEpochCurrent(variables.sessionEpoch)
            )
                return;
            onError(error);
        },
    }),
    defaultOptions: {
        queries: { staleTime: 30_000, gcTime: 30 * 60_000, refetchOnWindowFocus: false, retry: 1 },
    },
});

export const keys = {
    bootstrap: ["bootstrap"] as const,
    conversations: (archived = false) => ["conversations", { archived }] as const,
    conversation: (id: string) => ["conversation", id] as const,
    items: (id: string) => ["items", id] as const,
    settings: ["settings"] as const,
    models: ["models"] as const,
};

let sessionEpoch = 0;

/** Manual fetches capture this before awaiting, then check it before changing private state. */
export function captureSessionEpoch(): number {
    return sessionEpoch;
}

export function isSessionEpochCurrent(epoch: number): boolean {
    return epoch === sessionEpoch;
}

/** Bootstrap contains public instance metadata. Every other query can contain private user data. */
function dropUserData(): void {
    sessionEpoch += 1;
    try {
        resetSessionState();
    } finally {
        const privateQuery = {
            predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== keys.bootstrap[0],
        };
        void queryClient.cancelQueries(privateQuery);
        queryClient.removeQueries(privateQuery);
        queryClient.getMutationCache().clear();
        resetSocketSession();
        clearAllLive();
        wired = false;
    }
}

/**
 * The session ended (a 401 behind the host's sign-in): forget the cached user and their data. The pane sees
 * `user: null` and shows its signed-out state; the host owns signing in again.
 */
export function forgetSession(): void {
    const boot = queryClient.getQueryData<Bootstrap>(keys.bootstrap);
    void queryClient.cancelQueries({ queryKey: keys.bootstrap });
    try {
        dropUserData();
    } finally {
        if (boot) queryClient.setQueryData<Bootstrap>(keys.bootstrap, { ...boot, user: null });
    }
}

export const bootstrapQuery = queryOptions({
    queryKey: keys.bootstrap,
    queryFn: async ({ signal }) => {
        const next = await api.get<Bootstrap>("/bootstrap", signal);
        signal.throwIfAborted();
        const cachedUser = queryClient.getQueryData<Bootstrap>(keys.bootstrap)?.user;
        if (cachedUser && cachedUser.id !== next.user?.id) {
            try {
                dropUserData();
            } catch (error) {
                queryClient.setQueryData<Bootstrap>(keys.bootstrap, { ...next, user: null });
                throw error;
            }
        }
        return next;
    },
    staleTime: 5 * 60_000,
});

/** Start the first session check while IndexedDB opens. Route loading shares this request. */
export function revalidateSessionOnce(): void {
    void queryClient.fetchQuery(bootstrapQuery).catch(() => undefined);
}

export const conversationsQuery = (archived = false) =>
    queryOptions({
        queryKey: keys.conversations(archived),
        queryFn: async ({ signal }) =>
            (
                await api.get<{ conversations: ConversationSummary[] }>(
                    `/conversations${archived ? "?archived=1" : ""}`,
                    signal,
                )
            ).conversations,
    });

export const itemsQuery = (id: string) =>
    queryOptions({
        queryKey: keys.items(id),
        queryFn: async ({ signal }) =>
            (await api.get<{ items: OutputItem[]; hasMore: boolean }>(`/conversations/${id}/items`, signal)).items,
        staleTime: Number.POSITIVE_INFINITY,
    });

export const settingsQuery = queryOptions({
    queryKey: keys.settings,
    queryFn: ({ signal }) =>
        api.get<{ settings: SettingView[]; free: { key: string; value: unknown }[] }>("/settings", signal),
});

export function useBootstrap() {
    return useQuery(bootstrapQuery);
}

/** Effective value of a user-visible setting, with a fallback while loading. */
export function useSetting<T>(key: string, fallback: T): T {
    const { data } = useQuery(settingsQuery);
    const s = data?.settings.find((x) => x.key === key);
    return (s?.value as T | undefined) ?? fallback;
}

/** Prefetch a conversation's history (sidebar hover, link focus) so opening it is instant. */
export function prefetchConversation(id: string): void {
    void queryClient.prefetchQuery(itemsQuery(id));
}

/**
 * Replace or insert a conversation in a list sorted newest first. One pass, no full sort: with
 * thousands of chats the old filter-and-sort ran for every update event. Ties keep the updated
 * conversation first, as the stable sort did.
 */
export function placeConversation(
    list: readonly ConversationSummary[],
    c: ConversationSummary,
    belongs: boolean,
): ConversationSummary[] {
    const out: ConversationSummary[] = [];
    let placed = !belongs;
    for (const x of list) {
        if (x.id === c.id) continue;
        if (!placed && x.updatedAt <= c.updatedAt) {
            out.push(c);
            placed = true;
        }
        out.push(x);
    }
    if (!placed) out.push(c);
    return out;
}

function upsertConversation(c: ConversationSummary) {
    // Temporary chats are never listed; only their own summary is cached.
    if (c.temporary) return void queryClient.setQueryData(keys.conversation(c.id), c);
    for (const archived of [false, true]) {
        queryClient.setQueryData<ConversationSummary[]>(keys.conversations(archived), (list) => {
            if (!list) return list;
            return placeConversation(list, c, archived ? c.archivedAt !== null : c.archivedAt === null);
        });
    }
    queryClient.setQueryData(keys.conversation(c.id), c);
}

/** Newest items fetched after a response; grows when a response produced more items than this. */
const TAIL_PAGE = 100;
const MAX_TAIL_PAGE = 1600;

/**
 * Bring a conversation's cached history up to date after a response. Fetches only the newest page and
 * splices it onto the cache at the first item they share, instead of refetching the whole history
 * (34 MB for a 5,000-turn chat, after every reply). Item ids are stable entry ids, and history is
 * one chain, so everything before a shared item is unchanged. When no item is shared (a long response,
 * or the branch changed further back) the page grows, then falls back to a full refetch.
 */
async function refreshItems(conversationId: string): Promise<void> {
    const started = sessionEpoch;
    const key = keys.items(conversationId);
    const cached = queryClient.getQueryData<OutputItem[]>(key);
    if (cached?.length) {
        const index = new Map(cached.map((it, i) => [it.id, i]));
        for (let limit = TAIL_PAGE; limit <= MAX_TAIL_PAGE; limit *= 4) {
            const page = await api.get<{ items: OutputItem[]; hasMore: boolean }>(
                `/conversations/${conversationId}/items?limit=${limit}`,
            );
            if (started !== sessionEpoch) return;
            if (!page.hasMore) {
                queryClient.setQueryData(key, page.items);
                return;
            }
            const at = page.items[0] ? index.get(page.items[0].id) : undefined;
            if (at !== undefined) {
                queryClient.setQueryData(key, [...cached.slice(0, at), ...page.items]);
                return;
            }
        }
    }
    await queryClient.refetchQueries({ queryKey: key });
}

/**
 * The server's history ends a stopped, failed or cut-off turn with a `chat.run_end` item. When it does not (an older
 * server, or a run that ended before anything was stored), keep the live note by adding it to the cached history,
 * so the turn does not look complete once the live state is dropped. The next history fetch replaces it.
 */
function keepRunEnd(conversationId: string, live: LiveState): void {
    const end = live.response.output.at(-1);
    if (end?.type !== "chat.run_end") return;
    queryClient.setQueryData<OutputItem[]>(keys.items(conversationId), (items) => {
        if (!items) return items;
        for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i]!;
            if (it.type === "chat.run_end") return items;
            if (it.type === "message" && it.role === "user") break;
        }
        return [...items, end];
    });
}

async function settle(conversationId: string) {
    const started = sessionEpoch;
    // Local slash-command output is not in history; keep it on screen until the next message replaces it.
    if (getLive(conversationId)?.response.local) return;
    await refreshItems(conversationId).catch(() => {
        if (started === sessionEpoch) return queryClient.refetchQueries({ queryKey: keys.items(conversationId) });
    });
    // Only drop live state if no newer response or account started meanwhile.
    const live = getLive(conversationId);
    if (started !== sessionEpoch || !live?.done) return;
    // A run stopped or failed before the server stored anything: keep the live turn (the message and its note)
    // until the next send replaces it, instead of letting the message disappear.
    if (!storesTurn(queryClient.getQueryData<OutputItem[]>(keys.items(conversationId)), live)) return;
    keepRunEnd(conversationId, live);
    clearLive(conversationId);
}

const textOf = (m: { content: readonly { type: string; text?: string }[] }) =>
    m.content.map((p) => (p.type === "input_text" ? (p.text ?? "") : "")).join("");

/** True when history holds the live turn: a resumed run, or the optimistic message is the last stored one. */
function storesTurn(items: readonly OutputItem[] | undefined, live: LiveState): boolean {
    if (!live.pendingInput) return true;
    const last = items?.findLast((i) => i.type === "message" && i.role === "user");
    return !!last && last.type === "message" && textOf(last) === textOf(live.pendingInput);
}

/**
 * A rejected send never started a response, so no `chat.conversation.updated` clears the `active` flag the
 * creation event set. Clear it in the cached lists, so the sidebar does not show the chat as running.
 */
export function markConversationIdle(conversationId: string): void {
    const stale = (c: ConversationSummary) => c.id === conversationId && !!c.active;
    const idle = (c: ConversationSummary) => (stale(c) ? { ...c, active: false } : c);
    for (const archived of [false, true]) {
        queryClient.setQueryData<ConversationSummary[]>(keys.conversations(archived), (list) =>
            list?.some(stale) ? list.map(idle) : list,
        );
    }
    queryClient.setQueryData<ConversationSummary>(keys.conversation(conversationId), (c) => c && idle(c));
}

/** Remove a deleted chat from local state, whether confirmed by REST or a socket event. */
export function removeConversationFromCache(conversationId: string): void {
    for (const archived of [false, true]) {
        queryClient.setQueryData<ConversationSummary[]>(keys.conversations(archived), (list) =>
            list?.some((c) => c.id === conversationId) ? list.filter((c) => c.id !== conversationId) : list,
        );
    }
    queryClient.removeQueries({ queryKey: keys.conversation(conversationId) });
    queryClient.removeQueries({ queryKey: keys.items(conversationId) });
    clearLive(conversationId);
}

function onEvent(e: ServerEvent) {
    switch (e.type) {
        case "chat.conversation.created":
            upsertConversation(e.conversation);
            return;
        case "chat.conversation.updated":
            upsertConversation(e.conversation);
            return;
        case "chat.models.updated":
            // The server refreshed this user's runtime listing in the background.
            void queryClient.invalidateQueries({ queryKey: keys.models });
            void queryClient.invalidateQueries({ queryKey: ["commands"] });
            return;
        case "chat.conversation.deleted":
            removeConversationFromCache(e.conversation_id);
            return;
    }
    const cid = applyEvent(e);
    const ended = /^response\.(completed|failed|cancelled|incomplete)$/.exec(e.type);
    if (cid && ended) {
        void settle(cid);
        announceRunFinished({ conversationId: cid, status: ended[1] as RunFinished["status"] });
    }
}

let wired = false;
let listening = false;
export function wireSocket(): void {
    if (wired) return;
    wired = true;
    if (!listening) {
        listening = true;
        socket.on(onEvent);
        // The lists can be older than the socket: restored from the persisted snapshot (written on a throttle, so
        // possibly mid-run) or kept while offline, when chat.conversation.updated events were missed. Their
        // `active` flags (the sidebar's running spinner) are only true for this moment, so refetch on every open.
        socket.onStatus((status) => {
            if (status === "open") {
                void queryClient.invalidateQueries({ queryKey: ["conversations"] });
                // Provider, model or policy edits made while the socket was down sent no event. The catalogue index
                // carries a revision, so this costs one small request when nothing changed.
                void queryClient.invalidateQueries({ queryKey: keys.models }, { cancelRefetch: false });
            }
        });
    }
    socket.connect();
}

/** One conversation's summary. Same key and shape as the header's query, so they share one cache entry. */
export const conversationSummaryQuery = (id: string) =>
    queryOptions({
        queryKey: keys.conversation(id),
        queryFn: async () =>
            (await api.get<{ conversation: ConversationSummary }>(`/conversations/${id}`)).conversation,
    });
