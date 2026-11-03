/**
 * Label matching for filtering long lists on every keystroke (the sidebar filter over thousands of chats).
 *
 * Same rules and results as `matchLabel` in typeahead.ts (case and diacritic insensitive; label prefix 3 >
 * word start 2 > substring 1; ranges in the original label's UTF-16 indices), but each label is folded once
 * and cached, so a keystroke costs one `indexOf` per label. `matchLabel` folds the label on every call:
 * over 5,000 titles that is about 170 ms per keystroke; prepared labels take under 2 ms.
 *
 * Folding has an ASCII fast path (lower-casing is the whole fold, and indices map one to one).
 */
import type { LabelMatch, MatchRange } from "./typeahead";

export interface PreparedLabel {
    folded: string;
    /** Original index for each folded code unit (plus the end), or null when they map one to one. */
    map: Uint32Array | null;
    length: number;
}

const ASCII = /^[\x00-\x7f]*$/;

function prepare(label: string): PreparedLabel {
    if (ASCII.test(label)) return { folded: label.toLowerCase(), map: null, length: label.length };
    let folded = "";
    const map: number[] = [];
    let i = 0;
    for (const ch of label) {
        const f = ch.charCodeAt(0) < 0x80 ? ch.toLowerCase() : ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
        for (let k = 0; k < f.length; k++) map.push(i);
        folded += f;
        i += ch.length;
    }
    map.push(i);
    return { folded, map: Uint32Array.from(map), length: label.length };
}

const MAX_CACHED = 50_000;
const cache = new Map<string, PreparedLabel>();

/** The folded form of a label, computed once. */
export function prepareLabel(label: string): PreparedLabel {
    let p = cache.get(label);
    if (!p) {
        p = prepare(label);
        if (cache.size >= MAX_CACHED) cache.clear();
        cache.set(label, p);
    }
    return p;
}

/** Fold a query once per keystroke, with the same rules as labels. */
export function foldQuery(query: string): string {
    return prepareLabel(query).folded;
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** Where a folded query matches a prepared label (see matchLabel), or null. */
export function matchPrepared(p: PreparedLabel, q: string): LabelMatch | null {
    if (!q) return null;
    const { folded, map, length } = p;
    const range = (at: number): MatchRange =>
        map ? [map[at] ?? 0, map[at + q.length] ?? length] : [at, Math.min(at + q.length, length)];
    if (folded.startsWith(q)) return { score: 3, ranges: [range(0)] };
    for (let at = folded.indexOf(q, 1); at > 0; at = folded.indexOf(q, at + 1)) {
        if (!isWordChar(folded[at - 1])) return { score: 2, ranges: [range(at)] };
    }
    const at = folded.indexOf(q);
    return at >= 0 ? { score: 1, ranges: [range(at)] } : null;
}

/**
 * Prepare labels in idle time (a few ms per idle period), so the first filter keystroke does not pay for
 * folding thousands of labels at once. Returns a cancel function.
 */
export function warmLabels(labels: readonly string[]): () => void {
    let i = 0;
    let handle = 0;
    const idle =
        window.requestIdleCallback ??
        ((fn: IdleRequestCallback) => window.setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 4 }), 50));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const step = (deadline: IdleDeadline) => {
        while (i < labels.length && deadline.timeRemaining() > 1) prepareLabel(labels[i++]!);
        if (i < labels.length) handle = idle(step);
    };
    handle = idle(step);
    return () => cancel(handle);
}
