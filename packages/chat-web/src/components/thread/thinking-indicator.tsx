/**
 * Thinking indicator: a small animated mark plus a live one-line status.
 *
 * - Glyph: three accent dots on a slow orbit, each breathing on an offset phase (transform and
 *   opacity only). When the work finishes the dots draw into the centre and settle as one dot. With
 *   reduced motion it is a gentle opacity pulse. Durations follow --motion-scale.
 * - Label: derived from the streamed reasoning (latest heading, else the latest complete natural-language
 *   sentence; code, lists and JSON are skipped, else the generic label), throttled to one change per 600ms, and
 *   slid in when it changes.
 *
 * Exported for the activity header, the "Thinking" placeholder and the subagent lanes (glyph and
 * label apart, so a lane can put the glyph in its status slot).
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

const MAX_LABEL = 72;

function clip(s: string): string {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL - 1).trimEnd()}…` : t;
}

const CODE_MARKS = /[{}[\]<>|\\]|=>|->|==|::|\w\(|\)\s*[;,{.]|;\s*$|\w\s=\s\S|`/;
const LIST_MARK = /^\s*(?:[-*+\u2022]|\d+[.)])\s/;
const IDENTIFIER = /^[\p{L}\d]*(?:[\p{Ll}\d][\p{Lu}]|_)[\p{L}\d_]*$/u;

/**
 * True when the fragment reads as a natural-language phrase: no code marks, no list marker, no JSON key, mostly
 * letters, and at most a few identifier-like words. Deterministic and language-neutral (Unicode letters).
 */
function isProse(fragment: string, minWords: number): boolean {
    const s = fragment.trim();
    if (s.length < 6 || LIST_MARK.test(s) || CODE_MARKS.test(s) || /"[\w-]+"\s*:/.test(s)) return false;
    const words = s.split(/\s+/);
    if (words.length < minWords) return false;
    const letters = (s.match(/\p{L}/gu) ?? []).length;
    if (letters / s.length < 0.6) return false;
    const identifiers = words.filter((w) => IDENTIFIER.test(w.replace(/^[^\p{L}\d]+|[^\p{L}\d_]+$/gu, ""))).length;
    return identifiers / words.length <= 0.25;
}

/** The reasoning without fenced code blocks, including a block that is still open at the end of the text. */
function withoutCode(text: string): string {
    return text.replace(/```[\s\S]*?(?:```|$)/g, "\n");
}

/**
 * Status line for streamed reasoning, or undefined when nothing in it reads as natural language (the caller then
 * shows the generic "Thinking" label). In order of preference:
 * 1. the latest heading ("**Considering the angle**" or "## ...") that reads as a phrase;
 * 2. the latest complete sentence (ends in a full stop, "!", "?" or an ellipsis) that reads as a phrase.
 * Code blocks, list items, JSON and identifier-heavy lines are skipped, and so is a sentence that is still being
 * written, so the label changes at sentence boundaries and never shows a half-typed fragment of code.
 */
export function thinkingStatus(reasoning: string): string | undefined {
    const text = withoutCode(reasoning).trim();
    if (!text) return undefined;
    const headings: string[] = [];
    for (const m of text.matchAll(/^\s*(?:#{1,6}\s+(.+)|\*\*([^*\n]{2,120})\*\*\s*$)/gm)) headings.push(m[1] ?? m[2] ?? "");
    if (!headings.length) for (const m of text.matchAll(/\*\*([^*\n]{2,120})\*\*/g)) headings.push(m[1] ?? "");
    for (const h of headings.reverse()) {
        const clean = h.replace(/[*_#]/g, "").trim();
        if (isProse(clean, 1)) return clip(clean);
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.replace(/[*_>]/g, "").trim();
        if (!line || LIST_MARK.test(line)) continue;
        const sentences = line.split(/(?<=[.!?\u2026])\s+/);
        // A line that is the last of the text and has no end mark is still being written.
        const last = sentences.at(-1)!;
        if (i === lines.length - 1 && !/[.!?\u2026]$/.test(last)) sentences.pop();
        for (let j = sentences.length - 1; j >= 0; j--) {
            const sentence = sentences[j]!.trim();
            if (isProse(sentence, 3)) return clip(sentence.replace(/[.;:]$/, ""));
        }
    }
    return undefined;
}

/** The value, changing at most once per `ms` (the latest value wins at the end of each window). */
function useThrottled<T>(value: T, ms: number): T {
    const [shown, setShown] = useState(value);
    const last = useRef(0);
    useEffect(() => {
        const wait = last.current + ms - Date.now();
        if (wait <= 0) {
            last.current = Date.now();
            setShown(value);
            return;
        }
        const t = setTimeout(() => {
            last.current = Date.now();
            setShown(value);
        }, wait);
        return () => clearTimeout(t);
    }, [value, ms]);
    return shown;
}

/** Three orbiting, breathing dots; `done` settles them into one still dot. */
export function ThinkingGlyph({ done = false, className }: { done?: boolean; className?: string }) {
    return (
        <span aria-hidden data-done={done} className={cn("thinking-glyph", className)}>
            <span className="thinking-orbit">
                {[0, 1, 2].map((i) => (
                    <span key={i} className="thinking-slot" style={{ "--i": i } as React.CSSProperties}>
                        <span className="thinking-dot" />
                    </span>
                ))}
            </span>
        </span>
    );
}

/** A status line that changes at most every 600ms and slides in when it does. */
export function ThinkingLabel({ label, className }: { label: string; className?: string }) {
    const shown = useThrottled(label, 600);
    return (
        <span className={cn("relative min-w-0 overflow-hidden", className)} aria-live="polite">
            <span key={shown} className="thinking-label block truncate">
                {shown}
            </span>
        </span>
    );
}

/** Glyph plus a status line that slides in when it changes. */
export function ThinkingIndicator({
    label,
    done = false,
    className,
}: {
    label: string;
    done?: boolean;
    className?: string;
}) {
    return (
        <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
            <ThinkingGlyph done={done} />
            <ThinkingLabel label={label} />
        </span>
    );
}
