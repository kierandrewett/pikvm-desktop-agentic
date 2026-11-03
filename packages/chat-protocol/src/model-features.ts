/**
 * Model features: behaviours that work well with some models and badly with others, so an admin can turn them
 * on or off per model. This registry is the single source of truth. The server resolves every feature for every
 * model (`ModelInfo.features` on GET /api/models) and enforces it where the behaviour lives; the web app reads
 * the resolved state and never evaluates policy itself, except to preview an admin edit before it is saved.
 *
 * Resolution for one feature on one model, in order:
 * 1. `requires` fails for the model's capabilities -> off, reason `unsupported`. Nothing overrides this.
 * 2. `default` (a boolean, or a function of the capabilities) -> reason `default`.
 * 3. `policy.models.features`: the most specific pattern that sets this feature wins -> reason `admin`.
 * 4. `models.features` (the user's own map), only for features with `userToggle` -> reason `user`.
 *    A user can turn a feature off, and on again, but cannot turn on a feature the admin turned off.
 *
 * Patterns are the same globs as `policy.models.allow` / `policy.models.deny`: `provider/model`, `*` matches any
 * run of characters, case-insensitive. Specificity: a pattern without `*` (an exact model id) beats every glob;
 * between globs, more literal characters win (`anthropic/claude-*` beats `anthropic/*`); on a tie the entry later
 * in the map wins, so the last pattern written breaks ties. Each feature is matched on its own: a broad pattern
 * still applies to the features a more specific pattern does not set.
 *
 * The pattern `*` is the admin default for every model (the admin UI shows it as "Defaults"); being the least
 * specific glob, every other pattern beats it. Globs other than `*` are "rules"; an exact id is a per-model setting.
 *
 * Adding a feature: add an entry below, enforce it on the server where the behaviour lives, read it on the web
 * with `useModelFeature`, and add a case to e2e/api/model-features.test.ts. Do not add a feature that nothing
 * reads; an unwired toggle lies to the admin.
 */
import type { ModelInfo } from "./models.ts";

export const modelFeatureCategories = ["feedback", "input", "output", "tools", "context"] as const;
export type ModelFeatureCategory = (typeof modelFeatureCategories)[number];

export const modelFeatureCategoryLabels: Record<ModelFeatureCategory, string> = {
    feedback: "Feedback",
    input: "Input",
    output: "Output",
    tools: "Tools",
    context: "Context",
};

/** The parts of a model a feature can depend on. */
export type ModelCapabilities = Pick<ModelInfo, "reasoning" | "efforts" | "input" | "toolCall">;

export interface ModelFeatureDef {
    /** Stable id; the key in `ModelInfo.features` and in both override maps. Never rename. */
    id: string;
    label: string;
    /** One sentence for the admin UI: what turning it off changes. */
    description: string;
    category: ModelFeatureCategory;
    /** Value before any override. A function derives it from the model's capabilities. */
    default: boolean | ((model: ModelCapabilities) => boolean);
    /** A capability the model must have. Without it the feature is off and no override can turn it on. */
    requires?: { label: string; test: (model: ModelCapabilities) => boolean };
    /** Users may turn it off (and back on) for themselves in `models.features`. */
    userToggle?: boolean;
}

export const modelFeatures = [
    {
        id: "reactions",
        label: "Reactions",
        description:
            "People can react to messages with an emoji, and the reactions go to the model with the next message as " +
            "feedback. Some models find this confusing. When off, the reactions UI is hidden and nothing is sent; " +
            "stored reactions are kept.",
        category: "feedback",
        default: true,
        userToggle: true,
    },
    {
        id: "thinkingEffort",
        label: "Thinking effort control",
        description:
            "People can pick a thinking effort per message. When off, the effort control is hidden and the server " +
            "ignores a requested effort, so the conversation keeps its starting level.",
        category: "output",
        default: true,
        requires: {
            label: "Needs a model with adjustable thinking effort",
            test: (m: ModelCapabilities) => m.reasoning && m.efforts.length > 0,
        },
    },
] as const satisfies readonly ModelFeatureDef[];

export type ModelFeatureId = (typeof modelFeatures)[number]["id"];
export const modelFeatureIds = modelFeatures.map((f) => f.id) as [ModelFeatureId, ...ModelFeatureId[]];

const byId = new Map<string, ModelFeatureDef>(modelFeatures.map((f) => [f.id, f]));

export function getModelFeature(id: string): ModelFeatureDef | undefined {
    return byId.get(id);
}

/** Why a feature has its state. */
export type ModelFeatureReason = "default" | "admin" | "user" | "unsupported";

export interface ModelFeatureState {
    enabled: boolean;
    reason: ModelFeatureReason;
    /** The override pattern that decided it, for `admin` and `user`. */
    pattern?: string;
}

export type ModelFeatureStates = Record<ModelFeatureId, ModelFeatureState>;

/** Pattern -> feature id -> on/off. The shape of `policy.models.features` and `models.features`. */
export type ModelFeatureOverrides = Record<string, Partial<Record<ModelFeatureId, boolean>>>;

// Patterns

const compiled = new Map<string, RegExp>();

/** `*` matches any run of characters, case-insensitive; everything else is literal. Compiled once per pattern. */
export function modelGlob(pattern: string): RegExp {
    let re = compiled.get(pattern);
    if (!re) {
        re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
        compiled.set(pattern, re);
    }
    return re;
}

/** Higher is more specific. An exact id beats any glob; globs rank by their literal characters. */
export function patternSpecificity(pattern: string): number {
    return pattern.includes("*") ? pattern.replaceAll("*", "").length : Number.MAX_SAFE_INTEGER;
}

interface Hit {
    pattern: string;
    rank: number;
    index: number;
    values: Partial<Record<ModelFeatureId, boolean>>;
}

/** Patterns of `overrides` that match `modelId`, most specific last (ties: later entry last). */
function hitsFor(modelId: string, overrides: ModelFeatureOverrides | undefined): Hit[] {
    if (!overrides) return [];
    const hits: Hit[] = [];
    let index = 0;
    for (const [pattern, values] of Object.entries(overrides)) {
        if (modelGlob(pattern).test(modelId)) hits.push({ pattern, rank: patternSpecificity(pattern), index, values });
        index++;
    }
    return hits.sort((a, b) => a.rank - b.rank || a.index - b.index);
}

/** The deciding hit for one feature: the last (most specific) hit that sets it. */
function decide(hits: Hit[], id: ModelFeatureId): { pattern: string; value: boolean } | undefined {
    for (let i = hits.length - 1; i >= 0; i--) {
        const v = hits[i]!.values[id];
        if (typeof v === "boolean") return { pattern: hits[i]!.pattern, value: v };
    }
    return undefined;
}

// Evaluation

/** Default for a feature on a model, before overrides; `unsupported` when the model lacks the capability. */
export function featureBase(f: ModelFeatureDef, model: ModelCapabilities): ModelFeatureState {
    if (f.requires && !f.requires.test(model)) return { enabled: false, reason: "unsupported" };
    return { enabled: typeof f.default === "function" ? f.default(model) : f.default, reason: "default" };
}

/**
 * Every feature's state for one model. Pure: the server calls it with the stored settings, the admin UI with a
 * draft to preview an edit. See the module comment for the rules.
 */
export function evaluateModelFeatures(
    model: ModelCapabilities & { id: string },
    admin: ModelFeatureOverrides | undefined,
    user?: ModelFeatureOverrides,
): ModelFeatureStates {
    const adminHits = hitsFor(model.id, admin);
    const userHits = hitsFor(model.id, user);
    const out = {} as ModelFeatureStates;
    for (const f of modelFeatures as readonly ModelFeatureDef[]) {
        const id = f.id as ModelFeatureId;
        let state = featureBase(f, model);
        if (state.reason !== "unsupported") {
            const a = decide(adminHits, id);
            if (a) state = { enabled: a.value, reason: "admin", pattern: a.pattern };
            const u = f.userToggle ? decide(userHits, id) : undefined;
            const adminForcedOff = state.reason === "admin" && !state.enabled;
            if (u && !(u.value && adminForcedOff)) state = { enabled: u.value, reason: "user", pattern: u.pattern };
        }
        out[id] = state;
    }
    return out;
}

/** The admin default pattern: matches every model and loses to every other pattern. */
export const DEFAULT_PATTERN = "*";

/** The feature's value before rules and per-model settings: the `*` override, else the registry default. */
export function featureDefault(f: ModelFeatureDef, admin: ModelFeatureOverrides | undefined, model?: ModelCapabilities): boolean {
    const v = admin?.[DEFAULT_PATTERN]?.[f.id as ModelFeatureId];
    if (typeof v === "boolean") return v;
    if (typeof f.default === "boolean") return f.default;
    return model ? f.default(model) : false;
}

/**
 * Short reason for a state, for the admin UI and tooltips: "on, from rule acme/*", "off, set for this model",
 * "off, unsupported: needs a model with adjustable thinking effort". `modelId` tells an exact-id setting apart.
 */
export function describeFeatureState(f: ModelFeatureDef, s: ModelFeatureState, modelId?: string): string {
    const onOff = s.enabled ? "On" : "Off";
    switch (s.reason) {
        case "unsupported":
            return `Off, unsupported: ${(f.requires?.label ?? "the model cannot use it").replace(/^./, (c) => c.toLowerCase())}`;
        case "admin":
            if (s.pattern === DEFAULT_PATTERN) return `${onOff}, from Defaults`;
            if (modelId && s.pattern?.toLowerCase() === modelId.toLowerCase()) return `${onOff}, set for this model`;
            return `${onOff}, from rule ${s.pattern}`;
        case "user":
            return `${onOff}, your own setting for ${s.pattern}`;
        default:
            return `${onOff}, built-in default`;
    }
}
