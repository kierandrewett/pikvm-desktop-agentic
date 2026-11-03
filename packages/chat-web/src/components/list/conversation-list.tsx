/**
 * The conversation list: New chat, then the chats grouped by recency (pinned first), each with a running spinner and
 * the chat actions menu. Rename is inline; Delete asks first and offers Undo (sidebar/actions.ts).
 */
import type { ConversationSummary } from "@pikvm/chat-protocol";
import { CircleNotchIcon, DotsThreeIcon, PlusIcon } from "@pikvm/icons";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Localized, useT } from "../../l10n/provider";
import { chatParams, useActiveConversationId } from "../../lib/chat-path";
import { cn } from "../../lib/cn";
import { conversationsQuery } from "../../lib/queries";
import { Link } from "../../nav";
import { useChatActions } from "../sidebar/actions";
import { chatMenuItems } from "../sidebar/chat-menu";
import { groupByDate } from "../sidebar/group-by-date";
import { chatTitle } from "../sidebar/untitled";
import { ConfirmDialog } from "../ui/dialog";
import { Menu } from "../ui/menu";
import { useShell } from "../shell/context";

function Row({ c, selected }: { c: ConversationSummary; selected: boolean }) {
    const t = useT();
    const actions = useChatActions();
    const { afterNavigate } = useShell();
    const [renaming, setRenaming] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const title = chatTitle(c);
    return (
        <li className="group/row relative">
            {renaming ? (
                <input
                    autoFocus
                    aria-label={t("sidebar-chat-title")}
                    defaultValue={c.title}
                    className="h-[var(--row-height)] w-full rounded-[var(--radius-row)] bg-hover px-[var(--row-padding-x)] text-text outline-none"
                    onBlur={(e) => {
                        setRenaming(false);
                        const next = e.currentTarget.value.trim();
                        if (next && next !== c.title) void actions.rename(c.id, next);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setRenaming(false);
                    }}
                />
            ) : (
                <Link
                    to="/c/$conversationId"
                    params={chatParams(c)}
                    onClick={afterNavigate}
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                        "flex h-[var(--row-height)] items-center gap-2 rounded-[var(--radius-row)] px-[var(--row-padding-x)] pe-10 text-text hover-device:hover:bg-hover",
                        selected && "bg-selected",
                    )}
                >
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {c.active && <CircleNotchIcon aria-label={t("sidebar-responding")} className="animate-spin" />}
                </Link>
            )}
            {!renaming && (
                <div className="absolute inset-y-0 end-1 flex items-center">
                    <Menu
                        align="end"
                        title={title}
                        items={chatMenuItems(c, actions, () => setRenaming(true), () => setConfirm(true), t)}
                        trigger={
                            <button
                                type="button"
                                aria-label={t("sidebar-chat-actions")}
                                className="flex size-8 items-center justify-center rounded-full text-secondary hover-device:hover:bg-hover pointer-coarse:size-10"
                            >
                                <DotsThreeIcon size={20} />
                            </button>
                        }
                    />
                </div>
            )}
            <ConfirmDialog
                open={confirm}
                onOpenChange={setConfirm}
                title={t("sidebar-delete-chat-title")}
                description={
                    <Localized
                        id="sidebar-delete-chat-description"
                        elems={{ name: <strong className="font-semibold text-text">{title}</strong> }}
                    >
                        <span />
                    </Localized>
                }
                confirmLabel={t("sidebar-delete")}
                danger
                onConfirm={() => actions.remove(c.id)}
            />
        </li>
    );
}

export function ConversationList() {
    const t = useT();
    const query = useQuery(conversationsQuery());
    const active = useActiveConversationId();
    const { afterNavigate } = useShell();
    const groups = useMemo(() => {
        const all = query.data ?? [];
        const pinned = all.filter((c) => c.pinnedAt !== null);
        const rest = all.filter((c) => c.pinnedAt === null);
        return [
            ...(pinned.length ? [{ id: "pinned", label: t("sidebar-section-pinned"), items: pinned }] : []),
            ...groupByDate(rest),
        ];
    }, [query.data, t]);
    return (
        <nav aria-label={t("sidebar-chat-history")} className="flex h-full flex-col gap-2 p-2">
            <Link
                to="/"
                onClick={afterNavigate}
                className="flex h-[var(--row-height)] items-center gap-2 rounded-[var(--radius-row)] px-[var(--row-padding-x)] font-medium text-text hover-device:hover:bg-hover"
            >
                <PlusIcon size={18} />
                {t("sidebar-new-chat")}
            </Link>
            <div className="min-h-0 flex-1 overflow-y-auto">
                {query.isError && <p className="p-3 text-secondary">{t("sidebar-chats-error")}</p>}
                {query.isSuccess && groups.length === 0 && (
                    <div className="p-3 text-secondary">
                        <p className="font-medium">{t("sidebar-chats-empty")}</p>
                        <p>{t("sidebar-chats-empty-hint")}</p>
                    </div>
                )}
                {groups.map((g) => (
                    <section key={g.id} className="mb-[var(--section-gap)]">
                        <h3 className="px-[var(--row-padding-x)] py-1 text-[13px] text-tertiary">{g.label}</h3>
                        <ul className="flex flex-col gap-[var(--row-gap)]">
                            {g.items.map((c) => (
                                <Row key={c.id} c={c} selected={c.id === active} />
                            ))}
                        </ul>
                    </section>
                ))}
            </div>
        </nav>
    );
}
