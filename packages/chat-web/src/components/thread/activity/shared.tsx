/**
 * Pieces shared by every activity step (tool calls, web search, subagents): the step row, the live label,
 * the favicon stack, a ticking clock and output blocks. Kept apart from activity.tsx so the web search and
 * subagent steps can import them without an import cycle.
 *
 * The row grammar (docs/spec/tool-call-reference-notes.md 4.2): `[verb] [subject] [note] [caret]` on one
 * quiet 14px line. The verb says what happened, the subject what it happened to (a command, a file, a
 * query), the note the outcome when it matters ("exit 101", "Stopped", "+3 -1"). A row with more to show
 * is a button; its detail opens in place, below the row, and is closed by default.
 */
import { CaretRightIcon, CheckIcon, CopyIcon } from "@pikvm/icons";
import { Button } from "../../../ui/index";
import { memo, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "../../../lib/cn";
import { Tooltip } from "../../ui/tooltip";
import { useCopy } from "../markdown";
import { Favicon, hostOf } from "../sources";
import { formatDuration } from "../turns";
import "./agent-activity.css";

/** Cadenced shimmer label (same look as the activity header). Announced politely when `announce`. */
export function Shimmer({
    text,
    className,
    announce = false,
}: {
    text: string;
    className?: string;
    announce?: boolean;
}) {
    return (
        <span className={cn("live-label", className)} aria-live={announce ? "polite" : undefined}>
            {text}
            <span aria-hidden key={text} className="live-sweep">
                <span className="live-highlight">{text}</span>
            </span>
        </span>
    );
}

/** Up to `max` site icons, overlapping. Hidden from assistive technology: the count says it in words. */
export function FaviconStack({ urls, max = 4, size = 16 }: { urls: readonly string[]; max?: number; size?: number }) {
    const hosts: string[] = [];
    for (const u of urls) {
        const h = hostOf(u);
        if (h && !hosts.includes(h)) hosts.push(h);
        if (hosts.length === max) break;
    }
    if (!hosts.length) return null;
    return (
        <span className="aa-favicons" aria-hidden>
            {hosts.map((h) => (
                <Favicon key={h} host={h} size={size} />
            ))}
        </span>
    );
}

// One shared one-second tick for every live clock on the page.
let tick = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(fn: () => void) {
    listeners.add(fn);
    timer ??= setInterval(() => {
        tick = Date.now();
        for (const l of listeners) l();
    }, 1000);
    return () => {
        listeners.delete(fn);
        if (!listeners.size && timer) {
            clearInterval(timer);
            timer = undefined;
        }
    };
}

/** The current time, updated once a second while `live`. */
export function useNow(live: boolean): number {
    const now = useSyncExternalStore(live ? subscribe : noopSubscribe, () => tick);
    const [mounted] = useState(() => Date.now());
    return live ? Math.max(now, mounted) : now;
}
const noopSubscribe = () => () => {};

/** "12s" that keeps counting while running. */
export function Elapsed({
    startedAt,
    durationMs,
    running,
}: {
    startedAt?: number;
    durationMs: number;
    running: boolean;
}) {
    const now = useNow(running);
    const ms = running && startedAt ? Math.max(durationMs, now - startedAt) : durationMs;
    return <span className="tabular-nums">{formatDuration(ms)}</span>;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How a step ended, or that it is still going. "stopped": cut off by Stop (or never finished), not a failure. */
export type StepState = "running" | "done" | "failed" | "stopped";

/**
 * One step: `[verb] [subject] [note] [caret]`, and its detail below when opened.
 *
 * - `kind` and `state` are written to `data-step` and `data-state` for styles and tests.
 * - `detail` is a render function, so closed steps build nothing.
 * - `open` (optional) is the default: closed unless given. A user toggle wins from then on.
 * - `focus` changes when something outside asks for this step (a citation, a panel): it opens and scrolls in.
 */
export const StepRow = memo(function StepRow({
    kind,
    state,
    verb,
    subject,
    mono = false,
    title,
    note,
    meta,
    detail,
    open: initial = false,
    focus,
    announce,
}: {
    kind: string;
    state: StepState;
    verb: string;
    subject?: ReactNode;
    /** The subject is code or a path. */
    mono?: boolean;
    /** Full text of a clipped subject, for the tooltip. */
    title?: string;
    /** The outcome word ("exit 101", "Failed", "Stopped"); toned by `state`. */
    note?: string;
    /** Quiet facts after the subject (counts, favicons, a diff stat). */
    meta?: ReactNode;
    detail?: () => ReactNode;
    open?: boolean;
    focus?: number;
    /** Status changes to announce politely (for example "LintScout failed"). */
    announce?: string;
}) {
    const [manual, setManual] = useState<boolean>();
    const open = !!detail && (manual ?? initial);
    const ref = useRef<HTMLLIElement>(null);
    const bodyId = useId();
    useEffect(() => {
        if (!focus || !detail) return;
        setManual(true);
        requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
        // Only a new focus request opens the step.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focus]);
    const head = (
        <>
            <span className="act-verb">{state === "running" ? <Shimmer text={verb} /> : verb}</span>
            {subject !== undefined && subject !== "" && (
                <span
                    className={cn("act-subject", mono && "act-mono")}
                    title={title}
                    translate={mono ? "no" : undefined}
                >
                    {subject}
                </span>
            )}
            {meta && <span className="act-meta">{meta}</span>}
            {note && (
                <span className="act-note" data-tone={state}>
                    {note}
                </span>
            )}
            {detail && <CaretRightIcon size={14} aria-hidden className="act-caret" data-open={open} />}
        </>
    );
    return (
        <li ref={ref} className="act-row" data-step={kind} data-state={state}>
            {detail ? (
                <button
                    type="button"
                    className="act-row-head"
                    aria-expanded={open}
                    aria-controls={open ? bodyId : undefined}
                    onClick={() => setManual(!open)}
                >
                    {head}
                </button>
            ) : (
                <div className="act-row-head">{head}</div>
            )}
            {open && (
                <div id={bodyId} className="act-detail">
                    {detail()}
                </div>
            )}
            {announce !== undefined && (
                <span className="aa-sr" aria-live="polite">
                    {announce}
                </span>
            )}
        </li>
    );
});

/** Small copy button that shows a tick for 2s. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
    const [copied, copy] = useCopy();
    return (
        <Tooltip label={copied ? "Copied" : label}>
            <button
                type="button"
                aria-label={label}
                onClick={(e) => {
                    e.stopPropagation();
                    copy(text);
                }}
                className={cn("act-copy", className)}
            >
                {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            </button>
        </Tooltip>
    );
}

export interface Line {
    /** Line number in the source file, when the tool gave one. */
    n?: number;
    text: string;
    /** Diff lines: added or removed. */
    kind?: "add" | "del";
}

const PREVIEW = 8;
const MAX_SHOWN = 2000;

/**
 * A capped block of lines: the first eight, then "Show all N lines" to a scroll area. Line numbers in a
 * gutter when the lines have them; diff lines on the added and deleted tints. `label` names the block
 * for screen readers ("Output", "Changes", "config.rs"). Errors keep the neutral text colour: only the
 * heading says it failed, so a failure is readable without the block shouting.
 */
export function Lines({
    lines,
    label,
    copyText,
    heading,
    bad = false,
    preview = PREVIEW,
    footer,
}: {
    lines: readonly Line[];
    label: string;
    copyText?: string;
    /** A small heading above the lines ("Exit code 101", "Error"); `bad` tones it, the lines stay neutral. */
    heading?: string;
    bad?: boolean;
    preview?: number;
    footer?: ReactNode;
}) {
    const [all, setAll] = useState(false);
    // A preview that would hide only a line or two shows everything instead.
    const fits = lines.length <= preview + 2;
    const shown = all || fits ? lines.slice(0, MAX_SHOWN) : lines.slice(0, preview);
    const hidden = lines.length - shown.length;
    const numbered = shown.some((l) => l.n !== undefined);
    return (
        <div className="act-block">
            {heading && (
                <div className="act-block-label" data-bad={bad || undefined}>
                    {heading}
                </div>
            )}
            <div
                role="region"
                aria-label={label}
                tabIndex={all && !fits ? 0 : undefined}
                data-no-drawer-gesture=""
                className={cn("act-lines", all && !fits && "act-lines-all", !all && hidden > 0 && "act-fade")}
            >
                {shown.map((l, i) => (
                    <div key={i} className="act-line" data-kind={l.kind}>
                        {numbered && (
                            <span className="act-line-n" aria-hidden>
                                {l.n ?? ""}
                            </span>
                        )}
                        {l.kind && (
                            <span className="act-line-sign" aria-hidden>
                                {l.kind === "add" ? "+" : "-"}
                            </span>
                        )}
                        <span className="act-line-text">{l.text || " "}</span>
                    </div>
                ))}
            </div>
            {(hidden > 0 || (all && !fits) || footer) && (
                <div className="act-block-foot">
                    {hidden > 0 || (all && !fits) ? (
                        <Button variant="link" onClick={() => setAll(!all)}>
                            {all ? "Show less" : `Show all ${lines.length} lines`}
                        </Button>
                    ) : null}
                    {footer}
                </div>
            )}
            {copyText !== undefined && <CopyButton text={copyText} label={`Copy ${label.toLowerCase()}`} />}
        </div>
    );
}

/** Plain text as lines, with blank edges trimmed and runs of blank lines squashed. */
export function textLines(text: string): Line[] {
    const body = text.replace(/^\s*\n|\s+$/g, "").replace(/\n{3,}/g, "\n\n");
    return body ? body.split("\n").map((t) => ({ text: t })) : [];
}
