/**
 * Fast alerts through one user's pipeline: a toast in the corner of the screen, from the look that sees it to the push, read by the
 * host's own OCR.
 *
 * Failure modes, before behaviour:
 *  F1. A toast waits for the slow path's 6 s, or longer than the fast settle after the look that saw it.
 *  F2. A toast that is gone before the OCR is done is dropped, or read from the screen as it is now.
 *  F3. Two toasts a few seconds apart are one notification, or the second is lost.
 *  F4. The same toast text twice inside 30 s is two notifications.
 *  F5. A caret, a clock digit or a pointer in the corner costs an OCR read.
 *  F6. Fast alerts change what the slow path does outside the corner, or the slow path also notifies a toast.
 *  F7. With no rule anything goes over the network (a model, Jev), or a notification needs a key; with a rule Jev is not asked.
 *  F8. A call is pushed like a message (urgency, time to live, title, tag).
 *  F9. The fast path's gap or cap is not held, or it spends the slow path's budget (or the reverse).
 *  F10. The log cannot say how long a notification took, or it holds the screen's words without being asked to.
 *  F11. The OCR is sent more than the pop-up and its margin.
 *  F12. A toast that vanished before the confirming look is not read, or one that is still there is read from the older look.
 *  F13. A slow, failed or empty OCR sends nothing and says nothing; or asks a model without a key, or when it need not.
 */
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { ALERT_ZONES, DEFAULT_ALERT_ZONE, type CheckEntry, type WatchSettings } from "@pikvm/contracts/watch";
import { ALERT_PREVIOUS } from "../src/server/watch/fast-alerts";
import type { ZoneCells } from "../src/server/watch/frame-diff";
import { DEFAULT_FAST_SETTLE_MS, FAST_ALERT_TTL_SEC, FAST_CALL_TTL_SEC, FAST_DUPLICATE_MS, limitsFromEnv, OCR_TIMEOUT_MS } from "../src/server/watch/limits";
import { ModelError, type ModelProvider } from "../src/server/watch/models";
import { OcrTimeoutError } from "../src/server/watch/ocr";
import { createPipeline, type Pipeline } from "../src/server/watch/pipeline";
import { PushError } from "../src/server/watch/push";
import type { WatchStore } from "../src/server/watch/store";
import { cursor, dialog, fakeModels, fakeOcr, fakePush, flat, PROVIDER, patched, tempDir, tempStore, type FakeModels, type FakeOcr, type FakePush, type TempDir } from "./support/watch-rig";

const USER = "operator";
const SETTLE = DEFAULT_FAST_SETTLE_MS;
const GAP = 4000;

/** A toast-sized change in the default (bottom right) zone, and a second one that differs from it. */
const toastA = (base: Uint8Array) => patched(base, 100, 45, 24, 9, 240);
const toastB = (base: Uint8Array) => patched(base, 96, 41, 20, 7, 20);
const toastTopLeft = (base: Uint8Array) => patched(base, 5, 5, 24, 9, 240);

const EMAIL = ["Outlook", "Anna Berg", "Lunch on Thursday?", "Are you free at 12:30 for the quarterly review"];
const TEAMS = ["Microsoft Teams", "Ben Carter", "Can you join the standup now? We are waiting"];
const CALL = ["Microsoft Teams", "Priya Shah is calling you", "Accept", "Decline"];

interface Rig {
    dir: TempDir;
    store: WatchStore;
    models: FakeModels;
    ocr: FakeOcr;
    push: FakePush;
    settings: WatchSettings;
    provider: ModelProvider | undefined;
    clock: { t: number };
    /** What was cut from which frame: the frame's label and the cells. */
    crops: { label: string; cells: ZoneCells }[];
    pipeline: Pipeline;
    /** One look at `grid` (carried as the frame labelled `label`) at the current time; time does not move. */
    look(grid: Uint8Array, label: string, slow?: boolean): void;
    /** Time moves. */
    wait(ms: number): void;
    /** Looks at `grid` every second for `ms`, every third one a slow look, as the shared poller makes them. */
    hold(grid: Uint8Array, label: string, ms: number): void;
    /** A toast: seen, held a second, and confirmed at exactly the settle time after it was first seen. */
    toast(grid: Uint8Array, label: string): void;
    entries(): CheckEntry[];
}

const rigs: Rig[] = [];
after(() => rigs.forEach((rig) => rig.dir.remove()));

function rig(over: { fastCap?: number; rule?: string; fastAlerts?: boolean; dailyCap?: number; logText?: boolean; cloudFallback?: boolean } = {}): Rig {
    const dir = tempDir();
    const store = tempStore(dir.path);
    let looks = 0;
    const result: Rig = {
        dir,
        store,
        models: fakeModels(),
        ocr: fakeOcr(),
        push: fakePush(),
        settings: {
            enabled: true,
            rule: over.rule ?? "",
            visionModel: "vision/test",
            fastAlerts: over.fastAlerts ?? true,
            alertZone: DEFAULT_ALERT_ZONE,
        },
        provider: PROVIDER,
        clock: { t: 1_000_000 },
        crops: [],
        pipeline: undefined as unknown as Pipeline,
        look(grid, label, slow = true) {
            result.pipeline.look({ grid, jpeg: Buffer.from(label), capturedAt: result.clock.t }, result.clock.t, slow);
        },
        wait(ms) {
            result.clock.t += ms;
        },
        hold(grid, label, ms) {
            for (let spent = 0; spent < ms; spent += 1000) {
                result.look(grid, label, looks++ % 3 === 0);
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
    result.pipeline = createPipeline({
        userId: USER,
        store,
        push: result.push,
        models: result.models,
        provider: () => result.provider,
        settings: () => result.settings,
        limits: {
            ...limitsFromEnv({}),
            intervalMs: 3000,
            settleMs: 6000,
            minCheckGapMs: 60_000,
            dailyCap: over.dailyCap ?? 100,
            fast: { intervalMs: 1000, settleMs: SETTLE, minCheckGapMs: GAP, dailyCap: over.fastCap ?? 500 },
        },
        now: () => result.clock.t,
        prepare: async (jpeg) => jpeg,
        ocr: result.ocr,
        screenOcr: result.ocr,
        crop: async (jpeg, cells) => {
            result.crops.push({ label: jpeg.toString(), cells });
            return Buffer.from(`crop:${jpeg.toString()}`);
        },
        ...(over.logText ? { logText: true } : {}),
        ...(over.cloudFallback ? { cloudFallback: true } : {}),
    });
    rigs.push(result);
    return result;
}

let r: Rig;
beforeEach(() => {
    r = rig();
    r.ocr.texts = { "crop:toast-a": EMAIL, "crop:toast-b": TEAMS, "crop:toast-c": CALL };
    // The screen as it is when the watch starts, and a while after.
    r.hold(flat(60), "home", 3000);
});

describe("appearance, not settling", () => {
    it("F1: a toast is pushed the fast settle after the look that first saw it, not 6 seconds later", async () => {
        const seenAt = r.clock.t;
        r.look(toastA(flat(60)), "toast-a");
        r.wait(1000);
        r.look(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 0, "held 1 s of the 1.2 s it needs: not yet");
        assert.equal(r.pipeline.wakeAt(), seenAt + SETTLE, "and the shared poller is told when to look next");
        r.wait(SETTLE - 1000);
        r.look(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.clock.t - seenAt, SETTLE);
        assert.equal(r.push.sent.length, 1);
        assert.deepEqual(r.push.sent[0]!.payload, {
            title: "Outlook",
            body: "Anna Berg: Lunch on Thursday? - Are you free at 12:30 for the quarterly review",
            tag: r.push.sent[0]!.payload.tag,
            url: "/app/",
            badge: 1,
        });
        assert.equal(r.pipeline.wakeAt(), null);
    });

    it("F2: a toast that is gone before the OCR is done is still notified, from the frame captured when it fired", async () => {
        const gate = Promise.withResolvers<void>();
        r.ocr.gate = gate.promise;
        r.toast(toastA(flat(60)), "toast-a");
        // The OCR has not answered; the toast goes, and the screen is the desktop again for seconds.
        r.wait(1000);
        r.hold(flat(60), "home-again", 3000);
        assert.equal(r.push.sent.length, 0);
        gate.resolve();
        await r.pipeline.idle();
        assert.deepEqual(r.ocr.reads, ["crop:toast-a"], "the crop of the frame that fired, not of the desktop that is there now");
        assert.equal(r.push.sent.length, 1);
        assert.match(r.push.sent[0]!.payload.body, /Anna Berg/);
        assert.deepEqual(r.crops.map((crop) => crop.label), ["toast-a"]);
    });

    it("a toast that came and went inside the settle time is nothing", async () => {
        r.look(toastA(flat(60)), "toast-a");
        r.wait(600);
        r.look(flat(60), "home");
        r.wait(5000);
        r.look(flat(60), "home");
        await r.pipeline.idle();
        assert.deepEqual(r.ocr.reads, []);
        assert.deepEqual(r.entries(), []);
    });

    it("F5: a caret, a clock digit and a pointer in the corner cost nothing, for minutes", async () => {
        for (let i = 0; i < 120; i++) {
            const caret = patched(flat(60), 100, 50, 1, 2, 255);
            r.look(i % 3 === 0 ? cursor(flat(60)) : i % 2 ? caret : flat(60), "noise", i % 3 === 0);
            r.wait(1000);
        }
        await r.pipeline.idle();
        assert.deepEqual(r.ocr.reads, []);
        assert.deepEqual(r.models.described, []);
        assert.deepEqual(r.entries(), []);
    });

    it("with fast alerts off a toast in the corner is the slow path's: nothing fast runs", async () => {
        r.settings = { ...r.settings, fastAlerts: false };
        assert.equal(r.pipeline.wantsFast(), false);
        r.hold(flat(60), "home", 3000);
        r.hold(toastA(flat(60)), "toast-a", 10_000);
        await r.pipeline.idle();
        assert.deepEqual(r.ocr.reads, []);
        assert.ok(r.models.described.length > 0, "the whole-screen path saw it, as it always did");
    });

    it("switching them on starts from the screen as it is then: a toast already up is not news", async () => {
        r.settings = { ...r.settings, fastAlerts: false };
        r.hold(toastA(flat(60)), "toast-a", 3000);
        r.settings = { ...r.settings, fastAlerts: true };
        r.hold(toastA(flat(60)), "toast-a", 5000);
        await r.pipeline.idle();
        assert.deepEqual(r.ocr.reads, []);
    });
});

describe("which look is read", () => {
    it("F12: the confirming look when the pop-up is still there, not the first one it was seen in", async () => {
        r.look(toastA(flat(60)), "toast-a-first");
        r.wait(1000);
        r.look(toastA(flat(60)), "toast-a-middle");
        r.wait(SETTLE - 1000);
        r.look(toastA(flat(60)), "toast-a-confirm");
        await r.pipeline.idle();
        assert.deepEqual(r.crops.map((crop) => crop.label), ["toast-a-confirm"]);
    });

    it("F12: a toast that is gone by the confirming look is read from the last look that saw it", async () => {
        r.ocr.texts["crop:toast-a-last"] = EMAIL;
        const seen = r.clock.t;
        r.look(toastA(flat(60)), "toast-a-first");
        r.wait(1000);
        r.look(toastA(flat(60)), "toast-a-last");
        r.wait(SETTLE - 1000);
        r.look(flat(60), "home-confirm"); // dismissed just before the confirming look
        await r.pipeline.idle();
        assert.deepEqual(r.crops.map((crop) => crop.label), ["toast-a-last"]);
        assert.equal(r.push.sent.length, 1);
        const latency = r.entries()[0]!.latency!;
        assert.equal(latency.firstSeenAt, seen);
        assert.equal(latency.detectedAt, seen + SETTLE);
        assert.equal(latency.capturedAt, seen + 1000, "the frame that was read, not the confirming one");
    });

    it("F12: one that is gone a look earlier still, inside the settle time, was a flash and is not read", async () => {
        r.look(toastA(flat(60)), "toast-a");
        r.wait(1000);
        r.look(flat(60), "home");
        r.wait(5000);
        r.look(flat(60), "home");
        await r.pipeline.idle();
        assert.deepEqual(r.crops, []);
    });
});

describe("the slow path beside it", () => {
    it("F6: a change outside the corner is checked exactly as without fast alerts", async () => {
        const run = async (fastAlerts: boolean) => {
            const each = rig({ fastAlerts });
            each.hold(flat(60), "home", 3000);
            each.hold(dialog(flat(60)), "install finished", 9000);
            await each.pipeline.idle();
            return { models: each.models, push: each.push, log: each.entries() };
        };
        const off = await run(false);
        const on = await run(true);
        assert.deepEqual(on.models.described, off.models.described);
        assert.deepEqual(on.models.described, ["home", "install finished"]);
        assert.deepEqual(on.models.alerted, []);
        assert.deepEqual(on.models.decided.map((d) => d.current), off.models.decided.map((d) => d.current));
        assert.deepEqual(on.log.map(({ kind, score, outcome }) => ({ kind, score, outcome })), off.log.map(({ kind, score, outcome }) => ({ kind, score, outcome })));
        assert.equal(on.push.sent.length, off.push.sent.length);
    });

    it("F6: a toast is told once, by the fast path: the slow path does not also check it six seconds later, nor when it stays 30 s", async () => {
        r.hold(toastA(flat(60)), "toast-a", 30_000);
        await r.pipeline.idle();
        assert.deepEqual(r.ocr.reads, ["crop:toast-a"]);
        assert.deepEqual(r.models.described, [], "no whole-screen description");
        assert.equal(r.push.sent.length, 1);
        assert.deepEqual(r.entries().map((e) => e.kind), ["alert"]);
    });

    it("a change that overlaps the corner and the rest of the screen is still seen by the slow path, outside the corner", async () => {
        const both = patched(toastA(flat(60)), 20, 10, 16, 8, 240);
        r.hold(both, "both", 12_000);
        await r.pipeline.idle();
        assert.equal(r.ocr.reads.length, 1);
        assert.deepEqual(r.models.described, ["home", "both"]);
    });
});

describe("one notification per toast", () => {
    it("F3: two toasts 5 seconds apart are two notifications", async () => {
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        r.wait(1000);
        r.hold(flat(60), "home", 3800); // gone after the first 5 s on screen
        r.toast(toastB(flat(60)), "toast-b");
        await r.pipeline.idle();
        assert.deepEqual(r.ocr.reads, ["crop:toast-a", "crop:toast-b"]);
        assert.equal(r.push.sent.length, 2);
        assert.match(r.push.sent[0]!.payload.body, /Anna Berg/);
        assert.match(r.push.sent[1]!.payload.body, /Ben Carter/);
        assert.notEqual(r.push.sent[0]!.payload.tag, r.push.sent[1]!.payload.tag, "two messages are two notifications");
    });

    it("F3/F9: a second toast inside the gap waits for it and is read from its own frame, even if it is gone by then", async () => {
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        r.wait(800);
        r.look(toastB(toastA(flat(60))), "toast-b");
        r.wait(SETTLE);
        r.look(toastB(toastA(flat(60))), "toast-b");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 1, "inside the 4 s gap: waiting");
        r.look(flat(60), "home");
        r.wait(GAP);
        r.look(flat(60), "home");
        await r.pipeline.idle();
        assert.deepEqual(r.ocr.reads, ["crop:toast-a", "crop:toast-b"]);
        assert.equal(r.push.sent.length, 2);
    });

    it("F9: three toasts inside the gap: the middle one is replaced and logged as skipped, the newest is read when the gap ends", async () => {
        r.ocr.texts["crop:toast-c"] = ["Outlook", "Dana Ruiz", "Invoice 4471", "Please find the invoice attached"];
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        r.wait(600);
        r.toast(toastB(toastA(flat(60))), "toast-b");
        r.wait(400);
        r.toast(patched(toastB(toastA(flat(60))), 85, 60, 20, 6, 120), "toast-c");
        r.wait(GAP);
        r.look(flat(60), "home");
        await r.pipeline.idle();
        assert.deepEqual(r.ocr.reads, ["crop:toast-a", "crop:toast-c"]);
        const skipped = r.entries().filter((entry) => entry.outcome === "skipped");
        assert.equal(skipped.length, 1);
        assert.match(skipped[0]!.reason ?? "", /replaced by a newer pop-up/);
        assert.equal(skipped[0]!.asked, false);
    });

    it("F4: the same toast text twice inside 30 seconds is notified once, and again after 30 seconds", async () => {
        r.ocr.texts = { "crop:toast-a": EMAIL, "crop:toast-b": EMAIL };
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        r.hold(flat(60), "home", 6000);
        r.toast(toastB(flat(60)), "toast-b");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 1);
        const second = r.entries()[1]!;
        assert.equal(second.outcome, "skipped");
        assert.match(second.reason ?? "", /same pop-up text was notified \d+ seconds ago/);
        assert.equal(second.asked, true, "it was read, so it counts as a check");
        r.hold(flat(60), "home", FAST_DUPLICATE_MS);
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 2);
    });

    it("the same words read slightly differently (case, spacing, a stray glyph) are still the same text", async () => {
        r.ocr.texts = { "crop:toast-a": EMAIL, "crop:toast-b": ["OUTLOOK", "Anna  Berg", "Lunch on Thursday?", "Are you free at 12:30 for the quarterly review", "×"] };
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        r.hold(flat(60), "home", 6000);
        r.toast(toastB(flat(60)), "toast-b");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 1);
    });
});

describe("what the text says, and what is decided", () => {
    it("F7: with no rule nothing leaves the host: no vision model, no Jev, and no key needed at all", async () => {
        r.provider = undefined;
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 1);
        assert.deepEqual(r.models.decided, []);
        assert.deepEqual(r.models.described, []);
        assert.deepEqual(r.models.alerted, []);
        const entry = r.entries()[0]!;
        assert.equal(entry.outcome, "pushed");
        assert.equal(entry.noul, undefined);
        assert.equal(entry.model, undefined);
        assert.equal(entry.read?.by, "ocr");
    });

    it("F7: with a rule, Jev is asked about the pop-up's text as the slow path asks it, and a no sends nothing", async () => {
        r.settings = { ...r.settings, rule: "tell me about emails from Anna" };
        r.models.answers = [0.02];
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.deepEqual(r.models.decided, [
            { previous: ALERT_PREVIOUS, current: "Outlook: Outlook | Anna Berg | Lunch on Thursday? | Are you free at 12:30 for the quarterly review", rule: "tell me about emails from Anna" },
        ]);
        assert.equal(ALERT_PREVIOUS, "(none)");
        assert.equal(r.push.sent.length, 0);
        assert.equal(r.entries()[0]!.outcome, "no");
        assert.equal(r.entries()[0]!.noul, 0.02);
    });

    it("F7: with a rule a decisive yes pushes, and an answer in between does not; the same thresholds as the slow path", async () => {
        r.settings = { ...r.settings, rule: "tell me about emails from Anna" };
        r.models.answers = [0.95, 0.5];
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 1);
        assert.equal(r.entries()[0]!.noul, 0.95);
        r.hold(flat(60), "home", 6000);
        r.toast(toastB(flat(60)), "toast-b");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 1);
        assert.equal(r.entries()[1]!.outcome, "undecided");
    });

    it("F7: a decision answered from the cache is logged as such", async () => {
        r.settings = { ...r.settings, rule: "anything from Outlook" };
        r.models.cache = true;
        r.models.answers = [0.95];
        r.ocr.texts = { "crop:toast-a": EMAIL, "crop:toast-b": EMAIL };
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        r.hold(flat(60), "home", FAST_DUPLICATE_MS + 1000);
        r.toast(toastB(flat(60)), "toast-b");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 2);
        assert.equal(r.entries()[1]!.fromCache, true);
    });

    it("F7: a rule without a key cannot be judged: logged as an error, nothing sent", async () => {
        r.settings = { ...r.settings, rule: "anything from Outlook" };
        r.provider = undefined;
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 0);
        assert.equal(r.entries()[0]!.outcome, "error");
        assert.match(r.entries()[0]!.reason ?? "", /rule needs the OpenRouter key/);
    });

    it("text that is not a pop-up's (a few stray glyphs) sends nothing, and the log says how many words were read", async () => {
        r.ocr.texts = { "crop:toast-a": ["10:42", "×", "ab"] };
        r.look(patched(flat(60), 100, 45, 10, 6, 240), "toast-a");
        r.wait(SETTLE);
        r.look(patched(flat(60), 100, 45, 10, 6, 240), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 0);
        const entry = r.entries()[0]!;
        assert.equal(entry.outcome, "skipped");
        assert.match(entry.reason ?? "", /no readable text \(1 words read\)/);
        assert.deepEqual(r.models.alerted, [], "a change that small is not a dialog: no vision model");
    });
});

describe("calls", () => {
    it("F8: a call has a call's title, urgency high, a 60 second time to live and a tag of its caller; a message is normal and lives 5 minutes", async () => {
        r.toast(toastA(flat(60)), "toast-c");
        await r.pipeline.idle();
        const call = r.push.sent[0]!;
        assert.equal(call.payload.title, "Incoming call: Priya Shah");
        assert.match(call.payload.tag, /^pikvm-call-[0-9a-f]{8}$/);
        assert.equal(call.payload.url, "/app/");
        assert.deepEqual(call.options, { urgency: "high", ttlSeconds: FAST_CALL_TTL_SEC });
        assert.equal(FAST_CALL_TTL_SEC, 60);

        r.hold(flat(60), "home", 6000);
        r.toast(toastB(flat(60)), "toast-a");
        await r.pipeline.idle();
        const email = r.push.sent[1]!;
        assert.equal(email.payload.title, "Outlook");
        assert.match(email.payload.tag, /^pikvm-alert-/);
        assert.deepEqual(email.options, { urgency: "normal", ttlSeconds: FAST_ALERT_TTL_SEC });
    });

    it("F8: a caller who rings again later updates the same notification (the same tag); another caller is another one", async () => {
        r.ocr.texts = {
            "crop:toast-c": CALL,
            "crop:toast-d": CALL,
            "crop:toast-e": ["Microsoft Teams", "Ben Carter is calling you", "Accept", "Decline"],
        };
        r.toast(toastA(flat(60)), "toast-c");
        await r.pipeline.idle();
        r.hold(flat(60), "home", FAST_DUPLICATE_MS + 1000);
        r.toast(toastA(flat(60)), "toast-d");
        await r.pipeline.idle();
        r.hold(flat(60), "home", 6000);
        r.toast(toastB(flat(60)), "toast-e");
        await r.pipeline.idle();
        const tags = r.push.sent.map((sent) => sent.payload.tag);
        assert.equal(tags[0], tags[1]);
        assert.notEqual(tags[1], tags[2]);
    });
});

describe("its own gap and cap", () => {
    it("F9: the fast daily cap is held and says so, and counts fast checks only", async () => {
        const small = rig({ fastCap: 2 });
        small.ocr.texts = { "crop:toast-a": EMAIL, "crop:toast-b": TEAMS, "crop:toast-c": CALL };
        small.hold(flat(60), "home", 3000);
        for (const [grid, label] of [[toastA(flat(60)), "toast-a"], [toastB(flat(60)), "toast-b"], [toastA(flat(60)), "toast-c"]] as const) {
            small.toast(grid, label);
            await small.pipeline.idle();
            small.hold(flat(60), "home", 6000);
        }
        assert.deepEqual(small.ocr.reads, ["crop:toast-a", "crop:toast-b"]);
        assert.equal(small.push.sent.length, 2);
        const last = small.entries().at(-1)!;
        assert.equal(last.outcome, "skipped");
        assert.match(last.reason ?? "", /daily cap of 2 fast checks reached/);
        assert.equal(small.store.askedSince(USER, 0, "alert"), 2);
        assert.equal(small.store.askedSince(USER, 0), 0, "the slow path's budget is untouched");
    });

    it("F9: slow checks do not spend the fast cap, and the fast path's checks do not spend the slow path's", async () => {
        const both = rig({ fastCap: 1, dailyCap: 1 });
        both.ocr.texts = { "crop:toast-a": EMAIL };
        both.hold(flat(60), "home", 3000);
        both.hold(dialog(flat(60)), "install", 9000); // one slow check
        await both.pipeline.idle();
        assert.equal(both.models.described.length, 2);
        both.hold(flat(60), "home", 70_000); // past the slow gap
        both.toast(toastA(flat(60)), "toast-a"); // the one fast check
        await both.pipeline.idle();
        assert.equal(both.ocr.reads.length, 1, "the slow check did not use the fast cap");
        assert.equal(both.store.askedSince(USER, 0), 1, "the slow path's one check");
        assert.equal(both.store.askedSince(USER, 0, "alert"), 1);
    });

    it("F9: the slow path's 60 second gap does not hold a fast alert back", async () => {
        r.hold(dialog(flat(60)), "install", 9000); // a slow check just ran
        r.hold(toastA(dialog(flat(60))), "toast-a", 3000);
        await r.pipeline.idle();
        assert.equal(r.ocr.reads.length, 1);
    });

    it("no OpenRouter key does not stop the fast path: it reads and notifies on this host", async () => {
        r.provider = undefined;
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 1);
    });
});

describe("what the log says", () => {
    it("F10: every fast check logs when the frame was captured, seen, held, read, decided and pushed, and the total", async () => {
        r.ocr.afterRead = () => r.wait(700);
        const send = r.push.send.bind(r.push);
        r.push.send = async (userId, payload, options) => {
            r.wait(300);
            return send(userId, payload, options);
        };
        const firstSeen = r.clock.t;
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        const entry = r.entries()[0]!;
        assert.equal(entry.kind, "alert");
        assert.equal(entry.outcome, "pushed");
        assert.equal(entry.asked, true);
        assert.ok(entry.score !== null && entry.score > 0.1);
        assert.deepEqual(entry.latency, {
            firstSeenAt: firstSeen,
            capturedAt: firstSeen + SETTLE,
            detectedAt: firstSeen + SETTLE,
            readAt: firstSeen + SETTLE + 700,
            decidedAt: firstSeen + SETTLE + 700,
            pushedAt: firstSeen + SETTLE + 1000,
            totalMs: 1000,
            sinceFirstSeenMs: SETTLE + 1000,
        });
        assert.deepEqual(entry.read, { by: "ocr", ms: 120, chars: EMAIL.join("\n").length, words: 15, lines: 4 });
        assert.deepEqual(entry.push, { sent: 1, removed: 0, failed: 0 });
        assert.equal(entry.notified?.kind, "email");
        assert.equal(entry.notified?.urgency, "normal");
        assert.equal(entry.notified?.ttlSec, FAST_ALERT_TTL_SEC);
        assert.equal(entry.notified?.titleChars, "Outlook".length);
        assert.deepEqual(r.ocr.limits, [OCR_TIMEOUT_MS]);
    });

    it("F10: the screen's words are not in the log, or in the notified facts, unless the host is asked to log them", async () => {
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        const text = JSON.stringify(r.entries());
        for (const word of ["Anna", "Berg", "Lunch", "Thursday", "quarterly", "Outlook"]) assert.ok(!text.includes(word), `"${word}" is not in the log`);

        const loud = rig({ logText: true });
        loud.ocr.texts = { "crop:toast-a": EMAIL };
        loud.hold(flat(60), "home", 3000);
        loud.toast(toastA(flat(60)), "toast-a");
        await loud.pipeline.idle();
        const entry = loud.entries()[0]!;
        assert.equal(entry.notified?.title, "Outlook");
        assert.match(entry.notified?.body ?? "", /Anna Berg/);
        assert.equal(entry.description, EMAIL.join("\n"));
    });

    it("F10: a check that stops short still logs the timestamps it got to", async () => {
        r.ocr.texts = { "crop:toast-a": ["x"] };
        r.ocr.afterRead = () => r.wait(400);
        r.look(patched(flat(60), 100, 45, 10, 6, 240), "toast-a");
        r.wait(SETTLE);
        r.look(patched(flat(60), 100, 45, 10, 6, 240), "toast-a");
        await r.pipeline.idle();
        const latency = r.entries()[0]!.latency!;
        assert.equal(latency.readAt, latency.detectedAt + 400);
        assert.equal(latency.pushedAt, undefined);
        assert.equal(latency.totalMs, undefined);
    });

    it("a failed push is logged as an error with the pop-up's timestamps, and the next pop-up is still read", async () => {
        r.push.fail = new PushError("No device has subscribed to notifications yet.", "none");
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.entries()[0]!.outcome, "error");
        assert.match(r.entries()[0]!.reason ?? "", /No device has subscribed/);
        assert.equal(r.entries()[0]!.latency!.pushedAt, undefined, "never pushed, so no pushed time");
        r.push.fail = null;
        r.hold(flat(60), "home", 6000);
        r.toast(toastB(flat(60)), "toast-b");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 1);
    });
});

describe("what the OCR is sent", () => {
    it("F11: only the cells that changed and a margin of two cells, inside the zone, cut from the frame that was read", async () => {
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        // The toast is cells x 100..123, y 45..53; two cells more each way.
        assert.deepEqual(r.crops, [{ label: "toast-a", cells: { x0: 98, y0: 43, x1: 126, y1: 56 } }]);
        assert.deepEqual(r.ocr.reads, ["crop:toast-a"]);
    });

    it("F11: a margin never reaches outside the zone", async () => {
        r.ocr.texts["crop:toast-b"] = TEAMS;
        r.toast(patched(flat(60), 110, 55, 18, 17, 240), "toast-b");
        await r.pipeline.idle();
        assert.deepEqual(r.crops[0]!.cells, { x0: 108, y0: 53, x1: 128, y1: 72 });
    });

    it("a different corner is watched from the next look: a toast in the old corner is ignored, one in the new corner is read", async () => {
        r.settings = { ...r.settings, alertZone: ALERT_ZONES[3].zone };
        r.hold(flat(60), "home", 3000);
        r.hold(toastA(flat(60)), "toast-a", 6000);
        await r.pipeline.idle();
        assert.deepEqual(r.ocr.reads, [], "bottom right is not the zone any more (and the slow path is the one that sees it)");
        r.hold(flat(60), "home", 3000);
        r.ocr.texts["crop:toast-b"] = TEAMS;
        r.toast(toastTopLeft(flat(60)), "toast-b");
        await r.pipeline.idle();
        assert.deepEqual(r.ocr.reads, ["crop:toast-b"]);
    });
});

describe("a change of the whole corner, and a pop-up over a page", () => {
    const page = (level: number) => patched(flat(60), 79, 39, 49, 33, level);

    it("F15: the whole corner changing (a window, the desktop) is logged as not a pop-up and is not read, and costs no check", async () => {
        r.hold(page(200), "page", 4000);
        await r.pipeline.idle();
        assert.deepEqual(r.ocr.reads, []);
        const entry = r.entries()[0]!;
        assert.equal(entry.kind, "alert");
        assert.equal(entry.outcome, "skipped");
        assert.match(entry.reason ?? "", /100% of the corner changed: that is a window or the whole screen/);
        assert.equal(entry.asked, false);
        assert.equal(r.store.askedSince(USER, 0, "alert"), 0);
    });

    it("F15: a toast over a page is read as the toast, not the page, and its going away is not a second pop-up", async () => {
        r.hold(page(200), "page", 4000);
        r.wait(1000);
        r.hold(patched(page(200), 100, 45, 24, 9, 20), "toast-a", 4000);
        r.hold(page(200), "page", 8000);
        await r.pipeline.idle();
        assert.deepEqual(r.crops.map((crop) => crop.cells), [{ x0: 98, y0: 43, x1: 126, y1: 56 }], "the cells the toast changed, not the page's");
        assert.equal(r.push.sent.length, 1);
        assert.equal(r.entries().filter((entry) => entry.outcome !== "skipped").length, 1);
    });
});

describe("text that is the window behind the pop-up", () => {
    // toastA's cells are x 100..124, y 45..54; the crop is x 98..126, y 43..56: the pop-up is the middle 86% across and 69% down.
    const at = (y: number) => ({ x0: 0.1, y0: y - 0.04, x1: 0.9, y1: y + 0.04 });
    const WITH_PAGE = ["Outlook", "Anna Berg", "Lunch on Thursday?", "Figure 18: margins held at 48%"];

    it("F14: lines the OCR places outside the cells that changed are the page behind, and are not in the notification", async () => {
        r.ocr.texts = { "crop:toast-a": WITH_PAGE };
        r.ocr.boxes = { "crop:toast-a": [at(0.3), at(0.45), at(0.6), at(0.03)] };
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 1);
        assert.equal(r.push.sent[0]!.payload.body, "Anna Berg: Lunch on Thursday?");
        assert.equal(r.entries()[0]!.read?.lines, 3);
    });

    it("F14: when the OCR does not say where lines are, all of them are kept", async () => {
        r.ocr.texts = { "crop:toast-a": WITH_PAGE };
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.match(r.push.sent[0]!.payload.body, /Figure 18/);
    });

    it("F14: when every line is outside the cells that changed they are all kept, not none", async () => {
        r.ocr.texts = { "crop:toast-a": EMAIL };
        r.ocr.boxes = { "crop:toast-a": [at(0.02), at(0.04), at(0.97), at(0.99)] };
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.match(r.push.sent[0]!.payload.body, /Anna Berg/);
    });
});

describe("when the OCR does not deliver and the cloud fallback is off (the default)", () => {
    it("F16: a timed-out OCR with a key configured sends nothing anywhere: no vision model, no Jev, and the log says why", async () => {
        r.ocr.error = new OcrTimeoutError(OCR_TIMEOUT_MS);
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 0);
        assert.deepEqual(r.models.alerted, []);
        assert.deepEqual(r.models.described, []);
        assert.deepEqual(r.models.decided, []);
        const entry = r.entries()[0]!;
        assert.equal(entry.outcome, "error");
        assert.match(entry.reason ?? "", /^ocr timed out, and the cloud fallback is off \(PIKVM_WATCH_FAST_CLOUD_FALLBACK\), so nothing was sent/);
        assert.equal(entry.model, undefined);
        assert.equal(entry.description, undefined);
    });

    it("F16: so does too few words in a dialog-sized change", async () => {
        r.ocr.texts = { "crop:toast-a": ["Ping"] };
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 0);
        assert.deepEqual(r.models.alerted, []);
        assert.equal(r.entries()[0]!.outcome, "skipped");
        assert.match(r.entries()[0]!.reason ?? "", /cloud fallback is off/);
    });
});

describe("when the OCR does not deliver and the operator turned the cloud fallback on", () => {
    beforeEach(() => {
        r = rig({ cloudFallback: true });
        r.ocr.texts = { "crop:toast-a": EMAIL, "crop:toast-b": TEAMS, "crop:toast-c": CALL };
        r.hold(flat(60), "home", 3000);
    });

    it("F13: an OCR that passes its time is logged as 'ocr timed out'; with no key nothing is sent", async () => {
        r.provider = undefined;
        r.ocr.error = new OcrTimeoutError(OCR_TIMEOUT_MS);
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 0);
        const entry = r.entries()[0]!;
        assert.equal(entry.outcome, "error");
        assert.match(entry.reason ?? "", /^ocr timed out, and there is no OpenRouter key/);
        assert.deepEqual(r.models.alerted, []);
    });

    it("F13: with a key it falls back to the vision model on the same crop, and the log says that path ran and why", async () => {
        r.ocr.error = new OcrTimeoutError(OCR_TIMEOUT_MS);
        r.models.alertText = { "crop:toast-a": "Outlook: new email from Anna Berg, subject Lunch on Thursday?" };
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.deepEqual(r.models.alerted, ["crop:toast-a"]);
        assert.equal(r.push.sent.length, 1);
        assert.match(r.push.sent[0]!.payload.body, /Anna Berg/);
        const entry = r.entries()[0]!;
        assert.equal(entry.outcome, "pushed");
        assert.equal(entry.read?.by, "vision");
        assert.equal(entry.read?.fallback, "ocr timed out");
        assert.equal(entry.model, "vision/test");
        assert.equal(entry.description, undefined, "the vision model's words are not logged either");
        assert.ok((entry.costUsd ?? 0) > 0);
    });

    it("F13: any other OCR failure is logged with its message, and falls back the same way", async () => {
        r.provider = undefined;
        r.ocr.error = new Error("the OCR process exited (SIGKILL)");
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.match(r.entries()[0]!.reason ?? "", /^ocr failed: the OCR process exited \(SIGKILL\)/);
    });

    it("F13: fewer than 3 words in a change big enough to be a dialog is doubted: the vision model is asked, when there is a key", async () => {
        r.ocr.texts = { "crop:toast-a": ["Ping"] };
        r.models.alertText = { "crop:toast-a": "Slack: a message from Ben: Ping" };
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.deepEqual(r.models.alerted, ["crop:toast-a"]);
        assert.equal(r.push.sent.length, 1);
        assert.match(r.entries()[0]!.read?.fallback ?? "", /read 1 words \(fewer than 3\)/);
    });

    it("F13: and without a key it logs that and sends nothing", async () => {
        r.provider = undefined;
        r.ocr.texts = { "crop:toast-a": ["Ping"] };
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 0);
        assert.equal(r.entries()[0]!.outcome, "skipped");
        assert.match(r.entries()[0]!.reason ?? "", /no OpenRouter key for the vision model/);
    });

    it("F13: the vision model saying there is no notification sends nothing", async () => {
        r.ocr.error = new OcrTimeoutError(OCR_TIMEOUT_MS);
        r.models.alertText = { "crop:toast-a": "No notification." };
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 0);
        assert.equal(r.entries()[0]!.outcome, "no");
    });

    it("F13: a vision model that fails too is logged as an error and the next pop-up is still read", async () => {
        r.ocr.error = new OcrTimeoutError(OCR_TIMEOUT_MS);
        r.models.describeError = new ModelError("OpenRouter answered 503.", "http", 503);
        r.toast(toastA(flat(60)), "toast-a");
        await r.pipeline.idle();
        assert.equal(r.entries()[0]!.outcome, "error");
        assert.match(r.entries()[0]!.reason ?? "", /503/);
        r.ocr.error = null;
        r.models.describeError = null;
        r.hold(flat(60), "home", 6000);
        r.toast(toastB(flat(60)), "toast-b");
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 1);
    });
});
