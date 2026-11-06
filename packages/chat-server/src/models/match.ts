/**
 * Match a runtime model (provider id + model id) to a models.dev entry.
 *
 * Model ids differ between providers for the same model: vendor prefixes (`anthropic/claude-x`,
 * `accounts/fireworks/models/llama-v3p1`), date or tag suffixes (`-20250514`, `@2024-08-06`, `:free`,
 * `-latest`), and separators (`claude-3.5-sonnet` vs `claude-3-5-sonnet`). The matcher tries, in order:
 *
 *   1. exact id in the serving provider's models.dev entry           (score 1.00)
 *   2. normalised id in the serving provider                          (0.95)
 *   3. normalised id in the model's lab provider (from prefix/family) (0.90)
 *   4. normalised id anywhere, preferring a canonical_model_id hit    (0.85)
 *   5. token similarity over the serving + lab providers, >= 0.75     (score)
 *
 * The serving provider is found by id, alias, or by matching a custom provider's base URL host.
 */
import type { Catalog, DevModel } from "./catalog.ts";

export interface Match {
    provider: string;
    model: DevModel;
    score: number;
}

/** Our provider ids that are spelled differently on models.dev. */
const PROVIDER_ALIASES: Record<string, string> = {
    "google-gemini-cli": "google",
    "google-antigravity": "google",
    "openai-codex": "openai",
    "github-copilot": "github-copilot",
    "xai-oauth": "xai",
    "kimi-code": "moonshotai",
    moonshot: "moonshotai",
    "amazon-bedrock": "amazon-bedrock",
    azure: "azure",
    together: "togetherai",
    fireworks: "fireworks-ai",
    "lm-studio": "lmstudio",
    "opencode-zen": "opencode",
    nanogpt: "nano-gpt",
    novita: "novita-ai",
    "vercel-ai-gateway": "vercel",
    huggingface: "huggingface",
    zai: "zai",
};

/** Lab (model maker) by id stem. */
const LAB_PREFIXES: [RegExp, string][] = [
    [/^claude/, "anthropic"],
    [/^(gpt|o\d|chatgpt|codex|text-embedding|dall-e|whisper|tts)/, "openai"],
    [/^(gemini|gemma|learnlm)/, "google"],
    [/^(llama|meta-llama)/, "llama"],
    [/^(mistral|mixtral|codestral|devstral|magistral|ministral|pixtral|voxtral)/, "mistral"],
    [/^deepseek/, "deepseek"],
    [/^(qwen|qwq|qvq)/, "alibaba"],
    [/^grok/, "xai"],
    [/^(kimi|moonshot)/, "moonshotai"],
    [/^(glm|chatglm)/, "zai"],
    [/^minimax/, "minimax"],
    [/^(command|c4ai|aya)/, "cohere"],
    [/^(nova|titan)/, "amazon-bedrock"],
    [/^phi/, "azure"],
    [/^(sonar|r1-1776)/, "perplexity"],
];

const DATE_SUFFIX = /([-@_.]?(20\d{2})[-_]?(\d{2})[-_]?(\d{2}))$|[-@](\d{4})$/;
const TAG_SUFFIX = /[:@-](free|beta|extended|nitro|floor|thinking|latest|preview|exp|experimental|online|instruct-tuned)$/;

/** Canonical comparable form of a model id. */
export function normaliseId(id: string): string {
    let s = id.toLowerCase().trim();
    s = s.split("/").at(-1)!; // drop vendor/account prefixes
    s = s.replace(/^models\//, "");
    for (let i = 0; i < 3; i++) {
        const before = s;
        s = s.replace(TAG_SUFFIX, "").replace(DATE_SUFFIX, "");
        if (s === before) break;
    }
    s = s.replace(/[._:\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    // llama-v3p1 -> llama-3-1 (Fireworks style)
    s = s.replace(/-v(\d+)p(\d+)/g, "-$1-$2").replace(/(\d)p(\d)/g, "$1-$2");
    return s;
}

function tokens(id: string): Set<string> {
    return new Set(normaliseId(id).split("-").filter(Boolean));
}

function similarity(a: string, b: string): number {
    const A = tokens(a);
    const B = tokens(b);
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const union = A.size + B.size - inter;
    if (union === 0) return 0;
    // Numbers must agree: claude-4-5 must not match claude-4-1.
    const nums = (s: Set<string>) => [...s].filter((t) => /^\d+$/.test(t)).join(".");
    if (nums(A) !== nums(B)) return (inter / union) * 0.5;
    return inter / union;
}

export function labFor(modelId: string, model?: DevModel): string | undefined {
    const canon = model?.canonical_model_id?.split("/")[0];
    if (canon) return canon;
    const parts = modelId.toLowerCase().split("/");
    const stem = parts.at(-1)!;
    for (const [re, lab] of LAB_PREFIXES) if (re.test(stem)) return lab;
    if (parts.length > 1) return parts[0];
    return undefined;
}

export class Matcher {
    #byNorm = new Map<string, { provider: string; model: DevModel }[]>();
    #hostToProvider = new Map<string, string>();

    constructor(readonly catalog: Catalog) {
        for (const [pid, p] of Object.entries(catalog)) {
            for (const m of Object.values(p.models)) {
                const key = normaliseId(m.id);
                const list = this.#byNorm.get(key) ?? [];
                list.push({ provider: pid, model: m });
                this.#byNorm.set(key, list);
            }
            if (p.api) {
                try {
                    this.#hostToProvider.set(new URL(p.api).host, pid);
                } catch {}
            }
        }
    }

    /** models.dev provider id that corresponds to one of our providers. */
    devProvider(providerId: string, baseUrl?: string): string | undefined {
        if (this.catalog[providerId]) return providerId;
        const alias = PROVIDER_ALIASES[providerId];
        if (alias && this.catalog[alias]) return alias;
        if (baseUrl) {
            try {
                const host = new URL(baseUrl).host;
                const hit = this.#hostToProvider.get(host);
                if (hit) return hit;
                // Suffix match: api.x.ai and x.ai, openrouter.ai/api/v1 and openrouter.ai.
                for (const [h, pid] of this.#hostToProvider) if (host.endsWith(h) || h.endsWith(host)) return pid;
            } catch {}
        }
        return undefined;
    }

    match(providerId: string, modelId: string, baseUrl?: string): Match | undefined {
        const serving = this.devProvider(providerId, baseUrl);
        const norm = normaliseId(modelId);

        if (serving) {
            const exact = this.catalog[serving]!.models[modelId];
            if (exact) return { provider: serving, model: exact, score: 1 };
            const hit = (this.#byNorm.get(norm) ?? []).find((c) => c.provider === serving);
            if (hit) return { ...hit, score: 0.95 };
        }

        const candidates = this.#byNorm.get(norm) ?? [];
        const lab = labFor(modelId);
        if (lab) {
            const hit = candidates.find((c) => c.provider === lab);
            if (hit) return { ...hit, score: 0.9 };
        }
        if (candidates.length) {
            // Prefer an entry whose canonical id names the lab, then the lab's own listing, then any.
            const byLab = lab && candidates.find((c) => c.model.canonical_model_id?.startsWith(`${lab}/`));
            const own = candidates.find((c) => c.model.canonical_model_id?.startsWith(`${c.provider}/`));
            return { ...(byLab || own || candidates[0]!), score: 0.85 };
        }

        let best: Match | undefined;
        for (const pid of [serving, lab].filter((p): p is string => !!p && !!this.catalog[p])) {
            for (const m of Object.values(this.catalog[pid]!.models)) {
                const score = similarity(modelId, m.id);
                if (score >= 0.75 && (!best || score > best.score)) best = { provider: pid, model: m, score };
            }
        }
        return best;
    }
}
