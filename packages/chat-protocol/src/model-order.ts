/**
 * Deterministic model ordering for the picker and the ModelBrowser browse view.
 *
 * One function, `modelGroupKey`, places a model: { vendor, family, version, tier, ... }. The sort only reads
 * that key, so a different source of families (for example a cached classification) changes nothing in the sort.
 *
 * Where each part comes from, in order:
 *   1. `ModelInfo.series`  - a family the server classified for an id the rules could not place (cached).
 *   2. models.dev `family` - used when the id gives no family words of its own.
 *   3. Name parsing        - the id, with vendor prefixes, variants (`:free`) and dates removed.
 *
 * models.dev `family` is a tier label ("gpt", "gpt-mini", "gpt-sol"), not a lineage, so it cannot be the family
 * key: "gpt-6" and "gpt-6.1-sol" must sit together. Its words after the first are read as tier hints instead.
 *
 * Rules of the sort (all comparisons are total; the final tie-break is the full id):
 *   1. Vendor, by id.
 *   2. Family, newest first (newest release date in the family), then by name. The "other" family is last.
 *   3. Version, newest first, compared numerically per part: 6.10 > 6.9 > 6. Unversioned ids come after versioned ones.
 *   4. Tier: max/ultra/opus > pro > plus > base > flash > mini > lite > nano; unknown named tiers sit between
 *      base and mini and sort by name; capability tiers (codex, image, tts, embedding) come last.
 *   5. Variants (preview, exp, free) after the stable id.
 *   6. Dated snapshots after their alias.
 *   7. Release date, newest first, then the full id.
 * Search ranking is separate: the browse view uses this order, a typed query keeps its own score order.
 */
import type { ModelInfo } from "./models.ts";

export type ModelOrderInput = Pick<ModelInfo, "id" | "modelId" | "name" | "provider"> &
    Partial<Pick<ModelInfo, "family" | "releaseDate" | "series" | "labName" | "labLogo">>;

export interface ModelGroupKey {
    vendor: string;
    /** Lineage, for example "gpt", "claude", "gemini". "other" when nothing could place the model. */
    family: string;
    /** Numeric version parts, for example [6, 1]. Empty when the id has none. */
    version: number[];
    /** Tier words after the family, for example "mini" or "flash-lite". Empty for the base model. */
    tier: string;
    tierRank: number;
    /** Variant words (preview, exp, free). */
    variants: number;
    /** The id carries a date or build stamp. */
    snapshot: boolean;
    /** The rules could place this id. False means a classifier may be asked. */
    placed: boolean;
}

export const OTHER_FAMILY = "other";

const TIER_RANK: Record<string, number> = {
    max: 0,
    ultra: 0,
    opus: 0,
    pro: 2,
    plus: 3,
    large: 3,
    sonnet: 3,
    o: 4,
    base: 5,
    turbo: 5,
    medium: 6,
    flash: 7,
    haiku: 8,
    small: 8,
    mini: 9,
    lite: 10,
    nano: 11,
    tiny: 11,
    micro: 11,
    codex: 90,
    image: 90,
    tts: 90,
    audio: 90,
    realtime: 90,
    transcribe: 90,
    embedding: 90,
    embed: 90,
    moderation: 90,
    search: 90,
    vision: 90,
    live: 90,
};
const UNKNOWN_TIER = 7.5;
const VARIANT_WORDS = new Set(["preview", "exp", "experimental", "beta", "free", "extended", "latest", "alpha"]);
const NOISE_WORDS = new Set(["instruct", "chat", "it", "thinking", "reasoning", "online", "hf", "gguf", "v"]);
const SIZE = /^(?:\d+x)?\d+(?:\.\d+)?[bkm]$/;

interface Parsed {
    words: string[];
    version: number[];
    snapshot: boolean;
    variants: number;
}

function parse(modelId: string): Parsed {
    let s = modelId.toLowerCase().replace(/^~/, "");
    s = s.slice(s.lastIndexOf("/") + 1);
    let variants = 0;
    const colon = s.indexOf(":");
    if (colon >= 0) {
        variants += 1;
        s = s.slice(0, colon);
    }
    s = s.replace(/@.*$/, "");
    let snapshot = false;
    const stamp = (re: RegExp) => {
        if (re.test(s)) {
            snapshot = true;
            s = s.replace(re, "-");
        }
    };
    stamp(/(?<![0-9])20\d{2}[-_]?\d{2}[-_]?\d{2}(?![0-9])/g);
    stamp(/(?<![0-9])\d{2}-20\d{2}(?![0-9])/g);
    stamp(/(?<![0-9])20\d{2}-\d{2}(?![0-9])/g);
    s = s.replace(/(\d)p(\d)/g, "$1-$2").replace(/(\d)[._](\d)/g, "$1-$2");
    const words: string[] = [];
    const version: number[] = [];
    for (const raw of s.split(/[-_\s]+/).filter(Boolean)) {
        let parts = [raw];
        const letterDigit = /^([a-z]+)(\d+)$/.exec(raw);
        const digitLetter = /^(\d+)([a-z]+)$/.exec(raw);
        if (SIZE.test(raw)) continue;
        if (letterDigit) parts = [letterDigit[1]!, letterDigit[2]!];
        else if (digitLetter) parts = [digitLetter[1]!, digitLetter[2]!];
        for (const p of parts) {
            if (/^\d{1,2}$/.test(p)) version.push(Number(p));
            else if (/^\d{3,}$/.test(p)) snapshot = true;
            else if (VARIANT_WORDS.has(p)) variants += 1;
            else if (!NOISE_WORDS.has(p)) words.push(p);
        }
    }
    return { words, version, snapshot, variants };
}

const slug = (s: string) =>
    s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

function tierOf(words: readonly string[]): { tier: string; rank: number } {
    if (!words.length) return { tier: "", rank: TIER_RANK.base! };
    let rank = -1;
    for (const w of words) rank = Math.max(rank, TIER_RANK[w] ?? UNKNOWN_TIER);
    return { tier: words.join("-"), rank };
}

/** The vendor id used when a caller does not pass its own: lab from the model id prefix or lab name, else provider. */
function defaultVendor(m: ModelOrderInput): string {
    const prefix = m.modelId.includes("/") ? m.modelId.split("/")[0]!.toLowerCase().replace(/^~/, "") : undefined;
    return slug(m.labName ?? prefix ?? m.provider);
}

/** Place one model. `vendor` is the caller's vendor id (the web app passes `vendorOf(m).id`). */
export function modelGroupKey(m: ModelOrderInput, vendor: string = defaultVendor(m)): ModelGroupKey {
    const p = parse(m.modelId);
    const devFamily = m.family ? m.family.toLowerCase().split("-")[0] : undefined;
    // A rule places the model when the id has a lineage word and either a version or models.dev knows the family.
    const lead = p.words[0] ?? devFamily;
    const placed = !!lead && (p.version.length > 0 || !!m.family);
    let family = lead ?? OTHER_FAMILY;
    if (!placed) family = m.series ? slug(m.series) || OTHER_FAMILY : OTHER_FAMILY;
    const { tier, rank } = tierOf(p.words.slice(1));
    return {
        vendor,
        family,
        version: p.version,
        tier,
        tierRank: rank,
        variants: p.variants,
        snapshot: p.snapshot,
        placed: placed || !!m.series,
    };
}

/** True when the rules cannot place the model, so a cached or fresh classification may supply `series`. */
export function needsSeries(m: ModelOrderInput): boolean {
    const p = parse(m.modelId);
    const lead = p.words[0] ?? (m.family ? m.family.toLowerCase().split("-")[0] : undefined);
    return !(lead && (p.version.length > 0 || !!m.family));
}

/** Numeric, part by part; a missing part counts as 0. Positive when a is newer. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d) return d;
    }
    return 0;
}

const time = (d: string | undefined) => {
    const t = d ? Date.parse(d.length === 7 ? `${d}-01` : d) : NaN;
    return Number.isNaN(t) ? 0 : t;
};
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A new array in browse order. The input order never changes the result. */
export function sortModels<T extends ModelOrderInput>(models: readonly T[], vendorOf?: (m: T) => string): T[] {
    const rows = models.map((m) => ({ m, k: modelGroupKey(m, vendorOf?.(m)), t: time(m.releaseDate) }));
    const newest = new Map<string, number>();
    for (const r of rows) {
        const key = `${r.k.vendor}\n${r.k.family}`;
        newest.set(key, Math.max(newest.get(key) ?? 0, r.t));
    }
    rows.sort((a, b) => {
        if (a.k.vendor !== b.k.vendor) return cmp(a.k.vendor, b.k.vendor);
        if (a.k.family !== b.k.family) {
            if (a.k.family === OTHER_FAMILY) return 1;
            if (b.k.family === OTHER_FAMILY) return -1;
            const d = newest.get(`${b.k.vendor}\n${b.k.family}`)! - newest.get(`${a.k.vendor}\n${a.k.family}`)!;
            return d || cmp(a.k.family, b.k.family);
        }
        const hasA = a.k.version.length > 0;
        const hasB = b.k.version.length > 0;
        if (hasA !== hasB) return hasA ? -1 : 1;
        return (
            -compareVersions(a.k.version, b.k.version) ||
            a.k.tierRank - b.k.tierRank ||
            cmp(a.k.tier, b.k.tier) ||
            a.k.variants - b.k.variants ||
            Number(a.k.snapshot) - Number(b.k.snapshot) ||
            b.t - a.t ||
            cmp(a.m.id, b.m.id)
        );
    });
    return rows.map((r) => r.m);
}
