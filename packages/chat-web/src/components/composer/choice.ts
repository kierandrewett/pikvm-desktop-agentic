/**
 * Model, effort and permission choice for the composer, remembered per viewer in localStorage.
 *
 * - Home: the last used model and effort, else the server default (`ModelsResponse.defaultModel`).
 * - Conversation: the choice made in that conversation, else the conversation's own model.
 * - Effort: the stored effort if the model accepts it, else `agent.defaultThinking`, else "medium", else
 *   the model's first effort. Models without reasoning have no effort. "auto" (the runtime picks an effort for
 *   each message) is accepted for any model with at least one effort; `ModelInfo.efforts` never lists it.
 * - Permission: the last used value, else the `agent.permission` setting.
 */
import type { ModelInfo, ThinkingSelector } from "@pikvm/chat-protocol";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { translate } from "../../l10n/runtime";
import { useSetting } from "../../lib/queries";
import { useModels } from "../model-picker/models";
import { conversationSummaryQuery } from "../../lib/queries";

export type Permission = "default" | "full";

interface Choice {
    model?: string;
    effort?: ThinkingSelector;
}

const LAST_KEY = "chat.composer.last";
const BY_CONVERSATION_KEY = "chat.composer.byConversation";
const PERMISSION_KEY = "chat.composer.permission";
const MAX_REMEMBERED = 200;

function read<T>(key: string): T | undefined {
    try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
        return undefined;
    }
}

function write(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {}
}

function readFor(conversationId: string | undefined): Choice | undefined {
    if (!conversationId) return read<Choice>(LAST_KEY);
    return read<Record<string, Choice>>(BY_CONVERSATION_KEY)?.[conversationId];
}

/** Remember a choice for a conversation (and as the last used choice). */
export function rememberChoice(conversationId: string | undefined, c: Choice): void {
    write(LAST_KEY, c);
    if (!conversationId) return;
    const all = read<Record<string, Choice>>(BY_CONVERSATION_KEY) ?? {};
    delete all[conversationId];
    all[conversationId] = c;
    const ids = Object.keys(all);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_REMEMBERED))) delete all[id];
    write(BY_CONVERSATION_KEY, all);
}

/**
 * Level names as getters, so every read gives the active language. Components that show them re-render when the
 * language changes (they call `useT()`), which re-reads the getters.
 */
export const EFFORT_LABELS: Record<ThinkingSelector, string> = {
    get auto() {
        return translate("composer-effort-auto");
    },
    get off() {
        return translate("composer-effort-off");
    },
    get minimal() {
        return translate("composer-effort-minimal");
    },
    get low() {
        return translate("composer-effort-low");
    },
    get medium() {
        return translate("composer-effort-medium");
    },
    get high() {
        return translate("composer-effort-high");
    },
    get xhigh() {
        return translate("composer-effort-xhigh");
    },
    get max() {
        return translate("composer-effort-max");
    },
};

export interface ComposerChoice {
    models: ModelInfo[] | undefined;
    modelsError: unknown;
    model: ModelInfo | undefined;
    modelId: string | undefined;
    effort: ThinkingSelector | undefined;
    permission: Permission;
    setModel: (id: string) => void;
    setEffort: (e: ThinkingSelector) => void;
    setPermission: (p: Permission) => void;
}

export function useComposerChoice(
    conversationId: string | undefined,
    controls: { modelPicker: boolean; effort: boolean; permissions: boolean } = {
        modelPicker: true,
        effort: true,
        permissions: true,
    },
): ComposerChoice {
    const { data, error } = useModels();
    const { data: conversation } = useQuery({
        ...conversationSummaryQuery(conversationId ?? ""),
        enabled: !!conversationId,
    });
    const conversationModel = conversation?.model;
    const defaultThinking = useSetting<ThinkingSelector | undefined>("agent.defaultThinking", undefined);
    const defaultPermission = useSetting<Permission>("agent.permission", "default");

    // Explicit choice, re-read whenever the conversation changes.
    const scope = conversationId;
    const [stored, setStored] = useState(() => ({ id: scope, choice: readFor(scope) ?? {} }));
    const choice = stored.id === scope ? stored.choice : (readFor(scope) ?? {});
    if (stored.id !== scope) setStored({ id: scope, choice });

    const [permission, setPermissionState] = useState<Permission | undefined>(() => read<Permission>(PERMISSION_KEY));

    const models = data?.models;
    const resolved = useMemo(() => {
        const has = (id: string | undefined) => !!id && (!models || models.some((m) => m.id === id));
        const fallback = conversationId ? conversationModel : (data?.defaultModel ?? undefined);
        const modelId = [
            controls.modelPicker ? choice.model : undefined,
            fallback,
            data?.defaultModel ?? undefined,
            models?.[0]?.id,
        ].find(has);
        const model = models?.find((m) => m.id === modelId);
        let effort: ThinkingSelector | undefined;
        if (model?.reasoning && model.efforts.length) {
            const ok = (e: ThinkingSelector | undefined): e is ThinkingSelector =>
                !!e && (e === "auto" || model.efforts.includes(e));
            effort =
                [controls.effort ? choice.effort : undefined, defaultThinking, "medium" as const].find(ok) ??
                model.efforts[0];
        }
        return { modelId, model, effort };
    }, [
        models,
        data?.defaultModel,
        conversationId,
        conversationModel,
        controls.modelPicker,
        controls.effort,
        choice.model,
        choice.effort,
        defaultThinking,
    ]);

    const update = useCallback(
        (patch: Choice) => {
            setStored((s) => {
                const next = { ...s.choice, ...patch };
                rememberChoice(scope, next);
                return { id: scope, choice: next };
            });
        },
        [scope],
    );
    const setModel = useCallback((id: string) => update({ model: id }), [update]);
    const setEffort = useCallback((e: ThinkingSelector) => update({ effort: e }), [update]);
    const setPermission = useCallback((p: Permission) => {
        setPermissionState(p);
        write(PERMISSION_KEY, p);
    }, []);

    return {
        models,
        modelsError: error,
        ...resolved,
        permission: controls.permissions ? (permission ?? defaultPermission) : defaultPermission,
        setModel,
        setEffort,
        setPermission,
    };
}
