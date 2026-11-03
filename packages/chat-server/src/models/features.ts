/**
 * Model features on the server: resolves the registry in @pikvm/chat-protocol/model-features against the stored
 * overrides (`models.features`) and answers "is feature X on
 * for this user's turn". The rules live in the protocol module so the settings page previews edits with the same code.
 */
import {
    evaluateModelFeatures,
    thinkingLevels,
    type ModelCapabilities,
    type ModelFeatureOverrides,
    type ModelFeatureStates,
    type ThinkingEffort,
} from "@pikvm/chat-protocol";
import { getConversation } from "../conversations/service.ts";
import { setting } from "../settings/store.ts";

/**
 * Reads both override maps once and returns a resolver for many models, plus `key`, a string that changes
 * whenever the overrides change (service.ts folds it into its list cache key).
 */
export function modelFeatureResolver(userId: string): {
    key: string;
    resolve: (model: ModelCapabilities & { id: string }) => ModelFeatureStates;
} {
    const admin: ModelFeatureOverrides = {};
    const user = setting("models.features", userId) as ModelFeatureOverrides;
    return { key: JSON.stringify([admin, user]), resolve: (model) => evaluateModelFeatures(model, admin, user) };
}

/** Every feature's state for one model and user. */
export function resolveModelFeatures(model: ModelCapabilities & { id: string }, userId: string): ModelFeatureStates {
    return modelFeatureResolver(userId).resolve(model);
}

/**
 * Capabilities assumed when only the id is known. Overrides apply by id; capability checks pass, because the
 * runtime is the last judge of what the model accepts (it already ignores an effort a model does not support).
 */
function assumeCapable(id: string): ModelCapabilities & { id: string } {
    const efforts = thinkingLevels.filter((l) => l !== "off") as ThinkingEffort[];
    return { id, reasoning: true, efforts, input: ["text", "image", "audio", "video", "pdf"], toolCall: true };
}

/**
 * Features for the model a turn runs on: the requested model, else the conversation's model, else the user's
 * default model. Synchronous and by id only: a turn must not wait for a model listing, which spawns the runtime
 * (about 4 s) when the user has none cached. Never throws; a missing conversation is the caller's error to report.
 */
export function turnModelFeatures(userId: string, modelId?: string, conversationId?: string): ModelFeatureStates {
    let id = modelId;
    if (!id && conversationId) {
        try {
            id = getConversation(userId, conversationId).model || undefined;
        } catch {}
    }
    id ||= setting("agent.defaultModel", userId) || "";
    return resolveModelFeatures(assumeCapable(id), userId);
}
