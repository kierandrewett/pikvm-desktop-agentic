/**
 * Search, filters and grouping for the model browser. Pure functions, so they can be measured and reused.
 *
 * Search
 * - The query is split on spaces. Every term must match (AND), in any order.
 * - A term is scored against five fields: name, model id, vendor, provider and family. A name hit is worth the
 *   most; the other fields score a fixed step lower, so "mistral" ranks Mistral's own models above a router's.
 * - A substring match beats a subsequence match. Earlier and word-start hits beat later ones.
 * - Subsequence matches ("opus4", "sonet") are tight: only on the name and the id, starting at a word start,
 *   and spanning at most 3x the term (+2). Loose subsequences ("gpt" in "gemini pro turbo") would add noise
 *   to the result count, and bulk actions run on that count.
 * - The haystacks are folded once per catalogue (`buildIndex`), so a keystroke over 2,000 models only runs
 *   `indexOf` on short strings. Highlight ranges come from `matchLabel` and are computed for visible rows only.
 */
import type { ModelInfo } from "@pikvm/chat-protocol";
import { msg } from "../../l10n/runtime";
import { matchLabel, type MatchRange } from "../../lib/typeahead";
import { groupOf, sortedModels, type Group, type GroupBy } from "../model-picker/models";

export type CapabilityFilter = "reasoning" | "vision" | "tools" | "free";
export type StateFilter = "enabled" | "changed";
export type BrowserFilter = CapabilityFilter | StateFilter;

export const capabilityFilters: readonly CapabilityFilter[] = ["reasoning", "vision", "tools", "free"];

/** Message ID of each chip label. Translate with `t(filterLabelIds[filter])`. */
export const filterLabelIds: Record<BrowserFilter, string> = {
    reasoning: msg("models-browser-filter-reasoning"),
    vision: msg("models-browser-filter-vision"),
    tools: msg("models-browser-filter-tools"),
    free: msg("models-browser-filter-free"),
    enabled: msg("models-browser-filter-enabled"),
    changed: msg("models-browser-filter-changed"),
};

/** Host state for one row. `enabled` drives the "Enabled" filter, `changed` the "Changed" filter. */
export interface ModelRowState {
    enabled?: boolean;
    changed?: boolean;
    /** Dim the row (for example denied by policy). It stays selectable. */
    muted?: boolean;
}

export const isFree = (m: ModelInfo) => m.cost?.input === 0 && m.cost?.output === 0;

/** Whether a model passes one filter. State filters read the host's row state. */
export function passes(f: BrowserFilter, m: ModelInfo, state: ModelRowState | undefined): boolean {
    switch (f) {
        case "reasoning":
            return m.reasoning;
        case "vision":
            return m.input.includes("image");
        case "tools":
            return m.toolCall;
        case "free":
            return isFree(m);
        case "enabled":
            return state?.enabled === true;
        case "changed":
            return state?.changed === true;
    }
}

/** Lower-case, accent-free text, for the index. Ranges are never taken from it. */
export const foldText = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const WORD_BREAK = /[\s\-_:/.,()@]/;
const atWordStart = (hay: string, at: number) => at === 0 || WORD_BREAK.test(hay[at - 1] ?? " ");

/** Where a tight subsequence of `term` starts and ends in `hay`, or null. See the header for the rule. */
function subsequence(term: string, hay: string): { first: number; last: number; gaps: number } | null {
    if (term.length < 2) return null;
    const limit = term.length * 3 + 2;
    for (let start = hay.indexOf(term[0] ?? ""); start >= 0; start = hay.indexOf(term[0] ?? "", start + 1)) {
        if (!atWordStart(hay, start)) continue;
        let pos = start;
        let gaps = 0;
        let ok = true;
        for (let k = 1; k < term.length; k++) {
            const j = hay.indexOf(term[k] ?? "", pos + 1);
            if (j < 0 || j - start >= limit) {
                ok = false;
                break;
            }
            gaps += j - pos - 1;
            pos = j;
        }
        if (ok) return { first: start, last: pos, gaps };
    }
    return null;
}

/** Score one term against one folded field. Higher is better; -1 means no match. */
function scoreTerm(term: string, hay: string, fuzzy: boolean): number {
    const at = hay.indexOf(term);
    if (at >= 0) {
        // Prefer a word-start occurrence when the first one is mid-word.
        let best = at;
        if (!atWordStart(hay, at)) {
            for (let k = hay.indexOf(term, at + 1); k > 0; k = hay.indexOf(term, k + 1)) {
                if (atWordStart(hay, k)) {
                    best = k;
                    break;
                }
            }
        }
        return 1000 - Math.min(best, 100) - (atWordStart(hay, best) ? 0 : 60) - (best === 0 ? 0 : 5);
    }
    if (!fuzzy) return -1;
    const s = subsequence(term, hay);
    return s ? 500 - s.gaps * 8 - Math.min(s.first, 100) : -1;
}

export interface IndexedModel {
    model: ModelInfo;
    group: Group;
    /** Display name of the lab that made the model (the group name when grouping by vendor). */
    vendorName: string;
    /** Position in the shared browse order (model-order.ts), for stable ordering. */
    order: number;
    name: string;
    id: string;
    vendor: string;
    provider: string;
    family: string;
}

export interface BrowserIndex {
    entries: IndexedModel[];
    groups: Group[];
    byId: Map<string, IndexedModel>;
}

/** Fold every searchable field once and resolve each model's group (vendor or provider). */
export function buildIndex(models: readonly ModelInfo[], by: GroupBy): BrowserIndex {
    // A provider with the same id as a lab gives the lab its display name and logo (as `groupsOf` does).
    const named = new Map(models.map((m) => [m.provider, { name: m.providerName, logo: m.logo }]));
    const groups = new Map<string, Group>();
    const entries: IndexedModel[] = [];
    const byId = new Map<string, IndexedModel>();
    // Browse order is the shared sort. `order` is the position in it, so a tie in search score and an empty query
    // both fall back to it. Groups keep catalogue order (first appearance), as the rail did before.
    const rank = new Map(sortedModels(models).map((m, i) => [m.id, i]));
    models.forEach((m) => {
        const order = rank.get(m.id) ?? 0;
        let group = groups.get(groupOf(m, by).id);
        if (!group) {
            const g = groupOf(m, by);
            const known = named.get(g.id);
            group = known ? { id: g.id, ...known } : g;
            groups.set(g.id, group);
        }
        const vendor = by === "vendor" ? group.name : groupOf(m, "vendor").name;
        const e: IndexedModel = {
            model: m,
            group,
            vendorName: vendor,
            order,
            name: foldText(m.name),
            id: foldText(m.modelId),
            vendor: foldText(vendor),
            provider: foldText(m.providerName),
            family: foldText(m.family ?? ""),
        };
        entries.push(e);
        byId.set(m.id, e);
    });
    entries.sort((a, b) => a.order - b.order);
    return { entries, groups: [...groups.values()], byId };
}

/** Field penalties: a name hit wins over the same hit in the id, vendor, provider or family. */
const ID_STEP = 60;
const OWNER_STEP = 120;
const FAMILY_STEP = 150;

export const queryTerms = (query: string) => foldText(query.trim()).split(/\s+/).filter(Boolean);

/** Score of an entry for the given terms, or -1 when a term does not match. */
export function scoreEntry(e: IndexedModel, terms: readonly string[]): number {
    let total = 0;
    for (const t of terms) {
        const s = Math.max(
            scoreTerm(t, e.name, true),
            scoreTerm(t, e.id, true) - ID_STEP,
            scoreTerm(t, e.vendor, false) - OWNER_STEP,
            scoreTerm(t, e.provider, false) - OWNER_STEP,
            e.family ? scoreTerm(t, e.family, false) - FAMILY_STEP : -1,
        );
        if (s < 0) return -1;
        total += s;
    }
    // Shorter names win ties: "Atlas 4" before "Atlas 4 Mini Preview".
    return total - e.name.length * 0.5;
}

/** Entries matching the query, best first. An empty query keeps catalogue order. */
export function rankEntries(entries: readonly IndexedModel[], terms: readonly string[]): IndexedModel[] {
    if (!terms.length) return entries.slice();
    const scored: { e: IndexedModel; score: number }[] = [];
    for (const e of entries) {
        const score = scoreEntry(e, terms);
        if (score >= 0) scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score || a.e.order - b.e.order);
    return scored.map((x) => x.e);
}

/**
 * Ranges to mark in a display label for the query. Substring hits use `matchLabel` (the app's one matcher for
 * marked text); a term that only matches as a subsequence marks each matched character.
 */
export function highlightRanges(label: string, terms: readonly string[]): MatchRange[] {
    const out: MatchRange[] = [];
    for (const t of terms) {
        const hit = matchLabel(label, t);
        if (hit) {
            out.push(...hit.ranges);
            continue;
        }
        out.push(...subsequenceRanges(label, t));
    }
    if (out.length < 2) return out;
    out.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [s, e] of out) {
        const last = merged[merged.length - 1];
        if (last && s <= last[1]) last[1] = Math.max(last[1], e);
        else merged.push([s, e]);
    }
    return merged;
}

/** Ranges of a tight subsequence in the original label (per-character folding keeps indices exact). */
function subsequenceRanges(label: string, term: string): MatchRange[] {
    const chars: { at: number; len: number; f: string }[] = [];
    let i = 0;
    for (const ch of label) {
        chars.push({ at: i, len: ch.length, f: foldText(ch) });
        i += ch.length;
    }
    const folded = chars.map((c) => c.f.charAt(0) || " ").join("");
    const s = subsequence(term, folded);
    if (!s) return [];
    const ranges: [number, number][] = [];
    let k = 0;
    for (let j = s.first; j <= s.last && k < term.length; j++) {
        if (folded[j] !== term[k]) continue;
        k++;
        const c = chars[j];
        if (!c) continue;
        const last = ranges[ranges.length - 1];
        if (last && last[1] === c.at) last[1] = c.at + c.len;
        else ranges.push([c.at, c.at + c.len]);
    }
    return ranges;
}
