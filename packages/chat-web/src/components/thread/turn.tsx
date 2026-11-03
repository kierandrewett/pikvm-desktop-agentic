/**
 * One turn of the thread: user bubble, the agent activity group ("Worked for 1m 37s"), the final answer
 * and its action row. Layout values are the reference web conversation view (notes A.7.3 - A.7.7); the
 * activity group and its step rows follow docs/spec/islands-and-panels.md 1.1 - 1.3.
 *
 * Live items are mutated in place by lib/live.ts, so leaf components take primitive props (strings,
 * flags) and are memoised on them: a streaming delta re-renders only the item that changed.
 */
import type {
    ApprovalRequestItem,
    FunctionCallItem,
    FunctionCallOutputItem,
    MessageItem,
    OutputItem,
    RunEndItem,
} from "@pikvm/chat-protocol";
import { ArrowClockwiseIcon, CheckIcon, CopyIcon, ScissorsIcon, StopCircleIcon, WarningCircleIcon } from "@pikvm/icons";
import { memo, useContext, useMemo, useState } from "react";
import { msg, translate } from "../../l10n/runtime";
import { useT } from "../../l10n/provider";
import { cn } from "../../lib/cn";
import { useLive } from "../../lib/live";
import { sendMessage } from "../../lib/send";
import { useComposerChoice } from "../composer/choice";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { LocalNoticeRow, WorkedGroup } from "./activity";
import { AttachmentChips } from "./attachment-chips";
import { AssistantAvatar, UserAvatar } from "./avatars";
import { useEditing } from "./branch-actions";
import { BranchButtons, MessageTime } from "./branch-buttons";
import { MessageEditor, VersionSwitcher } from "./message-versions";
import { RuntimeNotices } from "./runtime-notices";
import { ThreadContext } from "./context";
import { localOutput } from "./local-notices";
import { ThinkingIndicator } from "./thinking-indicator";
import { Markdown, useCopy } from "./markdown";
import { useMessageSheet, type MessagePressProps } from "./message-sheet";
import { SourcesButton } from "./sources";
import { formatStamp, messageText, resendable, splitTurn, type Turn } from "./turns";

export { ThreadContext, type ThreadContextValue } from "./context";
export { LocalNoticeRow } from "./activity";

// Action buttons (A.7.4 / A.7.7): 32x32, radius 8px, 20px icon, tertiary, hover bg, no transition.
// Touch layouts get 44px targets (drawn, since the buttons sit side by side).
const actionBtn =
    "rounded-[calc(8px*var(--roundness))]! [--icon:20px] transition-none before:transition-none pointer-coarse:size-11";

function CopyAction({ text, label }: { text: string; label: string }) {
    const t = useT();
    const [copied, copy] = useCopy();
    return (
        <Tooltip label={copied ? t("thread-copied") : label}>
            <Button size="lg" uniform aria-label={label} className={actionBtn} onClick={() => copy(text)}>
                {copied ? <CheckIcon /> : <CopyIcon />}
            </Button>
        </Tooltip>
    );
}

/** The plain text of an answer message, for copying. */
function readableText(m: MessageItem): string {
    let s = "";
    for (const p of m.content) if (p.type === "output_text" || p.type === "input_text") s += p.text;
    return s;
}

export function TimeSeparator({ at }: { at: number }) {
    const { day, time } = formatStamp(at);
    return (
        <div role="separator" aria-label={`${day} ${time}`} className="flex justify-center py-4">
            <time dateTime={new Date(at).toISOString()} className="text-[length:var(--type-body,14px)] leading-5 text-tertiary">
                <span className="font-medium">{day}</span> {time}
            </time>
        </div>
    );
}

// User message (A.7.4)

/**
 * Messaging-app tail. The SVG box is sized from the bubble radius (thread.css): its left 13/20 overlap
 * the bubble, so the curl joins the bubble's side about half a radius above the bottom, sweeps out to
 * a tip 7/22 of a radius past the edge, and returns along a concave underside. Same colour as the
 * bubble, drawn over its corner, so there is no seam. `side="start"` mirrors it for assistant bubbles;
 * `dir="up"` uses a rising top-corner curve under the avatar.
 */
export function BubbleTail({
    side = "end",
    dir = "down",
    className,
}: {
    side?: "start" | "end";
    /** "up": flipped to the top corner, pointing up at an avatar above the bubble. */
    dir?: "down" | "up";
    className?: string;
}) {
    return (
        <svg aria-hidden viewBox="0 0 20 25" data-side={side} data-dir={dir} className={cn("bubble-tail", className)}>
            <path
                d={
                    dir === "up"
                        ? "M0 12H7C13 12 18 7 20 0V25H0Z"
                        : "M0 0H13V12.5C13 18.5 15.5 22.6 20 25C14.6 25.6 9.4 24.6 5.6 22.2C3.8 23.9 1.9 25 0 25Z"
                }
                fill="currentColor"
            />
        </svg>
    );
}

// 70% leaves a clear gutter on wide threads; on phones that gutter wastes a third of the screen, so allow 85%.
const bubbleShape =
    "relative max-w-[85%] md:max-w-[70%] whitespace-pre-wrap rounded-[calc(22px*var(--roundness))] px-4 py-2.5 text-[length:var(--type-headline,16px)] leading-[26px] font-normal break-words";
/** A neutral bubble (memory thoughts, previews of other people's words). */
export const userBubbleClass = `${bubbleShape} bg-user-bubble text-text`;
/** A message you sent: the accent colour. */
export const sentBubbleClass = `${bubbleShape} bg-sent-bubble text-on-sent-bubble`;

const UserMessage = memo(function UserMessage({
    message,
    tail = "down",
}: {
    message: MessageItem;
    /** "down": bottom corner (last bubble of a run). "up": top corner, under the avatar. false: none. */
    tail?: "down" | "up" | false;
}) {
    const { preview } = useContext(ThreadContext);
    return preview ? (
        <UserMessageBody message={message} tail={tail} />
    ) : (
        <InteractiveUserMessage message={message} tail={tail} />
    );
});

function InteractiveUserMessage({ message, tail }: { message: MessageItem; tail?: "down" | "up" | false }) {
    // Long-press on touch: the message action sheet (message-sheet.tsx).
    const press = useMessageSheet({ itemId: message.id, role: "user", text: messageText(message) });
    return (
        <>
            <UserMessageBody message={message} tail={tail} interactive gestures={press.props} />
            {press.sheet}
        </>
    );
}

function UserMessageBody({
    message,
    tail,
    interactive = false,
    gestures,
}: {
    message: MessageItem;
    tail?: "down" | "up" | false;
    interactive?: boolean;
    gestures?: MessagePressProps;
}) {
    const t = useT();
    const { conversationId } = useContext(ThreadContext);
    // Edit replaces the bubble with the inline editor (message-versions.tsx); saving adds a version.
    const editing = useEditing(conversationId, message.id) && interactive;
    const text = messageText(message);
    const images = message.content.filter((p) => p.type === "input_image");
    const files = message.content.filter((p) => p.type === "input_file");
    return (
        <div className="flex flex-col gap-2">
            <div className="msg-group flex flex-col items-end gap-1">
                <AttachmentChips images={images} files={files} interactive={interactive} />
                {editing && <MessageEditor message={message} />}
                {text && !editing && (
                    <div
                        {...gestures}
                        className={cn(sentBubbleClass, tail && "bubble-tailed")}
                        data-tail-dir={tail || undefined}
                    >
                        {text}
                        {tail && <BubbleTail dir={tail} className="text-sent-bubble" />}
                    </div>
                )}
                {interactive && !editing && (
                    <div className="flex flex-row-reverse gap-1">
                        <VersionSwitcher message={message} />
                        <div className="hover-actions mx-1 flex gap-2">
                            <div className="flex min-h-8">
                                <MessageTime at={message.created_at} />
                                {text && <CopyAction text={text} label={t("thread-copy-message")} />}
                                <BranchButtons itemId={message.id} role="user" className={actionBtn} />
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// Assistant answer and turn

const Answer = memo(function Answer({
    text,
    streaming,
    bubble,
}: {
    text: string;
    streaming: boolean;
    bubble: boolean;
}) {
    const t = useT();
    const body = <Markdown text={text} streaming={streaming} />;
    return (
        <div>
            <h4 className="sr-only">{t("thread-assistant-said")}</h4>
            {bubble ? (
                <div className="assistant-bubble bubble-tailed" data-tail-side="start">
                    {body}
                    <BubbleTail side="start" className="text-[var(--assistant-bubble)]" />
                </div>
            ) : (
                body
            )}
        </div>
    );
});

function CompletedAnswer({
    itemId,
    text,
    bubble,
    items,
}: {
    itemId: string;
    text: string;
    bubble: boolean;
    items: readonly OutputItem[];
}) {
    // Long-press on touch: the message action sheet (message-sheet.tsx).
    const press = useMessageSheet({ itemId, role: "assistant", text, items });
    // The sheet sits outside the pressable element: events from its portal bubble through the React tree.
    return (
        <>
            <div {...press.props}>
                <Answer text={text} streaming={false} bubble={bubble} />
            </div>
            {press.sheet}
        </>
    );
}

function CompletedActions({ itemId, text, items }: { itemId: string; text: string; items: readonly OutputItem[] }) {
    const t = useT();
    const at = items.find((i) => i.id === itemId);
    return (
        <div className="mt-3 -ms-0.5 flex min-h-5 max-w-[768px] gap-0.5">
            <CopyAction text={text} label={t("thread-copy")} />
            <BranchButtons itemId={itemId} role="assistant" className={actionBtn} />
            {/* The actions, then Sources (the evidence for the answer), then the time at the very end. */}
            <SourcesButton items={items} />
            <MessageTime at={at?.type === "message" ? at.created_at : undefined} />
        </div>
    );
}

/** What to do next, by run-end code, when the server message does not say. */
const RECOVERY: Record<string, string> = {
    model_not_allowed: msg("thread-recovery-model-not-allowed"),
    conversation_busy: msg("thread-recovery-conversation-busy"),
    process_limit: msg("thread-recovery-process-limit"),
    sandbox_unavailable: msg("thread-recovery-sandbox-unavailable"),
    timeout: msg("thread-recovery-timeout"),
};

/**
 * Server and provider messages sometimes keep a log tag ("[sandbox] ...") or a `key=/path` line pointing at a log
 * file on the server; the thread shows the sentence only.
 */
const plainMessage = (m: string) =>
    m
        .replace(/^\[[\w-]+\]\s*/, "")
        .replace(/^[\w-]+=\/\S*$/gm, "")
        .trim();

interface FailureText {
    title: string;
    hint?: string;
    /** The original message, shown under "Details" when the title and hint replaced it. */
    raw?: string;
}

/** Provider failures by HTTP status or error type, in words a person can act on. */
function providerFailure(
    status: number | undefined,
    type: string,
    detail: string,
): Omit<FailureText, "raw"> | undefined {
    const text = `${type} ${detail}`.toLowerCase();
    if (status === 529 || text.includes("overloaded"))
        return { title: translate("thread-failure-overloaded"), hint: translate("thread-failure-overloaded-hint") };
    if (status === 429 || text.includes("rate_limit") || text.includes("rate limit"))
        return { title: translate("thread-failure-rate-limit"), hint: translate("thread-failure-rate-limit-hint") };
    if (status === 401 || status === 403 || text.includes("authentication") || text.includes("permission"))
        return {
            title: translate("thread-failure-rejected"),
            hint: translate("thread-failure-rejected-hint"),
        };
    if (/context|too long|maximum.*tokens|token limit/.test(text))
        return {
            title: translate("thread-failure-too-long"),
            hint: translate("thread-failure-too-long-hint"),
        };
    if (status === 404 || text.includes("not_found") || text.includes("model not found"))
        return { title: translate("thread-failure-unavailable"), hint: translate("thread-failure-unavailable-hint") };
    if (status !== undefined && status >= 500)
        return { title: translate("thread-failure-provider"), hint: translate("thread-failure-provider-hint") };
    return undefined;
}

/**
 * A failed response in plain words. Provider errors often arrive as "<status> <JSON body>"; the thread shows a
 * sentence and a next step, and keeps the original under "Details" so nothing is hidden.
 */
function describeFailure(end: RunEndItem): FailureText {
    const message = plainMessage(end.message);
    const known = RECOVERY[end.code];
    if (known) return { title: message || translate("thread-failure-generic"), hint: translate(known) };
    const m = /^(\d{3})\b[:\s]*([\s\S]*)$/.exec(message);
    const status = m ? Number(m[1]) : undefined;
    let rest = (m ? m[2] : message) ?? "";
    let type = "";
    if (rest.trim().startsWith("{")) {
        try {
            const body = JSON.parse(rest) as {
                type?: string;
                error?: { type?: string; code?: string; message?: string };
            };
            const e = body.error ?? {};
            type = e.type ?? e.code ?? body.type ?? "";
            rest = e.message ?? "";
        } catch {
            // Not JSON after all: keep the text as it is.
        }
    }
    const mapped = providerFailure(status, type, rest);
    if (mapped) return { ...mapped, raw: message };
    if (/fetch failed|econnrefused|enotfound|network/i.test(message))
        return {
            title: translate("thread-failure-unreachable"),
            hint: translate("thread-failure-unreachable-hint"),
            raw: message,
        };
    const sentence = rest.trim() || message;
    return { title: sentence || translate("thread-failure-generic"), raw: sentence !== message ? message : undefined };
}

function FailedNote({ end, live, retryWith }: { end: RunEndItem; live: boolean; retryWith?: MessageItem }) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const { title, hint, raw } = describeFailure(end);
    return (
        <div
            role={live ? "alert" : undefined}
            data-run-end={end.status}
            className="mt-3 max-w-[768px] rounded-xl border border-subtle px-3.5 py-3 text-[length:var(--type-body,14px)] leading-5"
        >
            <div className="flex items-start gap-2.5">
                <WarningCircleIcon aria-hidden size={18} weight="fill" className="mt-px shrink-0 text-danger" />
                <div className="min-w-0 flex-1 break-words">
                    <p className="font-medium text-text">{title}</p>
                    {hint && <p className="mt-0.5 text-secondary">{hint}</p>}
                </div>
            </div>
            {(retryWith || raw) && (
                <div className="mt-2.5 flex flex-wrap items-center gap-1 ps-7">
                    {retryWith && <RetryButton user={retryWith} />}
                    {raw && (
                        <Button size="md" variant="ghost" pill aria-expanded={open} onClick={() => setOpen(!open)}>
                            {open ? t("thread-failure-hide-details") : t("thread-failure-details")}
                        </Button>
                    )}
                </div>
            )}
            {open && raw && (
                <pre className="mt-2 ms-7 overflow-x-auto rounded-lg bg-soft px-3 py-2 font-mono text-[length:var(--type-footnote,12px)] leading-[18px] whitespace-pre-wrap break-all text-secondary">
                    {raw}
                </pre>
            )}
        </div>
    );
}

/** Send the turn's user message again with the composer's current choice for this chat (the model it used). */
function RetryButton({ user }: { user: MessageItem }) {
    const t = useT();
    const { conversationId } = useContext(ThreadContext);
    const choice = useComposerChoice(conversationId);
    const live = useLive(conversationId);
    const busy = !!live && !live.done;
    const retry = () => {
        if (busy) return;
        void sendMessage({
            conversationId,
            text: messageText(user),
            attachments: resendable(user),
            model: choice.modelId,
            effort: choice.effort,
            permission: choice.permission,
        });
        // The note goes away with the old turn; keep focus where the user continues.
        document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus({ preventScroll: true });
    };
    return (
        <Button size="md" variant="soft" pill aria-disabled={busy || undefined} onClick={retry} className="shrink-0">
            <ArrowClockwiseIcon aria-hidden />
            {t("thread-try-again")}
        </Button>
    );
}

/**
 * Why a turn ended early (`chat.run_end`): failed in the danger tone with the reason, stopped and cut off as a
 * quiet line. Live notes are announced; stored ones are not, so opening a chat does not read out old failures.
 */
const RunEndNote = memo(function RunEndNote({
    end,
    live,
    retryWith,
}: {
    end: RunEndItem;
    live: boolean;
    /** The user message to send again, for the latest failed turn. */
    retryWith?: MessageItem;
}) {
    const t = useT();
    if (end.status === "failed") return <FailedNote end={end} live={live} retryWith={retryWith} />;
    const stopped = end.status === "cancelled";
    const Icon = stopped ? StopCircleIcon : ScissorsIcon;
    const detail = plainMessage(end.message);
    const generic = stopped ? /stopped/i.test(detail) : /cut off/i.test(detail);
    return (
        <div
            role={live ? "status" : undefined}
            data-run-end={end.status}
            className="mt-3 flex items-start gap-1.5 text-[length:var(--type-body,14px)] leading-5 text-tertiary"
        >
            <Icon aria-hidden size={16} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">
                {stopped ? t("thread-run-stopped") : t("thread-run-cut-off")}
                {detail && !generic && <span> · {detail}</span>}
            </span>
        </div>
    );
});

export const TurnView = memo(function TurnView({
    turn,
    stamp,
    deferred,
    tail = true,
    userAvatar = true,
    latest = false,
}: {
    turn: Turn;
    /** Show a time separator above the turn. */
    stamp?: number;
    /** Older turn: skip layout and paint until near the viewport. */
    deferred?: boolean;
    /** The user bubble gets a tail (false when another user message follows straight after). */
    tail?: boolean;
    /** Show the user's avatar (false when the previous message was also the user's). */
    userAvatar?: boolean;
    /** The newest turn of the thread: a failed one offers "Try again". */
    latest?: boolean;
}) {
    const t = useT();
    const { conversationId, avatars, assistantBubbles, preview } = useContext(ThreadContext);
    const running = !!turn.live && !turn.live.done;
    if (turn.local) {
        return (
            <div data-turn-key={turn.key}>
                <LocalNoticeRow
                    output={localOutput({ output: turn.items })}
                    running={running}
                    failed={!!turn.live && turn.live.done && turn.live.status !== "completed"}
                />
            </div>
        );
    }
    const { group, final, end } = splitTurn(turn.items);
    const finalText = final.map(readableText).join("\n\n");
    const streamingFinal = running && final.some((m) => m.status === "in_progress");
    const finalId = final.at(-1)?.id;
    const completed = !preview && !running && !!finalId && !!finalText;
    const thinking = running && turn.items.length === 0;
    const stopping = running && !!turn.live?.stopping;
    return (
        <div data-turn-key={turn.key} className={cn(deferred && "turn-cv")}>
            {stamp !== undefined && <TimeSeparator at={stamp} />}
            <div className="flex flex-col gap-1.5">
                <div className="flex flex-col">
                    <div className="flex flex-col gap-1">
                        {turn.user && (
                            <div className="relative">
                                <h4 className="sr-only">{t("thread-you-said")}</h4>
                                {/* Avatars on: the avatar above the first bubble of a run, the tail pointing up at it. */}
                                {avatars && userAvatar && (
                                    <div className="thread-avatar-above">
                                        <UserAvatar />
                                    </div>
                                )}
                                <UserMessage message={turn.user} tail={avatars ? userAvatar && "up" : tail && "down"} />
                            </div>
                        )}
                        {(group.length > 0 || thinking || final.length > 0) && (
                            <div className="relative flex flex-col gap-1">
                                {avatars && (
                                    <span className="thread-avatar-slot" data-side="start">
                                        <AssistantAvatar conversationId={conversationId} />
                                    </span>
                                )}
                                {group.length > 0 && <WorkedGroup turn={turn} items={group} />}
                                {thinking && (
                                    <div className="flex h-7 items-center text-[length:var(--type-body,14px)] leading-6">
                                        <ThinkingIndicator
                                            label={
                                                stopping
                                                    ? t("thread-stopping")
                                                    : turn.live?.queue
                                                      ? t("thread-queued", { position: turn.live.queue })
                                                      : t("thread-thinking")
                                            }
                                        />
                                    </div>
                                )}
                                {final.length > 0 &&
                                    (completed ? (
                                        <CompletedAnswer
                                            itemId={finalId}
                                            text={finalText}
                                            bubble={!!assistantBubbles}
                                            items={turn.items}
                                        />
                                    ) : (
                                        <Answer text={finalText} streaming={streamingFinal} bubble={!!assistantBubbles} />
                                    ))}
                            </div>
                        )}
                    </div>
                    {stopping && !thinking && (
                        <div role="status" className="mt-3 flex h-6 items-center text-[length:var(--type-body,14px)] leading-5">
                            <ThinkingIndicator label={t("thread-stopping")} />
                        </div>
                    )}
                    {turn.live?.notices && <RuntimeNotices notices={turn.live.notices} />}
                    {end && (
                        <RunEndNote
                            end={end}
                            live={!!turn.live}
                            retryWith={latest && !preview && end.status === "failed" ? turn.user : undefined}
                        />
                    )}
                    {completed && <CompletedActions itemId={finalId} text={finalText} items={turn.items} />}
                </div>
            </div>
        </div>
    );
});

/** Context compaction marker between turns. */
export function CompactionMarker() {
    const t = useT();
    return (
        <div role="separator" className="flex items-center gap-3 py-4 text-[length:var(--type-body,14px)] leading-5 text-tertiary">
            <div className="h-px flex-1 bg-[var(--border)]" />
            {t("thread-context-compacted")}
            <div className="h-px flex-1 bg-[var(--border)]" />
        </div>
    );
}

export type { ApprovalRequestItem };
