/**
 * The watch through one user's pipeline: a pop-up in the corner of the screen, from the look that sees it to the push, read by the
 * host's own OCR and (when the user has a chat model) written as a sentence by it.
 *
 * Failure modes, before behaviour:
 *  F1. A pop-up waits longer than the settle time after the look that saw it.
 *  F2. A pop-up that is gone before the OCR is done is dropped, or read from the screen as it is now.
 *  F3. Two pop-ups a few seconds apart are one notification, or the second is lost.
 *  F4. The same pop-up text twice inside 30 s is two notifications.
 *  F5. A caret, a clock digit or a pointer in the corner costs an OCR read.
 *  F7. Anything goes over the network with no chat model; a rule is ignored with one, or its SKIP is not obeyed.
 *  F8. A call is pushed like anything else (urgency, time to live, title, tag), or waits for the model.
 *  F9. The gap or the cap is not held.
 *  F10. The log cannot say how long a notification took, or it holds the screen's words without being asked to.
 *  F11. The OCR is sent more than the pop-up and its margin.
 *  F12. A pop-up that vanished before the confirming look is not read, or one that is still there is read from the older look.
 *  F13. A slow, failed or empty OCR sends nothing and says nothing.
 *  F14. The window behind a pop-up ends up in the notification.
 *  F17. The model gets the picture, or text it was not given; a bad answer is sent as the body.
 */
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { ALERT_ZONES, DEFAULT_ALERT_ZONE, type CheckEntry, type WatchSettings } from "@pikvm/contracts/watch";
import { createAlerts, type Alerts } from "../src/server/watch/alerts";
import type { ZoneCells } from "../src/server/watch/frame-diff";
import { ALERT_TTL_SEC, CALL_TTL_SEC, DEFAULT_SETTLE_MS, DUPLICATE_MS, limitsFromEnv, OCR_TIMEOUT_MS, SUMMARY_TIMEOUT_MS } from "../src/server/watch/limits";
import { OcrTimeoutError } from "../src/server/watch/ocr";
import { PushError } from "../src/server/watch/push";
import { RULE_ADDENDUM, SUMMARY_PROMPT } from "../src/server/watch/summary";
import type { WatchStore } from "../src/server/watch/store";
import { cursor, fakeModel, fakeOcr, fakePush, flat, patched, tempDir, tempStore, type FakeModel, type FakeOcr, type FakePush, type TempDir } from "./support/watch-rig";

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
const SENTENCE = "Anna Berg asks if you are free Thursday at 12:30 for the quarterly review";

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

function rig(over: { dailyCap?: number; rule?: string; logText?: boolean; noModel?: boolean } = {}): Rig {
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
        limits: { ...limitsFromEnv({}), dailyCap: over.dailyCap ?? 500 },
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
function withModel(over: { rule?: string; logText?: boolean } = {}): void {
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

    it("F9: three inside the gap: the middle one is replaced and logged as skipped, the newest is read when the gap ends", async () => {
        r.ocr.texts["crop:toast-c"] = ["Outlook", "Dana Ruiz", "Invoice 4471", "Please find the invoice attached"];
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        r.wait(600);
        r.toast(toastB(toastA(flat(60))), "toast-b");
        r.wait(400);
        r.toast(patched(toastB(toastA(flat(60))), 85, 60, 20, 6, 120), "toast-c");
        r.wait(GAP);
        r.look(flat(60), "home");
        await r.alerts.idle();
        assert.deepEqual(r.ocr.reads, ["crop:toast-a", "crop:toast-c"]);
        const skipped = r.entries().filter((entry) => entry.outcome === "skipped");
        assert.equal(skipped.length, 1);
        assert.match(skipped[0]!.reason ?? "", /replaced by a newer pop-up/);
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
        assert.equal(entry.summary, undefined);
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

    it("F17: the body is the model's sentence, the title stays the rules', and the request is the text only", async () => {
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.deepEqual(r.push.sent[0]!.payload, { title: "Outlook", body: SENTENCE, tag: r.push.sent[0]!.payload.tag, url: "/app/", badge: 1 });
        assert.deepEqual(r.model.asks, [{ system: SUMMARY_PROMPT, user: MAIL.join(" | "), timeoutMs: SUMMARY_TIMEOUT_MS }]);
        assert.ok(!r.model.asks[0]!.user.includes("crop:") && !r.model.asks[0]!.system.includes("crop:"), "the crop is not in the request");
        const entry = r.entries()[0]!;
        assert.deepEqual(entry.summary, { used: true, ms: 0 });
        assert.equal(entry.notified?.bodyChars, SENTENCE.length);
        assert.ok(!JSON.stringify(entry).includes("Anna"), "no text in the log");
        assert.ok(entry.latency!.summarisedAt !== undefined);
    });

    it("F17: the model's time is in the latency fields and in the total", async () => {
        r.model.onAsk = () => r.wait(600);
        const firstSeen = r.clock.t;
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        const entry = r.entries()[0]!;
        assert.equal(entry.summary?.ms, 600);
        assert.equal(entry.latency?.summarisedAt, firstSeen + SETTLE + 600);
        assert.equal(entry.latency?.totalMs, 600);
    });

    for (const [name, arrange, why] of [
        ["an error", () => void (r.model.error = new Error("503")), /^summary skipped: model error$/],
        ["an empty answer", () => void (r.model.answer = "   "), /^summary skipped: empty$/],
        ["an answer over 140 characters", () => void (r.model.answer = "x".repeat(141)), /^summary skipped: too long \(141 characters\)$/],
        ["no model after all (its provider cannot be called)", () => void (r.model.answer = undefined), /^summary skipped: no chat model$/],
    ] as const) {
        it(`F17: ${name} falls back to the text as read and says why, without text`, async () => {
            arrange();
            r.toast(toastA(flat(60)), "toast-a");
            await r.alerts.idle();
            assert.equal(r.push.sent[0]!.payload.body, PLAIN_MAIL_BODY);
            assert.match(r.entries()[0]!.summary?.skipped ?? "", why);
        });
    }

    it("F17: a model that does not answer in 2.5 s is given up on: the text as read goes", async () => {
        r.model.hang = true;
        r.toast(toastA(flat(60)), "toast-a");
        // The hard timeout is the thing under test, so this one waits for the real timer.
        await r.alerts.idle();
        assert.equal(r.push.sent[0]!.payload.body, PLAIN_MAIL_BODY);
        assert.equal(r.entries()[0]!.summary?.skipped, "summary skipped: timed out");
    });

    it("F8: a call never waits for the model, and is never asked about", async () => {
        r.toast(toastA(flat(60)), "toast-c");
        await r.alerts.idle();
        assert.equal(r.push.sent[0]!.payload.title, "Incoming call: Priya Shah");
        assert.deepEqual(r.model.asks, []);
        assert.equal(r.entries()[0]!.summary, undefined);
    });

    it("F7: the rule goes in the same request, in the message, and the instructions say how to answer SKIP", async () => {
        withModel({ rule: "only mail from Anna" });
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.deepEqual(r.model.asks, [{ system: SUMMARY_PROMPT + RULE_ADDENDUM, user: `Text: ${MAIL.join(" | ")}\nRule: only mail from Anna`, timeoutMs: SUMMARY_TIMEOUT_MS }]);
        assert.equal(r.push.sent[0]!.payload.body, SENTENCE);
        assert.match(RULE_ADDENDUM, /exactly SKIP/);
    });

    it("F7: SKIP means no notification, logged as such (and the text is not in the log)", async () => {
        withModel({ rule: "only mail from Anna" });
        r.model.answer = "SKIP";
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 0);
        const entry = r.entries()[0]!;
        assert.equal(entry.outcome, "no");
        assert.equal(entry.asked, true);
        assert.ok(!JSON.stringify(entry).includes("Berg"));
        // The text of a skipped pop-up is not "used up": the same pop-up can come again and be judged again.
        r.hold(flat(60), "home", 6000);
        r.model.answer = SENTENCE;
        r.toast(toastB(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.push.sent.length, 1);
    });

    it("F7: a rule with a timeout or an error still notifies, with the text as read", async () => {
        withModel({ rule: "only mail from Anna" });
        r.model.error = new Error("503");
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.push.sent[0]!.payload.body, PLAIN_MAIL_BODY);
    });

    it("F7: SKIP with no rule is not an answer: the text as read goes", async () => {
        r.model.answer = "SKIP";
        r.toast(toastA(flat(60)), "toast-a");
        await r.alerts.idle();
        assert.equal(r.push.sent[0]!.payload.body, PLAIN_MAIL_BODY);
        assert.equal(r.entries()[0]!.summary?.skipped, "summary skipped: unexpected answer");
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
