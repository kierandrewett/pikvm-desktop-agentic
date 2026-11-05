/**
 * The two OpenRouter calls, against a fake fetch.
 *
 * Failure modes, before behaviour:
 *  M1. Jev is called through the chat route, or as the router model (typesafe/jev-router), or at the wrong address.
 *  M2. A decision Jev did not really make (no answer, a wrong type, a number out of range) is read as a yes or a no.
 *  M3. An answer between the decisive bounds is acted on.
 *  M4. A 429 or 5xx is not retried, a 401 is retried, or the retries have no end.
 *  M5. The same request costs twice (no cache by request hash).
 *  M6. The key shows up in an error, or the image goes out as anything but a data URL the model can read.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModelClient, decisionRequest, decisionsUrl, ModelError, verdictOf, ALERT_PROMPT, DESCRIBE_PROMPT, NO_NOTIFICATION_TEXT } from "../src/server/watch/models";
import { JEV_MODEL } from "../src/server/watch/limits";
import { PROVIDER } from "./support/watch-rig";

interface Call {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
}

function scripted(replies: (Response | Error)[]): { fetch: typeof fetch; calls: Call[]; waits: number[]; sleep: (ms: number) => Promise<void> } {
    const calls: Call[] = [];
    const waits: number[] = [];
    let i = 0;
    return {
        calls,
        waits,
        sleep: async (ms) => void waits.push(ms),
        fetch: (async (url: string, init: RequestInit) => {
            calls.push({ url, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(String(init.body)) });
            const reply = replies[Math.min(i++, replies.length - 1)]!;
            if (reply instanceof Error) throw reply;
            return reply.clone();
        }) as typeof fetch,
    };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const status = (code: number, headers: Record<string, string> = {}) => new Response("busy", { status: code, headers });
const jev = (noul: number, type = "noul") => ok({ answers: { notify: { type, noul } }, usage: { cost: 0.00002 } });

describe("Jev", () => {
    it("M1: asks the decisions endpoint with the real model, a noul question and the state it was given", async () => {
        const net = scripted([jev(0.93)]);
        const client = createModelClient({ fetch: net.fetch, sleep: net.sleep });
        const decided = await client.decide(PROVIDER, { previous: "A shell prompt.", current: "A dialog says Install complete.", rule: "tell me when the install finishes" });
        assert.equal(net.calls.length, 1);
        assert.equal(net.calls[0]!.url, "https://openrouter.test/api/alpha/decisions");
        assert.equal(net.calls[0]!.body["model"], JEV_MODEL);
        assert.equal(JEV_MODEL, "typesafe/jev-1.14");
        assert.deepEqual(net.calls[0]!.body["state"], {
            previous: "A shell prompt.",
            current: "A dialog says Install complete.",
            rule: "tell me when the install finishes",
        });
        const questions = net.calls[0]!.body["questions"] as Record<string, { type: string; instructions: string }>;
        assert.equal(questions["notify"]!.type, "noul");
        assert.match(questions["notify"]!.instructions, /rule/);
        assert.equal(net.calls[0]!.headers["authorization"], `Bearer ${PROVIDER.apiKey}`);
        assert.deepEqual(decided, { noul: 0.93, verdict: "yes", costUsd: 0.00002, cached: false });
    });

    it("an empty rule asks the general question and says (none)", () => {
        const request = decisionRequest({ previous: "a", current: "b", rule: "  " });
        assert.equal((request["state"] as { rule: string }).rule, "(none)");
        const general = decisionRequest({ previous: "a", current: "b", rule: "" });
        const ruled = decisionRequest({ previous: "a", current: "b", rule: "x" });
        assert.notEqual(JSON.stringify(general["questions"]), JSON.stringify(ruled["questions"]));
    });

    it("the decisions address is the same host without /v1, whatever the provider's base", () => {
        assert.equal(decisionsUrl("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/alpha/decisions");
        assert.equal(decisionsUrl("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/alpha/decisions");
        assert.equal(decisionsUrl("http://127.0.0.1:4520/api/v1"), "http://127.0.0.1:4520/api/alpha/decisions");
    });

    it("M2: an answer that is missing, of another type, or out of range is an error, not a verdict", async () => {
        for (const reply of [ok({}), ok({ answers: {} }), jev(0.9, "choice"), jev(1.4), jev(-0.1), ok({ answers: { notify: { type: "noul", noul: "yes" } } }), new Response("<html>", { status: 200 })]) {
            const client = createModelClient({ fetch: scripted([reply]).fetch, sleep: async () => undefined });
            await assert.rejects(client.decide(PROVIDER, { previous: "a", current: "b", rule: "" }), (error: unknown) => error instanceof ModelError && error.kind === "shape");
        }
    });

    it("M3: only a decisive answer is a yes or a no", () => {
        assert.equal(verdictOf(0.85), "yes");
        assert.equal(verdictOf(0.99), "yes");
        assert.equal(verdictOf(0.849), "undecided");
        assert.equal(verdictOf(0.5), "undecided");
        assert.equal(verdictOf(0.151), "undecided");
        assert.equal(verdictOf(0.15), "no");
        assert.equal(verdictOf(0), "no");
    });

    it("M5: the same request is answered from the cache the second time, a different one is not", async () => {
        const net = scripted([jev(0.9)]);
        const client = createModelClient({ fetch: net.fetch, sleep: net.sleep });
        const input = { previous: "a", current: "b", rule: "r" };
        assert.equal((await client.decide(PROVIDER, input)).cached, false);
        assert.equal((await client.decide(PROVIDER, input)).cached, true);
        assert.equal(net.calls.length, 1);
        await client.decide(PROVIDER, { ...input, rule: "other" });
        assert.equal(net.calls.length, 2);
    });
});

describe("retries", () => {
    it("M4: a 429 then a 500 then success is three calls, waiting longer each time, and it succeeds", async () => {
        const net = scripted([status(429), status(500), jev(0.1)]);
        const client = createModelClient({ fetch: net.fetch, sleep: net.sleep });
        const decided = await client.decide(PROVIDER, { previous: "a", current: "b", rule: "" });
        assert.equal(decided.verdict, "no");
        assert.equal(net.calls.length, 3);
        assert.equal(net.waits.length, 2);
        assert.ok(net.waits[1]! > net.waits[0]!);
    });

    it("honours Retry-After, capped", async () => {
        const net = scripted([status(429, { "retry-after": "2" }), status(429, { "retry-after": "600" }), jev(0.1)]);
        const client = createModelClient({ fetch: net.fetch, sleep: net.sleep });
        await client.decide(PROVIDER, { previous: "a", current: "b", rule: "" });
        assert.deepEqual(net.waits, [2000, 10_000]);
    });

    it("gives up after its attempts and says what the last answer was", async () => {
        const net = scripted([status(503)]);
        const client = createModelClient({ fetch: net.fetch, sleep: net.sleep, attempts: 3 });
        await assert.rejects(client.decide(PROVIDER, { previous: "a", current: "b", rule: "" }), /answered 503/);
        assert.equal(net.calls.length, 3);
    });

    it("retries a network failure, and a 401 is not retried and tells the person to check the key, without the key", async () => {
        const flaky = scripted([new Error("socket hang up"), jev(0.1)]);
        await createModelClient({ fetch: flaky.fetch, sleep: flaky.sleep }).decide(PROVIDER, { previous: "a", current: "b", rule: "" });
        assert.equal(flaky.calls.length, 2);

        const refused = scripted([status(401)]);
        await assert.rejects(
            createModelClient({ fetch: refused.fetch, sleep: refused.sleep }).decide(PROVIDER, { previous: "a", current: "b", rule: "" }),
            (error: unknown) => {
                assert.ok(error instanceof ModelError && error.kind === "auth" && error.status === 401);
                assert.ok(!error.message.includes(PROVIDER.apiKey));
                assert.match(error.message, /Settings, Providers/);
                return true;
            },
        );
        assert.equal(refused.calls.length, 1);
    });

    it("M6: a service that echoes the key back in its error does not put it in ours", async () => {
        const net = scripted([new Response(`invalid request for key ${PROVIDER.apiKey}`, { status: 400 })]);
        const client = createModelClient({ fetch: net.fetch, sleep: net.sleep });
        await assert.rejects(client.decide(PROVIDER, { previous: "a", current: "b", rule: "" }), (error: unknown) => {
            assert.ok(error instanceof ModelError);
            assert.ok(!error.message.includes(PROVIDER.apiKey));
            assert.match(error.message, /\[key\]/);
            return true;
        });
        assert.equal(net.calls.length, 1, "a 400 is not retried");
    });
});

describe("the image model", () => {
    const completion = (text: unknown, cost = 0.0001) => ok({ choices: [{ message: { content: text } }], usage: { cost } });

    it("sends the frame as a data URL with a short factual prompt, to chat completions, and reads the text", async () => {
        const net = scripted([completion("  A terminal\nshowing   Install complete.  ")]);
        const client = createModelClient({ fetch: net.fetch, sleep: net.sleep });
        const jpeg = Buffer.from("not really a jpeg");
        const described = await client.describe(PROVIDER, "google/gemma-3-12b-it", jpeg);
        assert.equal(net.calls[0]!.url, "https://openrouter.test/api/v1/chat/completions");
        assert.equal(net.calls[0]!.body["model"], "google/gemma-3-12b-it");
        const messages = net.calls[0]!.body["messages"] as { role: string; content: unknown }[];
        assert.equal(messages[0]!.content, DESCRIBE_PROMPT);
        const parts = messages[1]!.content as { type: string; image_url?: { url: string } }[];
        assert.equal(parts[0]!.image_url!.url, `data:image/jpeg;base64,${jpeg.toString("base64")}`);
        assert.deepEqual(described, { text: "A terminal showing Install complete.", costUsd: 0.0001, cached: false });
    });

    it("the prompt asks for the dialog, error or status text first: the notification is made from the start of the answer", () => {
        assert.match(DESCRIBE_PROMPT, /Lead with the most important thing on the screen: a dialog, popup, error message/);
        assert.match(DESCRIBE_PROMPT, /at most three sentences/);
    });

    it("reads a reply given as parts, and refuses an empty one", async () => {
        const parts = scripted([completion([{ type: "text", text: "A desktop." }, { type: "text", text: " Clean." }])]);
        assert.equal((await createModelClient({ fetch: parts.fetch, sleep: parts.sleep }).describe(PROVIDER, "m", Buffer.from("a"))).text, "A desktop. Clean.");
        const empty = scripted([completion("   ")]);
        await assert.rejects(createModelClient({ fetch: empty.fetch, sleep: empty.sleep }).describe(PROVIDER, "m", Buffer.from("b")), /gave no description/);
    });

    it("M5: the same frame for the same model is not described twice", async () => {
        const net = scripted([completion("A desktop.")]);
        const client = createModelClient({ fetch: net.fetch, sleep: net.sleep });
        await client.describe(PROVIDER, "m", Buffer.from("frame"));
        assert.equal((await client.describe(PROVIDER, "m", Buffer.from("frame"))).cached, true);
        await client.describe(PROVIDER, "other", Buffer.from("frame"));
        assert.equal(net.calls.length, 2);
    });
});

describe("the image model, reading a corner for fast alerts", () => {
    const completion = (text: string) => ok({ choices: [{ message: { content: text } }], usage: { cost: 0.00003 } });

    it("M7: sends the crop with the alert prompt, which asks for the app, who it is from, the first line, and says it may be a call", async () => {
        const net = scripted([completion(" Microsoft Teams:  Ben Carter says hello. ")]);
        const client = createModelClient({ fetch: net.fetch, sleep: net.sleep });
        const crop = Buffer.from("a crop");
        const described = await client.describeAlert(PROVIDER, "google/gemma-3-12b-it", crop);
        assert.deepEqual(described, { text: "Microsoft Teams: Ben Carter says hello.", costUsd: 0.00003, cached: false });
        const messages = net.calls[0]!.body["messages"] as { role: string; content: unknown }[];
        assert.equal(messages[0]!.content, ALERT_PROMPT);
        const parts = messages[1]!.content as { type: string; image_url?: { url: string } }[];
        assert.equal(parts[0]!.image_url!.url, `data:image/jpeg;base64,${crop.toString("base64")}`);
        assert.match(ALERT_PROMPT, /which application it is from/);
        assert.match(ALERT_PROMPT, /who sent it or is calling/);
        assert.match(ALERT_PROMPT, /first line of the message/);
        assert.match(ALERT_PROMPT, /incoming call/i);
        assert.match(ALERT_PROMPT, /Accept and Decline/);
        assert.match(ALERT_PROMPT, new RegExp(`reply exactly: ${NO_NOTIFICATION_TEXT}`));
    });

    it("M7: the same crop is not read twice, and a crop is not mistaken for a whole-screen description of the same bytes", async () => {
        const net = scripted([completion("A.")]);
        const client = createModelClient({ fetch: net.fetch, sleep: net.sleep });
        await client.describeAlert(PROVIDER, "m", Buffer.from("x"));
        assert.equal((await client.describeAlert(PROVIDER, "m", Buffer.from("x"))).cached, true);
        assert.equal((await client.describe(PROVIDER, "m", Buffer.from("x"))).cached, false);
        assert.equal(net.calls.length, 2);
    });
});
