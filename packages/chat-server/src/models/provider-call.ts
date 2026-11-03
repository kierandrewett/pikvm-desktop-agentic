/**
 * Direct, non-streaming calls from the server to a chat provider, on the same path the user's agent takes: the
 * rendered models.yml entry. For a global provider that is the LLM gateway with the user's gateway token (the
 * gateway checks the policy and keeps the admin key); for a user's own provider it is its own endpoint and key.
 *
 * Used by chat titles and icons (conversations/titles.ts), the agent builder and the chat backend of the decisions
 * role (models/decisions.ts).
 */
import type { Provider } from "@pikvm/chat-protocol";
import { renderAgentConfig } from "../agent/config.ts";
import { authHeaderFor, BUILTIN_PROVIDERS, type Api } from "../agent/providers.ts";
import { agentBaseUrl } from "../env.ts";
import { resolveSetting } from "../settings/store.ts";

export interface ChatTarget {
    provider: string;
    baseUrl: string;
    api: Api;
    headers: Record<string, string>;
    /** Values to remove from error text: the key or gateway token, header values and the provider's real key. */
    secrets: string[];
}

/** HTTP failure of a provider call. `status` lets callers retry a 400 with a simpler request. */
export class ProviderCallError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
    }
}

/** Where to send a chat call to `provider` for this user, or undefined when it is not in their models.yml. */
export function chatTarget(userId: string, provider: string): ChatTarget | undefined {
    const entry = renderAgentConfig(userId, agentBaseUrl()).models.providers[provider] as
        { baseUrl?: string; api?: Api; apiKey?: string; headers?: Record<string, string> } | undefined;
    const builtin = BUILTIN_PROVIDERS[provider];
    const baseUrl = (entry?.baseUrl ?? builtin?.baseUrl)?.replace(/\/+$/, "");
    const api = entry?.api ?? builtin?.api;
    if (!entry || !baseUrl || !api) return undefined;
    const real = (resolveSetting("agent.providers", userId).value as Record<string, Provider>)[provider];
    return {
        provider,
        baseUrl,
        api,
        headers: {
            "content-type": "application/json",
            ...(entry.headers ?? {}),
            ...(entry.apiKey ? authHeaderFor(api, entry.apiKey) : {}),
        },
        secrets: [entry.apiKey, real?.apiKey, ...Object.values(entry.headers ?? {})].filter(
            (v): v is string => typeof v === "string" && v.length >= 4,
        ),
    };
}

/** Replace secret values in text that is logged or sent to a browser. */
export function cleanSecrets(text: string, secrets: readonly string[]): string {
    return secrets.reduce((t, s) => (s.length >= 4 ? t.split(s).join("[redacted]") : t), text);
}

/**
 * POST JSON and return the parsed reply. Provider reply shapes differ by API family, so the result is `unknown` and
 * callers read it defensively. Throws ProviderCallError on a non-2xx status, with the secrets removed.
 */
export async function postJson(
    t: ChatTarget,
    path: string,
    body: unknown,
    signal: AbortSignal,
    extraHeaders: Record<string, string> = {},
): Promise<unknown> {
    const res = await fetch(`${t.baseUrl}${path}`, {
        method: "POST",
        headers: { ...t.headers, ...extraHeaders },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const text = cleanSecrets((await res.text().catch(() => "")).slice(0, 200), t.secrets);
        throw new ProviderCallError(`HTTP ${res.status}${text ? `: ${text}` : ""}`, res.status);
    }
    return res.json();
}
