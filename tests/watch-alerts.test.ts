/**
 * The watch through one user's pipeline: a pop-up in the corner of the screen, from the look that sees it to the push, read by the
 * host's own OCR and (when the user has a chat model) read and judged by it in two steps.
 *
 * Failure modes, before behaviour:
 *  F1. A pop-up waits longer than the settle time after the look that saw it.
 *  F2. A pop-up that is gone before the OCR is done is dropped, or read from the screen as it is now.
 *  F3. Two pop-ups a few seconds apart are one notification, or the second is lost.
 *  F4. The same pop-up text twice inside 30 s is two notifications.
 *  F5. A caret, a clock digit or a pointer in the corner costs an OCR read.
 *  F7. Anything goes over the network with no chat model; a rule is ignored with one, or reaches the step that only reads.
 *  F8. A call is pushed like anything else (urgency, time to live, title, tag), or waits for the model.
 *  F9. The gap or the cap is not held.
 *  F10. The log cannot say how long a notification took, or it holds the screen's words without being asked to.
 *  F11. The OCR is sent more than the pop-up and its margin.
 *  F12. A pop-up that vanished before the confirming look is not read, or one that is still there is read from the older look.
 *  F13. A slow, failed or empty OCR sends nothing and says nothing.
 *  F14. The window behind a pop-up ends up in the notification.
 *  F17. The model gets the picture, or text it was not given; a bad answer is sent as the body.
 *  F18. A step that fails, is late or is nonsense loses the pop-up (the judge failing must notify), or the wrong step's failure is blamed.
 *  F19. The log holds what the pop-up or the model said, instead of numbers and fixed words.
 */
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { ALERT_ZONES, DEFAULT_ALERT_ZONE, type CheckEntry, type WatchSettings } from "@pikvm/contracts/watch";
import { createAlerts, type Alerts } from "../src/server/watch/alerts";
import type { ZoneCells } from "../src/server/watch/frame-diff";
import { factsForJudge, parseFacts } from "../src/server/watch/judge";
import { ALERT_TTL_SEC, CALL_TTL_SEC, DEFAULT_SETTLE_MS, DUPLICATE_MS, JUDGE_TIMEOUT_MS, limitsFromEnv, MAX_BODY_CHARS, MAX_WAITING_POPUPS, OCR_TIMEOUT_MS, READ_TIMEOUT_MS, type WatchLimits } from "../src/server/watch/limits";
import { OcrTimeoutError } from "../src/server/watch/ocr";
import { PushError } from "../src/server/watch/push";
import { JUDGE_PROMPT, READ_PROMPT } from "../src/server/watch/prompts";
import type { WatchStore } from "../src/server/watch/store";
import { cursor, FACTS_JSON, fakeModel, fakeOcr, fakePush, flat, patched, tempDir, tempStore, verdictJson, type FakeModel, type FakeOcr, type FakePush, type TempDir } from "./support/watch-rig";

const USER = "operator";
const SETTLE = DEFAULT_SETTLE_MS;
const GAP = 4000;

/** A toast-sized change in the default (bottom right) zone, and a second one that differs from it. */
const toastA = (base: Uint8Array) => patched(base, 100, 45, 24, 9, 240);
const toastB = (base: Uint8Array) => patched(base, 96, 41, 20, 7, 20);
const toastTopLeft = (base: Uint8Array) => patched(base, 5, 5, 24, 9, 240);

const MAIL = ["Outlook", "Anna Berg", "Lunch on Thursday?", "Are you free at 12:30 for the quarterly review"];
const CHAT = ["Microsoft Teams", "Ben Carter", "Can you join the standup now? We are waiting"];
const CALL = ["Microsoft Teams", "Priya Shah is calling you", "Accept", "Decline"];
const PLAIN_MAIL_BODY = "Anna Berg: Lunch on Thursday? - Are you free at 12:30 for the quarterly review";
const SENTENCE = "Anna Berg asks if you are free Thursday at 12:30 for the quarterly review.";
/** The facts text of FACTS_JSON: what goes out when the judge fails after the facts were read. */
const FACTS_TEXT = "Outlook / Anna Berg / Lunch on Thursday? / Are you free at 12:30 for the quarterly review";

interface Rig {
    dir: TempDir;
    store: WatchStore;
    model: FakeModel;
    ocr: FakeOcr;
    push: FakePush;
    settings: WatchSettings;
    clock: { t: number };
    crops: { label: string; cells: ZoneCells }[];
    alerts: Alerts;
    look(grid: Uint8Array, label: string): void;
    wait(ms: number): void;
    /** Looks at `grid` every second for `ms`. */
    hold(grid: Uint8Array, label: string, ms: number): void;
    /** A pop-up: seen, held a second, and confirmed at exactly the settle time after it was first seen. */
    toast(grid: Uint8Array, label: string): void;
    entries(): CheckEntry[];
}

const rigs: Rig[] = [];
after(() => rigs.forEach((rig) => rig.dir.remove()));

function rig(over: { dailyCap?: number; rule?: string; logText?: boolean; noModel?: boolean; limits?: Partial<WatchLimits> } = {}): Rig {
    const dir = tempDir();
    const store = tempStore(dir.path);
    const result: Rig = {
        dir,
        store,
        model: fakeModel(),
        ocr: fakeOcr(),
        push: fakePush(),
        settings: { enabled: true, rule: over.rule ?? "", alertZone: DEFAULT_ALERT_ZONE },
        clock: { t: 1_000_000 },
        crops: [],
        alerts: undefined as unknown as Alerts,
        look(grid, label) {
            result.alerts.look({ grid, jpeg: Buffer.from(label), capturedAt: result.clock.t }, result.clock.t);
        },
        wait(ms) {
            result.clock.t += ms;
        },
        hold(grid, label, ms) {
            for (let spent = 0; spent < ms; spent += 1000) {
                result.look(grid, label);
                result.wait(1000);
            }
        },
        toast(grid, label) {
            result.look(grid, label);
            result.wait(1000);
            result.look(grid, label);
            result.wait(SETTLE - 1000);
            result.look(grid, label);
        },
        entries: () => store.log(USER, 100).reverse(),
    };
    if (over.noModel) result.model.present = false;
    result.alerts = createAlerts({
        userId: USER,
        store,
        push: result.push,
        settings: () => result.settings,
        limits: { ...limitsFromEnv({}), dailyCap: over.dailyCap ?? 500, ...over.limits },
        now: () => result.clock.t,
        ocr: result.ocr,
        model: result.model,
        crop: async (jpeg, cells) => {
            result.crops.push({ label: jpeg.toString(), cells });
            return Buffer.from(`crop:${jpeg.toString()}`);
        },
        ...(over.logText ? { logText: true } : {}),
    });
    rigs.push(result);
    return result;
}

let r: Rig;
beforeEach(() => {
    r = rig({ noModel: true });
    r.ocr.texts = { "crop:toast-a": MAIL, "crop:toast-b": CHAT, "crop:toast-c": CALL };
    // The screen as it is when the watch starts, and a while after.
    r.hold(flat(60), "home", 3000);
});

/** The same rig with a chat model configured. */
function withModel(over: { rule?: string; logText?: boolean; limits?: Partial<WatchLimits> } = {}): void {
    r = rig(over);
    r.ocr.texts = { "crop:toast-a": MAIL, "crop:toast-b": CHAT, "crop:toast-c": CALL };
    r.hold(flat(60), "home", 3000);
}

describe("appearance, not settling", () => {
    it("F1: a pop-up is pushed the settle time after the look that first saw it", async () => {
        const seenAt = r.clock.t;
        r.look(toastA(flat(60)), "toast-a");
        r.wait(1000);
        r.look(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 0, "held 1 s of the 1.2 s it needs: not yet");
        assert.equal(r.alerts.wakeAt(), seenAt + SETTLE, "and the shared poller is told when to look next");
        r.wait(SETTLE - 1000);
        r.look(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.clock.t - seenAt, SETTLE);
        assert.deepEqual(r.push.sent[0]!.payload, { title: "Outlook", body: PLAIN_MAIL_BODY, tag: r.push.sent[0]!.payload.tag, url: "/app/", badge: 1 });
        assert.equal(r.alerts.wakeAt(), null);
    });

    it("F2: a pop-up that is gone before the OCR is done is still notified, from the frame captured when it counted", async () => {
        const gate = Promise.withResolvers<void>();
        r.ocr.gate = gate.promise;
        r.toast(toastA(flat(60)), "toast-a");
        r.wait(1000);
        r.hold(flat(60), "home-again", 3000);
        assert.equal(r.push.sent.length, 0);
        gate.resolve();
        await r.alerts.idle();
        assert.deepEqual(r.ocr.reads, ["crop:toast-a"], "the crop of the frame that counted, not of the desktop that is there now");
        assert.match(r.push.sent[0]!.payload.body, /Anna Berg/);
    });

    it("a pop-up that came and went inside the settle time is nothing", async () => {
        r.look(toastA(flat(60)), "toast-a");
        r.wait(600);
        r.look(flat(60), "home");
        r.wait(5000);
        r.look(flat(60), "home");
        await r.alerts.idle();
        assert.deepEqual(r.ocr.reads, []);
        assert.deepEqual(r.entries(), []);
    });

    it("F5: a caret, a clock digit and a pointer in the corner cost nothing, for minutes", async () => {
        for (let i = 0; i < 120; i++) {
            const caret = patched(flat(60), 100, 50, 1, 2, 255);
            r.look(i % 3 === 0 ? cursor(flat(60)) : i % 2 ? caret : flat(60), "noise");
            r.wait(1000);
        }
        await r.alerts.idle();
        assert.deepEqual(r.ocr.reads, []);
        assert.deepEqual(r.entries(), []);
    });

    it("F12: the confirming look is read when the pop-up is still there", async () => {
        r.look(toastA(flat(60)), "toast-a-first");
        r.wait(1000);
        r.look(toastA(flat(60)), "toast-a-middle");
        r.wait(SETTLE - 1000);
        r.look(toastA(flat(60)), "toast-a-confirm");
        await r.alerts.idle();
        assert.deepEqual(r.crops.map((crop) => crop.label), ["toast-a-confirm"]);
    });

    it("F12: a pop-up gone by the confirming look is read from the last look that saw it", async () => {
        r.ocr.texts["crop:toast-a-last"] = MAIL;
        const seen = r.clock.t;
        r.look(toastA(flat(60)), "toast-a-first");
        r.wait(1000);
        r.look(toastA(flat(60)), "toast-a-last");
        r.wait(SETTLE - 1000);
        r.look(flat(60), "home-confirm");
        await r.alerts.idle();
        assert.deepEqual(r.crops.map((crop) => crop.label), ["toast-a-last"]);
        const latency = r.entries()[0]!.latency!;
        assert.equal(latency.firstSeenAt, seen);
        assert.equal(latency.detectedAt, seen + SETTLE);
        assert.equal(latency.capturedAt, seen + 1000, "the frame that was read, not the confirming one");
    });

    it("the whole corner changing (a window, the desktop) is logged as not a pop-up and is not read", async () => {
        r.hold(patched(flat(60), 79, 39, 49, 33, 200), "page", 4000);
        await r.alerts.idle();
        assert.deepEqual(r.ocr.reads, []);
        assert.match(r.entries()[0]!.reason ?? "", /100% of the corner changed: that is a window or the whole screen/);
        assert.equal(r.entries()[0]!.asked, false);
    });

    it("a pop-up over a page is read as the pop-up, and its going away is not a second one", async () => {
        const page = (level: number) => patched(flat(60), 79, 39, 49, 33, level);
        r.hold(page(200), "page", 4000);
        r.wait(1000);
        r.hold(patched(page(200), 100, 45, 24, 9, 20), "toast-a", 4000);
        r.hold(page(200), "page", 8000);
        await r.alerts.idle();
        assert.deepEqual(r.crops.map((crop) => crop.cells), [{ x0: 98, y0: 43, x1: 126, y1: 56 }]);
        assert.equal(r.push.sent.length, 1);
    });
});

describe("one notification per pop-up", () => {
    it("F3: two pop-ups 5 seconds apart are two notifications", async () => {
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        r.wait(1000);
        r.hold(flat(60), "home", 3800);
        r.toast(toastB(flat(60)), "toast-b");
        await r.alerts.idle();
        assert.deepEqual(r.ocr.reads, ["crop:toast-a", "crop:toast-b"]);
        assert.match(r.push.sent[0]!.payload.body, /Anna Berg/);
        assert.match(r.push.sent[1]!.payload.body, /Ben Carter/);
        assert.notEqual(r.push.sent[0]!.payload.tag, r.push.sent[1]!.payload.tag);
    });

    it("F3/F9: a second pop-up inside the gap waits for it and is read from its own frame, even if it is gone by then", async () => {
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        r.wait(800);
        r.look(toastB(toastA(flat(60))), "toast-b");
        r.wait(SETTLE);
        r.look(toastB(toastA(flat(60))), "toast-b");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 1, "inside the 4 s gap: waiting");
        r.look(flat(60), "home");
        r.wait(GAP);
        r.look(flat(60), "home");
        await r.alerts.idle();
        assert.deepEqual(r.ocr.reads, ["crop:toast-a", "crop:toast-b"]);
    });

    it("F9: three inside the gap: the later two wait in order and every one is read, none is replaced", async () => {
        r.ocr.texts["crop:toast-c"] = ["Outlook", "Dana Ruiz", "Invoice 4471", "Please find the invoice attached"];
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        r.wait(600);
        r.toast(toastB(toastA(flat(60))), "toast-b");
        r.wait(400);
        r.toast(patched(toastB(toastA(flat(60))), 85, 60, 20, 6, 120), "toast-c");
        assert.equal(r.alerts.status().waiting, true);
        r.wait(GAP);
        r.look(flat(60), "home");
        await r.alerts.idle();
        assert.deepEqual(r.ocr.reads, ["crop:toast-a", "crop:toast-b"], "the oldest waiting one goes first");
        r.wait(GAP);
        r.look(flat(60), "home");
        await r.alerts.idle();
        assert.deepEqual(r.ocr.reads, ["crop:toast-a", "crop:toast-b", "crop:toast-c"]);
        assert.equal(r.entries().filter((entry) => entry.outcome === "skipped").length, 0, "nothing was dropped");
        assert.equal(r.alerts.status().waiting, false);
    });

    it("F9: the queue holds MAX_WAITING_POPUPS; only a pop-up that finds it full is dropped, and its reason is fixed", async () => {
        withModel({ limits: { minCheckGapMs: 1e9 } });
        for (let i = 0; i < MAX_WAITING_POPUPS + 2; i++) {
            r.toast(toastA(flat(60)), i === 0 ? "toast-a" : `toast-${i}`);
            await r.alerts.idle();
            r.hold(flat(60), "home", 2000);
        }
        const skipped = r.entries().filter((entry) => entry.outcome === "skipped");
        assert.equal(skipped.length, 1, "the first ran, MAX_WAITING_POPUPS waited, one more found it full");
        assert.equal(skipped[0]!.reason, "too many pop-ups waiting to be read");
        assert.equal(r.ocr.reads.length, 1);
        assert.equal(r.alerts.status().waiting, true);
    });

    it("F4: the same text twice inside 30 seconds is notified once, and again after 30 seconds", async () => {
        r.ocr.texts = { "crop:toast-a": MAIL, "crop:toast-b": MAIL };
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        r.hold(flat(60), "home", 6000);
        r.toast(toastB(flat(60)), "toast-b");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 1);
        assert.match(r.entries()[1]!.reason ?? "", /same pop-up text was notified \d+ seconds ago/);
        r.hold(flat(60), "home", DUPLICATE_MS);
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 2);
    });

    it("the same words read slightly differently (case, spacing, a stray glyph) are the same text", async () => {
        r.ocr.texts = { "crop:toast-a": MAIL, "crop:toast-b": ["OUTLOOK", "Anna  Berg", "Lunch on Thursday?", "Are you free at 12:30 for the quarterly review", "×"] };
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        r.hold(flat(60), "home", 6000);
        r.toast(toastB(flat(60)), "toast-b");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 1);
    });
});

describe("calls", () => {
    it("F8: a call has a call's title, urgency high, a 60 second time to live and a tag of its caller; anything else is normal and lives 5 minutes", async () => {
        r.toast(toastA(flat(60)), "toast-c");
        await r.alerts.idle();
        const call = r.push.sent[0]!;
        assert.equal(call.payload.title, "Incoming call: Priya Shah");
        assert.match(call.payload.tag, /^pikvm-call-[0-9a-f]{8}$/);
        assert.deepEqual(call.options, { urgency: "high", ttlSeconds: CALL_TTL_SEC });
        assert.equal(CALL_TTL_SEC, 60);
        r.hold(flat(60), "home", 6000);
        r.toast(toastB(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.deepEqual(r.push.sent[1]!.options, { urgency: "normal", ttlSeconds: ALERT_TTL_SEC });
    });

    it("F8: a caller who rings again later updates the same notification; another caller is another one", async () => {
        r.ocr.texts = { "crop:toast-c": CALL, "crop:toast-d": CALL, "crop:toast-e": ["Microsoft Teams", "Ben Carter is calling you", "Accept", "Decline"] };
        r.toast(toastA(flat(60)), "toast-c");
        await r.alerts.idle();
        r.hold(flat(60), "home", DUPLICATE_MS + 1000);
        r.toast(toastA(flat(60)), "toast-d");
        await r.alerts.idle();
        r.hold(flat(60), "home", 6000);
        r.toast(toastB(flat(60)), "toast-e");
        await r.alerts.idle();
        const tags = r.push.sent.map((sent) => sent.payload.tag);
        assert.equal(tags[0], tags[1]);
        assert.notEqual(tags[1], tags[2]);
    });
});

describe("with no chat model", () => {
    it("F7: nothing goes over the network: the model is not asked, and the notification is the text as read", async () => {
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 1);
        assert.deepEqual(r.model.asks, []);
        const entry = r.entries()[0]!;
        assert.equal(entry.judged, undefined);
        assert.equal(entry.outcome, "pushed");
    });

    it("F7: a rule cannot be applied without a model, and is not a reason to miss a pop-up: it is notified as read", async () => {
        r.settings = { ...r.settings, rule: "only mail from Anna" };
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 1);
        assert.deepEqual(r.model.asks, []);
    });
});

describe("with a chat model", () => {
    beforeEach(() => withModel());

    /** The chat model's steps never answer: short hang guards, so they can be waited for. */
    const quick: Partial<WatchLimits> = { readTimeoutMs: 30, judgeTimeoutMs: 30 };

    it("F17: READ then JUDGE, in that order, each asked for JSON, from the OCR text only; the verdict's body and title are what is pushed", async () => {
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.deepEqual(r.model.asks.map((ask) => ask.step), ["read", "judge"]);
        const [read, judge] = r.model.asks as [FakeModel["asks"][number], FakeModel["asks"][number]];
        assert.equal(read.system, READ_PROMPT);
        assert.equal(read.user, `Text:\n${MAIL.join("\n")}`);
        assert.equal(read.timeoutMs, READ_TIMEOUT_MS);
        assert.equal(judge.system, JUDGE_PROMPT);
        const facts = parseFacts(FACTS_JSON);
        assert.ok(facts.ok);
        assert.equal(judge.user, `Facts: ${factsForJudge(facts.value)}`);
        assert.ok(judge.timeoutMs > 0 && judge.timeoutMs <= JUDGE_TIMEOUT_MS);
        for (const ask of r.model.asks) {
            assert.equal(ask.json, true);
            assert.ok(ask.maxTokens > 80, "room for a JSON answer");
            assert.ok(!ask.user.includes("crop:") && !ask.system.includes("crop:"), "the crop is not in the request");
        }
        assert.deepEqual(r.push.sent[0]!.payload, { title: "Anna Berg", body: SENTENCE, tag: r.push.sent[0]!.payload.tag, url: "/app/", badge: 1 });
        const entry = r.entries()[0]!;
        assert.equal(entry.outcome, "pushed");
        assert.deepEqual(entry.judged, { readMs: 0, judgeMs: 0, notify: true, reason: "person_waiting" });
        assert.equal(entry.notified?.bodyChars, SENTENCE.length);
        assert.ok(entry.latency!.factsAt !== undefined && entry.latency!.judgedAt !== undefined);
    });

    it("F17: each step's time is in `judged` and the latency fields, and in the total", async () => {
        r.model.onAsk = (step) => r.wait(step === "read" ? 400 : 700);
        const firstSeen = r.clock.t;
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        const entry = r.entries()[0]!;
        assert.equal(entry.judged?.readMs, 400);
        assert.equal(entry.judged?.judgeMs, 700);
        assert.equal(entry.latency?.factsAt, firstSeen + SETTLE + 400);
        assert.equal(entry.latency?.judgedAt, firstSeen + SETTLE + 1100);
        assert.equal(entry.latency?.totalMs, 1100);
    });

    it("F17: a verdict of not urgent sends nothing and logs only the fixed reason; the same pop-up can come again and be judged again", async () => {
        r.model.answer.judge = verdictJson({ reason: "routine", notify: false, body: "Secret body text", title: "Secret title" });
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 0);
        const entry = r.entries()[0]!;
        assert.equal(entry.outcome, "no");
        assert.equal(entry.asked, true);
        assert.equal(entry.reason, undefined);
        assert.deepEqual(entry.judged, { readMs: 0, judgeMs: 0, notify: false, reason: "routine" });
        const text = JSON.stringify(entry);
        for (const word of ["Secret", "Anna", "Berg", "Lunch", "quarterly", "Outlook"]) assert.ok(!text.includes(word), `"${word}" is not in the log`);
        r.hold(flat(60), "home", 6000);
        r.model.answer.judge = verdictJson();
        r.toast(toastB(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 1);
    });

    it("F17: every reason of the list is accepted and is logged as that word; one that is not in the list is 'other'", async () => {
        for (const [reason, notify] of [["call", true], ["security", true], ["marketing_social", false], ["chatter", false], ["duplicate", false], ["rule", false], ["other", true]] as const) {
            r.model.answer.judge = verdictJson({ reason, notify });
            r.hold(flat(60), "home", 6000);
            r.toast(toastA(flat(60)), "toast-a");
            await r.alerts.idle();
            assert.equal(r.entries().at(-1)!.judged?.reason, reason);
            assert.equal(r.entries().at(-1)!.outcome, notify ? "pushed" : "no");
            r.hold(flat(60), "home", DUPLICATE_MS);
        }
        r.model.answer.judge = verdictJson({ reason: "social" });
        r.hold(flat(60), "home", 6000);
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.entries().at(-1)!.judged?.reason, "other");
        assert.equal(r.entries().at(-1)!.outcome, "pushed");
    });

    it("F17: an answer wrapped in a fence and a sentence is read; emoji and control characters are stripped and a long body is cut at the limit", async () => {
        const long = `${"word ".repeat(100)}end`;
        r.model.answer.judge = `Sure! Here you go:\n\`\`\`json\n${verdictJson({ body: `Call Anna now \u{1F4DE}\u0007 ${long}`, title: "Anna \u{1F514}" })}\n\`\`\``;
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        const payload = r.push.sent[0]!.payload;
        assert.ok(payload.body.startsWith("Call Anna now word"));
        assert.ok(!/[\u{1F4DE}\u0007]/u.test(payload.body));
        assert.ok(payload.body.length <= MAX_BODY_CHARS && payload.body.endsWith("..."));
        assert.equal(payload.title, "Anna");
    });

    describe("a step that fails (F18)", () => {
        for (const [name, arrange, why] of [
            ["errors", () => void (r.model.error.read = new Error("503")), "error"],
            ["times out", () => void (r.model.hang.read = true), "timeout"],
            ["answers something that is not JSON", () => void (r.model.answer.read = "I could not read that."), "invalid"],
            ["answers with nothing", () => void (r.model.answer.read = "   "), "empty"],
            ["answers JSON with no text in it", () => void (r.model.answer.read = JSON.stringify({ source: "x", from: null, text: "" })), "empty"],
            ["is not there after all", () => void (r.model.answer.read = undefined), "error"],
        ] as const) {
            it(`READ ${name}: the judge gets the OCR lines as read, and the log says why (${why})`, async () => {
                withModel({ limits: quick });
                arrange();
                r.toast(toastA(flat(60)), "toast-a");
                await r.alerts.idle();
                const tries = why === "timeout" ? 1 : 2;
                assert.deepEqual(r.model.asks.map((ask) => ask.step), [...Array<"read">(tries).fill("read"), "judge"], "a step that failed is tried once more, unless it timed out");
                assert.equal(r.model.asks[tries]!.user, `The facts could not be read. The lines of the pop-up, as read:\n${MAIL.join("\n")}`);
                assert.equal(r.push.sent[0]!.payload.body, SENTENCE, "the judge's body is used");
                const entry = r.entries()[0]!;
                assert.equal(entry.judged?.readSkipped, why);
                assert.equal(entry.judged?.judgeSkipped, undefined);
                assert.equal(entry.outcome, "pushed");
            });
        }

        for (const [name, arrange, why] of [
            ["errors", () => void (r.model.error.judge = new Error("503")), "error"],
            ["times out", () => void (r.model.hang.judge = true), "timeout"],
            ["answers something that is not JSON", () => void (r.model.answer.judge = "I cannot help with that."), "invalid"],
            ["answers JSON of the wrong shape", () => void (r.model.answer.judge = JSON.stringify({ answer: "yes" })), "invalid"],
            ["says notify with a reason to stay quiet", () => void (r.model.answer.judge = verdictJson({ notify: true, reason: "routine" })), "invalid"],
            ["says do not notify with a reason to interrupt", () => void (r.model.answer.judge = verdictJson({ notify: false, reason: "security" })), "invalid"],
            ["says notify with no body", () => void (r.model.answer.judge = verdictJson({ body: "  " })), "empty"],
            ["answers with nothing", () => void (r.model.answer.judge = ""), "empty"],
        ] as const) {
            it(`JUDGE ${name}: it fails open, the notification goes out with the facts' text, and the log says why (${why})`, async () => {
                withModel({ limits: quick });
                arrange();
                r.toast(toastA(flat(60)), "toast-a");
                await r.alerts.idle();
                assert.equal(r.push.sent.length, 1, "a judge that fails must not hide the pop-up");
                assert.equal(r.model.asks.filter((ask) => ask.step === "judge").length, why === "timeout" ? 1 : 2, "tried once more, unless it timed out");
                assert.equal(r.push.sent[0]!.payload.body, FACTS_TEXT);
                assert.equal(r.push.sent[0]!.payload.title, "Outlook", "the rules' own title");
                const entry = r.entries()[0]!;
                assert.equal(entry.outcome, "pushed");
                assert.equal(entry.judged?.judgeSkipped, why);
                assert.equal(entry.judged?.readSkipped, undefined);
                assert.equal(entry.judged?.notify, undefined);
            });
        }

        it("both steps failing: the rules' own plain text goes out", async () => {
            withModel({ limits: quick });
            r.model.error.read = new Error("503");
            r.model.error.judge = new Error("503");
            r.toast(toastA(flat(60)), "toast-a");
            await r.alerts.idle();
            assert.equal(r.push.sent[0]!.payload.body, PLAIN_MAIL_BODY);
            assert.deepEqual(r.entries()[0]!.judged, { readMs: 0, readSkipped: "error", judgeMs: 0, judgeSkipped: "error" });
        });

        it("a step that never answers is abandoned at its hang guard, not before, and fails open", async () => {
            withModel({ limits: { readTimeoutMs: 40, judgeTimeoutMs: 40 } });
            r.model.hang.read = true;
            r.model.hang.judge = true;
            const began = Date.now();
            r.toast(toastA(flat(60)), "toast-a");
            await r.alerts.idle();
            const took = Date.now() - began;
            assert.ok(took >= 70 && took < 1000, `two guards of 40 ms were waited, not a model's seconds (${took} ms)`);
            assert.deepEqual(r.model.asks.map((ask) => ask.timeoutMs), [40, 40], "and the request was told its guard, so it is aborted");
            assert.equal(r.push.sent.length, 1);
        });

        it("a slow model is waited for: READ at 20 s and JUDGE at 25 s are both used, and nothing is skipped", async () => {
            r.model.onAsk = (step) => r.wait(step === "read" ? 20_000 : 25_000);
            r.toast(toastA(flat(60)), "toast-a");
            await r.alerts.idle();
            assert.deepEqual(r.model.asks.map((ask) => ask.step), ["read", "judge"]);
            assert.equal(r.model.asks[1]!.timeoutMs, JUDGE_TIMEOUT_MS, "the judge has its whole guard, whatever READ took");
            assert.deepEqual(r.entries()[0]!.judged, { readMs: 20_000, judgeMs: 25_000, notify: true, reason: "person_waiting" });
            assert.equal(r.push.sent[0]!.payload.body, SENTENCE, "the judge's body, not a fallback");
        });

        it("a step that errors once is tried once more, and the second answer is used", async () => {
            let judges = 0;
            r.model.answer.judge = () => {
                judges += 1;
                if (judges === 1) throw new Error("503");
                return verdictJson();
            };
            let reads = 0;
            r.model.answer.read = () => {
                reads += 1;
                return reads === 1 ? "I could not read that." : FACTS_JSON;
            };
            r.toast(toastA(flat(60)), "toast-a");
            await r.alerts.idle();
            assert.deepEqual([reads, judges], [2, 2]);
            assert.equal(r.push.sent[0]!.payload.body, SENTENCE);
            const entry = r.entries()[0]!;
            assert.equal(entry.judged?.readSkipped, undefined);
            assert.equal(entry.judged?.judgeSkipped, undefined);
        });
    });

    it("F8: a call never waits for the model, and is never asked about", async () => {
        r.toast(toastA(flat(60)), "toast-c");
        await r.alerts.idle();
        assert.equal(r.push.sent[0]!.payload.title, "Incoming call: Priya Shah");
        assert.deepEqual(r.model.asks, []);
        assert.equal(r.entries()[0]!.judged, undefined);
    });

    it("F7: the person's rule reaches the judge only, at the end of its instructions, and never the read step or the pop-up message", async () => {
        withModel({ rule: "also tell me about the build server" });
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        const [read, judge] = r.model.asks as [FakeModel["asks"][number], FakeModel["asks"][number]];
        assert.equal(read.system, READ_PROMPT);
        assert.ok(!read.user.includes("build server") && !read.system.includes("build server"));
        assert.ok(judge.system.startsWith(JUDGE_PROMPT));
        assert.ok(judge.system.endsWith("Extra instructions: also tell me about the build server"));
        assert.ok(!judge.user.includes("build server"), "the pop-up's message carries no rule");
        assert.equal(r.push.sent[0]!.payload.body, SENTENCE);
    });

    it("F7: a rule that makes the judge say 'rule' for a skip is logged as that word, and the rule's own text is logged as the person's own setting", async () => {
        withModel({ rule: "never tell me about mail" });
        r.model.answer.judge = verdictJson({ reason: "rule", notify: false });
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 0);
        assert.equal(r.entries()[0]!.judged?.reason, "rule");
        assert.equal(r.entries()[0]!.outcome, "no");
    });

    it("F7: a rule with a failing judge still notifies, with the facts' text", async () => {
        withModel({ rule: "only mail from Anna", limits: quick });
        r.model.error.judge = new Error("503");
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.push.sent[0]!.payload.body, FACTS_TEXT);
    });

    it("F19: nothing the pop-up or the model said is in the log, on any path (a verdict, a skip, a failed judge), even when the host logs text", async () => {
        withModel({ logText: true });
        const said = ["Anna", "Berg", "Lunch", "quarterly", "Thursday", "Outlook", "free at 12:30", "Written by the judge"];
        const run = async (judge: string | undefined, error?: Error) => {
            r.model.answer.judge = judge;
            r.model.error.judge = error ?? null;
            r.hold(flat(60), "home", DUPLICATE_MS + 1000);
            r.toast(toastA(flat(60)), "toast-a");
            await r.alerts.idle();
        };
        await run(verdictJson({ body: "Written by the judge, Anna Berg asks about Thursday", title: "Written by the judge" }));
        await run(verdictJson({ reason: "routine", notify: false, body: "Written by the judge" }));
        await run(undefined, new Error("503 Anna Berg"));
        const entries = r.entries().filter((entry) => entry.kind === "alert");
        assert.equal(entries.length, 3);
        for (const entry of entries) {
            const { description, ...rest } = entry;
            const text = JSON.stringify(rest);
            for (const word of said) assert.ok(!text.includes(word), `"${word}" is not in a ${entry.outcome} entry outside the OCR text the host was asked to log`);
            assert.equal(description, MAIL.join("\n"), "the OCR text itself is logged only because the host asked for it");
        }
        assert.equal(entries[2]!.notified?.body, undefined, "the facts' text is the model's too");
    });
});

describe("its own gap and cap", () => {
    it("F9: the daily cap is held and says so", async () => {
        const small = rig({ dailyCap: 2, noModel: true });
        small.ocr.texts = { "crop:toast-a": MAIL, "crop:toast-b": CHAT, "crop:toast-c": CALL };
        small.hold(flat(60), "home", 3000);
        for (const [grid, label] of [[toastA(flat(60)), "toast-a"], [toastB(flat(60)), "toast-b"], [toastA(flat(60)), "toast-c"]] as const) {
            small.toast(grid, label);
            await small.alerts.idle();
            small.hold(flat(60), "home", 6000);
        }
        assert.deepEqual(small.ocr.reads, ["crop:toast-a", "crop:toast-b"]);
        const last = small.entries().at(-1)!;
        assert.equal(last.outcome, "skipped");
        assert.match(last.reason ?? "", /daily cap of 2 checks reached/);
        assert.equal(small.store.askedSince(USER, 0), 2);
    });
});

describe("what the log says", () => {
    it("F10: every check logs when the frame was captured, seen, held, read and pushed, and the total", async () => {
        r.ocr.afterRead = () => r.wait(700);
        const send = r.push.send.bind(r.push);
        r.push.send = async (userId, payload, options) => {
            r.wait(300);
            return send(userId, payload, options);
        };
        const firstSeen = r.clock.t;
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        const entry = r.entries()[0]!;
        assert.equal(entry.kind, "alert");
        assert.deepEqual(entry.latency, {
            firstSeenAt: firstSeen,
            capturedAt: firstSeen + SETTLE,
            detectedAt: firstSeen + SETTLE,
            readAt: firstSeen + SETTLE + 700,
            pushedAt: firstSeen + SETTLE + 1000,
            totalMs: 1000,
            sinceFirstSeenMs: SETTLE + 1000,
        });
        assert.deepEqual(entry.read, { ms: 120, chars: MAIL.join("\n").length, words: 15, lines: 4 });
        assert.deepEqual(entry.push, { sent: 1, removed: 0, failed: 0 });
        assert.equal(entry.notified?.kind, "email");
        assert.equal(entry.notified?.ttlSec, ALERT_TTL_SEC);
        assert.deepEqual(r.ocr.limits, [OCR_TIMEOUT_MS]);
    });

    it("F10: the screen's words are not in the log unless the host is asked to log them", async () => {
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        const text = JSON.stringify(r.entries());
        for (const word of ["Anna", "Berg", "Lunch", "Thursday", "quarterly", "Outlook"]) assert.ok(!text.includes(word), `"${word}" is not in the log`);
        const loud = rig({ logText: true, noModel: true });
        loud.ocr.texts = { "crop:toast-a": MAIL };
        loud.hold(flat(60), "home", 3000);
        loud.toast(toastA(flat(60)), "toast-a");
        await loud.alerts.idle();
        assert.equal(loud.entries()[0]!.notified?.title, "Outlook");
        assert.equal(loud.entries()[0]!.description, MAIL.join("\n"));
    });

    it("a failed push is logged with the timestamps, and the next pop-up is still read", async () => {
        r.push.fail = new PushError("No device has subscribed to notifications yet.", "none");
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.entries()[0]!.outcome, "error");
        assert.equal(r.entries()[0]!.latency!.pushedAt, undefined);
        r.push.fail = null;
        r.hold(flat(60), "home", 6000);
        r.toast(toastB(flat(60)), "toast-b");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 1);
    });
});

describe("what the OCR is sent", () => {
    it("F11: only the cells that changed and a margin of two cells, inside the zone, cut from the frame that was read", async () => {
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.deepEqual(r.crops, [{ label: "toast-a", cells: { x0: 98, y0: 43, x1: 126, y1: 56 } }]);
    });

    it("F11: a margin never reaches outside the zone", async () => {
        r.ocr.texts["crop:toast-b"] = CHAT;
        r.toast(patched(flat(60), 110, 55, 18, 17, 240), "toast-b");
        await r.alerts.idle();
        assert.deepEqual(r.crops[0]!.cells, { x0: 108, y0: 53, x1: 128, y1: 72 });
    });

    it("a different corner is watched from the next look", async () => {
        r.settings = { ...r.settings, alertZone: ALERT_ZONES[3].zone };
        r.hold(flat(60), "home", 3000);
        r.hold(toastA(flat(60)), "toast-a", 6000);
        await r.alerts.idle();
        assert.deepEqual(r.ocr.reads, []);
        r.hold(flat(60), "home", 3000);
        r.ocr.texts["crop:toast-b"] = CHAT;
        r.toast(toastTopLeft(flat(60)), "toast-b");
        await r.alerts.idle();
        assert.deepEqual(r.ocr.reads, ["crop:toast-b"]);
    });

    const at = (y: number) => ({ x0: 0.1, y0: y - 0.04, x1: 0.9, y1: y + 0.04 });

    it("F14: lines the OCR places outside the cells that changed are the page behind, and are not in the notification", async () => {
        r.ocr.texts = { "crop:toast-a": [...MAIL.slice(0, 3), "Figure 18: margins held at 48%"] };
        r.ocr.boxes = { "crop:toast-a": [at(0.3), at(0.45), at(0.6), at(0.03)] };
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.push.sent[0]!.payload.body, "Anna Berg: Lunch on Thursday?");
        assert.equal(r.entries()[0]!.read?.lines, 3);
    });

    it("F14: with no places for the lines, or none inside, all of them are kept", async () => {
        r.ocr.texts = { "crop:toast-a": [...MAIL.slice(0, 3), "Figure 18: margins held at 48%"] };
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.match(r.push.sent[0]!.payload.body, /Figure 18/);
    });
});

describe("when the OCR does not deliver", () => {
    it("F13: a timed-out OCR sends nothing, and the log says so", async () => {
        r.ocr.error = new OcrTimeoutError(OCR_TIMEOUT_MS);
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 0);
        assert.deepEqual(r.model.asks, []);
        assert.equal(r.entries()[0]!.outcome, "error");
        assert.match(r.entries()[0]!.reason ?? "", /^ocr timed out, so nothing was sent/);
    });

    it("F13: any other failure is logged with its message", async () => {
        r.ocr.error = new Error("the OCR process exited (SIGKILL)");
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.match(r.entries()[0]!.reason ?? "", /^ocr failed: the OCR process exited/);
    });

    it("F13: too few words in a dialog-sized change, or no text in a small one, sends nothing and says how much was read", async () => {
        r.ocr.texts = { "crop:toast-a": ["Ping"] };
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.match(r.entries()[0]!.reason ?? "", /read 1 words \(fewer than 3\) in a change big enough to be a dialog/);
        r.hold(flat(60), "home", 6000);
        r.ocr.texts = { "crop:toast-b": ["10:42"] };
        r.toast(patched(flat(60), 100, 45, 10, 6, 240), "toast-b");
        await r.alerts.idle();
        assert.match(r.entries()[1]!.reason ?? "", /no readable text \(0 words read\)/);
        assert.equal(r.push.sent.length, 0);
    });

    it("an OCR that has no engine here is logged the same way, the next pop-up still read", async () => {
        r.ocr.error = new Error("The OCR models are not installed");
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        r.ocr.error = null;
        r.hold(flat(60), "home", 6000);
        r.toast(toastB(flat(60)), "toast-b");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 1);
    });
});
