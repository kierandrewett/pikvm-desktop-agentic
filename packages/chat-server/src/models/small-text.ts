/**
 * One small text request on the user's own chat model, for the host's own features (the screen watch writing a notification). It
 * takes the path the chat takes (conversations/titles.ts `complete`): the model of the Small tasks role (`tiny`, else Fast, else the
 * default model), the provider's endpoint and its stored credential, in the provider's own API family. Nothing here names a provider.
 *
 * "No model" is a normal answer, not an error: no model set, a provider that is off, has no endpoint or key, or an API family without a
 * client here all give `undefined`, and the caller carries on without a model.
 */
import { complete } from "../conversations/titles.ts";
import { chatTarget } from "./provider-call.ts";
import { resolveModelRole } from "./roles.ts";

const SUPPORTED = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);

/** The model a small request would use, as `{ provider, model }`, or undefined when there is none that can be called. */
function target(userId: string): { provider: string; model: string } | undefined {
    const id = resolveModelRole(userId, "tiny").model;
    const slash = id?.indexOf("/") ?? -1;
    if (!id || slash <= 0) return undefined;
    const provider = id.slice(0, slash);
    const callable = chatTarget(userId, provider);
    return callable && SUPPORTED.has(callable.api) ? { provider, model: id.slice(slash + 1) } : undefined;
}

/** Whether a small request can be made for this user right now (a model is configured and its provider can be called). */
export function hasSmallModel(userId: string): boolean {
    return target(userId) !== undefined;
}

/**
 * Ask the small model: `system` and `user` in, text out. Undefined when there is no model to ask. Rejects when the call fails or passes
 * `timeoutMs` (the request is aborted); the caller decides what that means.
 */
export async function smallText(userId: string, system: string, user: string, options: { maxTokens?: number; timeoutMs: number }): Promise<string | undefined> {
    const t = target(userId);
    if (!t) return undefined;
    return complete(userId, t, system, user, options.maxTokens ?? 80, { disableReasoning: true, timeoutMs: options.timeoutMs });
}
