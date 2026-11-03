/**
 * Model roles: named jobs that each map to one model (docs/spec/model-roles.md). Every model consumer asks for a
 * role. A role without a model of its own is Automatic: the next role in its chain. The chain walk is pure so the
 * server (models/roles.ts, with settings and policy) and the settings page (to show what Automatic resolves to) use
 * the same rules.
 */
import type { ModelInfo } from "./models.ts";
import type { SettingKey } from "./settings.ts";

/** Roles with a setting of their own, in the order the settings page lists them. */
export const CHAT_MODEL_ROLES = ["smol", "slow", "tiny", "decisions"] as const;
export type ChatModelRole = (typeof CHAT_MODEL_ROLES)[number];

/** Every role Chat resolves: the default model, the settable roles and `memory` (derived, no setting). */
export type ModelRole = "default" | ChatModelRole | "memory";

/** Roles written to the runtime's config.yml `modelRoles`. `decisions` is Chat-only: the runtime has no such role. */
export const RUNTIME_MODEL_ROLES = ["smol", "slow", "tiny", "memory"] as const satisfies readonly ModelRole[];

/**
 * Fallback order per role; the first allowed value wins. Follows the runtime's own order (`tiny` -> `smol`, `smol` and
 * `slow` -> configured `default`). `decisions` has no fallback: it requires an explicit model.
 */
export const ROLE_CHAINS: Readonly<Record<ModelRole, readonly ModelRole[]>> = {
    default: ["default"],
    smol: ["smol", "default"],
    slow: ["slow", "default"],
    tiny: ["tiny", "smol", "default"],
    memory: ["tiny", "smol", "default"],
    decisions: ["decisions"],
};

const ROLE_KEYS: Readonly<Record<Exclude<ModelRole, "memory">, SettingKey>> = {
    default: "agent.defaultModel",
    smol: "agent.modelRoles.smol",
    slow: "agent.modelRoles.slow",
    tiny: "agent.modelRoles.tiny",
    decisions: "agent.modelRoles.decisions",
};

/** The setting that holds a role's own model. `memory` has none. */
export function roleSettingKey(role: ModelRole): SettingKey | undefined {
    return role === "memory" ? undefined : ROLE_KEYS[role];
}

export interface RoleResolution {
    /** `provider/model`, or undefined when no step of the chain has an allowed value. */
    model?: string;
    /** The role in the chain that gave the model. */
    from?: ModelRole;
    /** Values skipped because the policy refuses them, in chain order. */
    refused: { role: ModelRole; model: string }[];
}

/**
 * Walk a role's chain. `lookup` returns the effective stored value of one setting key (empty or undefined when not
 * set); `allowed` is the model policy. Never throws.
 */
export function resolveRoleChain(
    role: ModelRole,
    lookup: (key: SettingKey) => string | undefined,
    allowed: (model: string) => boolean,
): RoleResolution {
    const refused: RoleResolution["refused"] = [];
    for (const step of ROLE_CHAINS[role]) {
        const key = roleSettingKey(step);
        const model = key ? (lookup(key) ?? "").trim() : "";
        if (!model) continue;
        if (!allowed(model)) {
            refused.push({ role: step, model });
            continue;
        }
        return { model, from: step, refused };
    }
    return { refused };
}

// Decisions contracts: GET /api/models/decisions and POST /api/models/decisions/test. Any allowed model fits the
// decisions role: a model on a `systemone` provider answers natively, any chat model answers through a structured call.

/**
 * Models on `systemone` providers, for the extra group in the Decisions picker. Chat models come from
 * `GET /api/models` as for every other role; these never do, because the runtime cannot chat with them.
 */
export interface DecisionModelsResponse {
    models: ModelInfo[];
    /** Providers that could not be listed, with a reason. Never contains a key. */
    errors: { provider: string; message: string }[];
}

/** How a decision was answered: the native System One API, or a structured call to a chat model. */
export type DecisionBackend = "systemone" | "chat";

/** Why a decision returned no answer. `invalid_answer`: well-formed, but not one of the options or levels. */
export type DecisionFailure =
    "no_role" | "refused" | "provider" | "unreachable" | "timeout" | "http" | "malformed" | "invalid_answer";

/** Question types the test route can ask. */
export type DecisionKind = "probability" | "choose" | "score";

export interface DecisionCheck {
    ok: boolean;
    kind: DecisionKind;
    model?: string;
    backend?: DecisionBackend;
    latencyMs: number;
    /** The answer: yes/no for `probability`, the option name for `choose`, the score for `score`. */
    answer?: boolean | string | number;
    /** P(yes) for `probability`. Undefined when the backend gave no probabilities. */
    probability?: number;
    /** Per option or level for `choose` and `score`. Undefined when the backend gave no probabilities. */
    probabilities?: Record<string, number>;
    reason?: DecisionFailure;
    error?: string;
}
