/**
 * The model client over real HTTP against tools/fake-openrouter: what goes on the wire is what the fake (written from
 * OpenRouter's documented shapes, not from the client) accepts, including through retries.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createModelClient } from "../src/server/watch/models";
import { startFakeOpenRouter, type FakeOpenRouter } from "../tools/fake-openrouter/server";

let fake: FakeOpenRouter;
before(async () => {
    fake = await startFakeOpenRouter();
});
after(() => fake.close());

const provider = () => ({ baseUrl: fake.url, apiKey: "sk-test-key-not-real" });

describe("the client against a server that did not read it", () => {
    it("describes a frame: the image arrives byte for byte, with the key, and the answer is read back", async () => {
        fake.reset();
        fake.script({ describe: ["A terminal says Install complete."] });
        const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 5, 0xff, 0xd9]);
        const described = await createModelClient().describe(provider(), "google/gemma-3-12b-it", jpeg);
        assert.equal(described.text, "A terminal says Install complete.");
        assert.ok((described.costUsd ?? 0) > 0);
        const [call] = fake.calls;
        assert.equal(call!.kind, "describe");
        assert.equal(call!.model, "google/gemma-3-12b-it");
        assert.equal(call!.authorization, `Bearer ${provider().apiKey}`);
        assert.equal(call!.image!.sha256, createHash("sha256").update(jpeg).digest("hex"));
        assert.equal(call!.image!.mime, "image/jpeg");
        assert.match(call!.system!, /plain text/);
    });

    it("asks Jev at /api/alpha/decisions and reads the probability", async () => {
        fake.reset();
        fake.script({ noul: [0.97] });
        const decided = await createModelClient().decide(provider(), { previous: "A prompt.", current: "A dialog says Done.", rule: "tell me when it is done" });
        assert.equal(decided.verdict, "yes");
        assert.equal(decided.noul, 0.97);
        const [call] = fake.calls;
        assert.equal(call!.kind, "decide");
        assert.equal(call!.model, "typesafe/jev-1.14");
        assert.deepEqual(call!.state, { previous: "A prompt.", current: "A dialog says Done.", rule: "tell me when it is done" });
    });

    it("retries a 429 and a 500 over the wire and then succeeds", async () => {
        fake.reset();
        fake.script({ noul: [0.01], failFirst: { status: 429, count: 1 } });
        const client = createModelClient({ sleep: async () => undefined });
        const decided = await client.decide(provider(), { previous: "a", current: "b", rule: "" });
        assert.equal(decided.verdict, "no");
        assert.deepEqual(fake.calls.map((call) => call.answered), [429, 200]);

        fake.reset();
        fake.script({ describe: ["ok"], failFirst: { status: 503, count: 2 } });
        const described = await client.describe(provider(), "m", Buffer.from([0xff, 0xd8, 9]));
        assert.equal(described.text, "ok");
        assert.deepEqual(fake.calls.map((call) => call.answered), [503, 503, 200]);
    });

    it("does not retry a refused key", async () => {
        fake.reset();
        const client = createModelClient({ sleep: async () => undefined });
        await assert.rejects(client.decide({ baseUrl: fake.url, apiKey: "x" }, { previous: "a", current: "b", rule: "" }), /refused the key/);
        assert.equal(fake.calls.length, 1);
    });
});
