/**
 * Type-to-jump for lists and menus: label matching plus the typed-buffer state machine.
 *
 * Matching (`matchLabel`) is case and diacritic insensitive and ranks a label prefix (3) over a word start (2)
 * over any substring (1). Ranges are in the original label's UTF-16 indices, so they can mark the label as shown.
 *
 * The buffer (`useTypeahead`) appends each typed character. When the longer buffer matches nothing, it restarts
 * from that character, so "del" followed by "re" ends on "Rename" instead of sticking on "Delete". It clears after
 * `timeoutMs` without a key, and on `clear()` (Escape, arrow keys, pointer movement, selection).
 *
 * `findMatch` picks the item for a buffer. A single character, or the same character repeated ("aaa"), cycles
 * through the items that start with it, starting after the current item, as native menus do. A longer buffer
 * keeps the current item while it is still a best match, so typing more letters never jumps away from it.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type MatchRange = readonly [start: number, end: number];

export interface LabelMatch {
    /** 3 = label prefix, 2 = word start, 1 = substring. */
    score: 1 | 2 | 3;
    ranges: MatchRange[];
}

/** Folded text plus, for each folded code unit, the index of the original code unit it came from. */
function fold(text: string): { folded: string; map: number[] } {
    let folded = "";
    const map: number[] = [];
    let i = 0;
    for (const ch of text) {
        const f = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
        for (let k = 0; k < f.length; k++) map.push(i);
        folded += f;
        i += ch.length;
    }
    map.push(i);
    return { folded, map };
}

const foldQuery = (q: string) => fold(q).folded;

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** Where `query` matches `label`, or null. Empty queries never match. */
export function matchLabel(label: string, query: string): LabelMatch | null {
    const q = foldQuery(query);
    if (!q) return null;
    const { folded, map } = fold(label);
    const range = (at: number): MatchRange => [map[at] ?? 0, map[at + q.length] ?? label.length];
    if (folded.startsWith(q)) return { score: 3, ranges: [range(0)] };
    for (let at = folded.indexOf(q, 1); at > 0; at = folded.indexOf(q, at + 1)) {
        if (!isWordChar(folded[at - 1])) return { score: 2, ranges: [range(at)] };
    }
    const at = folded.indexOf(q);
    return at >= 0 ? { score: 1, ranges: [range(at)] } : null;
}

export interface TypeaheadHit {
    index: number;
    /** The query the hit was found with: the single letter when a repeated letter cycles. */
    query: string;
    match: LabelMatch;
}

/** The item a buffer points at, given the labels in order and the currently active index (-1 for none). */
export function findMatch(labels: readonly string[], query: string, current: number): TypeaheadHit | null {
    const n = labels.length;
    if (!n || !query) return null;
    const first = query[0] ?? "";
    const cycling = [...query].every((c) => c === first);
    const q = cycling ? first : query;
    // Single letters search after the current item; longer buffers include it.
    const start = cycling ? current + 1 : Math.max(current, 0);
    let best: TypeaheadHit | null = null;
    for (let k = 0; k < n; k++) {
        const index = (((start + k) % n) + n) % n;
        const match = matchLabel(labels[index] ?? "", q);
        if (match && (!best || match.score > best.match.score)) best = { index, query: q, match };
        if (best?.match.score === 3) break;
    }
    return best;
}

export interface Typeahead {
    /** The current buffer ("" when idle). */
    query: string;
    /**
     * Add a typed character and return the new buffer. `accept(buffer)` says whether a buffer matches anything;
     * when the appended buffer does not, the buffer restarts from `char`.
     */
    push: (char: string, accept: (buffer: string) => boolean) => string;
    /** Remove the last character (Backspace) and return the new buffer. */
    pop: () => string;
    clear: () => void;
}

export function useTypeahead({ timeoutMs = 1000 }: { timeoutMs?: number } = {}): Typeahead {
    const [query, setQuery] = useState("");
    // The key handler needs the buffer synchronously, between renders.
    const ref = useRef("");
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

    const set = useCallback(
        (next: string) => {
            ref.current = next;
            setQuery(next);
            clearTimeout(timer.current);
            if (next) timer.current = setTimeout(() => set(""), timeoutMs);
        },
        [timeoutMs],
    );

    useEffect(() => () => clearTimeout(timer.current), []);

    const push = useCallback(
        (char: string, accept: (buffer: string) => boolean) => {
            const appended = ref.current + char;
            const next = !ref.current || accept(appended) ? appended : char;
            set(next);
            return next;
        },
        [set],
    );
    const pop = useCallback(() => {
        const next = ref.current.slice(0, -1);
        set(next);
        return next;
    }, [set]);
    const clear = useCallback(() => {
        if (ref.current) set("");
    }, [set]);

    return { query, push, pop, clear };
}

/** A printable character key without command modifiers (Space excluded: it selects). */
export function typeaheadChar(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | null {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    if (e.key.length !== 1 || e.key === " ") return null;
    return e.key;
}
