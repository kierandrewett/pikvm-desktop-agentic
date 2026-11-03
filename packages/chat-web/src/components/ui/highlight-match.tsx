/**
 * A label with matched ranges marked (type-to-jump, filters). Pure and memoised, so long lists only re-render
 * the rows whose label or ranges change. Ranges come from `matchLabel` in lib/typeahead.ts.
 *
 * The mark is an accent tint with an underline in the accent text colour, so it reads on hover and selected
 * row backgrounds in both themes without changing the text colour.
 */
import { memo, type ReactNode } from "react";
import type { MatchRange } from "../../lib/typeahead";

export const highlightMark =
    "rounded-[calc(3px*var(--roundness))] bg-[color-mix(in_oklab,var(--accent)_28%,transparent)] text-inherit underline decoration-[color-mix(in_oklab,var(--accent-text)_70%,transparent)] decoration-1 underline-offset-[3px]";

export const HighlightMatch = memo(function HighlightMatch({
    text,
    ranges,
}: {
    text: string;
    ranges?: readonly MatchRange[] | null;
}) {
    if (!ranges?.length) return text;
    const parts: ReactNode[] = [];
    let at = 0;
    for (const [start, end] of ranges) {
        if (start > at) parts.push(text.slice(at, start));
        parts.push(
            <mark key={start} className={highlightMark}>
                {text.slice(start, end)}
            </mark>,
        );
        at = end;
    }
    if (at < text.length) parts.push(text.slice(at));
    return parts;
});
