/**
 * The agent's screen waits: an agent hands the server a yes/no question about the screen; the server asks the Decisions
 * model whenever the watched part of the screen changes and holds still, and hands back when the answer is yes.
 *
 * Failure modes, before behaviour:
 *  W1. A wait is armed where it cannot work (no Decisions model, no way to compare screenshots, too many already): it would
 *      poll and never answer, so it is refused at once, with the reason, and nothing is polled.
 *  W2. The question is asked about a screen that has not changed, or about noise (a pointer-sized change).
 *  W3. A change is asked more than once, the same text is asked again, or more than the text of the changed part is sent.
 *  W4. A yes does not hand back; or a no or a maybe does; or the wait stops asking when the screen changes again.
 *  W5. The wait outlives its time, or the poller keeps running after the last wait has ended.
 *  W6. Another conversation reads, waits on or cancels a wait that is not its own.
 *  W7. A model that keeps failing, or goes away, leaves the wait asking for ever.
 *  W8. A pop-up that comes and goes while a slow answer is pending is lost.
 *  W9. The caller's own wait returns late after a match, or for ever after the caller went.
 *  W10. A region of the screen is watched as if it were the whole screen.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ImageOps } from "../src/image-ops";
import { limitsFromEnv } from "../src/server/watch/limits";
import { createWatchService, WatchRefusal, type WatchService } from "../src/server/watch/service";
import type { ScreenWaits, WaitView } from "../src/server/watch/screen-wait";
import type { Snapshot } from "../src/server/watch/watcher";
import { cursor, fakeJpeg, fakeJpegLabel, fakeOcr, fakePush, flat, patched, tempDir, type FakeOcr, type TempDir } from "./support/watch-rig";

const dirs: TempDir[] = [];
after(() => dirs.forEach((dir) => dir.remove()));

const home = flat(60);
/** Two different pop-ups of toast size (2.3% of the screen) and a third somewhere else. */
const toastA = patched(home, 100, 45, 24, 9, 240);
const toastB = patched(home, 100, 45, 24, 9, 20);
const toastC = patched(home, 100, 45, 24, 9, 150);
const topLeft = patched(home, 4, 4, 24, 9, 240);

const WHOLE = { x0: 0, y0: 0, x1: 1, y1: 1 };
const QUESTION = "Has a message from Sam arrived?";

interface Rig {
    service: WatchService;
    waits: ScreenWaits;
    ocr: FakeOcr;
    clock: { t: number };
    crops: { x: number; y: number; width: number; height: number }[];
    screen: { label: string };
    screens: Record<string, Uint8Array>;
    decisions: {
        present: boolean;
        asked: { state: Record<string, string>; instructions: string; timeoutMs: number }[];
        answer: number | "fail" | "gone";
        /** While set, an answer waits for it: a model that is slow. */
        gate: Promise<void> | null;
    };
    hasGray: boolean;
    /** One look of the poller. */
    step(): Promise<void>;
    /** Looks until `done`, at most `max`. */
    until(done: () => boolean, max?: number): Promise<void>;
}

function rig(options: { hasGray?: boolean; decisions?: boolean } = {}): Rig {
    const dir = tempDir();
    dirs.push(dir);
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const screens: Record<string, Uint8Array> = { home, toastA, toastB, toastC, topLeft, pointer: cursor(home) };
    const state: Rig = {
        service: undefined as unknown as WatchService,
        waits: undefined as unknown as ScreenWaits,
        ocr: fakeOcr(),
        clock: { t: 9_000_000 },
        crops: [],
        screen: { label: "home" },
        screens,
        decisions: { present: options.decisions ?? true, asked: [], answer: 0.9, gate: null },
        hasGray: options.hasGray ?? true,
        async step() {
            const timer = timers.find((entry) => !entry.cancelled);
            assert.ok(timer, "a look is scheduled");
            timer.cancelled = true;
            state.clock.t += timer.ms;
            timer.fn();
            for (let i = 0; i < 40; i++) await Promise.resolve();
            await new Promise((done) => setImmediate(done));
        },
        async until(done, max = 60) {
            for (let i = 0; i < max && !done(); i++) await state.step();
        },
    };
    const images: ImageOps = {
        resize: async () => null,
        crop: async (jpeg, region) => {
            state.crops.push(region);
            return Buffer.from(`crop:${fakeJpegLabel(jpeg)}`);
        },
        gray: async (jpeg) => screens[fakeJpegLabel(jpeg)] ?? null,
    };
    state.service = createWatchService({
        chat: {
            hasSmallModel: () => false,
            hasDecisionModel: () => state.decisions.present,
            decide: async (_userId, request) => {
                state.decisions.asked.push(request);
                if (state.decisions.gate) await state.decisions.gate;
                if (state.decisions.answer === "gone") return undefined;
                if (state.decisions.answer === "fail") throw new Error("provider said: secret-token-123");
                return { probability: state.decisions.answer, backend: "decisions" };
            },
            smallText: async () => undefined,
            userDir: (userId) => join(dir.path, "chat", "users", userId),
        },
        target: async () => {
            throw new Error("unused");
        },
        images: new Proxy(images, { get: (target, key) => (key === "gray" && !state.hasGray ? undefined : Reflect.get(target, key)) }),
        dataDir: dir.path,
        limits: limitsFromEnv({}),
        ocr: state.ocr,
        push: fakePush(),
        now: () => state.clock.t,
        schedule: (fn, ms) => {
            const entry = { fn, ms, cancelled: false };
            timers.push(entry);
            return () => void (entry.cancelled = true);
        },
        snapshot: async (): Promise<Snapshot> => ({ kind: "frame", jpeg: fakeJpeg(1920, 1080, state.screen.label) }),
        log: () => undefined,
    });
    state.waits = state.service.waits("operator");
    return state;
}

const start = (r: Rig, owner = "conv-1", over: Partial<{ question: string; zone: typeof WHOLE; timeoutMs: number }> = {}): WaitView =>
    r.waits.start(owner, { question: QUESTION, zone: WHOLE, timeoutMs: 600_000, ...over });

describe("arming", () => {
    it("W1: it is refused, with the reason, where there is no Decisions model, and nothing is polled", () => {
        const r = rig({ decisions: false });
        assert.throws(
            () => start(r),
            (error: unknown) => error instanceof WatchRefusal && error.status === 409 && /Decisions model/.test(error.message),
        );
        assert.equal(r.service.watcher.size, 0);
    });

    it("W1: it is refused where this host cannot compare screenshots", () => {
        const r = rig({ hasGray: false });
        assert.throws(() => start(r), (error: unknown) => error instanceof WatchRefusal && /cannot read screenshots/.test(error.message));
        assert.equal(r.service.watcher.size, 0);
    });

    it("W1: only a few run at once, and a finished one makes room", () => {
        const r = rig();
        const ids = [1, 2, 3, 4].map((n) => start(r, `conv-${n}`).id);
        assert.throws(() => start(r, "conv-5"), (error: unknown) => error instanceof WatchRefusal && /at once/.test(error.message));
        r.waits.cancel("conv-1", ids[0]!);
        assert.equal(start(r, "conv-5").status, "watching");
    });

    it("W1: a question with nothing in it is refused", () => {
        const r = rig();
        assert.throws(() => start(r, "conv-1", { question: "  \n " }), (error: unknown) => error instanceof WatchRefusal && error.status === 400);
    });
});

describe("asking", () => {
    it("W2: a screen that does not change is never asked about, and neither is a change the size of a pointer", async () => {
        const r = rig();
        const wait = start(r);
        await r.step();
        for (let i = 0; i < 6; i++) await r.step();
        r.screen.label = "pointer";
        for (let i = 0; i < 8; i++) await r.step();
        assert.deepEqual(r.decisions.asked, []);
        assert.equal(r.waits.view("conv-1", wait.id)?.status, "watching");
    });

    it("W3/W4: a pop-up is read on this host and its text alone is asked about; a yes hands back with what matched", async () => {
        const r = rig();
        r.ocr.texts = { "crop:toastA": ["Slack", "Sam Rowe", "Are you free for a call?"] };
        const wait = start(r);
        await r.step();
        r.screen.label = "toastA";
        await r.until(() => r.waits.view("conv-1", wait.id)!.status !== "watching");
        const done = r.waits.view("conv-1", wait.id)!;
        assert.equal(done.status, "matched");
        assert.equal(done.match?.probability, 0.9);
        assert.match(done.match?.excerpt ?? "", /Sam Rowe/);
        assert.equal(r.decisions.asked.length, 1);
        const asked = r.decisions.asked[0]!;
        assert.deepEqual(Object.keys(asked.state), ["screen_text"]);
        assert.equal(asked.state["screen_text"], "Slack\nSam Rowe\nAre you free for a call?");
        assert.ok(asked.instructions.includes(QUESTION), "the agent's question is the question");
        assert.ok(!/jpe?g|base64|crop:/i.test(JSON.stringify(asked)), "text only");
        assert.equal(r.service.watcher.size, 0, "a finished wait stops the poller");
    });

    it("W4: a no and a maybe do not hand back, and it asks again when the screen changes again", async () => {
        const r = rig();
        r.ocr.texts = { "crop:toastA": ["Backup finished"], "crop:toastB": ["Sam Rowe", "Are you free for a call?"] };
        const wait = start(r);
        await r.step();

        r.decisions.answer = 0.5;
        r.screen.label = "toastA";
        await r.until(() => r.decisions.asked.length === 1);
        await r.until(() => r.waits.view("conv-1", wait.id)!.asked === 1);
        let view = r.waits.view("conv-1", wait.id)!;
        assert.equal(view.status, "watching");
        assert.equal(view.bestProbability, 0.5);

        r.decisions.answer = 0.95;
        r.screen.label = "toastB";
        await r.until(() => r.waits.view("conv-1", wait.id)!.status !== "watching");
        view = r.waits.view("conv-1", wait.id)!;
        assert.equal(view.status, "matched");
        assert.equal(view.asked, 2);
        assert.equal(view.changes, 2);
    });

    it("W3: the same text on a screen that looks different is not asked again", async () => {
        const r = rig();
        r.decisions.answer = 0.4;
        r.ocr.texts = { "crop:toastA": ["Backup finished"], "crop:toastB": ["Backup finished"], "crop:toastC": ["Backup finished"] };
        const wait = start(r);
        await r.step();
        for (const label of ["toastA", "toastB", "toastC"]) {
            r.screen.label = label;
            await r.until(() => r.waits.view("conv-1", wait.id)!.changes >= ["toastA", "toastB", "toastC"].indexOf(label) + 1);
            await r.until(() => r.waits.view("conv-1", wait.id)!.asked + r.waits.view("conv-1", wait.id)!.repeated >= ["toastA", "toastB", "toastC"].indexOf(label) + 1);
        }
        const view = r.waits.view("conv-1", wait.id)!;
        assert.equal(r.decisions.asked.length, 1);
        assert.equal(view.asked, 1);
        assert.equal(view.repeated, 2);
        assert.equal(view.status, "watching");
    });

    it("W3: a change with no readable text is not asked about", async () => {
        const r = rig();
        const wait = start(r);
        await r.step();
        r.screen.label = "toastA";
        await r.until(() => r.waits.view("conv-1", wait.id)!.changes === 1);
        for (let i = 0; i < 4; i++) await r.step();
        assert.equal(r.decisions.asked.length, 0);
        assert.equal(r.waits.view("conv-1", wait.id)!.skipped, 1);
    });
});

describe("ending", () => {
    it("W5: it ends when its time is up, and the poller stops", async () => {
        const r = rig();
        const wait = start(r, "conv-1", { timeoutMs: 20_000 });
        await r.until(() => r.waits.view("conv-1", wait.id)!.status !== "watching", 40);
        const view = r.waits.view("conv-1", wait.id)!;
        assert.equal(view.status, "timed_out");
        assert.ok(view.elapsedMs >= 20_000);
        assert.equal(r.service.watcher.size, 0);
    });

    it("W5: cancelling ends it and stops the poller, and only the last wait stops it", () => {
        const r = rig();
        const a = start(r, "conv-1");
        const b = start(r, "conv-2");
        assert.equal(r.service.watcher.size, 2);
        assert.equal(r.waits.cancel("conv-1", a.id)?.status, "cancelled");
        assert.equal(r.service.watcher.size, 1);
        assert.equal(r.waits.cancel("conv-2", b.id)?.status, "cancelled");
        assert.equal(r.service.watcher.size, 0);
    });

    it("W5: a finished wait keeps its result for a while, and cancelling it again changes nothing", async () => {
        const r = rig();
        r.ocr.texts = { "crop:toastA": ["Sam Rowe wrote to you"] };
        const wait = start(r);
        await r.step();
        r.screen.label = "toastA";
        await r.until(() => r.waits.view("conv-1", wait.id)!.status === "matched");
        assert.equal(r.waits.cancel("conv-1", wait.id)?.status, "matched");
        r.clock.t += 31 * 60_000;
        assert.equal(r.waits.view("conv-1", wait.id), undefined, "a result nobody collected is dropped");
    });

    it("W6: another conversation cannot see, wait on or cancel it", async () => {
        const r = rig();
        const wait = start(r, "conv-1");
        assert.equal(r.waits.view("conv-2", wait.id), undefined);
        assert.equal(r.waits.cancel("conv-2", wait.id), undefined);
        assert.equal(await r.waits.wait("conv-2", wait.id, 5, new AbortController().signal), undefined);
        assert.equal(r.waits.view("conv-1", wait.id)?.status, "watching");
    });

    it("W5: stopping a conversation cancels its waits and no one else's", () => {
        const r = rig();
        const mine = start(r, "conv-1");
        const theirs = start(r, "conv-2");
        assert.equal(r.waits.cancelFor("conv-1"), 1);
        assert.equal(r.waits.view("conv-1", mine.id)?.status, "cancelled");
        assert.equal(r.waits.view("conv-2", theirs.id)?.status, "watching");
        assert.equal(r.waits.cancelFor(), 1);
        assert.equal(r.service.watcher.size, 0);
    });
});

describe("a model that fails", () => {
    it("W7: three failures in a row end it, in fixed words that never carry the provider's text", async () => {
        const r = rig();
        r.decisions.answer = "fail";
        r.ocr.texts = { "crop:toastA": ["one"], "crop:toastB": ["two"], "crop:toastC": ["three"] };
        const wait = start(r);
        await r.step();
        for (const label of ["toastA", "toastB", "toastC"]) {
            r.screen.label = label;
            await r.until(() => r.decisions.asked.length >= ["toastA", "toastB", "toastC"].indexOf(label) + 1 || r.waits.view("conv-1", wait.id)!.status !== "watching");
            await r.until(() => r.waits.view("conv-1", wait.id)!.status !== "watching" || r.waits.view("conv-1", wait.id)!.failures >= ["toastA", "toastB", "toastC"].indexOf(label) + 1, 10);
        }
        const view = r.waits.view("conv-1", wait.id)!;
        assert.equal(view.status, "failed");
        assert.match(view.reason ?? "", /Decisions model/);
        assert.ok(!JSON.stringify(view).includes("secret-token-123"));
        assert.equal(r.service.watcher.size, 0);
    });

    it("W7: a model that goes away mid-wait ends it", async () => {
        const r = rig();
        r.decisions.answer = "gone";
        r.ocr.texts = { "crop:toastA": ["Sam Rowe wrote to you"] };
        const wait = start(r);
        await r.step();
        r.screen.label = "toastA";
        await r.until(() => r.waits.view("conv-1", wait.id)!.status !== "watching");
        const view = r.waits.view("conv-1", wait.id)!;
        assert.equal(view.status, "failed");
        assert.match(view.reason ?? "", /no longer set/);
    });

    it("W7: a read that fails is counted, not asked about, and the wait goes on", async () => {
        const r = rig();
        r.ocr.error = new Error("worker died");
        const wait = start(r);
        await r.step();
        r.screen.label = "toastA";
        await r.until(() => r.waits.view("conv-1", wait.id)!.changes === 1);
        for (let i = 0; i < 4; i++) await r.step();
        const view = r.waits.view("conv-1", wait.id)!;
        assert.equal(view.status, "watching");
        assert.equal(view.skipped, 1);
        assert.equal(r.decisions.asked.length, 0);
    });
});

describe("a slow answer", () => {
    it("W8: pop-ups that come while it is pending are all asked about afterwards, oldest first", async () => {
        const r = rig();
        r.decisions.answer = 0.3;
        r.ocr.texts = { "crop:toastA": ["first"], "crop:toastB": ["second"], "crop:toastC": ["third"] };
        const wait = start(r);
        await r.step();
        let release!: () => void;
        r.decisions.gate = new Promise<void>((resolve) => (release = resolve));
        r.screen.label = "toastA";
        await r.until(() => r.decisions.asked.length === 1);
        r.screen.label = "toastB";
        await r.until(() => r.waits.view("conv-1", wait.id)!.changes === 2);
        r.screen.label = "toastC";
        await r.until(() => r.waits.view("conv-1", wait.id)!.changes === 3);
        assert.equal(r.decisions.asked.length, 1, "one question at a time");
        r.decisions.gate = null;
        release();
        await r.until(() => r.decisions.asked.length === 3);
        assert.deepEqual(r.decisions.asked.map((asked) => asked.state["screen_text"]), ["first", "second", "third"]);
        assert.equal(r.waits.view("conv-1", wait.id)?.dropped, 0);
    });
});

describe("the caller's wait", () => {
    it("W9: it returns as soon as the watch matches, and returns what it has when its time is up", async () => {
        const r = rig();
        r.ocr.texts = { "crop:toastA": ["Sam Rowe wrote to you"] };
        const wait = start(r);
        const quick = await r.waits.wait("conv-1", wait.id, 15, new AbortController().signal);
        assert.equal(quick?.status, "watching", "nothing yet: it says so, and the watch carries on");

        const long = r.waits.wait("conv-1", wait.id, 60_000, new AbortController().signal);
        await r.step();
        r.screen.label = "toastA";
        await r.until(() => r.waits.view("conv-1", wait.id)!.status === "matched");
        assert.equal((await long)?.status, "matched");
    });

    it("W9: a caller that went away stops waiting at once and does not cancel the watch", async () => {
        const r = rig();
        const wait = start(r);
        const abort = new AbortController();
        const waiting = r.waits.wait("conv-1", wait.id, 60_000, abort.signal);
        abort.abort();
        assert.equal((await waiting)?.status, "watching");
        assert.equal(r.waits.view("conv-1", wait.id)?.status, "watching");
    });
});

describe("a region", () => {
    it("W10: a change outside the region is not a change, and the read is of the region", async () => {
        const r = rig();
        r.ocr.texts = { "crop:toastA": ["Sam Rowe wrote to you"], "crop:topLeft": ["Something else"] };
        // The lower right quarter of the screen: x 0.5..1, y 0.5..1.
        const wait = start(r, "conv-1", { zone: { x0: 0.5, y0: 0.5, x1: 1, y1: 1 } });
        await r.step();
        r.screen.label = "topLeft";
        for (let i = 0; i < 6; i++) await r.step();
        assert.equal(r.waits.view("conv-1", wait.id)?.changes, 0);
        assert.deepEqual(r.crops, []);

        r.screen.label = "toastA";
        await r.until(() => r.waits.view("conv-1", wait.id)!.status === "matched");
        assert.ok(r.crops.length > 0);
        for (const crop of r.crops) {
            assert.ok(crop.x >= 1920 / 2 - 15 && crop.y >= 1080 / 2 - 15, "inside the region, give or take a cell");
        }
    });
});
