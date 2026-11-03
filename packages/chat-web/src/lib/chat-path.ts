/**
 * Conversation paths inside the pane. A conversation is `/c/<id>`; the pane keeps no slugs, since it owns no URL.
 */
import type { ConversationSummary } from "@pikvm/chat-protocol";
import { useQuery } from "@tanstack/react-query";
import { useLocation, type ChatRouter } from "../nav";
import { api, ApiError } from "./api";
import { conversationsQuery, keys, queryClient } from "./queries";

/** A conversation summary, or only its id. */
export type ChatTarget = Pick<ConversationSummary, "id"> | string;

/** A conversation's summary from the query cache, by id. */
export function cachedConversation(id: string): ConversationSummary | undefined {
    for (const archived of [false, true]) {
        const hit = queryClient
            .getQueryData<ConversationSummary[]>(keys.conversations(archived))
            ?.find((c) => c.id === id);
        if (hit) return hit;
    }
    return queryClient.getQueryData<ConversationSummary>(keys.conversation(id));
}

const idOf = (target: ChatTarget): string => (typeof target === "string" ? target : target.id);

/** Path of a conversation, for `href`s and string navigation. */
export function chatPath(target: ChatTarget): string {
    return `/c/${encodeURIComponent(idOf(target))}`;
}

/** Route params for `navigate({ to: "/c/$conversationId" })`. */
export function chatParams(target: ChatTarget): { conversationId: string } {
    return { conversationId: idOf(target) };
}

const CHAT_PATH = /^\/c\/([^/]+)/;

/** Id of the conversation the pane shows, or undefined on the new-chat screen. */
export function useActiveConversationId(): string | undefined {
    return useLocation({ select: (l) => idFromPath(l.pathname) });
}

const idFromPath = (pathname: string): string | undefined => {
    const m = CHAT_PATH.exec(pathname);
    return m?.[1] ? decodeURIComponent(m[1]) : undefined;
};

/** Non-hook form of `useActiveConversationId`, for actions that hold the router. */
export function openConversationId(router: ChatRouter): string | undefined {
    return idFromPath(router.state.location.pathname);
}

/** Summary of one conversation: the cached lists first (kept fresh by the socket), then a single fetch. */
export function useConversationSummary(id: string | undefined): ConversationSummary | undefined {
    const fromList = useQuery({
        ...conversationsQuery(),
        enabled: !!id,
        select: (l) => l.find((c) => c.id === id),
    }).data;
    const fromArchive = useQuery({
        ...conversationsQuery(true),
        enabled: false,
        select: (l) => l.find((c) => c.id === id),
    }).data;
    const single = useQuery({
        queryKey: keys.conversation(id ?? ""),
        queryFn: async ({ signal }) => {
            const response = await api.get<{ conversation: ConversationSummary }>(`/conversations/${id}`, signal);
            signal.throwIfAborted();
            return response.conversation;
        },
        enabled: !!id && !fromList && !fromArchive,
        retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
    }).data;
    return fromList ?? fromArchive ?? single;
}
