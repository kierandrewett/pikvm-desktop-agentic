/**
 * Fast alerts as the host runs them: the service over the shared poller, the crop, the pace.
 *
 * Failure modes, before behaviour:
 *  S1. Fast alerts can be switched on with the watch off (and then do nothing, silently).
 *  S2. The poller stays at the slow pace, or fast alerts run at a pace under the floor.
 *  S3. The OCR is sent the whole frame, or the wrong rectangle of it, or a crop wider than the vision model's edge.
 *  S4. A snapshot that cannot be cropped is dropped without a line in the log.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { join } from "node:path";
import type { HostProvider } from "@pikvm/chat-server";
import { ALERT_ZONES } from "@pikvm/contracts/watch";
import type { ImageOps, ImageRegion } from "../src/image-ops";
import { limitsFromEnv, MIN_FAST_INTERVAL_MS } from "../src/server/watch/limits";
import { createWatchService, WatchRefusal, type WatchService } from "../src/server/watch/service";
import type { Snapshot } from "../src/server/watch/watcher";
import { fakeJpeg, fakeJpegLabel, fakeModels, fakeOcr, fakePush, flat, patched, PROVIDER, tempDir, type FakeModels, type FakeOcr, type FakePush, type TempDir } from "./support/watch-rig";

const dirs: TempDir[] = [];
after(() => dirs.forEach((dir) => dir.remove()));

const toast = patched(flat(60), 100, 45, 24, 9, 240);

interface Rig {
    service: WatchService;
    models: FakeModels;
    ocr: FakeOcr;
    push: FakePush;
    clock: { t: number };
    /** The delay each scheduled look was set with. */
    delays: number[];
    crops: ImageRegion[];
    resizes: { width: number; height: number }[];
    screen: { label: string; width: number; height: number };
    /** The grids the fake snapshots read as, by label. */
    screens: Record<string, Uint8Array>;
    cropFails: boolean;
    /** Whether the user has an OpenRouter key. */
    hasKey: boolean;
    /** Run the next look, the clock moving by the delay it was scheduled with. */
    step(): Promise<void>;
    log(): ReturnType<WatchService["checks"]>;
}

function rig(): Rig {
    const dir = tempDir();
    dirs.push(dir);
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const screens: Record<string, Uint8Array> = { home: flat(60), toast };
    const state: Rig = {
        service: undefined as unknown as WatchService,
        models: fakeModels(),
        ocr: fakeOcr(),
        push: fakePush(),
        clock: { t: 7_000_000 },
        delays: [],
        crops: [],
        resizes: [],
        screen: { label: "home", width: 1920, height: 1080 },
        screens,
        cropFails: false,
        hasKey: true,
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
        resize: async (jpeg, width, height) => {
            state.resizes.push({ width, height });
            return Buffer.from(`resized:${fakeJpegLabel(jpeg)}`);
        },
        crop: async (jpeg, region) => {
            state.crops.push(region);
            return state.cropFails ? null : Buffer.from(`crop:${fakeJpegLabel(jpeg)}`);
        },
        gray: async (jpeg) => screens[fakeJpegLabel(jpeg)] ?? null,
    };
    state.service = createWatchService({
        chat: {
            openRouter: (): HostProvider | undefined => (state.hasKey ? { id: "openrouter", ...PROVIDER } : undefined),
            userDir: (userId) => join(dir.path, "chat", "users", userId),
        },
        target: async () => {
            throw new Error("unused");
        },
        images,
        dataDir: dir.path,
        limits: limitsFromEnv({}),
        models: state.models,
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

describe("switching fast alerts on", () => {
    it("S1: they need the watch itself: refused with the reason when it is off, accepted in the same request as switching it on", () => {
        const r = rig();
        assert.throws(
            () => r.service.update("operator", { fastAlerts: true }),
            (error: unknown) => error instanceof WatchRefusal && error.status === 409 && /Switch the screen watch on first/.test(error.message),
        );
        assert.equal(r.service.view("operator").fastAlerts, false);
        const view = r.service.update("operator", { enabled: true, fastAlerts: true });
        assert.equal(view.fastAlerts, true);
        assert.equal(view.running, true);
        const afterOff = r.service.update("operator", { enabled: false });
        assert.equal(afterOff.fastAlerts, true, "the choice is remembered while the watch is off");
        assert.equal(afterOff.running, false);
        assert.throws(() => r.service.update("operator", { fastAlerts: true }), WatchRefusal, "and cannot be set again until it is on");
        assert.equal(r.service.update("operator", { fastAlerts: false }).fastAlerts, false, "but can always be switched off");
    });

    it("S2: the poller looks every second while fast alerts are on, never faster than the floor, and at the slow pace when they are off", async () => {
        const r = rig();
        r.service.update("operator", { enabled: true });
        await r.step();
        await r.step();
        assert.deepEqual(r.delays.slice(1), [3000, 3000]);
        r.service.update("operator", { fastAlerts: true });
        await r.step();
        await r.step();
        assert.deepEqual(r.delays.slice(3), [1000, 1000]);
        assert.equal(MIN_FAST_INTERVAL_MS, 1000);
        assert.equal(limitsFromEnv({ PIKVM_WATCH_FAST_INTERVAL_MS: "200" }).fast.intervalMs, 1000, "a faster setting is floored");
        assert.equal(limitsFromEnv({ PIKVM_WATCH_FAST_INTERVAL_MS: "1500" }).fast.intervalMs, 1500);
        r.service.update("operator", { fastAlerts: false });
        await r.step();
        assert.equal(r.delays.at(-1), 3000);
    });

    it("the limits env: the settle, the gap and the cap are overridable and bad values are ignored", () => {
        const fast = limitsFromEnv({ PIKVM_WATCH_FAST_SETTLE_MS: "800", PIKVM_WATCH_FAST_MIN_GAP_SEC: "10", PIKVM_WATCH_FAST_DAILY_CAP: "50.7" }).fast;
        assert.deepEqual(fast, { intervalMs: 1000, settleMs: 800, minCheckGapMs: 10_000, dailyCap: 50 });
        assert.deepEqual(limitsFromEnv({ PIKVM_WATCH_FAST_SETTLE_MS: "x", PIKVM_WATCH_FAST_MIN_GAP_SEC: "-1", PIKVM_WATCH_FAST_DAILY_CAP: "0" }).fast, { intervalMs: 1000, settleMs: 1200, minCheckGapMs: 4000, dailyCap: 500 });
    });
});

describe("what the model is sent", () => {
    it("S3: the cells that changed, and a margin, cut from the frame the Pi sent, and nothing else", async () => {
        const r = rig();
        r.ocr.texts = { "crop:toast": ["Outlook", "Anna Berg", "Lunch on Thursday?"] };
        r.service.update("operator", { enabled: true, fastAlerts: true });
        await r.step();
        await r.step();
        r.screen.label = "toast";
        await r.step(); // sees it
        await r.step(); // held 1 s
        await r.step(); // held long enough (the extra look is due at 1.2 s)
        await r.service.watcher.tick(); // one more, in case the clock landed just short
        for (let i = 0; i < 5 && r.push.sent.length === 0; i++) await r.step();
        assert.equal(r.push.sent.length, 1);
        // Cells x 98..126, y 43..56 of the 128 x 72 grid, at 15 px a cell.
        assert.deepEqual(r.crops[0], { x: 1470, y: 645, width: 420, height: 195 }, "the toast's cells and two more each way, in pixels of 1920 x 1080");
        assert.deepEqual(r.ocr.reads, ["crop:toast"]);
        assert.deepEqual(r.models.alerted, [], "no vision model");
        assert.deepEqual(r.models.described, []);
        assert.deepEqual(r.resizes, [], "420 px is under the model's edge: no scaling");
        const entry = r.log().find((each) => each.kind === "alert")!;
        assert.equal(entry.outcome, "pushed");
        assert.equal(r.service.view("operator").limits.fast.askedToday, 1);
        assert.equal(r.service.view("operator").limits.askedToday, 0, "the slow path's count is separate");
    });

    it("S3: a crop wider than the vision model's edge is scaled to it, keeping its shape; another corner is another rectangle", async () => {
        const r = rig();
        r.ocr.texts = { "crop:toast": ["Outlook", "Anna Berg", "Lunch on Thursday?"] };
        r.screen = { label: "home", width: 4000, height: 3000 };
        // A wide pop-up in the top-right corner: 42 cells of a 4000 x 3000 frame are 1312 px, and with its margin a crop wider than 1280.
        r.service.update("operator", { enabled: true, fastAlerts: true, alertZone: ALERT_ZONES[1].zone });
        await r.step();
        r.screen.label = "corner";
        r.screens["corner"] = patched(flat(60), 85, 5, 42, 11, 240);
        for (let i = 0; i < 6 && r.ocr.reads.length === 0; i++) await r.step();
        assert.deepEqual(r.crops[0], { x: 2593, y: 125, width: 1407, height: 625 }, "the pop-up's cells and two more each way (the right side kept inside the zone), in pixels of 4000 x 3000");
        assert.deepEqual(r.resizes, [{ width: 1280, height: 569 }], "long edge 1407 scaled to 1280");
    });

    it("S4: a snapshot that cannot be cropped is logged as an error, not dropped", async () => {
        const r = rig();
        r.ocr.texts = { "crop:toast": ["Outlook", "Anna Berg", "Lunch on Thursday?"] };
        r.cropFails = true;
        r.service.update("operator", { enabled: true, fastAlerts: true });
        await r.step();
        r.screen.label = "toast";
        for (let i = 0; i < 6 && r.log().length === 0; i++) await r.step();
        await r.service.watcher.tick();
        for (let i = 0; i < 20; i++) await Promise.resolve();
        const entry = r.log()[0]!;
        assert.equal(entry.kind, "alert");
        assert.equal(entry.outcome, "error");
        assert.match(entry.reason ?? "", /could not be cut out/);
        assert.equal(r.push.sent.length, 0);
    });
});

describe("no OpenRouter key: fast alerts only", () => {
    it("S5: no key and fast alerts switched on in the same request: the watch runs, the whole-screen path is idle, and the view says so", () => {
        const r = rig();
        r.hasKey = false;
        const view = r.service.update("operator", { enabled: true, fastAlerts: true });
        assert.equal(view.enabled, true);
        assert.equal(view.fastAlerts, true);
        assert.equal(view.running, true);
        assert.equal(view.canJudge, false);
        r.hasKey = true;
        assert.equal(r.service.view("operator").canJudge, true);
    });

    it("S5: no key and fast alerts off: refused as before, with the existing message, and nothing starts", () => {
        const r = rig();
        r.hasKey = false;
        assert.deepEqual(r.service.view("operator").canEnable.ok, false);
        for (const patch of [{ enabled: true }, { enabled: true, fastAlerts: false }]) {
            assert.throws(
                () => r.service.update("operator", patch),
                (error: unknown) => error instanceof WatchRefusal && error.status === 409 && /Add an OpenRouter key in Settings, Providers first/.test(error.message),
            );
        }
        assert.equal(r.service.view("operator").running, false);
        assert.equal(r.service.watcher.size, 0);
    });

    it("S5: no key: turning fast alerts off switches the watch off", () => {
        const r = rig();
        r.hasKey = false;
        r.service.update("operator", { enabled: true, fastAlerts: true });
        const off = r.service.update("operator", { fastAlerts: false });
        assert.equal(off.enabled, false);
        assert.equal(off.running, false);
        assert.equal(r.service.watcher.size, 0);
    });

    it("S5: no key and no OCR on this host: fast alerts alone cannot start it either, and the reason says why", () => {
        const r = rig();
        r.hasKey = false;
        r.ocr.unavailableReason = "The OCR models are not installed";
        assert.throws(
            () => r.service.update("operator", { enabled: true, fastAlerts: true }),
            (error: unknown) => error instanceof WatchRefusal && error.status === 409 && /OCR is not available: The OCR models are not installed/.test(error.message),
        );
    });

    it("S5: with a key both work as before: the watch alone, then fast alerts on top, and turning them off leaves the watch on", () => {
        const r = rig();
        assert.equal(r.service.update("operator", { enabled: true }).running, true);
        assert.equal(r.service.update("operator", { fastAlerts: true }).fastAlerts, true);
        const off = r.service.update("operator", { fastAlerts: false });
        assert.equal(off.enabled, true);
        assert.equal(off.running, true);
    });

    it("S5: no key, fast alerts only: a toast is read and pushed on this host; a change of the rest of the screen is logged as needing a key and nothing is asked", async () => {
        const r = rig();
        r.hasKey = false;
        r.ocr.texts = { "crop:toast": ["Microsoft Teams", "Priya Shah is calling you", "Accept", "Decline"] };
        r.service.update("operator", { enabled: true, fastAlerts: true });
        await r.step();
        r.screen.label = "toast";
        for (let i = 0; i < 6 && r.push.sent.length === 0; i++) await r.step();
        assert.equal(r.push.sent.length, 1);
        assert.equal(r.push.sent[0]!.payload.title, "Incoming call: Priya Shah");
        assert.deepEqual(r.models.decided, []);
        assert.deepEqual(r.models.described, []);
        // The rest of the screen changes (outside the zone): the whole-screen path would need the key.
        r.screens["rest"] = patched(flat(60), 20, 10, 16, 8, 240);
        r.screen.label = "rest";
        for (let i = 0; i < 12; i++) await r.step();
        const slow = r.log().filter((entry) => entry.kind === "change");
        assert.ok(slow.length >= 1);
        assert.match(slow[0]!.reason ?? "", /slow watch needs an OpenRouter key/);
        assert.equal(r.push.sent.length, 1);
        assert.deepEqual(r.models.described, []);
    });
});
