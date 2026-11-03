/**
 * The screen watch's local diff, the one step that runs every few seconds and costs nothing.
 *
 * Failure modes, before behaviour:
 *  D1. JPEG noise or a cursor/caret/clock change fires a notification (threshold too low).
 *  D2. A window that is still sliding open, a spinner or a video fires on its way (settle time ignored).
 *  D3. A change fires more than once (baseline not moved on to the settled frame).
 *  D4. A flash that returns to what was there (a tooltip) fires.
 *  D5. A slow drift under the threshold, frame by frame, is never noticed however far it goes.
 *  D6. The signal coming back is not a change (the screen was black, then it was not).
 *  D7. A resolution change (a grid of another size) is read as "nothing changed".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changedFraction, createSettler, type Look, type Settler } from "../src/server/watch/frame-diff";
import { CELL_DELTA, CHANGE_FRACTION, DEFAULT_SETTLE_MS, limitsFromEnv, MIN_INTERVAL_MS } from "../src/server/watch/limits";
import { cursor, dialog, flat, patched } from "./support/watch-rig";

const STEP = 3000;

/** Look at `grid` every STEP from `from` for `ms`, returning every answer. */
function watch(settler: Settler, grid: Uint8Array, from: number, ms: number): Look[] {
    const out: Look[] = [];
    for (let t = from; t <= from + ms; t += STEP) out.push(settler.look(grid, t));
    return out;
}

const settledCount = (looks: Look[]) => looks.filter((look) => look.state === "settled").length;

describe("changedFraction", () => {
    it("is 0 for the same frame and ignores a shift smaller than the cell delta", () => {
        assert.equal(changedFraction(flat(100), flat(100)), 0);
        assert.equal(changedFraction(flat(100), flat(100 + CELL_DELTA - 1)), 0);
        assert.equal(changedFraction(flat(100), flat(100 + CELL_DELTA)), 1);
    });

    it("D7: frames of different sizes are wholly different", () => {
        assert.equal(changedFraction(new Uint8Array(10), new Uint8Array(20)), 1);
        assert.equal(changedFraction(new Uint8Array(0), new Uint8Array(0)), 1);
    });
});

describe("settler", () => {
    const options = { settleMs: DEFAULT_SETTLE_MS };

    it("D1: a cursor-sized change and codec noise never leave idle", () => {
        const settler = createSettler(options);
        const base = flat(60);
        settler.look(base, 0);
        let t = STEP;
        for (let i = 0; i < 40; i++, t += STEP) {
            const noisy = base.map((v, cell) => (cell % 7 === 0 ? v + CELL_DELTA - 1 : v));
            assert.equal(settler.look(i % 2 ? cursor(base) : noisy, t).state, "idle");
        }
        assert.ok(changedFraction(base, cursor(base)) < CHANGE_FRACTION);
    });

    it("D3: a settled change fires exactly once, then stays quiet while it stays put", () => {
        const settler = createSettler(options);
        const base = flat(60);
        settler.look(base, 0);
        const after = dialog(base);
        const looks = watch(settler, after, STEP, 10 * STEP);
        assert.equal(settledCount(looks), 1);
        assert.equal(looks.findIndex((look) => look.state === "settled"), 2, "the third look, six seconds after the change was first seen");
        const fired = looks.find((look) => look.state === "settled");
        assert.ok(fired && fired.state === "settled" && fired.score > CHANGE_FRACTION);
        assert.ok(looks.slice(3).every((look) => look.state === "idle"));
    });

    it("D2: a change that keeps moving never settles, and fires once when it finally stops", () => {
        const settler = createSettler(options);
        const base = flat(60);
        settler.look(base, 0);
        const looks: Look[] = [];
        let t = STEP;
        // Twenty looks, each with the dialog nine cells further along: always moving.
        for (let i = 0; i < 20; i++, t += STEP) looks.push(settler.look(patched(base, (i * 9) % 40, 10, 16, 8, 240), t));
        assert.equal(settledCount(looks), 0);
        assert.ok(settler.pending);
        const stopped = patched(base, 3, 10, 16, 8, 240);
        const rest = watch(settler, stopped, t, 4 * STEP);
        assert.equal(settledCount(rest), 1);
        assert.equal(settler.pending, false);
    });

    it("D4: a change that returns to the settled frame before it settles is dropped", () => {
        const settler = createSettler(options);
        const base = flat(60);
        settler.look(base, 0);
        assert.equal(settler.look(dialog(base), STEP).state, "changing");
        assert.equal(settler.look(base, 2 * STEP).state, "reverted");
        assert.equal(settledCount(watch(settler, base, 3 * STEP, 10 * STEP)), 0);
        assert.equal(settler.pending, false);
    });

    it("a second, different change after the first settled fires again, measured from the new baseline", () => {
        const settler = createSettler(options);
        const base = flat(60);
        settler.look(base, 0);
        const first = dialog(base);
        assert.equal(settledCount(watch(settler, first, STEP, 4 * STEP)), 1);
        // Going back to the plain screen is itself a change from the dialog.
        assert.equal(settledCount(watch(settler, base, 10 * STEP, 4 * STEP)), 1);
    });

    it("D5: a drift too slow to change any one look is noticed once its total passes the threshold", () => {
        const settler = createSettler(options);
        const base = flat(60);
        settler.look(base, 0);
        // A rectangle of cells brightens by a little each look; the total passes the cell delta and the fraction.
        const looks: Look[] = [];
        let t = STEP;
        for (let level = 0; level < 80; level += 4, t += STEP) looks.push(settler.look(patched(base, 10, 10, 20, 10, 60 + level), t));
        const rest = watch(settler, patched(base, 10, 10, 20, 10, 140), t, 4 * STEP);
        assert.ok(settledCount(looks) + settledCount(rest) >= 1);
    });

    it("D6: after the signal comes back the first frame that settles counts as a change, however it looks", () => {
        const settler = createSettler(options);
        const base = flat(60);
        settler.look(base, 0);
        settler.reset("changed");
        const looks = watch(settler, base, STEP, 5 * STEP);
        assert.equal(settledCount(looks), 1);
        const fired = looks.find((look) => look.state === "settled");
        assert.ok(fired && fired.state === "settled" && fired.score === 1);
    });

    it("a watch that starts adopts the first frame silently", () => {
        const settler = createSettler(options);
        assert.equal(settler.look(flat(60), 0).state, "idle");
        settler.reset("adopt");
        assert.equal(settledCount(watch(settler, flat(200), 0, 10 * STEP)), 0, "adopt: the first frame after a reset is the baseline");
    });
});

describe("limits", () => {
    it("never polls faster than every two seconds, whatever the environment asks", () => {
        assert.equal(limitsFromEnv({}).intervalMs, 3000);
        assert.equal(limitsFromEnv({ PIKVM_WATCH_INTERVAL_MS: "100" }).intervalMs, MIN_INTERVAL_MS);
        assert.equal(limitsFromEnv({ PIKVM_WATCH_INTERVAL_MS: "5000" }).intervalMs, 5000);
        assert.equal(limitsFromEnv({ PIKVM_WATCH_INTERVAL_MS: "nonsense" }).intervalMs, 3000);
        assert.equal(limitsFromEnv({ PIKVM_WATCH_INTERVAL_MS: "-5" }).intervalMs, 3000);
    });

    it("reads the other bounds, and ignores values that are not positive numbers", () => {
        const limits = limitsFromEnv({ PIKVM_WATCH_MIN_GAP_SEC: "120", PIKVM_WATCH_DAILY_CAP: "50.9", PIKVM_WATCH_SETTLE_MS: "2500" });
        assert.equal(limits.minCheckGapMs, 120_000);
        assert.equal(limits.dailyCap, 50);
        assert.equal(limits.settleMs, 2500);
        const bad = limitsFromEnv({ PIKVM_WATCH_MIN_GAP_SEC: "0", PIKVM_WATCH_DAILY_CAP: "", PIKVM_WATCH_SETTLE_MS: "x" });
        assert.equal(bad.minCheckGapMs, 60_000);
        assert.equal(bad.dailyCap, 200);
        assert.equal(bad.settleMs, DEFAULT_SETTLE_MS);
    });
});
