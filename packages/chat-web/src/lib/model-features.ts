/**
 * Model features in the web app. The server resolves every feature for every model (`ModelInfo.features` on
 * GET /api/models: registry defaults, admin overrides, the user's own opt-outs, capability checks). Components
 * read the result here and never evaluate policy themselves.
 *
 *     const reactions = useModelFeature(conversation.model, "reactions");
 *     if (!reactions.enabled) ... // hide the control; reactions.offText for a tooltip
 */
import { getModelFeature, type ModelFeatureId, type ModelFeatureState, type ModelFeatureStates } from "@pikvm/chat-protocol";
import { useQuery } from "@tanstack/react-query";
import { modelsQuery } from "../components/model-picker/models";

/** Tooltip copy for a feature that is off for the current model. */
const OFF_TEXT: Record<ModelFeatureId, string> = {
    reactions: "Reactions are off for this model",
    thinkingEffort: "Thinking effort is fixed for this model",
};

export interface ModelFeatureView extends ModelFeatureState {
    /** False while the model list loads or when the model is not in it; `enabled` is then the registry default. */
    known: boolean;
    offText: string;
}

/** Every feature for a model, or undefined while loading or when the model is not listed. */
export function useModelFeatures(modelId: string | null | undefined): ModelFeatureStates | undefined {
    const { data } = useQuery(modelsQuery);
    const id = modelId || data?.defaultModel;
    return id ? data?.models.find((m) => m.id === id)?.features : undefined;
}

/**
 * One feature for a model (empty id means the user's default model). Until the list is loaded the registry
 * default applies, so a default-on control does not flicker in and out.
 */
export function useModelFeature(modelId: string | null | undefined, featureId: ModelFeatureId): ModelFeatureView {
    const state = useModelFeatures(modelId)?.[featureId];
    const offText = OFF_TEXT[featureId];
    if (state) return { ...state, known: true, offText };
    // Without the model's capabilities only an unconditional default-on feature counts as on.
    const def = getModelFeature(featureId);
    const enabled = !!def && def.default === true && !def.requires;
    return { enabled, reason: "default", known: false, offText };
}
