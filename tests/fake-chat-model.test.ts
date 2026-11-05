/**
 * The chat model stand-in the watch's end-to-end runs use: it must tell the two steps apart, script each on its own, and record what the
 * host sent. A stand-in that answers wrongly would make the e2e prove nothing.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startFakeChatModel, type FakeChatModel } from "../tools/fake-chat-model/server";

let fake: FakeChatModel;
before(async () => {
    fake = await startFakeChatModel();
});
after(async () => {
    await fake.close();
});

const READ = "You are the reading step of a notification filter. Write down everything.";
const JUDGE = "You are the judging step of a notification filter. Decide.";

async function ask(system: string, user: string, json = true): Promise<{ status: number; text: string }> {
    const res = await fetch(`${fake.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer k" },
        body: JSON.stringify({ model: "small", messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 400, ...(json ? { response_format: { type: "json_object" } } : {}) }),
    });
    const body = (await res.json()) as { choices?: { message: { content: string } }[] };
    return { status: res.status, text: body.choices?.[0]?.message.content ?? "" };
}

describe("the fake chat model", () => {
    it("tells the steps apart, records what was sent, and by default echoes the text as facts and a verdict that notifies", async () => {
        fake.reset();
        const read = await ask(READ, "Text:\nAnna Berg\nLunch?");
        assert.deepEqual(JSON.parse(read.text).text, "Anna Berg / Lunch?");
        const judge = await ask(JUDGE, "Facts: {}");
        assert.equal(JSON.parse(judge.text).notify, true);
        assert.deepEqual(fake.requests.map((request) => [request.step, request.json, request.maxTokens, request.hasImage, request.model]), [["read", true, 400, false, "small"], ["judge", true, 400, false, "small"]]);
        assert.equal((await ask("something else", "x", false)).text.startsWith("A sentence about"), true);
        assert.equal(fake.requests.at(-1)!.json, false);
    });

    it("scripts each step on its own: answers in order (the last repeats), a delay, and failures", async () => {
        fake.reset();
        fake.script({ read: { answers: ["R1", "R2"] }, judge: { answers: ["J1"], delayMs: 60 } });
        assert.equal((await ask(READ, "a")).text, "R1");
        assert.equal((await ask(READ, "a")).text, "R2");
        assert.equal((await ask(READ, "a")).text, "R2");
        const began = Date.now();
        assert.equal((await ask(JUDGE, "a")).text, "J1");
        assert.ok(Date.now() - began >= 55, "the judge's delay");
        fake.script({ judge: { failFirst: { status: 503, count: 1 } } });
        assert.equal((await ask(JUDGE, "a")).status, 503);
        assert.equal((await ask(JUDGE, "a")).status, 200);
        assert.equal((await ask(READ, "a")).status, 200, "the other step is not failed");
    });

    it("a shared script is the default for both steps and a step's own key wins; a hung step never answers", async () => {
        fake.reset();
        fake.script({ answers: ["same"], delayMs: 0, judge: { answers: ["mine"] } });
        assert.equal((await ask(READ, "a")).text, "same");
        assert.equal((await ask(JUDGE, "a")).text, "mine");
        fake.script({ judge: { hang: true } });
        const outcome = await Promise.race([ask(JUDGE, "a").then(() => "answered"), new Promise((done) => setTimeout(() => done("hung"), 150))]);
        assert.equal(outcome, "hung");
        assert.equal(fake.requests.at(-1)!.answered, 0);
    });
});
