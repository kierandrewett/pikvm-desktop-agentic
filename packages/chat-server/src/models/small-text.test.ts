import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useTempDb } from "../../test/db.ts";
import { OPERATOR_ID } from "../paths.ts";
import { deleteValue, setValue } from "../settings/store.ts";
import { hasSmallModel, smallText } from "./small-text.ts";

/**
 * The one small text request the host's own features make on the user's chat model: it takes the chat's path (the Small tasks role, else
 * the default model, the provider's endpoint and stored credential, the provider's API family) and names no provider of its own.
 */
let db: ReturnType<typeof useTempDb>;
beforeAll(() => {
    db = useTempDb();
});
afterAll(() => db.close());
afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ["agent.providers", "agent.defaultModel", "agent.modelRoles.tiny"]) deleteValue(key);
});

const provider = (over: Record<string, unknown> = {}) => ({ mine: { enabled: true, baseUrl: "https://llm.example.test/v1", api: "openai-completions", apiKey: "sk-test-secret-key", models: [], ...over } });

describe("smallText", () => {
    it("with no model configured there is nothing to ask: undefined, and no request", async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        expect(hasSmallModel(OPERATOR_ID)).toBe(false);
        expect(await smallText(OPERATOR_ID, "system", "user", { timeoutMs: 1000 })).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("a model on a provider without a key or an endpoint counts as none", () => {
        setValue("agent.providers", provider({ baseUrl: undefined, api: undefined }), "test");
        setValue("agent.defaultModel", "mine/small", "test");
        expect(hasSmallModel(OPERATOR_ID)).toBe(false);
    });

    it("uses the default model on its provider's endpoint, with the stored key, the system and the user text and nothing else", async () => {
        setValue("agent.providers", provider(), "test");
        setValue("agent.defaultModel", "mine/small", "test");
        const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
        vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
            calls.push({ url, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(String(init.body)) });
            return new Response(JSON.stringify({ choices: [{ message: { content: "One sentence." } }] }), { status: 200, headers: { "content-type": "application/json" } });
        });
        expect(hasSmallModel(OPERATOR_ID)).toBe(true);
        expect(await smallText(OPERATOR_ID, "Write one sentence.", "Ana Silva | Lunch", { timeoutMs: 2500 })).toBe("One sentence.");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.body.model).toBe("small");
        expect(calls[0]!.body.messages).toEqual([
            { role: "system", content: "Write one sentence." },
            { role: "user", content: "Ana Silva | Lunch" },
        ]);
        expect(JSON.stringify(calls[0]!.body)).not.toMatch(/image/);
    });

    it("the Small tasks role wins over the default model", async () => {
        setValue("agent.providers", provider(), "test");
        setValue("agent.defaultModel", "mine/big", "test");
        setValue("agent.modelRoles.tiny", "mine/tiny", "test");
        const models: string[] = [];
        vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
            models.push(JSON.parse(String(init.body)).model);
            return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), { status: 200 });
        });
        await smallText(OPERATOR_ID, "s", "u", { timeoutMs: 1000 });
        expect(models).toEqual(["tiny"]);
    });

    it("a failing provider rejects, with the key not in the message", async () => {
        setValue("agent.providers", provider(), "test");
        setValue("agent.defaultModel", "mine/small", "test");
        vi.stubGlobal("fetch", async () => new Response("bad key sk-test-secret-key", { status: 401 }));
        await expect(smallText(OPERATOR_ID, "s", "u", { timeoutMs: 1000 })).rejects.toThrow(/HTTP 401/);
        await expect(smallText(OPERATOR_ID, "s", "u", { timeoutMs: 1000 })).rejects.not.toThrow(/sk-test-secret-key/);
    });

    describe("json", () => {
        const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });

        it("asks the endpoint for JSON mode and passes the token limit; without it the request has no response_format", async () => {
            setValue("agent.providers", provider(), "test");
            setValue("agent.defaultModel", "mine/small", "test");
            const bodies: Record<string, unknown>[] = [];
            vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
                bodies.push(JSON.parse(String(init.body)));
                return reply("{}");
            });
            await smallText(OPERATOR_ID, "s", "u", { json: true, maxTokens: 400, timeoutMs: 1000 });
            await smallText(OPERATOR_ID, "s", "u", { timeoutMs: 1000 });
            expect(bodies[0]!.response_format).toEqual({ type: "json_object" });
            expect(bodies[0]!.max_tokens).toBe(400);
            expect(bodies[1]!.response_format).toBeUndefined();
            expect(bodies[1]!.max_tokens).toBe(80);
        });

        it("an endpoint that does not know JSON mode (400 or 422) is asked once more without it; any other failure is not retried", async () => {
            setValue("agent.providers", provider(), "test");
            setValue("agent.defaultModel", "mine/small", "test");
            const seen: boolean[] = [];
            let status = 400;
            vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
                const withFormat = "response_format" in JSON.parse(String(init.body));
                seen.push(withFormat);
                return withFormat ? new Response("unknown field response_format", { status }) : reply('{"ok":true}');
            });
            expect(await smallText(OPERATOR_ID, "s", "u", { json: true, timeoutMs: 1000 })).toBe('{"ok":true}');
            expect(seen).toEqual([true, false]);
            status = 422;
            seen.length = 0;
            expect(await smallText(OPERATOR_ID, "s", "u", { json: true, timeoutMs: 1000 })).toBe('{"ok":true}');
            expect(seen).toEqual([true, false]);
            status = 500;
            seen.length = 0;
            await expect(smallText(OPERATOR_ID, "s", "u", { json: true, timeoutMs: 1000 })).rejects.toThrow(/HTTP 500/);
            expect(seen).toEqual([true]);
        });
    });
});
