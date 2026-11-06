/**
 * End to end with the real omp binary: signing in to a model subscription from Settings (agent/login.ts).
 * Failure modes: an unknown provider is run; the sign-in address is never returned; another user's login can be read or answered;
 * a wrong paste hangs instead of failing with a reason; a cancelled login leaves the runtime running; a credential shows up in a reply.
 * A real sign-in needs a real account and a browser, so the last step (a valid paste) is not covered here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixture, type Fixture } from "./host.ts";

let f: Fixture;
beforeAll(async () => {
    f = await startFixture();
});
afterAll(async () => f.close());

const post = (path: string, json: unknown) => f.api(path, { method: "POST", json });

describe("subscription sign-in", () => {
    it("lists the sign-ins the server remembers: none before any finished, and a failed one is not remembered", async () => {
        const list = async () => ((await (await f.api("/logins")).json()) as { signedIn: unknown[] }).signedIn;
        expect(await list()).toEqual([]);
        const login = (await (await post("/logins", { provider: "anthropic" })).json()) as { id: string };
        await post(`/logins/${login.id}/code`, { input: "not a code" });
        await new Promise((r) => setTimeout(r, 1500));
        expect(await list()).toEqual([]);
    });

    it("refuses a provider that is not a subscription", async () => {
        expect((await post("/logins", { provider: "bash" })).status).toBe(400);
    });

    it.each([
        ["anthropic", "https://claude.ai/oauth/authorize"],
        ["openai-codex", "https://auth.openai.com/oauth/authorize"],
    ])("%s: returns the sign-in address and waits, and a wrong paste fails with a reason", async (provider, prefix) => {
        const started = await post("/logins", { provider });
        expect(started.status).toBe(200);
        const login = (await started.json()) as { id: string; url: string; state: string };
        expect(login.url.startsWith(prefix)).toBe(true);
        expect(login.state).toBe("waiting");
        const status = (await (await f.api(`/logins/${login.id}`)).json()) as { state: string };
        expect(status.state).toBe("waiting");
        expect((await post(`/logins/${login.id}/code`, { input: "not a code" })).status).toBe(200);
        let end = status;
        for (let i = 0; i < 40 && end.state === "waiting"; i++) {
            await new Promise((r) => setTimeout(r, 250));
            end = (await (await f.api(`/logins/${login.id}`)).json()) as { state: string };
        }
        expect(end.state).toBe("failed");
        expect(JSON.stringify(end)).not.toMatch(/sk-|Bearer|access_token/);
    });

    it("cancel ends a waiting login, and an unknown id is 404", async () => {
        const login = (await (await post("/logins", { provider: "anthropic" })).json()) as { id: string };
        expect(((await (await f.api(`/logins/${login.id}`, { method: "DELETE" })).json()) as { ok: boolean }).ok).toBe(true);
        expect((await f.api(`/logins/${login.id}`)).status).toBe(404);
        expect((await f.api("/logins/does-not-exist")).status).toBe(404);
    });
});
