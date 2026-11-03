/**
 * Question tray: attached to the top of the composer, like the approval tray, while the assistant waits
 * for an answer. One question at a time; several questions in one request step through ("1 of 3").
 *
 * Kinds: a list of options (single choice: click, a number key or Enter answers; multiple choice: Space
 * or a number key toggles, Enter or Submit sends), "Something else" free text, yes or no, one line of
 * text, and several lines (editor).
 *
 * Keyboard while the list has focus: 1-9 pick, arrows move, Enter chooses, Escape skips the rest, and
 * typing a letter starts a free-text answer. While the tray is open the composer answers the current
 * question in free text (see `useQuestionReply`).
 *
 * Skip and close do not stop the assistant: it continues without the answer. The composer's stop
 * button is what ends the run.
 */
import type { AskRequestItem, Question, QuestionAnswer } from "@pikvm/chat-protocol";
import { ArrowElbowDownLeftIcon, CaretLeftIcon, CaretRightIcon, CheckIcon, PencilSimpleIcon, XIcon } from "@pikvm/icons";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useCoarsePointer } from "../../lib/media";
import { Button } from "../ui/button";
import { Kbd, Tooltip } from "../ui/tooltip";
import { answerStep, getDraft, setDraft, skipRest, useOpenQuestions, useQuestionsVersion } from "./questions/store";
import { useT } from "../../l10n/provider";
import "./questions/questions.css";

/** Seconds until `expires` (epoch ms), ticking once a second. */
function useSecondsLeft(expires: number | undefined): number | undefined {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!expires) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [expires]);
    return expires === undefined ? undefined : Math.max(0, Math.ceil((expires - now) / 1000));
}

/** Take focus when it opens, unless the user is in the middle of typing somewhere else. */
function mayTakeFocus(): boolean {
    const el = document.activeElement;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value.trim() === "";
    return !(el instanceof HTMLElement && el.isContentEditable);
}

function Badge({ children, on }: { children: ReactNode; on?: boolean }) {
    return (
        <span
            aria-hidden
            className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-md text-xs font-medium tabular-nums transition-colors duration-[var(--duration-basic)]",
                on ? "bg-accent text-on-accent" : "bg-kbd text-secondary",
            )}
        >
            {children}
        </span>
    );
}

const rowClass = (active: boolean, coarse: boolean) =>
    cn(
        "question-row flex min-h-[var(--menu-row-height)] cursor-default select-none items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm leading-5 text-text",
        "hover-device:hover:bg-hover",
        coarse && "min-h-12",
        active && "bg-hover",
    );

interface StepProps {
    item: AskRequestItem;
    conversationId: string;
    step: number;
    autoFocus: boolean;
}

function StepView({ item, conversationId, step, autoFocus }: StepProps) {
    const t = useT();
    const coarse = useCoarsePointer();
    const uid = useId();
    const q: Question = item.questions[step]!;
    const count = item.questions.length;
    const draft = getDraft(item);
    const prev = draft.answers[step];
    const kind = item.kind;
    const textOnly = kind === "input" || kind === "editor";
    const free = item.allow_free_text && !textOnly;
    const multi = !!q.multi;
    const rows = q.options.length + (free ? 1 : 0);
    const freeIndex = free ? q.options.length : -1;

    const [active, setActive] = useState(() => {
        if (prev?.text) return freeIndex;
        const picked = prev?.selected[0] ? q.options.findIndex((o) => o.label === prev.selected[0]) : -1;
        return picked >= 0 ? picked : Math.min(Math.max(q.recommended ?? 0, 0), Math.max(rows - 1, 0));
    });
    const [picked, setPicked] = useState<string[]>(prev?.selected ?? []);
    const [editing, setEditing] = useState(textOnly || !!prev?.text);
    const [text, setText] = useState(prev?.text ?? item.prefill ?? "");
    const [listFocus, setListFocus] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
    const seconds = useSecondsLeft(item.expires_at);

    useEffect(() => {
        // Focus on open (see mayTakeFocus), or when the previous step took the focus with it.
        const lost = !document.activeElement || document.activeElement === document.body;
        if (coarse || !(autoFocus || lost)) return;
        if (editing) inputRef.current?.focus();
        else listRef.current?.focus();
        // The focus event can fire before React listens (first paint); read the result instead.
        setListFocus(!!listRef.current && document.activeElement === listRef.current);
        // Mount only: later focus moves follow the user's actions.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const send = (a: QuestionAnswer) => answerStep(conversationId, item, a);
    const skipStep = () => {
        if (count === 1 || kind !== "ask") return skipRest(conversationId, item);
        send({ id: q.id, selected: [], skipped: true });
    };
    const startEditing = (initial?: string) => {
        setEditing(true);
        setActive(freeIndex);
        if (initial !== undefined) setText(initial);
        requestAnimationFrame(() => inputRef.current?.focus());
    };
    const choose = (i: number) => {
        if (i === freeIndex) return startEditing();
        const label = q.options[i]?.label;
        if (!label) return;
        setActive(i);
        if (multi) setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
        else send({ id: q.id, selected: [label] });
    };
    const submitMulti = () => {
        const t = editing ? text.trim() : "";
        if (!picked.length && !t) return;
        send({ id: q.id, selected: picked, ...(t ? { text: t } : {}) });
    };
    const submitText = () => {
        const t = text.trim();
        if (!t) return;
        if (multi) return submitMulti();
        send({ id: q.id, selected: [], text: t });
    };
    const go = (to: number) => {
        if (to < 0 || to >= count) return;
        setDraft(item, { ...draft, step: to });
    };

    const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const n = rows;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (n) setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n));
        } else if (e.key === "Home" || e.key === "End") {
            e.preventDefault();
            setActive(e.key === "Home" ? 0 : n - 1);
        } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= q.options.length) {
            e.preventDefault();
            choose(Number(e.key) - 1);
        } else if (e.key === " ") {
            e.preventDefault();
            choose(active);
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (multi && active !== freeIndex && picked.length) submitMulti();
            else choose(active);
        } else if (e.key === "Escape") {
            e.preventDefault();
            skipRest(conversationId, item);
        } else if (count > 1 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            e.preventDefault();
            go(step + (e.key === "ArrowLeft" ? -1 : 1));
        } else if (free && e.key.length === 1 && e.key.trim()) {
            // A letter starts a free-text answer with that letter.
            e.preventDefault();
            startEditing(e.key);
        }
    };

    const onInputKey = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (e.nativeEvent.isComposing) return;
        const editor = kind === "editor";
        if (e.key === "Enter" && (!editor || e.metaKey || e.ctrlKey) && !e.shiftKey) {
            e.preventDefault();
            submitText();
        } else if (e.key === "Escape") {
            e.preventDefault();
            if (textOnly) return skipRest(conversationId, item);
            setEditing(false);
            listRef.current?.focus();
        }
    };

    const recommended = q.recommended !== undefined ? q.options[q.recommended]?.label : undefined;
    const countdown =
        seconds === undefined
            ? undefined
            : kind === "ask" && recommended
              ? t("thread-qt-chooses", { option: recommended, seconds })
              : t("thread-qt-closes", { seconds });
    const titleId = `${uid}-title`;
    const showEnter = (i: number) =>
        !coarse && listFocus && active === i && !(multi && i !== freeIndex && !picked.length);
    const last = step === count - 1 || item.questions.every((_, i) => i === step || draft.answers[i]);
    const needsSubmit = multi || kind === "editor" || (textOnly && coarse);

    // In the header on desktop; in the footer on touch screens, where the title needs the width.
    const stepper = count > 1 && (
        <div
            className={cn(
                "flex shrink-0 items-center gap-0.5 text-xs text-tertiary tabular-nums",
                coarse && "-ml-2.5 mr-auto",
            )}
        >
            <Button
                uniform
                size={coarse ? "2xl" : "md"}
                aria-label={t("thread-qt-previous")}
                disabled={step === 0}
                onClick={() => go(step - 1)}
            >
                <CaretLeftIcon size={16} />
            </Button>
            <span aria-live="polite">{t("thread-qt-step", { step: step + 1, count })}</span>
            <Button
                uniform
                size={coarse ? "2xl" : "md"}
                aria-label={t("thread-qt-next")}
                disabled={step === count - 1}
                onClick={() => go(step + 1)}
            >
                <CaretRightIcon size={16} />
            </Button>
        </div>
    );
    const hint = coarse
        ? ""
        : kind === "editor"
          ? t("thread-qt-hint-editor")
          : editing
            ? textOnly
                ? t("thread-qt-hint-send-skip")
                : t("thread-qt-hint-send-back")
            : multi
              ? t("thread-qt-hint-multi")
              : t("thread-qt-hint-choose");

    return (
        <section
            aria-labelledby={titleId}
            className="flex flex-col gap-1.5 px-2 pt-2.5 pb-[calc(24px+12px)] max-sm:px-1.5"
        >
            <div className="flex items-start gap-1 pl-2.5">
                <h3
                    id={titleId}
                    className="min-w-0 flex-1 py-1 text-[length:var(--type-callout,15px)] leading-6 font-semibold text-pretty text-text"
                >
                    {q.question}
                </h3>
                {!coarse && stepper}
                <Tooltip label={count > 1 ? t("thread-qt-skip-rest") : t("thread-qt-skip-one")}>
                    <Button
                        uniform
                        size={coarse ? "2xl" : "md"}
                        aria-label={count > 1 ? t("thread-qt-skip-rest") : t("thread-qt-skip-one")}
                        onClick={() => skipRest(conversationId, item)}
                    >
                        <XIcon size={18} />
                    </Button>
                </Tooltip>
            </div>
            {item.message && (
                <p className="px-2.5 text-sm leading-5 whitespace-pre-wrap text-secondary">{item.message}</p>
            )}

            {rows > 0 && (
                <div
                    ref={listRef}
                    role="listbox"
                    tabIndex={0}
                    aria-labelledby={titleId}
                    aria-multiselectable={multi || undefined}
                    aria-activedescendant={`${uid}-o${active}`}
                    onKeyDown={onListKey}
                    onFocus={() => setListFocus(true)}
                    onBlur={() => setListFocus(false)}
                    className="question-list flex flex-col gap-px rounded-2xl outline-none"
                >
                    {q.options.map((o, i) => {
                        const on = picked.includes(o.label);
                        return (
                            <div
                                key={o.label}
                                id={`${uid}-o${i}`}
                                role="option"
                                aria-selected={multi ? on : active === i}
                                data-active={listFocus && active === i ? "" : undefined}
                                onPointerMove={() => !coarse && setActive(i)}
                                onClick={() => choose(i)}
                                className={rowClass(listFocus && active === i, coarse)}
                            >
                                <Badge on={multi && on}>
                                    {multi && on ? <CheckIcon size={14} weight="bold" /> : i + 1}
                                </Badge>
                                <span className="min-w-0 flex-1">
                                    <span className="block break-words">{o.label}</span>
                                    {o.description && (
                                        <span className="block text-xs leading-4 text-tertiary">{o.description}</span>
                                    )}
                                </span>
                                {o.label === recommended && !showEnter(i) && (
                                    <span className="shrink-0 text-xs text-tertiary">{t("thread-qt-recommended")}</span>
                                )}
                                {showEnter(i) && (
                                    <Kbd className="shrink-0 gap-1 text-xs! text-secondary!">
                                        <ArrowElbowDownLeftIcon size={14} />
                                    </Kbd>
                                )}
                            </div>
                        );
                    })}
                    {free && !editing && (
                        <div
                            id={`${uid}-o${freeIndex}`}
                            role="option"
                            aria-selected={active === freeIndex}
                            data-active={listFocus && active === freeIndex ? "" : undefined}
                            onPointerMove={() => !coarse && setActive(freeIndex)}
                            onClick={() => startEditing()}
                            className={rowClass(listFocus && active === freeIndex, coarse)}
                        >
                            <Badge>
                                <PencilSimpleIcon size={14} />
                            </Badge>
                            <span className="min-w-0 flex-1 text-secondary">{t("thread-qt-other")}</span>
                            {showEnter(freeIndex) && (
                                <Kbd className="shrink-0 text-xs! text-secondary!">
                                    <ArrowElbowDownLeftIcon size={14} />
                                </Kbd>
                            )}
                        </div>
                    )}
                </div>
            )}

            {editing && kind !== "editor" && (
                <label className={cn(rowClass(false, coarse), "question-input cursor-text")}>
                    <Badge>
                        <PencilSimpleIcon size={14} />
                    </Badge>
                    <input
                        ref={inputRef}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={onInputKey}
                        aria-label={textOnly ? q.question : t("thread-qt-your-answer")}
                        placeholder={item.placeholder ?? (textOnly ? t("thread-qt-type") : t("thread-qt-other"))}
                        enterKeyHint="send"
                        className="min-w-0 flex-1 bg-transparent text-base leading-5 text-text caret-[var(--text)] outline-none placeholder:text-tertiary sm:text-sm"
                    />
                    {!coarse && text.trim() && (
                        <Kbd className="shrink-0 text-xs! text-secondary!">
                            <ArrowElbowDownLeftIcon size={14} />
                        </Kbd>
                    )}
                </label>
            )}
            {kind === "editor" && (
                <textarea
                    ref={inputRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onInputKey}
                    aria-label={q.question}
                    rows={5}
                    placeholder={t("thread-qt-type")}
                    className="question-input max-h-64 min-h-28 resize-y rounded-xl bg-soft px-3 py-2 text-base leading-5 text-text caret-[var(--text)] outline-none placeholder:text-tertiary sm:text-sm"
                />
            )}

            <div className="flex min-h-8 items-center justify-end gap-2 pl-2.5">
                {coarse && stepper}
                {(countdown || hint) && (
                    <span className="mr-auto truncate text-xs text-tertiary tabular-nums" aria-live="off">
                        {countdown ?? hint}
                    </span>
                )}
                <Button size={coarse ? "2xl" : "lg"} variant="soft" pill className="rounded-full!" onClick={skipStep}>
                    {t("thread-qt-skip")}
                </Button>
                {needsSubmit && (
                    <Button
                        size={coarse ? "2xl" : "lg"}
                        variant="solid"
                        pill
                        className="rounded-full!"
                        disabled={multi ? !picked.length && !(editing && text.trim()) : !text.trim()}
                        onClick={multi ? submitMulti : submitText}
                    >
                        {last ? t("thread-qt-send") : t("thread-qt-continue")}
                    </Button>
                )}
            </div>
        </section>
    );
}

/** Mount directly above the Composer, next to the approval tray. Renders nothing while no question is open. */
export function QuestionTray({ conversationId }: { conversationId: string }) {
    const t = useT();
    const open = useOpenQuestions(conversationId);
    useQuestionsVersion();
    const current = open[0];
    const last = useRef<AskRequestItem | undefined>(undefined);
    const focusOnOpen = useRef(false);
    if (current && current.id !== last.current?.id) focusOnOpen.current = mayTakeFocus();
    if (current) last.current = current;
    const [mounted, setMounted] = useState(!!current);
    useEffect(() => {
        if (current) setMounted(true);
        // The step view has used it by now (child effects run first).
        focusOnOpen.current = false;
    }, [current]);
    if (!mounted || !last.current) return null;
    const item = last.current;
    const leaving = !current;
    const step = Math.min(getDraft(item).step, item.questions.length - 1);
    return (
        <div className="relative -mb-6 overflow-hidden px-[13px] pt-3 max-sm:px-1.5">
            <div
                role="region"
                aria-label={t("thread-qt-region")}
                data-state={leaving ? "closed" : "open"}
                inert={leaving || undefined}
                onAnimationEnd={() => leaving && setMounted(false)}
                className="question-tray rounded-t-2xl bg-composer shadow-composer"
            >
                <StepView
                    key={`${item.id}:${step}`}
                    item={item}
                    conversationId={conversationId}
                    step={step}
                    autoFocus={focusOnOpen.current}
                />
            </div>
        </div>
    );
}
