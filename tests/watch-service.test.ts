/**
 * The screen watch as the host runs it: the service over the shared poller, the stored key, the settings and the push.
 *
 * Failure modes, before behaviour:
 *  V1. The watch is switched on with no OpenRouter key (it would poll the PiKVM and never be able to ask a model).
 *  V2. The poller keeps running after the last user switched off, or stops while one is still on.
 *  V3. A restart forgets who had their watch on.
 *  V4. A rule or model setting is stored unvalidated (an unbounded rule makes every decision call dearer).
 *  V5. The whole chain (screen changes, settles, is described, judged, pushed) fires more or less than once.
 *  V6. The test notification reports success when nobody was reachable, or leaves an expired device stored.
 *  V7. The view hands out anything secret (the key, a subscription endpoint).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ImageOps } from "../src/image-ops";
import { limitsFromEnv, MAX_RULE_CHARS } from "../src/server/watch/limits";
import { createPush } from "../src/server/watch/push";
import { createWatchService, WatchRefusal, type WatchService } from "../src/server/watch/service";
import { startFakePush } from "../tools/fake-push/server";
import { dialog, fakeModels, fakePush, flat, PROVIDER, tempDir, type FakeModels, type FakePush, type TempDir } from "./support/watch-rig";
import type { Snapshot } from "../src/server/watch/watcher";
import type { HostProvider } from "@pikvm/chat-server";

const dirs: TempDir[] = [];
after(() => dirs.forEach((dir) => dir.remove()));

const STEP = 3000;
const SECRET = PROVIDER.apiKey;

interface Rig {
    dir: TempDir;
    service: WatchService;
    models: FakeModels;
    push: FakePush;
    /** Which users have a key. */
    keys: Set<string>;
    clock: { t: number };
    /** The screens by the label the fake snapshots carry. */
    screens: Record<string, Uint8Array>;
    shows: { label: string };
    snapshots: number;
    step(): Promise<void>;
    /** Look at one screen for `looks` looks. */
    stay(looks: number): Promise<void>;
}

function rig(over: { dailyCap?: number; usePush?: ReturnType<typeof createPush>; reuse?: TempDir } = {}): Rig {
    const dir = over.reuse ?? tempDir();
    if (!over.reuse) dirs.push(dir);
    const timers: { fn: () => void; cancelled: boolean }[] = [];
    const screens: Record<string, Uint8Array> = { home: flat(60), dialog: dialog(flat(60)) };
    const state: Rig = {
        dir,
        models: fakeModels(),
        push: fakePush(),
        keys: new Set(["operator"]),
        clock: { t: 5_000_000 },
        screens,
        shows: { label: "home" },
        snapshots: 0,
        service: undefined as unknown as WatchService,
        async step() {
            const timer = timers.find((entry) => !entry.cancelled);
            assert.ok(timer, "a look is scheduled");
            timer.cancelled = true;
            state.clock.t += STEP;
            timer.fn();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            await new Promise((done) => setImmediate(done));
        },
        async stay(looks) {
            for (let i = 0; i < looks; i++) await state.step();
        },
    };
    const images: ImageOps = {
        resize: async () => null,
        crop: async () => null,
        gray: async (jpeg) => screens[jpeg.toString()] ?? null,
    };
    const limits = { ...limitsFromEnv({}), ...(over.dailyCap ? { dailyCap: over.dailyCap } : {}) };
    state.service = createWatchService({
        chat: {
            openRouter: (userId): HostProvider | undefined => (state.keys.has(userId) ? { id: "openrouter", ...PROVIDER } : undefined),
            userDir: (userId) => join(dir.path, "chat", "users", userId),
        },
        target: async () => {
            throw new Error("the fake snapshot does not use the target");
        },
        images,
        dataDir: dir.path,
        limits,
        models: state.models,
        push: over.usePush ?? state.push,
        now: () => state.clock.t,
        schedule: (fn) => {
            const entry = { fn, cancelled: false };
            timers.push(entry);
            return () => void (entry.cancelled = true);
        },
        snapshot: async (): Promise<Snapshot> => {
            state.snapshots++;
            return { kind: "frame", jpeg: Buffer.from(state.shows.label) };
        },
        log: () => undefined,
    });
    return state;
}

describe("switching on", () => {
    it("V1: without a stored key it is refused with the reason, and nothing starts", () => {
        const r = rig();
        r.keys.clear();
        assert.throws(
            () => r.service.update("operator", { enabled: true }),
            (error: unknown) => error instanceof WatchRefusal && error.status === 409 && /Settings, Providers/.test(error.message),
        );
        const view = r.service.view("operator");
        assert.equal(view.enabled, false);
        assert.equal(view.canEnable.ok, false);
        assert.equal(r.service.watcher.running, false);
        assert.equal(r.service.watcher.size, 0);
        assert.equal(r.snapshots, 0);
    });

    it("a host that cannot read screenshots for comparing says so instead of switching on", () => {
        const r = rig();
        const service = createWatchService({
            chat: { openRouter: () => ({ id: "openrouter", ...PROVIDER }), userDir: (id) => join(r.dir.path, "chat", "users", id) },
            target: async () => {
                throw new Error("unused");
            },
            images: { resize: async () => null, crop: async () => null },
            dataDir: r.dir.path,
            limits: limitsFromEnv({}),
            models: r.models,
            push: r.push,
            log: () => undefined,
        });
        assert.throws(() => service.update("operator", { enabled: true }), /cannot read screenshots/);
    });

    it("V2: the poller runs while any user is on and stops when the last one switches off", async () => {
        const r = rig();
        r.keys.add("second");
        r.service.update("operator", { enabled: true });
        assert.equal(r.service.watcher.running, true);
        r.service.update("second", { enabled: true });
        assert.equal(r.service.watcher.size, 2);
        assert.equal(r.service.view("second").running, true);

        r.service.update("operator", { enabled: false });
        assert.equal(r.service.watcher.size, 1);
        assert.equal(r.service.watcher.running, true, "the second user still has it on");
        assert.equal(r.service.view("operator").running, false);

        await r.step();
        const before = r.snapshots;
        r.service.update("second", { enabled: false });
        assert.equal(r.service.watcher.size, 0);
        assert.equal(r.service.watcher.running, false);
        assert.equal(r.snapshots, before);
        // Nothing is scheduled any more: a step would find no look to run.
        await assert.rejects(r.step(), /a look is scheduled/);
    });

    it("switching on twice does not start a second watch", () => {
        const r = rig();
        r.service.update("operator", { enabled: true });
        r.service.update("operator", { enabled: true });
        assert.equal(r.service.watcher.size, 1);
    });

    it("V3: a restart resumes whoever had it on and only them, and not a user whose key is gone", () => {
        const first = rig();
        first.keys.add("second").add("third");
        for (const id of ["operator", "second", "third"]) first.service.update(id, { enabled: true });
        first.service.update("third", { enabled: false });
        first.service.stop();

        const second = rig({ reuse: first.dir });
        second.keys.delete("second");
        second.service.start();
        assert.equal(second.service.watcher.size, 1, "operator only: second has no key, third is off");
        assert.equal(second.service.view("operator").running, true);
        assert.equal(second.service.view("second").running, false);
        assert.equal(second.service.view("second").enabled, true, "what the person chose is not lost");
    });
});

describe("settings", () => {
    it("V4: rule and model are stored, trimmed and bounded; an empty model is the default again", () => {
        const r = rig();
        const view = r.service.update("operator", { rule: "  tell me when the install finishes  ", visionModel: "qwen/qwen3.7-flash" });
        assert.equal(view.rule, "tell me when the install finishes");
        assert.equal(view.visionModel, "qwen/qwen3.7-flash");
        assert.equal(r.service.update("operator", { visionModel: "" }).visionModel, view.defaultVisionModel);
        assert.throws(() => r.service.update("operator", { rule: "x".repeat(MAX_RULE_CHARS + 1) }), (error: unknown) => error instanceof WatchRefusal && error.status === 400);
        for (const bad of ["has spaces", "a;b", "x".repeat(200), "../../etc"]) {
            assert.throws(() => r.service.update("operator", { visionModel: bad }), (error: unknown) => error instanceof WatchRefusal && error.status === 400, bad);
        }
        assert.equal(r.service.view("operator").rule, "tell me when the install finishes", "a refused change changes nothing");
    });

    it("V7: the view carries no key and no endpoint, and states the limits that bound it", () => {
        const r = rig();
        const view = r.service.view("operator");
        assert.ok(!JSON.stringify(view).includes(SECRET));
        assert.deepEqual(view.limits, {
            intervalSec: 3,
            settleSec: 6,
            minCheckGapSec: 60,
            dailyCap: 200,
            askedToday: 0,
            fast: { intervalSec: 1, settleSec: 1.2, minCheckGapSec: 4, dailyCap: 500, askedToday: 0 },
        });
        assert.equal(view.push.available, true);
        assert.equal(view.push.subscriptions, 0);
    });
});

describe("the whole chain", () => {
    it("V5: a screen that changes and settles is checked once, judged once and pushed once; a quiet screen costs nothing", async () => {
        const r = rig();
        r.models.answers = [0.95];
        r.service.update("operator", { enabled: true, rule: "tell me when the install finishes" });
        await r.stay(10);
        assert.equal(r.models.described.length, 0, "a quiet screen asks nothing");

        r.shows.label = "dialog";
        await r.stay(2);
        assert.equal(r.models.decided.length, 0, "not settled yet");
        await r.stay(2);
        assert.deepEqual(r.models.described, ["home", "dialog"]);
        assert.equal(r.models.decided.length, 1);
        assert.equal(r.models.decided[0]!.rule, "tell me when the install finishes");
        assert.equal(r.push.sent.length, 1);
        assert.equal(r.push.sent[0]!.payload.body, "Screen dialog. Something else.");

        await r.stay(20);
        assert.equal(r.push.sent.length, 1, "still the one notification");
        const [entry] = r.service.checks("operator", 5);
        assert.equal(entry!.outcome, "pushed");
        assert.equal(r.service.view("operator").limits.askedToday, 1);
    });

    it("a watch switched off asks nothing even if the screen changes", async () => {
        const r = rig();
        r.service.update("operator", { enabled: true });
        await r.stay(2);
        r.service.update("operator", { enabled: false });
        r.shows.label = "dialog";
        await assert.rejects(r.stay(5), /a look is scheduled/);
        assert.deepEqual(r.models.decided, []);
    });
});

describe("notifications", () => {
    it("V6: a test with no device subscribed is refused with the reason", async () => {
        const r = rig({ usePush: createPush({ dataDir: join(tempDir().path), subscriptionsFile: () => "/nonexistent/none.json" }) });
        await assert.rejects(r.service.test("operator"), (error: unknown) => error instanceof WatchRefusal && error.status === 409 && /No device has subscribed/.test(error.message));
    });

    it("V6: a test reaches a device, is logged, and an expired device is removed and reported", async () => {
        const remote = await startFakePush();
        after(() => remote.close());
        const dir = tempDir();
        dirs.push(dir);
        const r = rig({
            reuse: dir,
            usePush: createPush({
                dataDir: dir.path,
                subscriptionsFile: (userId) => join(dir.path, "chat", "users", userId, "watch", "push-subscriptions.json"),
                allowLocalEndpoints: true,
                subject: "https://kvm.example.org",
            }),
        });
        const live = remote.subscribe();
        const expired = remote.subscribe();
        r.service.subscribe("operator", { endpoint: live.endpoint, keys: live.keys }, {});
        r.service.subscribe("operator", { endpoint: expired.endpoint, keys: expired.keys }, {});
        assert.equal(r.service.view("operator").push.subscriptions, 2);
        remote.setStatus(expired.id, 410);

        const result = await r.service.test("operator");
        assert.deepEqual({ sent: result.sent, removed: result.removed }, { sent: 1, removed: 1 });
        assert.equal(remote.received.length, 1);
        assert.equal((remote.received[0]!.payload as { tag: string }).tag, "pikvm-test");
        assert.equal(r.service.view("operator").push.subscriptions, 1);
        const [entry] = r.service.checks("operator", 1);
        assert.equal(entry!.kind, "test");
        assert.equal(entry!.outcome, "pushed");
        assert.equal(entry!.asked, false);
    });

    it("refuses a subscription for an address it must not call", () => {
        const r = rig({ usePush: createPush({ dataDir: tempDir().path, subscriptionsFile: () => "/nonexistent/x.json" }) });
        assert.throws(
            () => r.service.subscribe("operator", { endpoint: "https://127.0.0.1/x", keys: { p256dh: "a", auth: "b" } }, {}),
            (error: unknown) => error instanceof WatchRefusal && error.status === 400,
        );
    });
});
