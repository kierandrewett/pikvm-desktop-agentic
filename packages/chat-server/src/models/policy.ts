/**
 * Which models may be used. A provider entry can turn single models off (`disabledModels`); `isModelAllowed` guards
 * `response.create` and the gateway, and the model list drops them too.
 */
import type { Provider } from "@pikvm/chat-protocol";
import { resolveSetting } from "../settings/store.ts";

/** Models turned off on the effective provider entries, as a predicate on `provider/model`. */
export function modelSwitch(userId: string): (model: string) => boolean {
    const providers = resolveSetting("agent.providers", userId).value as Record<string, Provider>;
    return (model) => {
        const slash = model.indexOf("/");
        if (slash < 0) return true;
        const off = providers[model.slice(0, slash)]?.disabledModels;
        return !off?.includes(model.slice(slash + 1));
    };
}

export function isModelAllowed(userId: string, model: string): boolean {
    return modelSwitch(userId)(model);
}
