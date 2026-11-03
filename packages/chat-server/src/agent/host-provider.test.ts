/**
 * The provider the host itself calls with a user's stored key (the screen watch).
 *
 * Failure modes:
 *  H1. A provider that is off, or has no key, is used.
 *  H2. A provider that is not OpenRouter (another vendor's key) is sent the screen.
 *  H3. The stored key is returned sealed or masked, so the call fails with a key that is not the user's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTempDb } from "../../test/db.ts";
import { OPERATOR_ID } from "../paths.ts";
import { deleteValue, setValue } from "../settings/store.ts";
import { openRouterProvider } from "./host-provider.ts";

let db: ReturnType<typeof useTempDb>;
beforeAll(() => {
    db = useTempDb();
});
afterAll(() => db.close());

const key = `users.${OPERATOR_ID}.agent.providers`;
const provider = (over: Record<string, unknown>) => ({ enabled: true, api: "openai-completions", models: [], ...over });

beforeEach(() => {
    deleteValue(key);
});

describe("openRouterProvider", () => {
    it("H3: is the provider named openrouter, with its address and the real key", () => {
        setValue(key, { openrouter: provider({ apiKey: "sk-or-real-1" }) }, OPERATOR_ID);
        expect(openRouterProvider(OPERATOR_ID)).toEqual({ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-real-1" });
    });

    it("uses the address Settings holds, without a trailing slash", () => {
        setValue(key, { openrouter: provider({ apiKey: "k", baseUrl: "http://127.0.0.1:4520/api/v1/" }) }, OPERATOR_ID);
        expect(openRouterProvider(OPERATOR_ID)?.baseUrl).toBe("http://127.0.0.1:4520/api/v1");
    });

    it("finds an OpenRouter entry the user gave another name, by its address", () => {
        setValue(key, { mine: provider({ apiKey: "k2", baseUrl: "https://openrouter.ai/api/v1" }) }, OPERATOR_ID);
        expect(openRouterProvider(OPERATOR_ID)?.id).toBe("mine");
    });

    it("H1: none when the provider is off or has no key, or there are none", () => {
        expect(openRouterProvider(OPERATOR_ID)).toBeUndefined();
        setValue(key, { openrouter: provider({ enabled: false, apiKey: "k" }) }, OPERATOR_ID);
        expect(openRouterProvider(OPERATOR_ID)).toBeUndefined();
        setValue(key, { openrouter: provider({}) }, OPERATOR_ID);
        expect(openRouterProvider(OPERATOR_ID)).toBeUndefined();
    });

    it("H2: another vendor's key is never taken for it", () => {
        setValue(
            key,
            {
                anthropic: provider({ apiKey: "sk-ant-1", api: "anthropic-messages" }),
                acme: provider({ apiKey: "k", baseUrl: "https://llm.acme.example/v1" }),
                lookalike: provider({ apiKey: "k", baseUrl: "https://openrouter.ai.evil.example/v1" }),
            },
            OPERATOR_ID,
        );
        expect(openRouterProvider(OPERATOR_ID)).toBeUndefined();
    });

    it("prefers the one called openrouter when there are two", () => {
        setValue(key, { aaa: provider({ apiKey: "k1", baseUrl: "https://openrouter.ai/api/v1" }), openrouter: provider({ apiKey: "k2" }) }, OPERATOR_ID);
        expect(openRouterProvider(OPERATOR_ID)?.apiKey).toBe("k2");
    });
});
