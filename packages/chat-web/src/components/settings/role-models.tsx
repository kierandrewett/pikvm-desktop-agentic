/**
 * Model role rows (docs/spec/model-roles.md 8): Fast, Thinking, Small tasks and Decisions, next to the default
 * model. The same rows edit the user's own value (Chat page) or the global default (admin Models page, row id
 * `global.<key>`). Labels and descriptions come from registry.ts.
 *
 * - Fast, Thinking and Small tasks use the composer's model picker (ModelSelect). An empty value is Automatic; the hint
 *   shows what Automatic resolves to now, with the same chain the server uses (`resolveRoleChain`) over the effective
 *   values and the model list, which the server already filters by policy.
 * - Decisions uses the same picker with every allowed chat model, plus the models of decisions (System One)
 *   providers (`GET /api/models/decisions`) as an extra group, since those are never in the chat model list.
 */
import {
    resolveRoleChain,
    roleSettingKey,
    type ChatModelRole,
    type DecisionModelsResponse,
    type SettingKey,
} from "@pikvm/chat-protocol";
import { useQuery } from "@tanstack/react-query";
import { useT } from "../../l10n/provider";
import { api } from "../../lib/api";
import { keys } from "../../lib/queries";
import { erase, useAdminSetting, useUserSetting, type Binding } from "./bindings";
import { BoundRow, row } from "./kit";
import { ModelSelect, modelsQuery } from "./models";

/** Roles picked from chat models. */
export type ChatRole = Exclude<ChatModelRole, "decisions">;

/** Values a chat-role chain can read besides the role's own (ROLE_CHAINS: smol and default). */
type Values = Partial<Record<SettingKey, string>>;

/** Effective values in the user's view. */
function useUserValues(): Values {
    const d = useUserSetting<string>("agent.defaultModel").value;
    const smol = useUserSetting<string>("agent.modelRoles.smol").value;
    return { "agent.defaultModel": d, "agent.modelRoles.smol": smol };
}

/** Global values in the admin view. */
function useGlobalValues(): Values {
    const d = useAdminSetting<string>("agent.defaultModel").value;
    const smol = useAdminSetting<string>("agent.modelRoles.smol").value;
    return { "agent.defaultModel": d, "agent.modelRoles.smol": smol };
}

/**
 * The row hint and the Automatic line. `auto` says what Automatic resolves to now (the chain without the role's own
 * step); it is the description of the picker's pinned row. `hint` is shown under the row: `auto`, or why a chosen
 * model is not used, and empty when a listed model is chosen. Both are empty while models load.
 */
function useRoleHint(role: ChatRole, value: string, values: Values): { hint: string; auto: string } {
    const t = useT();
    const models = useQuery(modelsQuery).data?.models;
    if (!models) return { hint: "", auto: "" };
    const allowed = (id: string) => models.some((m) => m.id === id);
    const own = roleSettingKey(role);
    const r = resolveRoleChain(role, (k) => (k === own ? "" : values[k]), allowed);
    const auto = r.model
        ? t("models-role-auto", { from: r.from!, model: models.find((m) => m.id === r.model)?.name ?? r.model })
        : t("models-role-auto-chat");
    if (value && allowed(value)) return { hint: "", auto };
    return { hint: value ? t("models-role-unavailable", { value, auto }) : auto, auto };
}

function RoleRow({ role, id, binding, values, admin }: RoleRowProps) {
    const t = useT();
    const label = row(id).label;
    const value = (binding.value as string | undefined) ?? "";
    const { hint, auto } = useRoleHint(role, value, values);
    return (
        <BoundRow
            id={id}
            binding={binding}
            hint={hint || undefined}
            control={{
                type: "custom",
                render: () => (
                    <ModelSelect
                        value={value}
                        onChange={(v) => binding.set(v)}
                        disabled={!binding.writable}
                        label={label}
                        emptyDescription={auto || t("models-role-next")}
                        providersSection={admin ? "admin-providers" : "providers"}
                    />
                ),
            }}
        />
    );
}

interface RoleRowProps {
    role: ChatRole;
    id: string;
    binding: Binding<unknown>;
    values: Values;
    admin: boolean;
}

const keyOf = (role: ChatModelRole) => roleSettingKey(role)!;

/** The user's own role model (Chat settings). */
export function RoleModelRow({ role }: { role: ChatRole }) {
    const k = keyOf(role);
    const b = useUserSetting<string>(k);
    return <RoleRow role={role} id={k} binding={erase(b)} values={useUserValues()} admin={false} />;
}

/** The global default role model (admin Models and policy). */
export function GlobalRoleModelRow({ role }: { role: ChatRole }) {
    const k = keyOf(role);
    const b = useAdminSetting<string>(k);
    return <RoleRow role={role} id={`global.${k}`} binding={erase(b)} values={useGlobalValues()} admin />;
}

const decisionModelsQuery = {
    queryKey: [...keys.models, "decisions"] as const,
    queryFn: () => api.get<DecisionModelsResponse>("/models/decisions"),
    retry: false,
    staleTime: 60_000,
};

/**
 * Decisions: any allowed model, through the same picker as the other roles. Chat models answer through a structured
 * call; models on decisions providers (System One) are an extra group. Empty is Off: the role has no fallback.
 */
function DecisionsRow({ id, binding, admin }: { id: string; binding: Binding<unknown>; admin: boolean }) {
    const t = useT();
    const label = row(id).label;
    const value = (binding.value as string | undefined) ?? "";
    const chat = useQuery(modelsQuery).data?.models;
    const { data } = useQuery(decisionModelsQuery);
    const listed = !!value && [...(chat ?? []), ...(data?.models ?? [])].some((m) => m.id === value);
    const failed = data?.errors[0];
    const hint =
        value && chat && data && !listed
            ? t("models-decisions-unavailable", { value })
            : failed
              ? t("models-decisions-list-failed", { provider: failed.provider, message: failed.message })
              : undefined;
    return (
        <BoundRow
            id={id}
            binding={binding}
            hint={hint}
            control={{
                type: "custom",
                render: () => (
                    <ModelSelect
                        value={value}
                        onChange={(v) => binding.set(v)}
                        disabled={!binding.writable}
                        label={label}
                        emptyLabel={t("models-decisions-off")}
                        emptyDescription={t("models-decisions-off-description")}
                        providersSection={admin ? "admin-providers" : "providers"}
                        extraModels={data?.models}
                    />
                ),
            }}
        />
    );
}

/** The user's own decisions model (Chat settings). */
export function DecisionsModelRow() {
    const b = useUserSetting<string>("agent.modelRoles.decisions");
    return <DecisionsRow id="agent.modelRoles.decisions" binding={erase(b)} admin={false} />;
}

/** The global default decisions model (admin Models and policy). */
export function GlobalDecisionsModelRow() {
    const b = useAdminSetting<string>("agent.modelRoles.decisions");
    return <DecisionsRow id="global.agent.modelRoles.decisions" binding={erase(b)} admin />;
}
