/**
 * Provider endpoint knowledge shared by the config generator and the LLM gateway.
 *
 * Global (admin) providers never reach a sandbox with their real key. The agent sees them at
 * `<gateway>/gw/<providerId>` with a per-user gateway token; the gateway checks the token and policy,
 * swaps in the real key and forwards to the real base URL.
 */
import type { Provider } from "@pikvm/chat-protocol";
import { createHmac, timingSafeEqual } from "node:crypto";
import { serverSecret } from "../auth/secret.ts";

export type Api = NonNullable<Provider["api"]>;

/** Real endpoints of built-in providers, used when a provider entry has no baseUrl. */
export const BUILTIN_PROVIDERS: Record<string, { baseUrl: string; api: Api }> = {
    anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
    openai: { baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
    google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai" },
    openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
    groq: { baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions" },
    mistral: { baseUrl: "https://api.mistral.ai/v1", api: "openai-completions" },
    xai: { baseUrl: "https://api.x.ai/v1", api: "openai-completions" },
    deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions" },
    together: { baseUrl: "https://api.together.xyz/v1", api: "openai-completions" },
    fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", api: "openai-completions" },
    cerebras: { baseUrl: "https://api.cerebras.ai/v1", api: "openai-completions" },
    moonshot: { baseUrl: "https://api.moonshot.ai/v1", api: "openai-completions" },
};

export function resolveEndpoint(id: string, p: Provider): { baseUrl: string; api: Api } | undefined {
    const builtin = BUILTIN_PROVIDERS[id];
    const baseUrl = p.baseUrl ?? builtin?.baseUrl;
    const api = p.api ?? builtin?.api;
    return baseUrl && api ? { baseUrl: baseUrl.replace(/\/+$/, ""), api } : undefined;
}

/** Header the upstream expects the key in, per API family. */
export function authHeaderFor(api: Api, key: string): Record<string, string> {
    switch (api) {
        case "anthropic-messages":
            return { "x-api-key": key };
        case "google-generative-ai":
        case "google-vertex":
            return { "x-goog-api-key": key };
        default:
            return { authorization: `Bearer ${key}` };
    }
}

/** Extract a key the agent sent, whichever header its SDK used. */
export function keyFromRequest(headers: Headers): string | undefined {
    const bearer = headers.get("authorization");
    if (bearer?.toLowerCase().startsWith("bearer ")) return bearer.slice(7).trim();
    return headers.get("x-api-key") ?? headers.get("x-goog-api-key") ?? undefined;
}

// Gateway tokens: `gw.<userId>.<hmac>`. Stateless; rotating secret.key revokes all of them.

function mac(userId: string): string {
    return createHmac("sha256", serverSecret()).update(`gateway:${userId}`).digest("base64url");
}

export function gatewayToken(userId: string): string {
    return `gw.${userId}.${mac(userId)}`;
}

export function verifyGatewayToken(token: string | undefined): string | undefined {
    if (!token?.startsWith("gw.")) return undefined;
    const [, userId, sig] = token.split(".");
    if (!userId || !sig) return undefined;
    const want = Buffer.from(mac(userId));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got) ? userId : undefined;
}
