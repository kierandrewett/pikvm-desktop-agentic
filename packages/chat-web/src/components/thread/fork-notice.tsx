/**
 * "Forked from <title>" at the top of a forked chat (conversations/branching.ts), linking to the source. A source
 * deleted since shows as "a deleted chat", without a link. Chats that are not forks show nothing.
 */
import { GitForkIcon } from "@pikvm/icons";
import { useQuery } from "@tanstack/react-query";
import { Link } from "../../nav";
import { Localized, useT } from "../../l10n/provider";
import { ApiError } from "../../lib/api";
import { chatParams, useConversationSummary } from "../../lib/chat-path";
import { conversationSummaryQuery } from "../../lib/queries";

/** The link to the source chat. It draws its own title and ignores the (empty) tag content of the message. */
function SourceLink({ source }: { source: Parameters<typeof chatParams>[0] & { title?: string } }) {
    const t = useT();
    return (
        <Link
            to="/c/$conversationId"
            params={chatParams(source)}
            className="text-secondary underline decoration-[var(--border)] underline-offset-2 hover-device:hover:text-text"
        >
            {source.title || t("thread-fork-untitled")}
        </Link>
    );
}

export function ForkNotice({ conversationId }: { conversationId: string }) {
    const t = useT();
    const from = useConversationSummary(conversationId)?.forkedFrom;
    const source = useQuery({
        ...conversationSummaryQuery(from ?? ""),
        enabled: !!from,
        retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
    });
    if (!from) return null;
    const gone = source.error instanceof ApiError && source.error.status === 404;
    if (!source.data && !gone) return null;
    return (
        <p
            data-fork-notice=""
            className="mx-auto mb-6 flex max-w-full items-center justify-center gap-1.5 px-2 pt-2 text-[length:var(--type-subhead,13px)] leading-5 text-tertiary"
        >
            <GitForkIcon aria-hidden size={14} className="shrink-0" />
            <span className="min-w-0 truncate">
                {source.data ? (
                    <Localized
                        id="thread-fork-from"
                        elems={{
                            source: <SourceLink source={source.data} />,
                        }}
                    >
                        <span />
                    </Localized>
                ) : (
                    t("thread-fork-deleted")
                )}
            </span>
        </p>
    );
}
