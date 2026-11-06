import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATOR_ID } from "../src/paths.ts";
import { setValue } from "../src/settings/store.ts";
import { decide, decisionModels, hasDecisionModel } from "../src/models/decisions.ts";
import { useTempDb } from "./db.ts";

/**
 * End to end against the real OpenRouter, with the user's own key (skipped without GNOBLIN_OPENROUTER_API_KEY).
 * Failure modes this walks through the real services:
 *  1. the picker never lists a decisions model (the list call is wrong or needs a different host);
 *  2. a decisions model is sent to the chat API, which answers 400 "is a decisions model";
 *  3. the key or the host is wrong (the chat gateway only reaches `/api/v1`, the decisions endpoint is `/api/alpha`);
 *  4. a plainly routine pop-up comes back as a yes, or an urgent one as a no.
 * Each run appends what it saw to $PK_E2E_LOG (default ~/.cache/pk-e2e/decisions.log) for docs/e2e/2026-11-06-decisions-model.md.
 */
const key = process.env.GNOBLIN_OPENROUTER_API_KEY;
const log = (value: unknown) => appendFileSync(process.env.PK_E2E_LOG ?? `${process.env.HOME}/.cache/pk-e2e/decisions.log`, `${JSON.stringify(value)}\n`);
const QUESTION =
    "popup is the text of a pop-up that appeared on a computer whose owner is away. Answer yes if the owner needs to know now or within minutes: someone is calling, a real person waits for a reply, an error or outage, a sign-in code. Answer no for marketing, routine status and chatter.";

let db: ReturnType<typeof useTempDb>;
beforeAll(() => {
    db = useTempDb();
});
afterAll(() => db.close());

describe.skipIf(!key)("the Decisions model on the real OpenRouter", () => {
    it("lists decisions models, and Jev answers a routine pop-up no and an urgent one yes", async () => {
        setValue("agent.providers", { openrouter: { enabled: true, apiKey: key, models: [] } }, "e2e");
        setValue("agent.modelRoles.decisions", "openrouter/typesafe/jev-1.14", "e2e");
        const listed = await decisionModels(OPERATOR_ID);
        log({ listed: listed.models.length, jev: listed.models.some((m) => m.id === "openrouter/typesafe/jev-1.14"), errors: listed.errors });
        expect(listed.errors).toEqual([]);
        expect(listed.models.some((m) => m.id === "openrouter/typesafe/jev-1.14")).toBe(true);
        expect(hasDecisionModel(OPERATOR_ID)).toBe(true);
        const routine = await decide(OPERATOR_ID, { state: { popup: "Dependabot: 3 updates available\nView on GitHub" }, instructions: QUESTION, timeoutMs: 8000 });
        const urgent = await decide(OPERATOR_ID, { state: { popup: "Priya Shah: the build is failing and prod is down, call me now" }, instructions: QUESTION, timeoutMs: 8000 });
        log({ routine, urgent });
        expect(routine?.backend).toBe("decisions");
        expect(routine!.probability).toBeLessThanOrEqual(0.15);
        expect(urgent!.probability).toBeGreaterThanOrEqual(0.85);
    });
});
