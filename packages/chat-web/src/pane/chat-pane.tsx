/**
 * ChatPane: the conversation list, a header, and the open conversation (or the new-chat screen), inside the pane's
 * shell. Render it inside <ChatScope>. A 401 behind the host's sign-in shows a signed-out note instead of a blank pane.
 */
import { ListIcon, NotePencilIcon } from "@pikvm/icons";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { ConversationList } from "../components/list/conversation-list";
import { Composer } from "../components/composer/composer";
import { PaneShell } from "../components/shell/pane-shell";
import { useShell } from "../components/shell/context";
import { ConversationPane } from "../components/thread/conversation-page";
import { Button } from "../components/ui/button";
import { EmptyState, ErrorState } from "../components/ui/state";
import { useT } from "../l10n/provider";
import { chatParams, useActiveConversationId, useConversationSummary } from "../lib/chat-path";
import { usePaneActive } from "../lib/pane-active";
import { bootstrapQuery } from "../lib/queries";
import { useNavigate } from "../nav";
import { chatTitle } from "../components/sidebar/untitled";

function Header({ conversationId }: { conversationId: string | undefined }) {
    const t = useT();
    const { mobile, toggleSidebar } = useShell();
    const navigate = useNavigate();
    const summary = useConversationSummary(conversationId);
    return (
        <header className="flex h-[var(--header-height)] shrink-0 items-center gap-2 border-b border-default px-2">
            {mobile && (
                <Button variant="ghost" size="lg" uniform aria-label={t("shell-sidebar-open")} onClick={toggleSidebar}>
                    <ListIcon />
                </Button>
            )}
            <h1 className="min-w-0 flex-1 truncate px-2 text-[15px] font-medium">
                {conversationId ? (summary ? chatTitle(summary) : "") : t("thread-home-title")}
            </h1>
            <Button variant="ghost" size="lg" uniform aria-label={t("sidebar-new-chat")} onClick={() => void navigate({ to: "/" })}>
                <NotePencilIcon />
            </Button>
        </header>
    );
}

function Body({ conversationId }: { conversationId: string | undefined }) {
    const t = useT();
    const navigate = useNavigate();
    const active = usePaneActive();
    if (conversationId) {
        return (
            <ConversationPane
                conversationId={conversationId}
                active={active}
                label={t("thread-page-conversation")}
                empty={<p className="text-center text-secondary">{t("thread-page-empty")}</p>}
            />
        );
    }
    return (
        <div className="flex min-h-0 flex-1 flex-col justify-end px-3 pb-[max(12px,var(--safe-bottom))]">
            <h2 className="mb-6 text-center text-[22px] font-normal text-balance">{t("thread-home-heading")}</h2>
            <Composer
                variant="home"
                embedded
                onCreated={(id) => void navigate({ to: "/c/$conversationId", params: chatParams(id) })}
            />
        </div>
    );
}

export function ChatPane() {
    const t = useT();
    const boot = useQuery(bootstrapQuery);
    const conversationId = useActiveConversationId();
    if (boot.isError)
        return <ErrorState size="page" title={t("thread-page-load-failed")} query={boot} error={boot.error} />;
    if (boot.isSuccess && !boot.data.user)
        return <EmptyState size="page" title={t("pane-signed-out-title")} description={t("pane-signed-out-body")} />;
    if (!boot.data) return <div role="status" aria-busy className="h-full" />;
    return (
        <PaneShell list={<ConversationList />}>
            <Header conversationId={conversationId} />
            <Body conversationId={conversationId} />
        </PaneShell>
    );
}
