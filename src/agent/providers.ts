/**
 * Multi-provider model selection — the PURE, framework-agnostic core.
 *
 * The app used to be hard-wired to a single provider (`openai-codex`, the
 * ChatGPT subscription). This module generalises that: a model is now named as a
 * `provider/model` string (e.g. `codex/gpt-5.5`, `moonshotai/kimi-k2.6`), so the
 * user can route each ROLE (reasoning / fast tool-calling / sub-agent) to a
 * different provider — including non-OpenAI models like Kimi.
 *
 * Everything here is deliberately side-effect-free and independent of pi-ai's
 * runtime types, so it can be unit-tested in isolation (see
 * `scripts/providers-test.ts`). The runner does the actual `getModel(...)` /
 * `applyModel(...)` wiring using the ids this module resolves.
 *
 * Why a `codex` alias? Today's settings + auth call the ChatGPT-subscription
 * provider `codex`, but pi-ai registers it as `openai-codex`. We keep `codex` as
 * the user-facing/spec id and translate to the pi-ai id at the boundary, so a
 * spec like `codex/gpt-5.5` keeps working with zero reconfiguration.
 */

/** How a provider authenticates. */
export type ProviderKind = "oauth" | "apiKey";

/** Static metadata describing a provider we can reach through pi-ai. */
export interface ProviderInfo {
    /** User-facing / spec id (what appears before the slash in a model spec). */
    id: string;
    /** The provider id pi-ai's `getModel(provider, ...)` expects. */
    piProvider: string;
    /** Human label for the settings UI. */
    label: string;
    /** OAuth (sign-in flow) or API key (paste a key). */
    kind: ProviderKind;
    /**
     * For `apiKey` providers: the environment variable pi-ai reads the key from.
     * We set it in-process from the secrets vault before a request. (See
     * env-api-keys.js in pi-ai for the canonical map.)
     */
    envVar?: string;
    /** A short hint shown in the UI about where to get a key. */
    keyHint?: string;
    /** One-line description of what the provider is / when to use it. */
    desc?: string;
}

/**
 * The providers we expose. Confirmed registrable via pi-ai's
 * `registerBuiltInApiProviders()` + its generated model catalogue.
 *
 *  - `codex`      → pi-ai `openai-codex`: OAuth (ChatGPT subscription). The
 *                   existing, default path. Keeps working untouched.
 *  - `moonshotai` → Kimi's first-party API. API key (MOONSHOT_API_KEY). Kimi
 *                   K2.x lives here and IS vision-capable.
 *  - `openrouter` → aggregator. API key (OPENROUTER_API_KEY). Reaches Kimi as
 *                   `openrouter/moonshotai/kimi-k2.6`, plus most other models.
 *  - `opencode`   → opencode "zen" gateway. API key (OPENCODE_API_KEY). Also
 *                   exposes `opencode/kimi-k2.6`. The brief named "opencode"; it
 *                   is a real pi-ai provider, so we support it directly.
 *  - `anthropic`  → Claude. API key (ANTHROPIC_API_KEY). All models vision-capable.
 *  - `google`     → Gemini. API key (GEMINI_API_KEY). All models vision-capable.
 *
 * NB: the brief's example `opencode/kimi-k2.6` is exactly reachable. Kimi is NOT
 * reachable through `codex`/`openai-codex` (the subscription only exposes the
 * gpt-5.x family), which is why a non-OpenAI provider must be authed separately.
 */
export const PROVIDERS: readonly ProviderInfo[] = [
    { id: "codex", piProvider: "openai-codex", label: "ChatGPT (Codex)", kind: "oauth", desc: "Your ChatGPT subscription — GPT-5.x family only." },
    {
        id: "moonshotai",
        piProvider: "moonshotai",
        label: "Moonshot (Kimi)",
        kind: "apiKey",
        envVar: "MOONSHOT_API_KEY",
        keyHint: "platform.moonshot.ai → API keys",
        desc: "Kimi K2.x, first-party. Vision-capable.",
    },
    {
        id: "openrouter",
        piProvider: "openrouter",
        label: "OpenRouter",
        kind: "apiKey",
        envVar: "OPENROUTER_API_KEY",
        keyHint: "openrouter.ai/keys",
        desc: "One key, hundreds of models from every vendor.",
    },
    {
        id: "opencode",
        piProvider: "opencode",
        label: "opencode zen",
        kind: "apiKey",
        envVar: "OPENCODE_API_KEY",
        keyHint: "opencode.ai → API keys",
        desc: "opencode's hosted model gateway (zen) — broad model catalogue.",
    },
    {
        id: "opencode-go",
        piProvider: "opencode-go",
        label: "opencode go",
        kind: "apiKey",
        envVar: "OPENCODE_API_KEY",
        keyHint: "opencode.ai → API keys (same key as zen)",
        desc: "opencode's 'go' endpoint — same key as zen, different routing.",
    },
    {
        id: "anthropic",
        piProvider: "anthropic",
        label: "Anthropic (Claude)",
        kind: "apiKey",
        envVar: "ANTHROPIC_API_KEY",
        keyHint: "console.anthropic.com → API keys",
        desc: "Claude models — all vision-capable.",
    },
    {
        id: "google",
        piProvider: "google",
        label: "Google (Gemini)",
        kind: "apiKey",
        envVar: "GEMINI_API_KEY",
        keyHint: "aistudio.google.com → API keys",
        desc: "Gemini models — all vision-capable.",
    },
] as const;

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));
/** Reverse lookup: the pi-ai provider id (e.g. "openai-codex") → our info. */
const BY_PI = new Map(PROVIDERS.map((p) => [p.piProvider, p]));

/** Default per-role specs — preserve today's behaviour exactly (`codex` only). */
export const DEFAULT_REASONING_SPEC = "codex/gpt-5.5";
export const DEFAULT_FAST_SPEC = "codex/gpt-5.4-mini";
export const DEFAULT_SUBAGENT_SPEC = "codex/gpt-5.5";

/** A parsed `provider/model` spec. */
export interface ModelSpec {
    /** Our provider id (e.g. "codex", "moonshotai"). */
    provider: string;
    /** The model id as pi-ai's `getModel` expects (may itself contain slashes, e.g. openrouter). */
    model: string;
    /** The pi-ai provider id to pass to `getModel(piProvider, model)`. */
    piProvider: string;
}

export function getProviderInfo(id: string): ProviderInfo | undefined {
    return BY_ID.get(id);
}

export function getProviderInfoByPi(piProvider: string): ProviderInfo | undefined {
    return BY_PI.get(piProvider);
}

/**
 * Parse a `provider/model` spec. Returns undefined when the string is malformed
 * or names a provider we don't know. The model part keeps any further slashes
 * (OpenRouter ids look like `openrouter/moonshotai/kimi-k2.6`).
 */
export function parseModelSpec(spec: string | undefined | null): ModelSpec | undefined {
    if (typeof spec !== "string") return undefined;
    const trimmed = spec.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) return undefined;
    const provider = trimmed.slice(0, slash).trim();
    const model = trimmed.slice(slash + 1).trim();
    if (!provider || !model) return undefined;
    const info = BY_ID.get(provider);
    if (!info) return undefined;
    return { provider, model, piProvider: info.piProvider };
}

/**
 * Parse a spec, falling back to a known-good default spec when the input is
 * missing/malformed/unknown. Guarantees a resolvable result, so a bad setting
 * can never strand a role without a model. The fallback itself must be valid.
 */
export function parseSpecOrDefault(spec: string | undefined | null, fallback: string): ModelSpec {
    const parsed = parseModelSpec(spec);
    if (parsed) return parsed;
    const fb = parseModelSpec(fallback);
    if (fb) return fb;
    // Last-ditch: the built-in default must always parse.
    return parseModelSpec(DEFAULT_REASONING_SPEC)!;
}

/** Format a spec back to its canonical `provider/model` string. */
export function formatSpec(spec: ModelSpec): string {
    return `${spec.provider}/${spec.model}`;
}

/**
 * A model's capability summary, derived from pi-ai's catalogue entry. Kept tiny
 * and plain so the guard logic is pure and testable.
 */
export interface ModelCaps {
    /** Whether the model accepts image input (needed for the screenshot loop). */
    vision: boolean;
}

/**
 * Guard a fast/tool-tier choice against the vision requirement.
 *
 * The agent loop feeds the model screenshots, so the fast tier MUST be
 * vision-capable. If the chosen model is text-only we refuse it and fall back to
 * the reasoning model (which we already know works), surfacing a warning the
 * caller can show the user.
 *
 * `caps` is looked up by the caller (the runner, via pi-ai). When caps are
 * unknown (model id not in the catalogue) we treat it as a miss and fall back,
 * rather than risk sending images to a text-only endpoint.
 */
export interface FastTierGuardResult {
    /** The spec the fast tier should actually use. */
    spec: ModelSpec;
    /** Non-null when we rejected the requested model; a message to show the user. */
    warning: string | null;
}

export function guardFastTier(
    requested: ModelSpec,
    requestedCaps: ModelCaps | undefined,
    reasoning: ModelSpec,
    needsVision: boolean,
): FastTierGuardResult {
    if (!needsVision) return { spec: requested, warning: null };
    if (requestedCaps?.vision) return { spec: requested, warning: null };
    return {
        spec: reasoning,
        warning: `Fast model ${formatSpec(requested)} is text-only but the agent sends screenshots — falling back to ${formatSpec(reasoning)} for the fast tier.`,
    };
}
