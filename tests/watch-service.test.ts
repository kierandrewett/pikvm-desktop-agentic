/**
 * The watch as the host runs it: the service over the shared poller, the crop, the chat model, the settings and the push.
 *
 * Failure modes, before behaviour:
 *  V1. The watch is switched on where this host cannot read the screen or the text on it (it would poll and never find anything).
 *  V2. The poller keeps running after the last user switched off, or stops while one is still on; a restart forgets who had it on.
 *  V3. The rule is stored unvalidated (an unbounded rule makes every request dearer).
 *  V4. The OCR is sent the whole frame, or the wrong rectangle of it.
 *  V5. The chain (a pop-up appears, is read, written up by the chat model, pushed) fires more or less than once.
 *  V6. The view hands out anything secret (a subscription endpoint), or old settings fields come back.
 *  V7. The look pace is not the interval, or goes under the floor.
 *  V8. The test notification reports success when nobody was reachable.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ALERT_ZONES, DEFAULT_ALERT_ZONE } from "@pikvm/contracts/watch";
import type { ImageOps } from "../src/image-ops";
import { limitsFromEnv, MAX_RULE_CHARS } from "../src/server/watch/limits";
import { createWatchService, WatchRefusal, type WatchService } from "../src/server/watch/service";
import { PushError } from "../src/server/watch/push";
import type { Snapshot } from "../src/server/watch/watcher";
import { fakeJpeg, fakeJpegLabel, fakeOcr, fakePush, flat, patched, tempDir, type FakeOcr, type FakePush, type TempDir } from "./support/watch-rig";

const dirs: TempDir[] = [];
after(() => dirs.forEach((dir) => dir.remove()));

const toast = patched(flat(60), 100, 45, 24, 9, 240);

interface Asked {
    userId: string;
    system: string;
    user: string;
    timeoutMs: number;
}

interface Rig {
    dir: TempDir;
    service: WatchService;
    ocr: FakeOcr;
    push: FakePush;
    clock: { t: number };
    /** The delay each scheduled look was set with. */
    delays: number[];
    crops: { x: number; y: number; width: number; height: number }[];
    screen: { label: string; width: number; height: number };
    screens: Record<string, Uint8Array>;
    /** The chat model: whether there is one, what it was asked, and what it answers. */
    chat: { present: boolean; asked: Asked[]; answer: string };
    cropFails: boolean;
    hasGray: boolean;
    step(): Promise<void>;
    log(): ReturnType<WatchService["checks"]>;
}

function rig(reuse?: TempDir): Rig {
    const dir = reuse ?? tempDir();
    if (!reuse) dirs.push(dir);
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const screens: Record<string, Uint8Array> = { home: flat(60), toast };
    const state: Rig = {
        dir,
        service: undefined as unknown as WatchService,
        ocr: fakeOcr(),
        push: fakePush(),
        clock: { t: 7_000_000 },
        delays: [],
        crops: [],
        screen: { label: "home", width: 1920, height: 1080 },
        screens,
        chat: { present: true, asked: [], answer: "Anna Berg asks if you are free Thursday" },
        cropFails: false,
        hasGray: true,
        async step() {
            const timer = timers.find((entry) => !entry.cancelled);
            assert.ok(timer, "a look is scheduled");
            timer.cancelled = true;
            state.clock.t += timer.ms;
            timer.fn();
            for (let i = 0; i < 30; i++) await Promise.resolve();
            await new Promise((done) => setImmediate(done));
        },
        log: () => state.service.checks("operator", 50).reverse(),
    };
    const images: ImageOps = {
        resize: async () => null,
        crop: async (jpeg, region) => {
            state.crops.push(region);
            return state.cropFails ? null : Buffer.from(`crop:${fakeJpegLabel(jpeg)}`);
        },
        gray: async (jpeg) => screens[fakeJpegLabel(jpeg)] ?? null,
    };
    if (!state.hasGray) delete images.gray;
    state.service = createWatchService({
        chat: {
            hasSmallModel: () => state.chat.present,
            smallText: async (userId, system, user, options) => {
                state.chat.asked.push({ userId, system, user, timeoutMs: options.timeoutMs });
                return state.chat.present ? state.chat.answer : undefined;
            },
            userDir: (userId) => join(dir.path, "chat", "users", userId),
        },
        target: async () => {
            throw new Error("unused");
        },
        images: new Proxy(images, { get: (target, key) => (key === "gray" && !state.hasGray ? undefined : Reflect.get(target, key)) }),
        dataDir: dir.path,
        limits: limitsFromEnv({}),
        ocr: state.ocr,
        push: state.push,
        now: () => state.clock.t,
        schedule: (fn, ms) => {
            const entry = { fn, ms, cancelled: false };
            timers.push(entry);
            state.delays.push(ms);
            return () => void (entry.cancelled = true);
        },
        snapshot: async (): Promise<Snapshot> => ({ kind: "frame", jpeg: fakeJpeg(state.screen.width, state.screen.height, state.screen.label) }),
        log: () => undefined,
    });
    return state;
}

describe("switching on", () => {
    it("V1: needs a host that can compare screenshots and has its OCR; says why when it has not, and starts nothing", () => {
        const r = rig();
        r.ocr.unavailableReason = "The OCR models are not installed";
        const view = r.service.view("operator");
        assert.equal(view.canEnable.ok, false);
        assert.throws(
            () => r.service.update("operator", { enabled: true }),
            (error: unknown) => error instanceof WatchRefusal && error.status === 409 && /cannot read pop-ups: The OCR models are not installed/.test(error.message),
        );
        assert.equal(r.service.watcher.running, false);
        r.ocr.unavailableReason = undefined;
        r.hasGray = false;
        assert.match(JSON.stringify(r.service.view("operator").canEnable), /cannot read screenshots for comparing/);
    });

    it("V1/V6: with a key or without, there is nothing else it needs: no key, no model, no provider", () => {
        const r = rig();
        r.chat.present = false;
        const view = r.service.update("operator", { enabled: true });
        assert.equal(view.enabled, true);
        assert.equal(view.running, true);
        assert.equal(view.chatModel, false);
        r.chat.present = true;
        assert.equal(r.service.view("operator").chatModel, true);
        assert.deepEqual(Object.keys(view).sort(), ["alertZone", "canEnable", "chatModel", "enabled", "limits", "push", "rule", "running", "signal"]);
    });

    it("V2: the poller runs while someone has it on, and a restart resumes whoever had it on", () => {
        const r = rig();
        r.service.update("operator", { enabled: true });
        assert.equal(r.service.watcher.size, 1);
        r.service.stop();
        const again = rig(r.dir);
        assert.equal(again.service.view("operator").enabled, true);
        assert.equal(again.service.watcher.running, false);
        again.service.start();
        assert.equal(again.service.watcher.running, true);
        again.service.update("operator", { enabled: false });
        assert.equal(again.service.watcher.running, false);
        assert.equal(again.service.watcher.size, 0);
    });
});

describe("settings", () => {
    it("V3: the rule is trimmed and bounded; the zone is validated; nothing else can be set", () => {
        const r = rig();
        assert.equal(r.service.update("operator", { rule: "  only mail from Anna  " }).rule, "only mail from Anna");
        assert.throws(() => r.service.update("operator", { rule: "x".repeat(MAX_RULE_CHARS + 1) }), (error: unknown) => error instanceof WatchRefusal && error.status === 400);
        assert.deepEqual(r.service.update("operator", { alertZone: ALERT_ZONES[1].zone }).alertZone, ALERT_ZONES[1].zone);
        assert.throws(() => r.service.update("operator", { alertZone: { x0: 0, y0: 0, x1: 0.01, y1: 1 } }), (error: unknown) => error instanceof WatchRefusal && error.status === 400);
        assert.deepEqual(r.service.view("operator").alertZone, ALERT_ZONES[1].zone);
    });

    it("V6: a settings file from an older version is read for what is still in it: its removed fields are ignored and dropped on the next save", () => {
        const r = rig();
        const dir = join(r.dir.path, "chat", "users", "operator", "watch");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabled: true, rule: "keep me", visionModel: "a/b", fastAlerts: true, fastSummary: true, summaryModel: "c/d", alertZone: ALERT_ZONES[2].zone }));
        const view = r.service.view("operator");
        assert.equal(view.enabled, true);
        assert.equal(view.rule, "keep me");
        assert.deepEqual(view.alertZone, ALERT_ZONES[2].zone);
        assert.ok(!("fastAlerts" in view) && !("visionModel" in view) && !("summaryModel" in view));
        r.service.update("operator", { rule: "kept" });
        const saved = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
        assert.deepEqual(Object.keys(saved).sort(), ["alertZone", "enabled", "rule"]);
        assert.deepEqual(DEFAULT_ALERT_ZONE, ALERT_ZONES[0].zone);
    });
});

describe("the pace and the crop", () => {
    it("V7: the poller looks every second, never faster than the floor", async () => {
        const r = rig();
        r.service.update("operator", { enabled: true });
        await r.step();
        await r.step();
        assert.deepEqual(r.delays.slice(1), [1000, 1000]);
        assert.equal(limitsFromEnv({ PIKVM_WATCH_INTERVAL_MS: "200" }).intervalMs, 1000);
    });

    it("V4: the cells that changed, and a margin, cut from the frame the Pi sent, and nothing else", async () => {
        const r = rig();
        r.ocr.texts = { "crop:toast": ["Outlook", "Anna Berg", "Lunch on Thursday?"] };
        r.service.update("operator", { enabled: true });
        await r.step();
        await r.step();
        r.screen.label = "toast";
        for (let i = 0; i < 6 && r.push.sent.length === 0; i++) await r.step();
        // Cells x 98..126, y 43..56 of the 128 x 72 grid, at 15 px a cell.
        assert.deepEqual(r.crops[0], { x: 1470, y: 645, width: 420, height: 195 });
        assert.deepEqual(r.ocr.reads, ["crop:toast"]);
    });

    it("V4: a snapshot that cannot be cropped is logged as an error, not dropped", async () => {
        const r = rig();
        r.cropFails = true;
        r.service.update("operator", { enabled: true });
        await r.step();
        r.screen.label = "toast";
        for (let i = 0; i < 6 && r.log().length === 0; i++) await r.step();
        await r.service.watcher.tick();
        for (let i = 0; i < 20; i++) await Promise.resolve();
        assert.equal(r.log()[0]!.outcome, "error");
        assert.match(r.log()[0]!.reason ?? "", /could not be cut out/);
        assert.equal(r.push.sent.length, 0);
    });
});

describe("the chain", () => {
    it("V5: a pop-up is read on the host, written up by the chat model from the text only, and pushed once", async () => {
        const r = rig();
        r.ocr.texts = { "crop:toast": ["Outlook", "Anna Berg", "Lunch on Thursday?", "Are you free at 12:30"] };
        r.service.update("operator", { enabled: true });
        await r.step();
        r.screen.label = "toast";
        for (let i = 0; i < 6 && r.push.sent.length === 0; i++) await r.step();
        for (let i = 0; i < 4; i++) await r.step();
        assert.equal(r.push.sent.length, 1);
        assert.equal(r.push.sent[0]!.payload.body, "Anna Berg asks if you are free Thursday");
        assert.equal(r.chat.asked.length, 1);
        assert.equal(r.chat.asked[0]!.timeoutMs, 2500);
        assert.ok(!/crop|jpe?g|base64/i.test(r.chat.asked[0]!.user + r.chat.asked[0]!.system), "text only");
        assert.equal(r.service.view("operator").limits.askedToday, 1);
    });

    it("V5: with no chat model nothing is asked of anything and the notification is the text as read", async () => {
        const r = rig();
        r.chat.present = false;
        r.ocr.texts = { "crop:toast": ["Microsoft Teams", "Priya Shah is calling you", "Accept", "Decline"] };
        r.service.update("operator", { enabled: true });
        await r.step();
        r.screen.label = "toast";
        for (let i = 0; i < 6 && r.push.sent.length === 0; i++) await r.step();
        assert.equal(r.push.sent[0]!.payload.title, "Incoming call: Priya Shah");
        assert.deepEqual(r.chat.asked, []);
    });
});

describe("devices and the test notification", () => {
    it("V8: the test notification reports what was sent, and a service with no device refuses it", async () => {
        const r = rig();
        r.push.fail = new PushError("No device has subscribed to notifications yet.", "none");
        await assert.rejects(r.service.test("operator"), (error: unknown) => error instanceof WatchRefusal);
        r.push.fail = null;
        r.push.subscriptions = [{ endpoint: "https://web.push.apple.com/x", keys: { p256dh: "p", auth: "a" }, addedAt: "now" }];
        const result = await r.service.test("operator");
        assert.equal(result.sent, 1);
        assert.equal(r.log().at(-1)!.kind, "test");
        assert.equal(r.log().at(-1)!.outcome, "pushed");
    });
});
