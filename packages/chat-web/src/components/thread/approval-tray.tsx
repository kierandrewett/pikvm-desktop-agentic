/**
 * Approval tray: attached to the top of the composer, slides up from behind it when the agent asks
 * for permission and back down once answered. Uses the reference's composer rail pattern (ui-spec 4.9:
 * inset 13px each side, tucked 24px under the composer, top corners rounded).
 *
 * Keyboard while the tray has focus: Enter runs, Escape denies. Several pending requests are answered
 * one at a time, oldest first ("1 of 3").
 */
import type { ApprovalRequestItem } from "@pikvm/chat-protocol";
import { PencilSimpleIcon, PlugIcon, TerminalWindowIcon, WarningIcon } from "@pikvm/icons";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { useCoarsePointer } from "../../lib/media";
import { captureSessionEpoch } from "../../lib/queries";
import { Button } from "../ui/button";
import { useT } from "../../l10n/provider";
import { describeApproval, decideApproval, usePendingApprovals } from "./approvals";
import { useHighlight } from "./highlight";

function CodeWell({ code, lang }: { code: string; lang: string }) {
    const [ownerEpoch] = useState(captureSessionEpoch);
    const html = useHighlight(lang, code, { ownerEpoch });
    return (
        <div data-no-drawer-gesture="" className="max-h-32 overflow-auto rounded-xl bg-code-header px-3 py-2">
            <pre className="md-pre p-0! whitespace-pre-wrap! break-all">
                {html !== undefined ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
            </pre>
        </div>
    );
}

function TrayBody({
    item,
    index,
    count,
    conversationId,
}: {
    item: ApprovalRequestItem;
    index: number;
    count: number;
    conversationId: string;
}) {
    const t = useT();
    const v = describeApproval(item);
    const coarse = useCoarsePointer();
    const IconCmp = v.kind === "run" ? TerminalWindowIcon : v.kind === "edit" ? PencilSimpleIcon : PlugIcon;
    const decide = (approve: boolean) => decideApproval(conversationId, item.id, approve);
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            decide(false);
        } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault();
            decide(true);
        }
    };
    return (
        <section
            tabIndex={0}
            aria-label={`${v.title} Approval ${index + 1} of ${count}`}
            onKeyDown={onKeyDown}
            className="flex flex-col gap-2 px-3 pt-3 pb-[calc(24px+12px)] outline-none"
        >
            <div className="flex items-center gap-2 px-1">
                <IconCmp size={16} className="shrink-0 text-secondary" />
                <h3 className="min-w-0 flex-1 truncate text-[14px] leading-5 font-semibold text-text">{v.title}</h3>
                {count > 1 && (
                    <span className="text-xs text-tertiary tabular-nums">
                        {index + 1} of {count}
                    </span>
                )}
            </div>
            {v.server && (
                <div className="px-1 font-mono text-xs text-tertiary" translate="no">
                    from {v.server}
                </div>
            )}
            {v.warning && (
                <div className="flex items-center gap-1.5 px-1 text-sm font-medium text-warning">
                    <WarningIcon size={16} weight="fill" className="shrink-0" aria-hidden />
                    {v.warning}
                </div>
            )}
            {v.badges.length > 0 && (
                <ul aria-label={t("thread-appr-hints")} className="flex flex-wrap gap-1 px-1">
                    {v.badges.map((b) => (
                        <li key={b} className="rounded-full bg-soft px-2 py-0.5 text-xs leading-4 text-secondary">
                            {b}
                        </li>
                    ))}
                </ul>
            )}
            <CodeWell code={v.code} lang={v.lang} />
            {(v.cwd || v.risk) && (
                <div className="flex flex-col gap-1 px-1">
                    {v.cwd && <div className="truncate font-mono text-xs text-tertiary">in {v.cwd}</div>}
                    {v.risk && (
                        <div className="flex items-center gap-1.5 text-xs text-warning">
                            <WarningIcon size={14} weight="fill" className="shrink-0" />
                            {v.risk}
                        </div>
                    )}
                </div>
            )}
            <div className="flex items-center gap-2 px-1">
                {!coarse && (
                    <span className="mr-auto text-xs text-tertiary">
                        Enter to {v.action.toLowerCase()}, Esc to deny
                    </span>
                )}
                <Button
                    size="lg"
                    variant="soft"
                    pill
                    className={cn("rounded-full!", coarse && "ml-auto h-10 px-4")}
                    onClick={() => decide(false)}
                >
                    {t("thread-appr-deny")}
                </Button>
                <Button
                    size="lg"
                    variant="solid"
                    pill
                    className={cn("rounded-full!", coarse && "h-10 px-4")}
                    onClick={() => decide(true)}
                >
                    {v.action}
                </Button>
            </div>
        </section>
    );
}

/** Mount directly above the Composer. Renders nothing while no approval is pending. */
export function ApprovalTray({ conversationId }: { conversationId: string }) {
    const t = useT();
    const pending = usePendingApprovals(conversationId);
    const current = pending[0];
    const last = useRef<{ item: ApprovalRequestItem; count: number } | undefined>(undefined);
    if (current) last.current = { item: current, count: pending.length };
    const [mounted, setMounted] = useState(!!current);
    useEffect(() => {
        if (current) setMounted(true);
    }, [current]);
    if (!mounted || !last.current) return null;
    const leaving = !current;
    return (
        <div className="relative -mb-6 overflow-hidden px-[13px] pt-3">
            <div
                role="region"
                aria-label={t("thread-appr-region")}
                aria-live="polite"
                data-state={leaving ? "closed" : "open"}
                onAnimationEnd={() => leaving && setMounted(false)}
                className="approval-tray rounded-t-2xl bg-composer shadow-composer"
            >
                <TrayBody
                    key={last.current.item.id}
                    item={last.current.item}
                    index={0}
                    count={leaving ? 1 : last.current.count}
                    conversationId={conversationId}
                />
            </div>
        </div>
    );
}
