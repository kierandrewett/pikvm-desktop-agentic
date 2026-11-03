/**
 * Model roles on the server: the one place that turns a role into a model (docs/spec/model-roles.md 6.2).
 *
 * - resolveModelRole   effective settings + provider switches, walking the chain in @pikvm/chat-protocol ROLE_CHAINS; Chat-side
 *                      consumers (titles, icons, decisions) end at the chat's own model when nothing else is allowed
 * - runtimeModelRoles  the config.yml `modelRoles` fragment: one concrete, switch-checked model per runtime role, or
 *                      none, in which case the runtime uses its own choice for that role. `judge` follows `tiny`
 */
import { resolveRoleChain, RUNTIME_MODEL_ROLES, type ModelRole, type SettingKey } from "@pikvm/chat-protocol";
import { setting } from "../settings/store.ts";
import { modelSwitch } from "./policy.ts";

export interface ResolvedRole {
    /** `provider/model`, or undefined when the chain has nothing allowed and no chat model was given. */
    model?: string;
    /** Where the model came from: a role in the chain, or the chat's own model. */
    from?: ModelRole | "chat";
    /** Models in the chain the policy refused, in chain order. */
    refused: string[];
}

/** The provider switches as one predicate, read once per resolution. */
function allowedFor(userId: string): (model: string) => boolean {
    return modelSwitch(userId);
}

function walk(userId: string, role: ModelRole, allowed: (model: string) => boolean) {
    const r = resolveRoleChain(role, (key: SettingKey) => setting(key, userId) as string, allowed);
    for (const skip of r.refused) {
        console.warn(`[roles] ${userId}: ${role} skips ${skip.model} (${skip.role}): switched off`);
    }
    return r;
}

/**
 * The model for a role. `chatModel` is the conversation's model, the last step for Chat-side calls; it already passed
 * the policy at response.create. Runtime config callers leave it out.
 */
export function resolveModelRole(userId: string, role: ModelRole, opts: { chatModel?: string } = {}): ResolvedRole {
    const r = walk(userId, role, allowedFor(userId));
    const refused = r.refused.map((x) => x.model);
    if (r.model) return { model: r.model, from: r.from, refused };
    const chat = opts.chatModel?.trim();
    return chat ? { model: chat, from: "chat", refused } : { refused };
}

/** config.yml `modelRoles` for the roles the runtime knows. A role with no allowed model is left out. */
export function runtimeModelRoles(userId: string): Record<string, string> {
    const allowed = allowedFor(userId);
    const out: Record<string, string> = {};
    for (const role of RUNTIME_MODEL_ROLES) {
        const model = walk(userId, role, allowed).model;
        if (model) out[role] = model;
    }
    // The runtime's `judge` role starts with a built-in System One model (`typesafe/jev-latest`, or the same model
    // through OpenRouter as `~typesafe/jev-latest`). Chat hosts no such provider, and OpenRouter answers 404, so every
    // judged call failed (the `find` tool showed "1 failed"). A judge the runtime can reach is the small-tasks model.
    // Written explicitly, the native candidates drop out. As a side effect `find.enabled: auto` turns `find` off,
    // because it only enables itself for a native judge.
    if (out.tiny) out.judge = out.tiny;
    return out;
}
