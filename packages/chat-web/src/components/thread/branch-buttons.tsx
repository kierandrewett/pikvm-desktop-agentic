/**
 * Edit, rewind and fork controls under messages (hover row) and in the long-press message sheet, plus the time a
 * message was sent, shown in the hover row. Actions live in branch-actions.ts.
 *
 * Under an answer: "Fork from here" and, except on the newest turn, "Rewind to here" (removes every later message).
 * Under your message: "Edit" (the inline editor; saving adds a version, nothing is removed) and "Fork from here"
 * (a new chat up to before it, the text in its composer). Edit and rewind are separate on purpose
 * (docs/spec/thread-branching.md section 6). Only messages in the saved history get them (a live turn's ids
 * change when it is stored). Temporary chats cannot be forked. While a response runs the buttons stay visible but
 * do nothing.
 */
import { ClockCounterClockwiseIcon, GitForkIcon, PencilSimpleIcon } from "@pikvm/icons";
import { useRouter } from "../../nav";
import { useContext } from "react";
import { useLocale, useT } from "../../l10n/provider";
import { sheetRow } from "../ui/menu";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { forkChat, rewindTo, startEditing, useBranchState } from "./branch-actions";
import { ThreadContext } from "./context";
import { formatStamp } from "./turns";

export interface BranchTarget {
    itemId: string;
    role: "user" | "assistant";
}

interface BranchAction {
    key: string;
    label: string;
    icon: React.ReactNode;
    run: () => void;
}

function useBranchActions({ itemId, role }: BranchTarget): { actions: BranchAction[]; busy: boolean } {
    const t = useT();
    const { conversationId } = useContext(ThreadContext);
    const router = useRouter();
    const { stored, latest, busy, temporary } = useBranchState(conversationId, itemId);
    const actions: BranchAction[] = [];
    if (!stored) return { actions, busy };
    if (role === "user") {
        actions.push({
            key: "edit",
            label: t("branch-edit"),
            icon: <PencilSimpleIcon aria-hidden />,
            run: () => startEditing(conversationId, itemId),
        });
    }
    if (role === "assistant" && !latest) {
        actions.push({
            key: "rewind",
            label: t("branch-rewind"),
            icon: <ClockCounterClockwiseIcon aria-hidden />,
            run: () => void rewindTo(conversationId, itemId),
        });
    }
    if (!temporary) {
        actions.push({
            key: "fork",
            label: t("branch-fork"),
            icon: <GitForkIcon aria-hidden />,
            run: () => void forkChat(router, conversationId, itemId),
        });
    }
    return { actions, busy };
}

/** Icon buttons for the hover row under a message. `className`: the row's button style. */
export function BranchButtons({ className, ...target }: BranchTarget & { className?: string }) {
    const t = useT();
    const { actions, busy } = useBranchActions(target);
    return actions.map((a) => (
        <Tooltip key={a.key} label={busy ? t("branch-busy") : a.label}>
            <Button
                size="lg"
                uniform
                aria-label={a.label}
                aria-disabled={busy || undefined}
                data-branch-action={a.key}
                className={className}
                onClick={() => !busy && a.run()}
            >
                {a.icon}
            </Button>
        </Tooltip>
    ));
}

/** Rows for the message sheet. `onDone` closes the sheet first. */
export function BranchSheetRows({ onDone, ...target }: BranchTarget & { onDone: () => void }) {
    const { actions, busy } = useBranchActions(target);
    return actions.map((a) => (
        <button
            key={a.key}
            type="button"
            className={sheetRow}
            aria-disabled={busy || undefined}
            data-branch-action={a.key}
            onClick={() => {
                if (busy) return;
                onDone();
                a.run();
            }}
        >
            {a.icon}
            {a.label}
        </button>
    ));
}

/** When a message was sent, shown with the hover row ("3:04 PM"; the full date in the tooltip). */
export function MessageTime({ at }: { at: number | undefined }) {
    const t = useT();
    const { locale } = useLocale();
    if (!at) return null;
    const { day, time } = formatStamp(at);
    // The app's chosen locale, not the browser's (docs/spec/localisation.md "Variables, dates and numbers").
    const full = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }).format(at);
    return (
        <Tooltip label={full}>
            <time
                dateTime={new Date(at).toISOString()}
                aria-label={t("branch-sent-at", { day, time })}
                data-message-time=""
                className="msg-time flex h-8 shrink-0 items-center px-1.5 text-[length:var(--type-subhead,13px)] leading-5 text-tertiary tabular-nums pointer-coarse:h-11"
            >
                {day === t("thread-day-today") ? time : t("branch-time-other-day", { day, time })}
            </time>
        </Tooltip>
    );
}
