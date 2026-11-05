/**
 * The one poller shared by every user's watch.
 *
 * Failure modes, before behaviour:
 *  K1. A poller per user: two users make two snapshots every look.
 *  K2. The poller keeps running (or an unfinished snapshot keeps going) after the last user switched off.
 *  K3. The screen going black for no signal is handed on as a change.
 *  K4. One missed look is announced as a lost signal; or the signal coming back is not announced.
 *  K5. A watch that starts while there is no signal announces it.
 *  K6. The PiKVM being unreachable is mistaken for no signal.
 *  K7. A pipeline that throws stops the other users' watches.
 *  K9. A pending corner change waits for the next look instead of the moment it will have held, or looks in a tight loop.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWatcher, type Snapshot, type Watcher } from "../src/server/watch/watcher";
import type { Alerts as Pipeline } from "../src/server/watch/alerts";
import type { Frame } from "../src/server/watch/frame-diff";
import { flat } from "./support/watch-rig";

interface Rig {
    watcher: Watcher;
    /** The scheduled timers waiting, with the delay each was set with. */
    timers: { ms: number; cancelled: boolean; fn: () => void }[];
    snapshots: number;
    aborted: boolean[];
    /** What the next snapshots answer; the last one repeats. */
    next: (Snapshot | "hang")[];
    grid: Uint8Array | null;
    /** The clock the watcher reads. */
    now: number;
    /** Fire the pending timer and wait for the tick it runs. */
    step(): Promise<void>;
}

function rig(): Rig {
    const state: Rig = {
        now: 42,
        timers: [],
        snapshots: 0,
        aborted: [],
        next: [{ kind: "frame", jpeg: Buffer.from("a") }],
        grid: flat(60),
        watcher: undefined as unknown as Watcher,
        async step() {
            const timer = state.timers.find((entry) => !entry.cancelled);
            assert.ok(timer, "a timer is waiting");
            timer.cancelled = true;
            timer.fn();
            // The loop's tick: let its promises settle.
            for (let i = 0; i < 10; i++) await Promise.resolve();
            await new Promise((done) => setImmediate(done));
        },
    };
    state.watcher = createWatcher({
        intervalMs: 3000,
        now: () => state.now,
        schedule(fn, ms) {
            const entry = { ms, cancelled: false, fn };
            state.timers.push(entry);
            return () => void (entry.cancelled = true);
        },
        async snapshot(signal) {
            state.snapshots++;
            const reply = state.next.length > 1 ? state.next.shift()! : state.next[0]!;
            if (reply === "hang") {
                return new Promise<Snapshot>((_resolve, reject) => {
                    signal.addEventListener("abort", () => {
                        state.aborted.push(true);
                        reject(new Error("aborted"));
                    });
                });
            }
            return reply;
        },
        grid: async () => state.grid,
    });
    return state;
}

interface Seen {
    looks: (Frame | null)[];
    pipeline: Pipeline;
}

function recorder(over: Partial<Pipeline> = {}): Seen {
    const seen: Seen = {
        looks: [],
        pipeline: {
            look: (frame) => void seen.looks.push(frame),
            idle: async () => undefined,
            wakeAt: () => null,
            status: () => ({ pending: false, waiting: false, checking: false }),
            ...over,
        },
    };
    return seen;
}

describe("the shared poller", () => {
    it("K1/K2: starts with the first user, takes one snapshot per look for everyone, stops with the last", async () => {
        const r = rig();
        assert.equal(r.watcher.running, false);
        const a = recorder();
        const b = recorder();
        r.watcher.attach("a", a.pipeline);
        assert.equal(r.watcher.running, true);
        r.watcher.attach("b", b.pipeline);
        assert.equal(r.watcher.size, 2);
        assert.equal(r.timers.filter((t) => !t.cancelled).length, 1, "one loop, not one per user");

        await r.step();
        assert.equal(r.snapshots, 1, "one snapshot for two users");
        assert.equal(a.looks.length, 1);
        assert.equal(b.looks.length, 1);
        assert.equal(a.looks[0]!.jpeg, b.looks[0]!.jpeg);
        assert.equal(r.timers.at(-1)!.ms, 3000, "the next look is an interval away");

        r.watcher.detach("a");
        assert.equal(r.watcher.running, true);
        await r.step();
        assert.equal(a.looks.length, 1, "a detached pipeline is not looked through");
        assert.equal(b.looks.length, 2);

        r.watcher.detach("b");
        assert.equal(r.watcher.running, false);
        assert.equal(r.timers.filter((t) => !t.cancelled).length, 0, "no look is scheduled");
        assert.equal(r.snapshots, 2);
    });

    it("K2: the snapshot in flight when the last user leaves is aborted and its answer is dropped", async () => {
        const r = rig();
        r.next = ["hang"];
        const a = recorder();
        r.watcher.attach("a", a.pipeline);
        const step = r.step();
        await new Promise((done) => setImmediate(done));
        assert.equal(r.snapshots, 1);
        r.watcher.detach("a");
        await step;
        assert.deepEqual(r.aborted, [true]);
        assert.deepEqual(a.looks, []);
        assert.equal(r.timers.filter((t) => !t.cancelled).length, 0);
    });

    it("can start again after it stopped", async () => {
        const r = rig();
        r.watcher.attach("a", recorder().pipeline);
        r.watcher.detach("a");
        const again = recorder();
        r.watcher.attach("a", again.pipeline);
        await r.step();
        assert.equal(again.looks.length, 1);
    });

    it("K3/K4: no signal is not a frame, counts as no signal on the second look only, and is over when a frame is back", async () => {
        const r = rig();
        const a = recorder();
        r.watcher.attach("a", a.pipeline);
        await r.step();
        assert.equal(r.watcher.signal, "signal");

        r.next = [{ kind: "no-signal" }];
        await r.step();
        assert.equal(r.watcher.signal, "signal", "one missed look is a hiccup");
        await r.step();
        assert.equal(r.watcher.signal, "no-signal");
        await r.step();
        assert.deepEqual(a.looks.slice(1), [null, null, null], "no frame was handed on, but each look gives waiting work its turn");

        r.next = [{ kind: "frame", jpeg: Buffer.from("again") }];
        await r.step();
        assert.equal(a.looks.at(-1)!.jpeg.toString(), "again");
        assert.equal(r.watcher.signal, "signal");
    });

    it("K4: a single miss between two frames is nothing", async () => {
        const r = rig();
        const a = recorder();
        r.watcher.attach("a", a.pipeline);
        r.next = [{ kind: "frame", jpeg: Buffer.from("1") }, { kind: "no-signal" }, { kind: "frame", jpeg: Buffer.from("2") }];
        await r.step();
        await r.step();
        assert.equal(r.watcher.signal, "signal");
        await r.step();
        assert.equal(r.watcher.signal, "signal");
    });

    it("K5: starting with no signal is no signal until a frame comes", async () => {
        const r = rig();
        r.next = [{ kind: "no-signal" }];
        r.watcher.attach("a", recorder().pipeline);
        await r.step();
        assert.equal(r.watcher.signal, "unknown");
        await r.step();
        assert.equal(r.watcher.signal, "no-signal");
        r.next = [{ kind: "frame", jpeg: Buffer.from("up") }];
        await r.step();
        assert.equal(r.watcher.signal, "signal");
    });

    it("K6: an unreachable PiKVM is not a lost signal", async () => {
        const r = rig();
        const a = recorder();
        r.watcher.attach("a", a.pipeline);
        await r.step();
        r.next = [{ kind: "unreachable", message: "ECONNREFUSED" }];
        for (let i = 0; i < 4; i++) await r.step();
        assert.equal(r.watcher.signal, "signal", "what it knew before stays until the PiKVM says otherwise");
    });

    it("a frame that cannot be read gives waiting work its turn and nothing else", async () => {
        const r = rig();
        r.grid = null;
        const a = recorder();
        r.watcher.attach("a", a.pipeline);
        await r.step();
        assert.deepEqual(a.looks, [null]);
    });

    it("K7: a pipeline that throws does not stop the others", async () => {
        const r = rig();
        const bad = recorder({
            look() {
                throw new Error("boom");
            },
        });
        const good = recorder();
        r.watcher.attach("bad", bad.pipeline);
        r.watcher.attach("good", good.pipeline);
        await r.step();
        await r.step();
        assert.equal(good.looks.length, 2);
    });

    it("K9: a pending corner change brings the next look forward to the moment it has held long enough, and no earlier than 50 ms", async () => {
        const r = rig();
        let wake: number | null = null;
        const a = recorder({ wakeAt: () => wake });
        r.watcher.attach("a", a.pipeline);
        wake = 42 + 200;
        await r.step();
        assert.equal(r.timers.at(-1)!.ms, 200, "200 ms from now, not a whole second");
        wake = 42 + 5000;
        await r.step();
        assert.equal(r.timers.at(-1)!.ms, 3000, "the pace, when the wake is further off");
        wake = 42 - 500;
        await r.step();
        assert.equal(r.timers.at(-1)!.ms, 50, "already due: at once, but not a tight loop");
        wake = null;
        await r.step();
        assert.equal(r.timers.at(-1)!.ms, 3000);
    });

    it("hands the frame on with the time its snapshot was requested", async () => {
        const r = rig();
        const a = recorder();
        r.watcher.attach("a", a.pipeline);
        r.now = 5000;
        await r.step();
        assert.equal(a.looks[0]!.capturedAt, 5000);
    });
});
