/**
 * Model catalogue (`GET /api/models`) and favourites (`ui.models.favorites`) for the picker.
 */
import { sortModels, type ModelInfo } from "@pikvm/chat-protocol";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { apiUrl } from "../../lib/config";
import { api } from "../../lib/api";
import { chatView, fetchCatalogue } from "../../lib/models-cache";
import { keys, queryClient, settingsQuery, useSetting } from "../../lib/queries";
import type { SettingView } from "../../lib/types";
import { activeLocalization, msg, translate } from "../../l10n/runtime";

/**
 * The shared catalogue query. Its data holds every model the server lists (chat and native Decisions models); the
 * `select` keeps only models that can chat, so every existing consumer sees the chat list it always saw.
 * The loader (lib/models-cache.ts) fetches pages in parallel and owns retries and the failure toast.
 */
export const catalogueQuery = queryOptions({
    queryKey: keys.models,
    queryFn: fetchCatalogue,
    staleTime: 5 * 60_000,
    retry: false,
});

export const modelsQuery = queryOptions({ ...catalogueQuery, select: chatView });

export function useModels() {
    return useQuery(modelsQuery);
}

/** Every catalogue entry, including models that only answer Decisions. For the Decisions selector. */
export function useCatalogue() {
    return useQuery(catalogueQuery);
}

export { chatModelsOf, decisionModelsOf, type Catalogue, type CatalogueModel } from "../../lib/models-cache";

export interface Provider {
    id: string;
    name: string;
    logo: string;
}

/** Providers in catalogue order (first appearance wins). */
export function providersOf(models: ModelInfo[]): Provider[] {
    const seen = new Map<string, Provider>();
    for (const m of models) {
        if (!seen.has(m.provider)) seen.set(m.provider, { id: m.provider, name: m.providerName, logo: m.logo });
    }
    return [...seen.values()];
}

const FAVORITES_KEY = "ui.models.favorites";

/** Favourite model ids (setting `ui.models.favorites`) with an optimistic toggle. */
export function useFavorites(): { favorites: string[]; toggle: (id: string) => void } {
    const favorites = useSetting<string[]>(FAVORITES_KEY, []);
    const toggle = useCallback((id: string) => {
        const current = (
            queryClient.getQueryData(keys.settings) as { settings: SettingView[] } | undefined
        )?.settings.find((s) => s.key === FAVORITES_KEY)?.value as string[] | undefined;
        const list = current ?? [];
        const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
        queryClient.setQueryData<{ settings: SettingView[]; free: { key: string; value: unknown }[] }>(
            keys.settings,
            (d) =>
                d
                    ? {
                          ...d,
                          settings: d.settings.map((s) =>
                              s.key === FAVORITES_KEY ? { ...s, value: next, userValue: next, source: "user" } : s,
                          ),
                      }
                    : d,
        );
        api.put(`/settings/${FAVORITES_KEY}`, { value: next }).catch(() => {
            void queryClient.invalidateQueries(settingsQuery);
        });
    }, []);
    return useMemo(() => ({ favorites, toggle }), [favorites, toggle]);
}

const RECENT_KEY = "chat.models.recent";
const RECENT_MAX = 5;

/** Recently chosen model ids, newest first (per viewer, localStorage). */
export function readRecent(): string[] {
    try {
        const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
        return [];
    }
}

export function recordRecent(id: string): void {
    try {
        const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {}
}

/** "200K", "1M", "128K" for token counts. */
export function formatTokens(n: number | undefined): string | undefined {
    if (!n) return undefined;
    if (n >= 1_000_000)
        return translate("models-token-millions", { count: +(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0) });
    if (n >= 1000) return translate("models-token-thousands", { count: Math.round(n / 1000) });
    return new Intl.NumberFormat(activeLocalization().locale).format(n);
}

/** "$3", "$0.15", "Free" per million tokens. Check `isFreeCost` for free, not the text. */
export function formatCost(usd: number | undefined): string | undefined {
    if (usd === undefined) return undefined;
    if (usd === 0) return translate("models-cost-free");
    const digits = usd >= 1 ? 2 : 3;
    return `$${new Intl.NumberFormat(activeLocalization().locale, { maximumFractionDigits: digits }).format(usd)}`;
}

/** Both prices are zero. */
export const isFreeCost = (m: ModelInfo) => m.cost?.input === 0 && m.cost?.output === 0;

/** "Mar 2025" from "2025-03-14" or "2025-03". */
export function formatMonth(date: string | undefined): string | undefined {
    if (!date) return undefined;
    const d = new Date(date.length === 7 ? `${date}-01` : date);
    if (Number.isNaN(d.getTime())) return date;
    return d.toLocaleDateString(activeLocalization().locale, { month: "short", year: "numeric" });
}

const INPUT_LABELS: Record<string, string> = {
    text: msg("models-input-text"),
    image: msg("models-input-vision"),
    audio: msg("models-input-audio"),
    video: msg("models-input-video"),
    pdf: msg("models-input-pdf"),
};

/** Short name of an input kind ("Vision" for images). Unknown kinds show as they are. */
export const inputLabel = (kind: string): string => (INPUT_LABELS[kind] ? translate(INPUT_LABELS[kind]) : kind);

/** A comma-separated list in the active locale. */
export const joinList = (items: string[]): string =>
    new Intl.ListFormat(activeLocalization().locale, { style: "short", type: "unit" }).format(items);

/**
 * Context, output, price, inputs, thinking, tools and dates, as label and value pairs. The hover card and the
 * detail pane share this list. `efforts` names the thinking levels (the composer owns those labels).
 */
export function modelFacts(
    model: ModelInfo,
    opts: { tools: boolean; effortLabel: (effort: ModelInfo["efforts"][number]) => string },
): [string, string][] {
    const facts: [string, string][] = [];
    const ctx = formatTokens(model.contextWindow);
    const out = formatTokens(model.maxOutput);
    const costIn = formatCost(model.cost?.input);
    const costOut = formatCost(model.cost?.output);
    if (ctx) facts.push([translate("models-fact-context"), translate("models-fact-tokens", { count: ctx })]);
    if (out) facts.push([translate("models-fact-output"), translate("models-fact-tokens", { count: out })]);
    if (isFreeCost(model)) facts.push([translate("models-fact-price"), translate("models-cost-free")]);
    else if (costIn || costOut)
        facts.push([
            translate("models-fact-price"),
            translate("models-fact-price-split", { in: costIn ?? "?", out: costOut ?? "?" }),
        ]);
    facts.push([
        translate("models-fact-inputs"),
        joinList(model.input.map((i) => (i === "image" ? translate("models-input-images") : inputLabel(i)))) ||
            translate("models-input-text"),
    ]);
    facts.push([
        translate("models-fact-thinking"),
        model.reasoning
            ? model.efforts.length
                ? joinList(model.efforts.map(opts.effortLabel))
                : translate("models-fact-thinking-built-in")
            : translate("models-fact-thinking-none"),
    ]);
    if (opts.tools)
        facts.push([
            translate("models-fact-tools"),
            model.toolCall ? translate("models-fact-yes") : translate("models-fact-no"),
        ]);
    const released = formatMonth(model.releaseDate);
    if (released) facts.push([translate("models-fact-released"), released]);
    const knowledge = formatMonth(model.knowledge);
    if (knowledge) facts.push([translate("models-fact-knowledge"), knowledge]);
    return facts;
}

export type GroupBy = "vendor" | "provider";

export interface Group {
    id: string;
    name: string;
    logo: string;
}

/** Display names for lab ids whose catalogue name is not available. Other names come from the catalogue. */
const VENDOR_NAMES: Record<string, string> = {
    anthropic: "Anthropic",
    google: "Google",
    meta: "Meta",
    mistral: "Mistral",
    deepseek: "DeepSeek",
    alibaba: "Qwen",
    xai: "xAI",
    cohere: "Cohere",
    moonshotai: "Moonshot",
    zhipuai: "Zhipu",
    minimax: "MiniMax",
    amazon: "Amazon",
    microsoft: "Microsoft",
    nvidia: "NVIDIA",
    perplexity: "Perplexity",
};

/** Vendor ids that share a logo key on the server. */
const VENDOR_ALIASES: Record<string, string> = {
    "meta-llama": "meta",
    llama: "meta",
    mistralai: "mistral",
    qwen: "alibaba",
    "x-ai": "xai",
    "z-ai": "zhipuai",
};

/**
 * Model name families mapped to their lab, for catalogues without lab metadata. Labs whose families are not
 * listed here still group correctly when the catalogue gives `labLogo` or a "lab/model" id.
 */
const FAMILIES: [RegExp, string][] = [
    [/\bclaude\b/i, "anthropic"],
    [/\b(gemini|gemma|palm)\b/i, "google"],
    [/\bllama\b/i, "meta"],
    [/\b(mistral|mixtral|codestral|ministral|magistral|devstral|pixtral)\b/i, "mistral"],
    [/\bdeepseek\b/i, "deepseek"],
    [/\b(qwen|qwq)\b/i, "alibaba"],
    [/\bgrok\b/i, "xai"],
    [/\bcommand\b/i, "cohere"],
    [/\bkimi\b/i, "moonshotai"],
    [/\bglm\b/i, "zhipuai"],
    [/\bminimax\b/i, "minimax"],
    [/\bnova\b/i, "amazon"],
    [/\bphi-?\d/i, "microsoft"],
];

const logoKey = (url: string | undefined) => (url ? /\/logos\/([^/]+)\.svg/.exec(url)?.[1] : undefined);
const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** The lab that made a model. A Claude model served through a router groups under Anthropic. */
export function vendorOf(m: ModelInfo): Group {
    const { known: _known, ...group } = resolveVendor(m);
    return group;
}

/**
 * The lab behind a model, and whether it is known. `known: false` means no lab could be found, so the group
 * is the provider. A lab that serves its own model has the provider's id and logo.
 */
function resolveVendor(m: ModelInfo): Group & { known: boolean } {
    const own = { id: m.provider, name: m.providerName, logo: m.logo };
    let key = logoKey(m.labLogo);
    // The server names the lab and leaves `labLogo` out when the lab serves the model itself.
    if (!key && m.labName) return { ...own, name: m.labName, known: true };
    if (!key && m.modelId.includes("/")) key = m.modelId.split("/")[0]?.toLowerCase();
    if (!key) key = FAMILIES.find(([re]) => re.test(m.name) || re.test(m.modelId))?.[1];
    if (!key) return { ...own, known: false };
    const id = VENDOR_ALIASES[key] ?? key;
    if (id === m.provider || id === logoKey(m.logo)) return { ...own, known: true };
    return {
        id,
        name: m.labName ?? VENDOR_NAMES[key] ?? VENDOR_NAMES[id] ?? titleCase(id),
        logo: m.labLogo ?? apiUrl(`/models/logos/${id}.svg`),
        known: true,
    };
}

/**
 * Who made a model and who serves it. The vendor mark is primary, the provider mark is the corner badge.
 * `badge` is false when the vendor and the provider are the same, or when the vendor is unknown (then the
 * provider mark is the main mark and `vendor` is the provider).
 */
export interface ModelIdentity {
    vendor: Group;
    provider: Group;
    vendorKnown: boolean;
    badge: boolean;
    /** Screen reader text, for example "Claude Sonnet, by Anthropic, via OpenRouter". */
    label: string;
    /** Short visible text, for example "Anthropic via OpenRouter", "Anthropic" or "Vendor unknown, via Acme". */
    byline: string;
}

export function identityOf(m: ModelInfo): ModelIdentity {
    const v = resolveVendor(m);
    const provider: Group = { id: m.provider, name: m.providerName, logo: m.logo };
    const { known, ...vendor } = v;
    const same = known && (vendor.id === provider.id || vendor.logo === provider.logo);
    if (!known) {
        return {
            vendor: provider,
            provider,
            vendorKnown: false,
            badge: false,
            label: translate("models-identity-label-unknown", { model: m.name, provider: provider.name }),
            byline: translate("models-identity-byline-unknown", { provider: provider.name }),
        };
    }
    return {
        vendor,
        provider,
        vendorKnown: true,
        badge: !same,
        label: same
            ? translate("models-identity-label-same", { model: m.name, vendor: vendor.name })
            : translate("models-identity-label-via", { model: m.name, vendor: vendor.name, provider: provider.name }),
        byline: same
            ? vendor.name
            : translate("models-identity-byline-via", { vendor: vendor.name, provider: provider.name }),
    };
}

/**
 * What a row says about who made and who serves the model. Browsing a vendor tab, the vendor is the heading, so
 * the row names the provider ("via OpenRouter"). Browsing a provider tab, it names the vendor. Search results
 * and favourites have no heading, so they name both.
 */
export function rowByline(m: ModelInfo, by: GroupBy, standalone: boolean): string | undefined {
    const id = identityOf(m);
    if (standalone) return id.byline;
    if (by === "vendor") return id.badge ? translate("models-byline-via", { provider: id.provider.name }) : undefined;
    return id.vendorKnown && id.badge ? id.vendor.name : undefined;
}

/** Browse order (see @chat/protocol model-order.ts): vendor, family, version, tier, snapshot, id. */
export function sortedModels(models: readonly ModelInfo[]): ModelInfo[] {
    return sortModels(models, (m) => vendorOf(m).id);
}

export function groupOf(m: ModelInfo, by: GroupBy): Group {
    return by === "vendor" ? vendorOf(m) : { id: m.provider, name: m.providerName, logo: m.logo };
}

/** Groups in catalogue order (first appearance wins). */
export function groupsOf(models: ModelInfo[], by: GroupBy): Group[] {
    // A provider with the same id as a lab gives the lab its display name and logo.
    const named = new Map(models.map((m) => [m.provider, { name: m.providerName, logo: m.logo }]));
    const seen = new Map<string, Group>();
    for (const m of models) {
        const g = groupOf(m, by);
        if (seen.has(g.id)) continue;
        const known = named.get(g.id);
        seen.set(g.id, known ? { id: g.id, ...known } : g);
    }
    return [...seen.values()];
}

/** Write a user setting with an optimistic cache update (rolls back by refetching on failure). */
export function writeSetting(key: string, value: unknown): void {
    queryClient.setQueryData<{ settings: SettingView[]; free: { key: string; value: unknown }[] }>(
        keys.settings,
        (d) =>
            d
                ? {
                      ...d,
                      settings: d.settings.map((s) =>
                          s.key === key ? { ...s, value, userValue: value, source: "user" } : s,
                      ),
                  }
                : d,
    );
    api.put(`/settings/${key}`, { value }).catch(() => {
        void queryClient.invalidateQueries(settingsQuery);
    });
}
