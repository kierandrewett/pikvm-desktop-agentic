/**
 * The model provider the HOST itself calls with a user's stored key (the screen watch's image model and decision
 * call). The agent never sees these keys: this is the one place besides the gateway that reads them back.
 */
import type { Provider } from "@pikvm/chat-protocol";
import { resolveSetting } from "../settings/store.ts";
import { resolveEndpoint } from "./providers.ts";

export interface HostProvider {
    /** The provider's id in Settings (`openrouter`, or whatever the user named it). */
    id: string;
    /** Without a trailing slash, e.g. `https://openrouter.ai/api/v1`. */
    baseUrl: string;
    apiKey: string;
}

function isOpenRouterHost(baseUrl: string | undefined): boolean {
    if (!baseUrl) return false;
    try {
        const host = new URL(baseUrl).hostname;
        return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
    } catch {
        return false;
    }
}

/**
 * The user's enabled OpenRouter provider that holds a key: the entry named `openrouter`, else any entry whose
 * address is on openrouter.ai. Undefined when there is none.
 */
export function openRouterProvider(userId: string): HostProvider | undefined {
    const providers = resolveSetting("agent.providers", userId).value as Record<string, Provider>;
    const ids = Object.keys(providers).sort((a, b) => Number(b === "openrouter") - Number(a === "openrouter"));
    for (const id of ids) {
        const provider = providers[id];
        if (!provider || provider.enabled === false || !provider.apiKey) continue;
        if (id !== "openrouter" && !isOpenRouterHost(provider.baseUrl)) continue;
        const endpoint = resolveEndpoint(id, provider);
        if (!endpoint) continue;
        return { id, baseUrl: endpoint.baseUrl, apiKey: provider.apiKey };
    }
    return undefined;
}
