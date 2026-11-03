/**
 * Fuzzy multi-term model search (model-picker spec section 4).
 *
 * - The query is trimmed, lower-cased and split on spaces. Every term must match (AND), in any order.
 * - A term matches the display name or the provider label, as a substring or as an in-order subsequence
 *   ("opus4", "c45", "sonet").
 * - Model ids are not searched.
 * - Ranking: substring beats subsequence, earlier and word-start matches beat later ones, fewer gaps beat
 *   more, shorter names beat longer ones, then alphabetical.
 */
import type { ModelInfo } from "@pikvm/chat-protocol";

const WORD_BREAK = /[\s\-_:/.,()]/;

/** Score one term against one haystack. Higher is better; -1 means no match. */
function scoreTerm(term: string, hay: string): number {
    const at = hay.indexOf(term);
    if (at >= 0) {
        const wordStart = at === 0 || WORD_BREAK.test(hay[at - 1] ?? " ");
        return 1000 - at - (wordStart ? 0 : 50);
    }
    let pos = -1;
    let first = -1;
    let gaps = 0;
    for (const ch of term) {
        const j = hay.indexOf(ch, pos + 1);
        if (j < 0) return -1;
        if (first < 0) first = j;
        else gaps += j - pos - 1;
        pos = j;
    }
    return 500 - gaps * 5 - first;
}

export function searchModels(models: ModelInfo[], query: string): ModelInfo[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return models;
    const scored: { m: ModelInfo; score: number }[] = [];
    for (const m of models) {
        const name = m.name.toLowerCase();
        const provider = m.providerName.toLowerCase();
        let total = 0;
        let ok = true;
        for (const t of terms) {
            // A provider-label hit is worth a little less than a name hit.
            const s = Math.max(scoreTerm(t, name), scoreTerm(t, provider) - 100);
            if (s < 0) {
                ok = false;
                break;
            }
            total += s;
        }
        if (ok) scored.push({ m, score: total - name.length * 0.5 });
    }
    scored.sort((a, b) => b.score - a.score || a.m.name.localeCompare(b.m.name));
    return scored.map((x) => x.m);
}
