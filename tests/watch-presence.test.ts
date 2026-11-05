/**
 * A notification is held back while the person is at the screen: the page's focus and real input, reported as ages, kept per client.
 *
 * Failure modes, before behaviour:
 *  H1. A notification (a call too) is pushed, or a model asked, while the person is using the window.
 *  H2. One tiny nudge, an unfocused page, or old input holds notifications back.
 *  H3. A closed tab or a crashed app holds notifications back for ever.
 *  H4. Two pages: the idle one hides the active one, or the other way round.
 *  H5. A held pop-up is logged with its words, or counted as a notification, or marked as seen (so the next one is lost as a repeat).
 *  H6. The report is trusted unvalidated (an id of any size, a negative age).
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { DEFAULT_ALERT_ZONE } from "@pikvm/contracts/watch";
import { createAlerts, type Alerts } from "../src/server/watch/alerts";
import { limitsFromEnv, PRESENCE_EXPIRY_MS, USER_ACTIVE_WINDOW_MS } from "../src/server/watch/limits";
import { createPresence, type Presence, type PresenceReport } from "../src/server/watch/presence";
import { cursor, fakeModel, fakeOcr, fakePush, flat, patched, tempDir, tempStore, type TempDir } from "./support/watch-rig";

const USER = "operator";
const dirs: TempDir[] = [];
after(() => dirs.forEach((dir) => dir.remove()));

const MAIL = ["Outlook", "Anna Berg", "Lunch on Thursday?", "Are you free at 12:30 for the quarterly review"];
const CALL = ["Microsoft Teams", "Priya Shah is calling you", "Accept", "Decline"];
const toast = (base: Uint8Array) => patched(base, 100, 45, 24, 9, 240);

const report = (over: Partial<PresenceReport> = {}): PresenceReport => ({ focused: true, keyboardAgoMs: null, pointerAgoMs: null, ...over });

describe("the presence record", () => {
    it("the constants: 20 s of input counts, a client that is silent for 12 s is gone", () => {
        assert.equal(USER_ACTIVE_WINDOW_MS, 20_000);
        assert.equal(PRESENCE_EXPIRY_MS, 12_000);
    });

    const make = (): { presence: Presence; clock: { t: number } } => {
        const clock = { t: 1_000_000 };
        return { presence: createPresence(() => clock.t), clock };
    };

    it("H1: focused with a key press a moment ago, or a significant pointer movement, is active", () => {
        const { presence } = make();
        presence.report(USER, "client-keys", report({ keyboardAgoMs: 1500 }));
        assert.equal(presence.active(USER), true);
        const other = make();
        other.presence.report(USER, "client-pointer", report({ pointerAgoMs: 300 }));
        assert.equal(other.presence.active(USER), true);
    });

    it("H2: not focused is not active, however fresh the input; no input at all is not active", () => {
        const { presence } = make();
        presence.report(USER, "client-a", report({ focused: false, keyboardAgoMs: 100, pointerAgoMs: 100 }));
        assert.equal(presence.active(USER), false);
        presence.report(USER, "client-a", report({ focused: true }));
        assert.equal(presence.active(USER), false);
    });

    it("H2: input older than 20 s, as reported or as time passes since, is not active", () => {
        const { presence, clock } = make();
        presence.report(USER, "client-a", report({ keyboardAgoMs: USER_ACTIVE_WINDOW_MS }));
        assert.equal(presence.active(USER), false, "20 s ago exactly is out");
        presence.report(USER, "client-a", report({ keyboardAgoMs: 5000 }));
        assert.equal(presence.active(USER), true);
        clock.t += 14_000;
        presence.report(USER, "client-a", report({ keyboardAgoMs: 19_000 }));
        assert.equal(presence.active(USER), true, "19 s old is in");
        clock.t += 1500;
        assert.equal(presence.active(USER), false, "the same input is 20.5 s old by now");
    });

    it("H3: a client that stops reporting is gone after 12 s, and the input it reported goes with it", () => {
        const { presence, clock } = make();
        presence.report(USER, "client-a", report({ keyboardAgoMs: 0 }));
        clock.t += PRESENCE_EXPIRY_MS - 1;
        assert.equal(presence.active(USER), true);
        clock.t += 1;
        assert.equal(presence.active(USER), false);
    });

    it("H1: the age is the page's, so the clocks of the page and the host never meet: only the age of the report matters", () => {
        const { presence } = make();
        presence.report(USER, "client-a", report({ keyboardAgoMs: 19_999 }));
        assert.equal(presence.active(USER), true);
    });

    it("H4: two clients: one active is enough, whatever the other says; a final 'not focused' report lifts it", () => {
        const { presence } = make();
        presence.report(USER, "client-idle", report());
        presence.report(USER, "client-away", report({ focused: false, keyboardAgoMs: 0 }));
        assert.equal(presence.active(USER), false);
        presence.report(USER, "client-here", report({ pointerAgoMs: 100 }));
        assert.equal(presence.active(USER), true);
        presence.report(USER, "client-here", report({ focused: false, pointerAgoMs: 100 }));
        assert.equal(presence.active(USER), false);
    });

    it("another user's page does not count", () => {
        const { presence } = make();
        presence.report("someone-else", "client-a", report({ keyboardAgoMs: 0 }));
        assert.equal(presence.active(USER), false);
    });
});

interface Rig {
    alerts: Alerts;
    presence: Presence;
    clock: { t: number };
    model: ReturnType<typeof fakeModel>;
    ocr: ReturnType<typeof fakeOcr>;
    push: ReturnType<typeof fakePush>;
    entries(): ReturnType<ReturnType<typeof tempStore>["log"]>;
    /** The screen is flat, then a pop-up shows for 2 s. */
    popup(label: string): Promise<void>;
    quiet(ms: number): void;
}

function rig(): Rig {
    const dir = tempDir();
    dirs.push(dir);
    const store = tempStore(dir.path);
    const clock = { t: 1_000_000 };
    const presence = createPresence(() => clock.t);
    const model = fakeModel();
    const ocr = fakeOcr();
    const push = fakePush();
    ocr.texts = { "crop:toast-a": MAIL, "crop:toast-c": CALL };
    const alerts = createAlerts({
        userId: USER,
        store,
        push,
        settings: () => ({ enabled: true, rule: "", alertZone: DEFAULT_ALERT_ZONE }),
        limits: limitsFromEnv({}),
        now: () => clock.t,
        ocr,
        model,
        crop: async (jpeg) => Buffer.from(`crop:${jpeg.toString()}`),
        userActive: () => presence.active(USER),
    });
    const look = (grid: Uint8Array, label: string): void => alerts.look({ grid, jpeg: Buffer.from(label), capturedAt: clock.t }, clock.t);
    const result: Rig = {
        alerts,
        presence,
        clock,
        model,
        ocr,
        push,
        entries: () => store.log(USER, 50).reverse(),
        async popup(label) {
            look(toast(flat(60)), label);
            clock.t += 1000;
            look(toast(flat(60)), label);
            clock.t += 200;
            look(toast(flat(60)), label);
            await alerts.idle();
            clock.t += 1000;
            look(flat(60), "home");
            clock.t += 6000;
            look(flat(60), "home");
            await alerts.idle();
        },
        quiet(ms) {
            clock.t += ms;
        },
    };
    for (let i = 0; i < 3; i++) {
        look(cursor(flat(60)), "home");
        clock.t += 1000;
    }
    return result;
}

describe("a pop-up while the person is at the screen", () => {
    it("H1: focused with a key press 1 s ago: nothing is read, asked or pushed, and the log says so", async () => {
        const r = rig();
        r.presence.report(USER, "client-a", report({ keyboardAgoMs: 1000 }));
        await r.popup("toast-a");
        assert.equal(r.push.sent.length, 0);
        assert.deepEqual(r.model.asks, []);
        assert.deepEqual(r.ocr.reads, [], "not even read");
        const entry = r.entries()[0]!;
        assert.equal(entry.outcome, "held");
        assert.equal(entry.reason, "you are using this window");
        assert.equal(entry.asked, false);
        assert.ok(entry.latency!.detectedAt >= entry.latency!.firstSeenAt && entry.latency!.capturedAt <= entry.latency!.detectedAt);
        assert.equal(entry.latency!.pushedAt, undefined);
        assert.equal(entry.notified, undefined);
        assert.ok(!JSON.stringify(entry).match(/Anna|Berg|Lunch|Outlook/), "no pop-up text in the log");
    });

    it("H1: focused with a significant pointer movement just now: held, and a call is held too", async () => {
        const r = rig();
        r.presence.report(USER, "client-a", report({ pointerAgoMs: 200 }));
        await r.popup("toast-c");
        assert.equal(r.push.sent.length, 0);
        assert.equal(r.entries()[0]!.outcome, "held");
    });

    it("H2: not focused is pushed, as is 20 s of quiet, as is a page that only nudged the pointer (it reports no movement)", async () => {
        const away = rig();
        away.presence.report(USER, "client-a", report({ focused: false, keyboardAgoMs: 500 }));
        await away.popup("toast-a");
        assert.equal(away.push.sent.length, 1);

        const quiet = rig();
        quiet.presence.report(USER, "client-a", report({ keyboardAgoMs: 1000 }));
        quiet.quiet(USER_ACTIVE_WINDOW_MS);
        quiet.presence.report(USER, "client-a", report({ keyboardAgoMs: USER_ACTIVE_WINDOW_MS + 1000 }));
        await quiet.popup("toast-a");
        assert.equal(quiet.push.sent.length, 1);

        const nudge = rig();
        nudge.presence.report(USER, "client-a", report({ focused: true, pointerAgoMs: null }));
        await nudge.popup("toast-a");
        assert.equal(nudge.push.sent.length, 1);
    });

    it("H3: a client that stopped reporting 12 s ago no longer holds it back", async () => {
        const r = rig();
        r.presence.report(USER, "client-a", report({ keyboardAgoMs: 0 }));
        r.quiet(PRESENCE_EXPIRY_MS);
        await r.popup("toast-a");
        assert.equal(r.push.sent.length, 1);
    });

    it("H4: two clients, one active: held", async () => {
        const r = rig();
        r.presence.report(USER, "client-idle", report());
        r.presence.report(USER, "client-here", report({ keyboardAgoMs: 2000 }));
        await r.popup("toast-a");
        assert.equal(r.push.sent.length, 0);
    });

    it("H1: the person arrives while the OCR is working: checked again before the model is asked, and nothing is asked", async () => {
        const r = rig();
        r.ocr.afterRead = () => r.presence.report(USER, "client-a", report({ keyboardAgoMs: 0 }));
        await r.popup("toast-a");
        assert.deepEqual(r.model.asks, []);
        assert.equal(r.push.sent.length, 0);
        const entry = r.entries()[0]!;
        assert.equal(entry.outcome, "held");
        assert.equal(entry.asked, true, "it was read, so it counts as a check");
    });

    it("H1: the person arrives while the model is writing: checked again right before the push, and nothing is sent", async () => {
        const r = rig();
        r.model.onAsk = () => r.presence.report(USER, "client-a", report({ keyboardAgoMs: 0 }));
        await r.popup("toast-a");
        assert.equal(r.model.asks.length, 1, "the model was already asked");
        assert.equal(r.push.sent.length, 0);
        assert.equal(r.entries()[0]!.outcome, "held");
    });

    it("H5: a held pop-up is not a notification: the same text a moment later, when the person has left, is still sent", async () => {
        const r = rig();
        r.presence.report(USER, "client-a", report({ keyboardAgoMs: 500 }));
        await r.popup("toast-a");
        assert.equal(r.push.sent.length, 0);
        r.quiet(USER_ACTIVE_WINDOW_MS + 5000);
        r.presence.report(USER, "client-a", report({ focused: false }));
        await r.popup("toast-a");
        assert.equal(r.push.sent.length, 1);
    });
});
