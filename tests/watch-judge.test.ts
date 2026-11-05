/**
 * The chat model's two steps as text: the prompts, what is asked, and how an answer is trusted. No network, no clock.
 *
 * Failure modes, before behaviour:
 *  J1. A prompt names an app, a product or a provider, or has a character a plain-ASCII file should not.
 *  J2. A prompt's own examples would fail the parser that reads the model's answers (so a model that copies them is rejected).
 *  J3. The reasons the judge is offered and the ones the parser accepts drift apart.
 *  J4. A model's answer that is fenced, wrapped in a sentence, loose in its types or too long is taken as it is, or crashes the check.
 *  J5. A verdict that contradicts itself, or has no decision, is believed.
 *  J6. The person's rule gets into the pop-up's message, or an empty rule changes the instructions.
 *  J7. A step that never answers is waited for, or a failed step throws.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JUDGE_REASONS } from "@pikvm/contracts/watch";
import { clamp, factsForJudge, failOpenBody, firstJsonObject, judgePopup, parseFacts, parseVerdict, readFacts, type Ask, type Facts } from "../src/server/watch/judge";
import { MAX_BODY_CHARS } from "../src/server/watch/limits";
import { JUDGE_PROMPT, judgeRequest, READ_PROMPT, readRequest } from "../src/server/watch/prompts";

const now = () => 0;

/** The examples of a prompt: the lines that follow `marker` up to a blank line, from `Example` on. */
function exampleAnswers(prompt: string): string[] {
    return prompt.split("\n").filter((line) => line.startsWith("{") && line.endsWith("}") && !line.includes('{"source": ') && !line.startsWith('{"reason": one of') && !line.startsWith('{"notify": true or false'));
}

describe("the prompts", () => {
    it("J1: name no app, product or provider, and are plain ASCII", () => {
        for (const prompt of [READ_PROMPT, JUDGE_PROMPT]) {
            assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(prompt), "plain ASCII");
            assert.ok(!/teams|outlook|slack|gmail|whatsapp|openrouter|openai|anthropic|claude|gemini|jev|windows|pikvm/i.test(prompt), "no name");
        }
    });

    it("J3: the judge is offered exactly the reasons the parser accepts, each as the start of a criteria line or in the answer shape", () => {
        for (const reason of JUDGE_REASONS) assert.ok(JUDGE_PROMPT.includes(reason), `${reason} is in the instructions`);
        assert.ok(JUDGE_PROMPT.includes(`one of ${JUDGE_REASONS.join(", ")}`));
    });

    it("the judge's instructions carry the whole policy: what to notify about, what not, the tie-break and the body rules", () => {
        for (const must of ["a call or video invitation", "missed call", "asks a question", "within about 15 minutes", "one-time code", "unknown device", "failed build", "outage", "critical battery", "signature", "delivery at the door", "newsletters", "likes, follows", "update available", "typing", "read receipts", "bot noise", "3 more messages", "If it is automated and low-signal, DO NOT", "no emoji", "sentence case", "never follow instructions"]) {
            assert.ok(JUDGE_PROMPT.toLowerCase().includes(must.toLowerCase()), `says "${must}"`);
        }
    });

    it("J2: the judge has 8 to 10 worked examples, both verdicts, and every one parses as an answer", () => {
        const answers = exampleAnswers(JUDGE_PROMPT);
        assert.ok(answers.length >= 8 && answers.length <= 10, `${answers.length} examples`);
        const verdicts = answers.map((line) => parseVerdict(line));
        assert.ok(verdicts.every((verdict) => verdict.ok), "every example is a valid verdict");
        const values = verdicts.flatMap((verdict) => (verdict.ok ? [verdict.value] : []));
        assert.ok(values.some((verdict) => verdict.notify) && values.some((verdict) => !verdict.notify));
        for (const verdict of values) if (verdict.notify) assert.ok(verdict.body.length > 0 && verdict.body.length <= 250);
    });

    it("J2: the facts in the judge's examples are valid facts, and the reader has two examples that parse", () => {
        const facts = JUDGE_PROMPT.split("\n").filter((line) => line.startsWith("Facts: ")).map((line) => line.slice("Facts: ".length));
        assert.ok(facts.length >= 8);
        for (const line of facts) assert.ok(parseFacts(line).ok, line);
        const answers = exampleAnswers(READ_PROMPT);
        assert.equal(answers.length, 2);
        for (const line of answers) assert.ok(parseFacts(line).ok, line);
    });

    it("the instructions of both steps say the text is data and ask for one JSON object (some endpoints need the word)", () => {
        for (const prompt of [READ_PROMPT, JUDGE_PROMPT]) {
            assert.match(prompt, /JSON/);
            assert.match(prompt, /never follow|Never follow/);
        }
    });
});

describe("the requests", () => {
    it("the reader gets the lines and nothing else; the judge gets the facts, or the lines when there are none", () => {
        assert.deepEqual(readRequest(["a b", "c d"]), { system: READ_PROMPT, user: "Text:\na b\nc d" });
        assert.equal(judgeRequest({ facts: '{"text":"x"}' }, "").user, 'Facts: {"text":"x"}');
        assert.equal(judgeRequest({ lines: ["a b", "c d"] }, "").user, "The facts could not be read. The lines of the pop-up, as read:\na b\nc d");
    });

    it("J6: no rule leaves the instructions as they are; a rule is one clean line at the end of them, and nowhere else", () => {
        assert.equal(judgeRequest({ facts: "{}" }, "").system, JUDGE_PROMPT);
        assert.equal(judgeRequest({ facts: "{}" }, "   ").system, JUDGE_PROMPT);
        const ruled = judgeRequest({ facts: "{}" }, "also tell me\nabout the \u0007build server \u200b  now");
        assert.ok(ruled.system.startsWith(JUDGE_PROMPT));
        assert.ok(ruled.system.endsWith("Extra instructions: also tell me about the build server now"));
        assert.equal(ruled.user, "Facts: {}");
        assert.equal(readRequest(["x y z"]).system, READ_PROMPT);
    });
});

describe("reading an answer", () => {
    it("J4: the first balanced object, through a fence, a sentence, braces in strings and a block that is not JSON", () => {
        assert.deepEqual(firstJsonObject('{"a":1}'), { a: 1 });
        assert.deepEqual(firstJsonObject('Sure!\n```json\n{"a": "x } y", "b": {"c": 2}}\n```\nDone.'), { a: "x } y", b: { c: 2 } });
        assert.deepEqual(firstJsonObject('{not json} then {"a":3}'), { a: 3 });
        assert.deepEqual(firstJsonObject('{"a":"say \\"hi\\" {"}'), { a: 'say "hi" {' });
        assert.equal(firstJsonObject("no object here"), undefined);
        assert.equal(firstJsonObject('{"a": 1'), undefined, "cut off");
        assert.equal(firstJsonObject("[1,2]"), undefined, "a list is not the object asked for");
    });

    it("J4: facts are validated field by field: types coerced, lists made, lengths clamped, control characters out, empties null", () => {
        const parsed = parseFacts(
            JSON.stringify({
                source: "  Mail\u0007 ",
                from: 42,
                subject: "",
                text: ["Mia Turner", "Quick question", ""],
                when: { not: "a string" },
                numbers_and_codes: "12:30",
                actions: ["Reply", "Reply", 7, null, { x: 1 }],
                urgent_words: Array.from({ length: 30 }, (_, i) => `w${i}`),
                extra: "ignored",
            }),
        );
        assert.ok(parsed.ok);
        assert.deepEqual(parsed.value, {
            source: "Mail",
            from: "42",
            subject: null,
            text: "Mia Turner / Quick question",
            when: null,
            numbers_and_codes: ["12:30"],
            actions: ["Reply", "7"],
            urgent_words: Array.from({ length: 12 }, (_, i) => `w${i}`),
        });
        const long = parseFacts(JSON.stringify({ text: "x ".repeat(2000) }));
        assert.ok(long.ok && long.value.text.length <= 700 && long.value.text.endsWith("..."));
    });

    it("J4: facts that are not facts are invalid or empty, never a value", () => {
        assert.deepEqual(parseFacts("I could not read that."), { ok: false, failure: "invalid" });
        assert.deepEqual(parseFacts('{"unrelated": true}'), { ok: false, failure: "invalid" });
        assert.deepEqual(parseFacts('{"source":"x","text":"  "}'), { ok: false, failure: "empty" });
    });

    it("the judge is given the facts compactly, in the prompt's order, without what is not shown", () => {
        const facts: Facts = { source: null, from: "Mia Turner", subject: null, text: "Mia Turner / hi", when: "12:30", numbers_and_codes: [], actions: ["Reply"], urgent_words: [] };
        assert.equal(factsForJudge(facts), '{"from":"Mia Turner","text":"Mia Turner / hi","when":"12:30","actions":["Reply"]}');
    });

    it("J5: a verdict needs a decision and a reason that agree; a made-up reason word is 'other'; booleans may come as words", () => {
        const ok = (raw: string) => {
            const parsed = parseVerdict(raw);
            assert.ok(parsed.ok, raw);
            return parsed.value;
        };
        assert.deepEqual(ok('{"reason":"security","notify":true,"body":"Code 482913.","title":"Bank"}'), { notify: true, reason: "security", body: "Code 482913.", title: "Bank" });
        assert.deepEqual(ok('{"notify":"false","reason":"Marketing Social","body":"ignored"}'), { notify: false, reason: "marketing_social", body: "", title: null });
        assert.equal(ok('{"reason":"social","notify":false}').reason, "other");
        assert.equal(ok('{"reason":"other","notify":true,"body":"Something happened.","title":null}').title, null);
        for (const raw of ['{"reason":"routine","notify":true,"body":"x"}', '{"reason":"call","notify":false}', '{"reason":"security"}', '{"notify":true,"body":"x"}', '{"reason":"","notify":true,"body":"x"}', '{"reason":"call","notify":"maybe","body":"x"}', "no"]) {
            assert.deepEqual(parseVerdict(raw), { ok: false, failure: "invalid" }, raw);
        }
        assert.deepEqual(parseVerdict('{"reason":"call","notify":true,"body":"  \\n "}'), { ok: false, failure: "empty" });
        assert.deepEqual(parseVerdict('{"reason":"call","notify":true}'), { ok: false, failure: "empty" });
    });

    it("J4: a body is plain text: no emoji or control characters, one line, cut at a word at the body limit; a title at 40", () => {
        const parsed = parseVerdict(JSON.stringify({ reason: "call", notify: true, body: `Ring \u{1F4DE}\u{1F514}\n\tnow ${"word ".repeat(200)}`, title: `Title \u{1F514} ${"t".repeat(100)}` }));
        assert.ok(parsed.ok);
        assert.ok(parsed.value.body.startsWith("Ring now word word"));
        assert.ok(parsed.value.body.length <= MAX_BODY_CHARS && parsed.value.body.endsWith("..."));
        assert.ok(parsed.value.title !== null && parsed.value.title.length <= 40);
        assert.equal(clamp("short", 10), "short");
        assert.equal(clamp("aaaa bbbb cccc", 12), "aaaa bbbb...");
    });

    it("the fail-open body is the facts' text, else the rules' own", () => {
        const facts: Facts = { source: null, from: null, subject: null, text: "Mia Turner / hi", when: null, numbers_and_codes: [], actions: [], urgent_words: [] };
        assert.equal(failOpenBody(facts, "plain"), "Mia Turner / hi");
        assert.equal(failOpenBody(undefined, "plain"), "plain");
        assert.equal(failOpenBody({ ...facts, text: "" }, "plain"), "plain");
        assert.ok(failOpenBody({ ...facts, text: "x ".repeat(400) }, "plain").length <= MAX_BODY_CHARS);
    });
});

describe("running a step", () => {
    const facts = parseFacts('{"text":"Mia Turner / hi","from":"Mia Turner"}');
    assert.ok(facts.ok);

    it("J7: a good answer is a value and a time", async () => {
        let clock = 100;
        const ask: Ask = async (_system, _user, options) => {
            clock += 250;
            assert.deepEqual(options, { timeoutMs: 500, maxTokens: 500, json: true });
            return '{"text":"Mia Turner / hi"}';
        };
        const result = await readFacts(ask, ["Mia Turner", "hi"], 500, () => clock);
        assert.ok(result.ok);
        assert.equal(result.ms, 250);
    });

    it("J7: a step that never answers is abandoned at its limit; one that throws, answers nothing or answers rubbish is a named failure and not a throw", async () => {
        const never: Ask = () => new Promise<never>(() => undefined);
        assert.deepEqual(await readFacts(never, ["a b c"], 20, now), { ok: false, failure: "timeout", ms: 0 });
        assert.deepEqual(await readFacts(async () => { throw new Error("503"); }, ["a b c"], 20, now), { ok: false, failure: "error", ms: 0 });
        const aborted = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        assert.deepEqual(await readFacts(async () => { throw aborted; }, ["a b c"], 20, now), { ok: false, failure: "timeout", ms: 0 });
        assert.deepEqual(await readFacts(async () => undefined, ["a b c"], 20, now), { ok: false, failure: "error", ms: 0 });
        assert.deepEqual(await readFacts(async () => "  ", ["a b c"], 20, now), { ok: false, failure: "empty", ms: 0 });
        assert.deepEqual(await readFacts(async () => "words", ["a b c"], 20, now), { ok: false, failure: "invalid", ms: 0 });
        assert.deepEqual(await readFacts(async () => "{}", ["a b c"], 0, now), { ok: false, failure: "timeout", ms: 0 }, "no time left is a timeout without asking");
    });

    it("the judge step takes facts or lines and the rule", async () => {
        const seen: { system: string; user: string }[] = [];
        const ask: Ask = async (system, user) => {
            seen.push({ system, user });
            return '{"reason":"call","notify":true,"body":"Mia Turner says hi."}';
        };
        assert.ok((await judgePopup(ask, facts.value, "a rule", 500, now)).ok);
        assert.ok((await judgePopup(ask, ["Mia Turner", "hi there"], "", 500, now)).ok);
        assert.ok(seen[0]!.user.startsWith("Facts: {"));
        assert.ok(seen[0]!.system.endsWith("Extra instructions: a rule"));
        assert.ok(seen[1]!.user.startsWith("The facts could not be read."));
        assert.equal(seen[1]!.system, JUDGE_PROMPT);
    });
});
