/**
 * Finding words inside one transcript, in the page.
 *
 * The host's search (full text, with stemming) chose which recordings and which seconds to open; this marks the words in the one
 * that is open. It reads a query as the host does: words, `"phrases"`, the last word also as a prefix. Because the host also
 * matches other forms of a word ("upgrading" for "upgrade"), a word of five letters or more is marked by its stem, found by
 * dropping an ending (ing, ed, es, s, e, ly): an approximation of the host's stemmer that errs towards marking a little more.
 */

import type { TranscriptSegment } from "@pikvm/contracts/recordings";

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function stem(word: string): string {
    const lower = word.toLowerCase();
    if (lower.length < 5) return lower;
    const cut = lower.replace(/(?:ing|ed|es|ly|s|e)$/u, "");
    return cut.length >= 3 ? cut : lower;
}

/** One word as a pattern: the last word of a query as a prefix; a word with an ending by its stem; any other as itself or its plural. */
function wordPattern(word: string, asPrefix: boolean): string {
    const lower = word.toLowerCase();
    if (asPrefix) return `${escape(lower)}[\\p{L}\\p{N}]*`;
    const base = stem(word);
    if (base !== lower) return `${escape(base)}[\\p{L}\\p{N}]*`;
    return `${escape(lower)}(?:e?s)?(?![\\p{L}\\p{N}])`;
}

/** The patterns a query stands for, each marking one word or phrase. Empty when there is nothing to look for. */
export function compileQuery(query: string): RegExp[] {
    const patterns: RegExp[] = [];
    const chunk = /"([^"]*)"?|([^\s"]+)/gu;
    const open = !/[\s"]$/u.test(query);
    const found: Array<{ words: string[]; quoted: boolean }> = [];
    for (let at = chunk.exec(query); at !== null; at = chunk.exec(query)) {
        const words = (at[1] ?? at[2] ?? "").match(/[\p{L}\p{N}\p{M}]+/gu);
        if (words) found.push({ words, quoted: at[1] !== undefined });
    }
    found.forEach((term, i) => {
        const prefix = i === found.length - 1 && open && !term.quoted;
        const last = term.words.length - 1;
        const source = term.words.map((word, j) => wordPattern(word, j === last && prefix)).join("[^\\p{L}\\p{N}]+");
        patterns.push(new RegExp(`(?<![\\p{L}\\p{N}])${source}`, "giu"));
    });
    return patterns;
}

/** Where the patterns match in `text`: [start, end) in order, overlaps joined. */
export function matchRanges(text: string, patterns: ReadonlyArray<RegExp>): Array<[number, number]> {
    const all: Array<[number, number]> = [];
    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
            if (m[0] === "") pattern.lastIndex += 1;
            else all.push([m.index, m.index + m[0].length]);
        }
    }
    all.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const joined: Array<[number, number]> = [];
    for (const range of all) {
        const last = joined[joined.length - 1];
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else joined.push([range[0], range[1]]);
    }
    return joined;
}

export interface Finding {
    /** Per segment: the ranges to mark (empty when it has none). */
    readonly ranges: ReadonlyArray<ReadonlyArray<[number, number]>>;
    /** Indexes of the segments with at least one match, in order. */
    readonly lines: ReadonlyArray<number>;
}

export function findIn(segments: ReadonlyArray<Pick<TranscriptSegment, "text">>, query: string): Finding {
    const patterns = compileQuery(query);
    if (patterns.length === 0) return { ranges: segments.map(() => []), lines: [] };
    const ranges = segments.map((segment) => matchRanges(segment.text, patterns));
    return { ranges, lines: ranges.flatMap((r, i) => (r.length > 0 ? [i] : [])) };
}
