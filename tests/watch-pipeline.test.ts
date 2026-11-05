/**
 * One user's watch: the model check behind the settle detector, and everything that bounds it.
 *
 * Failure modes, before behaviour:
 *  P1. A model is asked about a screen that has not settled, or that did not change.
 *  P2. One change costs more than one check (two descriptions every time, or a decision asked twice).
 *  P3. Jev's "no", or an answer between yes and no, sends a notification.
 *  P4. Jev's "yes" sends none, or sends it twice, or with text that is not from the image model's description.
 *  P5. Changes in quick succession each cost a check (the minimum gap is ignored), or the newest one is lost.
 *  P6. The daily cap is not held, or a restart forgets it.
 *  P7. No key: a model call is made anyway, or the change vanishes without a trace.
 *  P8. A failed model call leaves the person without a line in the log saying why nothing came.
 *  P9. Two checks run at once.
 *  P10. The signal going away is described by the image model (it has nothing to look at), or is announced at start-up.
 */
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { notificationBody } from "../src/server/watch/alert-text";
import { DEFAULT_SETTLE_MS, limitsFromEnv } from "../src/server/watch/limits";
import { ModelError, type ModelProvider } from "../src/server/watch/models";
import { createPipeline, NO_SIGNAL_TEXT, type Pipeline } from "../src/server/watch/pipeline";
import { PushError } from "../src/server/watch/push";
import { DEFAULT_ALERT_ZONE } from "@pikvm/contracts/watch";
import type { WatchSettings, WatchStore } from "../src/server/watch/store";
import { dialog, fakeModels, fakeOcr, fakePush, flat, PROVIDER, patched, tempDir, tempStore, type FakeModels, type FakeOcr, type FakePush, type TempDir } from "./support/watch-rig";

const STEP = 3000;
const GAP = 60_000;
const USER = "operator";

interface Rig {
    dir: TempDir;
    store: WatchStore;
    models: FakeModels;
    /** The OCR the whole-screen path reads with when there is no key. Not installed unless a test says so. */
    screenOcr: FakeOcr;
    push: FakePush;
    settings: WatchSettings;
    provider: ModelProvider | undefined;
    clock: { t: number };
    readonly pipeline: Pipeline;
    /** Look at `label`'s screen for as long as it takes to settle. */
    show(grid: Uint8Array, label: string): Promise<void>;
    restart(): Pipeline;
}

function rig(over: { dailyCap?: number; prepare?: (jpeg: Buffer) => Promise<Buffer> } = {}): Rig {
    const dir = tempDir();
    const store = tempStore(dir.path);
    const build = (): Pipeline =>
        createPipeline({
            userId: USER,
            store,
            push: result.push,
            models: result.models,
            provider: () => result.provider,
            settings: () => result.settings,
            limits: { ...limitsFromEnv({}), intervalMs: STEP, settleMs: DEFAULT_SETTLE_MS, minCheckGapMs: GAP, dailyCap: over.dailyCap ?? 100 },
            now: () => result.clock.t,
            prepare: over.prepare ?? (async (jpeg) => jpeg),
            ocr: fakeOcr(),
            screenOcr: result.screenOcr,
            crop: async (jpeg) => jpeg,
        });
    const result: Rig = {
        dir,
        store,
        models: fakeModels(),
        screenOcr: Object.assign(fakeOcr(), { unavailableReason: "no OCR in this test" }),
        push: fakePush(),
        settings: { enabled: true, rule: "", visionModel: "vision/test", fastAlerts: false, alertZone: DEFAULT_ALERT_ZONE },
        provider: PROVIDER,
        clock: { t: 1_000_000 },
        get pipeline(): Pipeline {
            return current;
        },
        async show(grid, label) {
            const frame = { grid, jpeg: Buffer.from(label) };
            // Three looks, six seconds: enough to settle.
            for (let i = 0; i < 3; i++) {
                current.look(frame, result.clock.t);
                result.clock.t += STEP;
            }
            await current.idle();
        },
        restart() {
            current = build();
            return current;
        },
    };
    let current = build();
    return result;
}

let r: Rig;
const rigs: Rig[] = [];
beforeEach(() => {
    r = rig();
    rigs.push(r);
});
afterEach(() => undefined);
after(() => rigs.forEach((each) => each.dir.remove()));

/** The screen as it is when the watch starts. */
async function begin(rg: Rig): Promise<void> {
    rg.pipeline.look({ grid: flat(60), jpeg: Buffer.from("home") }, rg.clock.t);
    rg.clock.t += STEP;
    await rg.pipeline.idle();
}

describe("what costs a model call", () => {
    it("P1: nothing on a screen that does not change, or whose change has not settled", async () => {
        await begin(r);
        for (let i = 0; i < 30; i++) {
            r.pipeline.look({ grid: flat(60), jpeg: Buffer.from("home") }, r.clock.t);
            r.clock.t += STEP;
        }
        // A change that is still moving at every look.
        for (let i = 0; i < 10; i++) {
            r.pipeline.look({ grid: patched(flat(60), (i * 9) % 40, 10, 16, 8, 240), jpeg: Buffer.from(`moving ${i}`) }, r.clock.t);
            r.clock.t += STEP;
        }
        await r.pipeline.idle();
        assert.deepEqual(r.models.described, []);
        assert.deepEqual(r.models.decided, []);
        assert.deepEqual(r.store.log(USER, 10), []);
    });

    it("P2: a settled change is one check: the frame before is described once, the new one once, one decision", async () => {
        await begin(r);
        await r.show(dialog(flat(60)), "install finished");
        assert.deepEqual(r.models.described, ["home", "install finished"]);
        assert.equal(r.models.decided.length, 1);
        assert.match(r.models.decided[0]!.previous, /^Screen home\./);
        assert.match(r.models.decided[0]!.current, /^Screen install finished\./);

        // The next change already has the previous description: one description, one decision.
        r.clock.t += GAP;
        await r.show(flat(60), "desktop");
        assert.deepEqual(r.models.described, ["home", "install finished", "desktop"]);
        assert.equal(r.models.decided.length, 2);
        assert.match(r.models.decided[1]!.previous, /^Screen install finished\./);
    });

    it("a decision answered from the cache is logged as such, still counts as a check, and still pushes on a yes", async () => {
        r.models.cache = true;
        r.models.answers = [0.95];
        await begin(r);
        for (const [grid, label] of [[dialog(flat(60)), "failed"], [flat(60), "home again"], [dialog(flat(60)), "failed"], [flat(60), "home again"]] as const) {
            await r.show(grid, label);
            r.clock.t += GAP;
        }
        const log = r.store.log(USER, 10).reverse();
        assert.deepEqual(log.map((entry) => entry.fromCache ?? false), [false, false, false, true], "the fourth asks what the second asked");
        assert.equal(r.models.decided.length, 4, "the client was asked, and answered from its cache");
        assert.deepEqual(log.map((entry) => entry.outcome), ["pushed", "pushed", "pushed", "pushed"]);
        assert.ok(log.every((entry) => entry.asked), "a cached answer is still a check for the daily cap");
    });

    it("hands the person's rule and the model's id to the calls", async () => {
        r.settings = { ...r.settings, rule: "tell me when the install finishes" };
        await begin(r);
        await r.show(dialog(flat(60)), "x");
        assert.equal(r.models.decided[0]!.rule, "tell me when the install finishes");
        const [entry] = r.store.log(USER, 1);
        assert.equal(entry!.model, "vision/test");
        assert.equal(entry!.rule, "tell me when the install finishes");
    });
});

describe("what Jev decides", () => {
    it("P3: no and not-decisive send nothing, and the log says which", async () => {
        await begin(r);
        r.models.answers = [0.02, 0.5, 0.84];
        for (const [i, label] of ["a", "b", "c"].entries()) {
            await r.show(i % 2 ? flat(60) : dialog(flat(60)), label);
            r.clock.t += GAP;
        }
        assert.deepEqual(r.push.sent, []);
        const outcomes = r.store.log(USER, 10).reverse().map((entry) => entry.outcome);
        assert.deepEqual(outcomes, ["no", "undecided", "undecided"]);
        const undecided = r.store.log(USER, 10).find((entry) => entry.outcome === "undecided");
        assert.match(undecided!.reason ?? "", /not decisive/);
    });

    it("P4: a decisive yes sends exactly one notification, its text from the description, and logs it", async () => {
        await begin(r);
        r.models.answers = [0.9];
        await r.show(dialog(flat(60)), "Install complete");
        assert.equal(r.push.sent.length, 1);
        assert.equal(r.push.sent[0]!.userId, USER);
        assert.deepEqual(r.push.sent[0]!.payload, { title: "PiKVM", body: "Screen Install complete. Something else.", tag: "pikvm-screen", url: "/app/", badge: 1 });
        const [entry] = r.store.log(USER, 1);
        assert.equal(entry!.outcome, "pushed");
        assert.equal(entry!.noul, 0.9);
        assert.equal(entry!.description, "Screen Install complete. Something else.");
        assert.equal(entry!.asked, true);
        assert.ok((entry!.costUsd ?? 0) > 0);
        assert.deepEqual(entry!.push, { sent: 1, removed: 0, failed: 0 });
        // Nothing more happens while the screen stays put.
        for (let i = 0; i < 10; i++) {
            r.pipeline.look({ grid: dialog(flat(60)), jpeg: Buffer.from("Install complete") }, r.clock.t);
            r.clock.t += STEP;
        }
        await r.pipeline.idle();
        assert.equal(r.push.sent.length, 1);
    });

    it("a yes with nobody subscribed is logged as an error, not as a push", async () => {
        await begin(r);
        r.models.answers = [0.95];
        r.push.fail = new PushError("No device has subscribed to notifications yet.", "none");
        await r.show(dialog(flat(60)), "x");
        const [entry] = r.store.log(USER, 1);
        assert.equal(entry!.outcome, "error");
        assert.match(entry!.reason ?? "", /No device has subscribed/);
    });

    it("a yes where every subscription had expired is an error that says so", async () => {
        await begin(r);
        r.models.answers = [0.95];
        r.push.result = { sent: 0, removed: 1, failed: [] };
        await r.show(dialog(flat(60)), "x");
        const [entry] = r.store.log(USER, 1);
        assert.equal(entry!.outcome, "error");
        assert.deepEqual(entry!.push, { sent: 0, removed: 1, failed: 0 });
    });

    it("the notification body is the first sentence, plus the second while both fit in 160 characters", () => {
        assert.equal(notificationBody("A dialog says Install complete. The terminal is behind it. A third sentence."), "A dialog says Install complete. The terminal is behind it.");
        assert.equal(notificationBody("A dialog says Install complete."), "A dialog says Install complete.");
        const long = `${"x".repeat(100)}. ${"y".repeat(100)}.`;
        assert.equal(notificationBody(long), `${"x".repeat(100)}.`, "the second does not fit");
        assert.equal(notificationBody("x".repeat(400)).length, 160);
        assert.ok(notificationBody("x".repeat(400)).endsWith("..."));
        assert.equal(notificationBody("Is it done? Yes! Really."), "Is it done? Yes!");
    });
});

describe("the bounds", () => {
    it("P5: a second change inside the gap waits, the newest wins, and it runs once the gap is over", async () => {
        await begin(r);
        await r.show(dialog(flat(60)), "first");
        assert.equal(r.models.decided.length, 1);

        // Two more changes inside the gap: each settles, neither is checked yet.
        await r.show(flat(60), "second");
        await r.show(dialog(flat(60)), "third");
        assert.equal(r.models.decided.length, 1, "still the first check only");
        assert.ok(r.pipeline.status().waiting);

        // The gap ends at the next look.
        r.clock.t += GAP;
        r.pipeline.look({ grid: dialog(flat(60)), jpeg: Buffer.from("third") }, r.clock.t);
        await r.pipeline.idle();
        assert.equal(r.models.decided.length, 2);
        assert.match(r.models.decided[1]!.current, /^Screen third\./);
        const log = r.store.log(USER, 10).reverse();
        assert.deepEqual(log.map((entry) => entry.outcome), ["no", "skipped", "no"]);
        assert.match(log[1]!.reason ?? "", /replaced by a newer change/);
        assert.equal(log[1]!.asked, false);
    });

    it("P6: past the daily cap nothing is asked and the log says why; a restart does not reset it", async () => {
        r = rig({ dailyCap: 2 });
        rigs.push(r);
        await begin(r);
        for (const [i, label] of ["a", "b"].entries()) {
            await r.show(i % 2 ? flat(60) : dialog(flat(60)), label);
            r.clock.t += GAP;
        }
        assert.equal(r.models.decided.length, 2);

        await r.show(dialog(flat(60)), "c");
        assert.equal(r.models.decided.length, 2, "capped");
        const capped = r.store.log(USER, 1)[0]!;
        assert.equal(capped.outcome, "skipped");
        assert.match(capped.reason ?? "", /daily cap of 2/);

        // A new pipeline (the host restarted) reads the log.
        r.restart();
        await begin(r);
        r.clock.t += GAP;
        await r.show(flat(60), "d");
        assert.equal(r.models.decided.length, 2, "still capped after a restart");

        // A day after the first two checks, the window has moved on.
        r.clock.t += 24 * 60 * 60 * 1000;
        await r.show(dialog(flat(60)), "e");
        assert.equal(r.models.decided.length, 3);
    });

    it("P7: no key means no model call, and a log line saying so", async () => {
        r.provider = undefined;
        await begin(r);
        await r.show(dialog(flat(60)), "x");
        assert.deepEqual(r.models.described, []);
        assert.deepEqual(r.models.decided, []);
        const [entry] = r.store.log(USER, 1);
        assert.equal(entry!.outcome, "skipped");
        assert.match(entry!.reason ?? "", /no OpenRouter key/);
        assert.equal(entry!.asked, false);
    });

    it("P9: one check at a time", async () => {
        const release = Promise.withResolvers<void>();
        let active = 0;
        let most = 0;
        const describe = r.models.describe.bind(r.models);
        r.models.describe = async (...args) => {
            active++;
            most = Math.max(most, active);
            await release.promise;
            try {
                return await describe(...args);
            } finally {
                active--;
            }
        };
        await (async () => {
            await begin(r);
            const frame = { grid: dialog(flat(60)), jpeg: Buffer.from("one") };
            for (let i = 0; i < 3; i++) {
                r.pipeline.look(frame, r.clock.t);
                r.clock.t += STEP;
            }
            assert.equal(r.pipeline.status().checking, true);
            // The screen changes again, settles, while the first check is still waiting on its model.
            const other = { grid: flat(60), jpeg: Buffer.from("two") };
            for (let i = 0; i < 3; i++) {
                r.pipeline.look(other, r.clock.t);
                r.clock.t += STEP;
            }
            r.clock.t += GAP;
            r.pipeline.look(other, r.clock.t);
            assert.ok(r.pipeline.status().waiting, "the second change waits");
            release.resolve();
            await r.pipeline.idle();
            r.pipeline.look(other, r.clock.t);
            await r.pipeline.idle();
        })();
        assert.equal(most, 1);
        assert.equal(r.models.decided.length, 2);
    });
});

describe("when a model call fails", () => {
    it("P8: a failed description is logged with its reason, nothing is decided or sent", async () => {
        await begin(r);
        r.models.describeError = new ModelError("OpenRouter answered 500.", "http", 500);
        await r.show(dialog(flat(60)), "x");
        assert.deepEqual(r.models.decided, []);
        assert.deepEqual(r.push.sent, []);
        const [entry] = r.store.log(USER, 1);
        assert.equal(entry!.outcome, "error");
        assert.equal(entry!.reason, "OpenRouter answered 500.");
    });

    it("a failed decision is logged, counts as asked, and the next check still compares with the last good description", async () => {
        await begin(r);
        await r.show(dialog(flat(60)), "good"); // answers no
        r.clock.t += GAP;
        r.models.decideError = new ModelError("Jev's answer was not the yes/no probability that was asked for.", "shape");
        await r.show(flat(60), "lost");
        const failed = r.store.log(USER, 1)[0]!;
        assert.equal(failed.outcome, "error");
        assert.equal(failed.asked, true);
        r.models.decideError = null;
        r.clock.t += GAP;
        await r.show(dialog(flat(60)), "later");
        assert.match(r.models.decided.at(-1)!.previous, /^Screen good\./);
    });
});

describe("the signal", () => {
    it("P10: losing the signal is one check with no image call; coming back checks the next settled frame against it", async () => {
        await begin(r);
        await r.show(dialog(flat(60)), "working");
        r.clock.t += GAP;
        const before = r.models.described.length;
        r.models.answers = [0.9];
        r.pipeline.signal("lost");
        await r.pipeline.idle();
        assert.equal(r.models.described.length, before, "no frame to describe");
        assert.equal(r.models.decided.at(-1)!.current, NO_SIGNAL_TEXT);
        assert.equal(r.push.sent.length, 1);
        assert.equal(r.store.log(USER, 1)[0]!.kind, "signal-lost");

        r.pipeline.signal("back");
        r.clock.t += GAP;
        r.models.answers = [0.02];
        await r.show(dialog(flat(60)), "booted");
        assert.equal(r.models.decided.at(-1)!.previous, NO_SIGNAL_TEXT);
        assert.match(r.models.decided.at(-1)!.current, /^Screen booted\./);
    });

    it("a watch that starts with no signal remembers it without announcing it", async () => {
        r.pipeline.signal("absent");
        await r.pipeline.idle();
        assert.deepEqual(r.models.decided, []);
        assert.deepEqual(r.store.log(USER, 5), []);
        r.pipeline.signal("back");
        await r.show(dialog(flat(60)), "first picture");
        assert.equal(r.models.decided[0]!.previous, NO_SIGNAL_TEXT);
    });
});

describe("large frames", () => {
    it("are scaled before they reach the model", async () => {
        const seen: string[] = [];
        r = rig({ prepare: async (jpeg) => { seen.push(jpeg.toString()); return Buffer.from(`small ${jpeg.toString()}`); } });
        rigs.push(r);
        await begin(r);
        await r.show(dialog(flat(60)), "big");
        assert.deepEqual(seen, ["home", "big"]);
        assert.deepEqual(r.models.described, ["small home", "small big"]);
    });
});

describe("no key: the whole screen read by this host's OCR", () => {
    beforeEach(() => {
        r.provider = undefined;
        r.screenOcr.unavailableReason = undefined;
    });

    it("P11: a settled change is read by the OCR and reported with its text, and no model is asked", async () => {
        r.screenOcr.texts = { "install finished": ["Terminal", "10:42", "Installation complete", "PostgreSQL 16 was installed successfully"] };
        await begin(r);
        await r.show(dialog(flat(60)), "install finished");
        assert.deepEqual(r.models.described, []);
        assert.deepEqual(r.models.decided, []);
        assert.deepEqual(r.screenOcr.reads, ["install finished"]);
        assert.equal(r.push.sent.length, 1);
        assert.deepEqual(r.push.sent[0]!.payload, { title: "PiKVM", body: "Terminal Installation complete PostgreSQL 16 was installed successfully", tag: "pikvm-screen", url: "/app/", badge: 1 });
        const entry = r.store.log(USER, 1)[0]!;
        assert.equal(entry.outcome, "pushed");
        assert.equal(entry.asked, true);
        assert.deepEqual(entry.read, { by: "ocr", ms: 120, chars: 77, words: 8, lines: 4 });
        assert.equal(entry.description, undefined, "the screen's words are not in the log");
        assert.equal(entry.model, undefined);
    });

    it("P11: the text is the first 600 characters in reading order, the furniture left out", async () => {
        r.screenOcr.texts = { big: ["Word ".repeat(300), "10:42"] };
        await begin(r);
        await r.show(dialog(flat(60)), "big");
        const body = r.push.sent[0]!.payload.body;
        assert.ok(body.length <= 160);
        assert.ok(!/10:42/.test(body));
    });

    it("P11: a rule cannot be judged without Jev: logged as an error, nothing is read and nothing sent", async () => {
        r.settings = { ...r.settings, rule: "tell me when the install finishes" };
        await begin(r);
        await r.show(dialog(flat(60)), "install finished");
        assert.deepEqual(r.screenOcr.reads, []);
        assert.equal(r.push.sent.length, 0);
        const entry = r.store.log(USER, 1)[0]!;
        assert.equal(entry.outcome, "error");
        assert.match(entry.reason ?? "", /rule needs the OpenRouter key/);
    });

    it("P11: an OCR that fails is logged with its message, and the watch goes on", async () => {
        r.screenOcr.error = new Error("the OCR process exited (SIGKILL)");
        await begin(r);
        await r.show(dialog(flat(60)), "install finished");
        assert.equal(r.push.sent.length, 0);
        assert.match(r.store.log(USER, 1)[0]!.reason ?? "", /the OCR process exited/);
        r.screenOcr.error = null;
        r.screenOcr.texts = { next: ["Back at the desktop", "all done here"] };
        r.clock.t += GAP;
        await r.show(flat(60), "next");
        assert.equal(r.push.sent.length, 1);
    });

    it("P11: the signal lost is reported without reading anything", async () => {
        await begin(r);
        r.pipeline.signal("lost");
        await r.pipeline.idle();
        assert.deepEqual(r.screenOcr.reads, []);
        assert.equal(r.push.sent[0]!.payload.body, NO_SIGNAL_TEXT);
    });

    it("P11: without the OCR too, a change is logged as skipped for want of a key, as before", async () => {
        r.screenOcr.unavailableReason = "The OCR models are not installed";
        await begin(r);
        await r.show(dialog(flat(60)), "install finished");
        assert.equal(r.push.sent.length, 0);
        assert.equal(r.store.log(USER, 1)[0]!.reason, "no OpenRouter key in Settings, Providers");
    });
});

