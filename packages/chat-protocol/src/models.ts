/**
 * `GET /api/models` contract. Models come from the agent runtime for the user's effective providers,
 * filtered by policy, enriched with models.dev metadata. Logos are served by the server.
 */
import type { ModelFeatureStates } from "./model-features.ts";
import type { ThinkingEffort } from "./responses.ts";

export interface ModelInfo {
    /** `provider/modelId`, the value sent as `model` in response.create. */
    id: string;
    provider: string;
    /** Display name of the provider, from models.dev or the provider entry's label. */
    providerName: string;
    modelId: string;
    /** Display name, for example "Claude Opus 4.5" or "GPT-6 Luna". */
    name: string;
    /** Provider logo: `/api/models/logos/<key>.svg`, key is the serving models.dev provider id, or the provider id. */
    logo: string;
    /** Logo of the model's lab when it differs from the serving provider (OpenRouter serving Anthropic). */
    labLogo?: string;
    /**
     * Display name of the lab (vendor) that made the model, for example "Anthropic", from the models.dev
     * match. Optional and additive: older servers omit it, and clients then fall back to their own lab names.
     * Set whenever the lab is known, also when the lab serves the model itself (then `labLogo` is omitted).
     */
    labName?: string;
    /**
     * Family chosen by the server's classifier for an id the sort rules could not place (see model-order.ts).
     * Optional: absent when the rules placed the model, no decisions model is set, or no answer is cached yet.
     */
    series?: string;
    family?: string;
    reasoning: boolean;
    /** Reasoning efforts the model accepts; empty when reasoning is fixed or unsupported. */
    efforts: ThinkingEffort[];
    input: ("text" | "image" | "audio" | "video" | "pdf")[];
    toolCall: boolean;
    contextWindow?: number;
    maxOutput?: number;
    /** USD per million tokens. */
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    releaseDate?: string;
    knowledge?: string;
    openWeights?: boolean;
    /** Older than the newest models of its family; grouped under "Legacy models" in the picker. */
    legacy: boolean;
    /** models.dev entry this was matched to, for debugging the matcher. */
    matched?: { provider: string; model: string; score: number };
    /** Every registered model feature, resolved for the requesting user (see model-features.ts). */
    features: ModelFeatureStates;
}

export interface ModelsResponse {
    models: ModelInfo[];
    /** The user's effective default (`agent.defaultModel`, or the first model). */
    defaultModel: string | null;
    /** Providers the runtime could not load, with a reason, so settings can show the problem. */
    errors: { provider: string; message: string }[];
}
