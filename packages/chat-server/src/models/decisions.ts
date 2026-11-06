/**
 * The Decisions role: short typed questions answered by a cheap model, for the host's own features (the screen watch asking
 * whether a pop-up is worth a notification). Two kinds of model can fill it:
 *  - a decisions model on OpenRouter (Jev, Perplexity Decider, Liquid d1 and others): `POST /api/alpha/decisions`, a yes/no probability and no text, a
 *    small fraction of a chat model's price. They are not in the chat list, so `decisionModels` lists them for the picker;
 *  - any chat model, asked for a JSON probability through the same small-text path the chat uses.
 * With no model set there is no decision (`undefined`) and the feature uses its own rules. There is no fallback to another role.
 */
import type { DecisionModelsResponse, ModelInfo, Provider } from "@pikvm/chat-protocol";
import { authHeaderFor, resolveEndpoint } from "../agent/providers.ts";
import { resolveSetting } from "../settings/store.ts";
import { complete } from "../conversations/titles.ts";
import { ProviderCallError, chatTarget, postJson } from "./provider-call.ts";
import { modelFeatureResolver } from "./features.ts";
import { resolveModelRole } from "./roles.ts";

const LIST_TIMEOUT_MS = 10_000;
const LIST_TTL_MS = 10 * 60_000;
const OPENROUTER = "openrouter";

/**
 * OpenRouter itself, with the user's own key. The decisions endpoint is outside the chat API (`/api/alpha`, next to `/api/v1`), and the
 * chat gateway only reaches paths under the provider's chat base URL, so these calls do not go through it.
 */
function direct(userId: string): { apiRoot: string; headers: Record<string, string>; secrets: string[] } | undefined {
    const p = (resolveSetting("agent.providers", userId).value as Record<string, Provider>)[OPENROUTER];
    const ep = p?.enabled ? resolveEndpoint(OPENROUTER, p) : undefined;
    if (!p || !ep || !p.apiKey) return undefined;
    return {
        apiRoot: ep.baseUrl.replace(/\/v1$/, ""),
        headers: { "content-type": "application/json", ...authHeaderFor(ep.api, p.apiKey), "x-title": "PiKVM decisions" },
        secrets: [p.apiKey],
    };
}

interface Listed {
    id?: unknown;
    name?: unknown;
    pricing?: { prompt?: unknown };
}

const cache = new Map<string, { at: number; models: ModelInfo[]; error?: string }>();

function perMillion(price: unknown): number | undefined {
    const n = typeof price === "string" ? Number(price) : typeof price === "number" ? price : NaN;
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1000) / 1000 : undefined;
}

/** The decisions models the user's OpenRouter provider offers. Empty, with no error, when the user has no OpenRouter provider. */
export async function decisionModels(userId: string): Promise<DecisionModelsResponse> {
    const t = direct(userId);
    if (!t) return { models: [], errors: [] };
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < LIST_TTL_MS)
        return { models: hit.models, errors: hit.error ? [{ provider: OPENROUTER, message: hit.error }] : [] };
    const resolve = modelFeatureResolver(userId);
    try {
        const res = await fetch(`${t.apiRoot}/v1/models?output_modalities=decisions`, {
            headers: t.headers,
            signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
        const data = ((await res.json()) as { data?: Listed[] }).data ?? [];
        const models = data
            .filter((m): m is Listed & { id: string } => typeof m.id === "string")
            .map((m) => {
                const info: Omit<ModelInfo, "features"> = {
                    id: `${OPENROUTER}/${m.id}`,
                    provider: OPENROUTER,
                    providerName: "OpenRouter",
                    modelId: m.id,
                    name: typeof m.name === "string" && m.name ? m.name : m.id,
                    logo: `/api/models/logos/${OPENROUTER}.svg`,
                    reasoning: false,
                    efforts: [],
                    input: ["text"],
                    toolCall: false,
                    cost: { input: perMillion(m.pricing?.prompt) },
                    legacy: false,
                };
                return { ...info, features: resolve.resolve(info) };
            });
        cache.set(userId, { at: Date.now(), models });
        return { models, errors: [] };
    } catch (error) {
        const message = cleanMessage(error, t.secrets);
        cache.set(userId, { at: Date.now() - LIST_TTL_MS + 30_000, models: [], error: message });
        return { models: [], errors: [{ provider: OPENROUTER, message }] };
    }
}

function cleanMessage(error: unknown, secrets: readonly string[]): string {
    const text = error instanceof Error ? error.message : "could not be listed";
    return secrets.reduce((m, s) => (s.length >= 4 ? m.split(s).join("[redacted]") : m), text).slice(0, 200);
}

export function forgetDecisionModels(userId?: string): void {
    if (userId) cache.delete(userId);
    else cache.clear();
}

/**
 * Whether `provider/model` answers on OpenRouter's decisions endpoint: it is in the provider's decisions list (Jev, Perplexity Decider,
 * Liquid d1 and others), or, when that list cannot be read, it is named like a Jev model.
 */
async function isDecisionModel(userId: string, id: string): Promise<boolean> {
    const listed = await decisionModels(userId);
    if (listed.models.some((m) => m.id === id)) return true;
    return listed.errors.length > 0 && /^openrouter\/~?typesafe\/jev/i.test(id);
}

export interface Decision {
    /** P(yes), 0 to 1. */
    probability: number;
    /** `decisions`: the native endpoint. `chat`: a chat model asked for JSON. */
    backend: "decisions" | "chat";
}

export interface DecideRequest {
    /** The facts the question is about, as named strings. */
    state: Record<string, string>;
    /** The yes/no question, written about the names in `state`. */
    instructions: string;
    timeoutMs: number;
}

/** Whether a decisions model is set and can be called now. */
export function hasDecisionModel(userId: string): boolean {
    return target(userId) !== undefined;
}

function target(userId: string): { provider: string; model: string } | undefined {
    const id = resolveModelRole(userId, "decisions").model;
    const slash = id?.indexOf("/") ?? -1;
    if (!id || slash <= 0) return undefined;
    const provider = id.slice(0, slash);
    const model = id.slice(slash + 1);
    return chatTarget(userId, provider) ? { provider, model } : undefined;
}

function probabilityOf(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/**
 * Ask the Decisions model one yes/no question. Undefined when no decisions model is set or it cannot be called. Rejects when the call
 * fails, times out or answers with something that is not a probability: the caller decides what that means.
 */
export async function decide(userId: string, req: DecideRequest): Promise<Decision | undefined> {
    const t = target(userId);
    if (!t) return undefined;
    const call = chatTarget(userId, t.provider)!;
    if (t.provider === OPENROUTER && (await isDecisionModel(userId, `${t.provider}/${t.model}`))) {
        const key = direct(userId);
        if (!key) return undefined;
        const body = (await postJson(
            { provider: OPENROUTER, baseUrl: key.apiRoot, api: "openai-completions", headers: key.headers, secrets: key.secrets },
            "/alpha/decisions",
            { model: t.model, state: req.state, questions: { q: { type: "noul", instructions: req.instructions } } },
            AbortSignal.timeout(req.timeoutMs),
        )) as { answers?: { q?: { type?: unknown; noul?: unknown } } };
        const answer = body.answers?.q;
        const probability = answer?.type === "noul" ? probabilityOf(answer.noul) : undefined;
        if (probability === undefined) throw new ProviderCallError("The decisions model gave no yes/no answer");
        return { probability, backend: "decisions" };
    }
    const text = await complete(
        userId,
        t,
        "Answer one yes/no question about the facts. Reply with JSON only: {\"probability\": a number from 0 to 1, the chance the answer is yes}.",
        `Facts:\n${JSON.stringify(req.state)}\n\nQuestion: ${req.instructions}`,
        40,
        { disableReasoning: true, json: true, timeoutMs: req.timeoutMs },
    );
    const match = text?.match(/\{[\s\S]*\}/);
    const probability = match ? probabilityOf((JSON.parse(match[0]) as { probability?: unknown }).probability) : undefined;
    if (probability === undefined) throw new ProviderCallError("The decisions model gave no yes/no answer");
    return { probability, backend: "chat" };
}
