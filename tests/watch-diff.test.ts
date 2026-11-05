/**
 * The watch's numbers: what the environment can change, and what it cannot.
 *
 * Failure modes, before behaviour:
 *  D1. A value that is not a positive number replaces a default.
 *  D2. The look interval can be set below the floor (every look is a snapshot the Pi serves).
 *  D3. The old whole-screen variables still do something (there is one mode now).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTLE_MS, JUDGE_TIMEOUT_MS, limitsFromEnv, MIN_INTERVAL_MS, MODEL_BUDGET_MS, READ_TIMEOUT_MS } from "../src/server/watch/limits";

describe("limits", () => {
    it("D1: the defaults are a look a second, held 1.2 s, one check per 4 s, 500 a day, and 3 s + 3 s inside 5 s for the chat model", () => {
        assert.deepEqual(limitsFromEnv({}), { intervalMs: 1000, settleMs: 1200, minCheckGapMs: 4000, dailyCap: 500, readTimeoutMs: 3000, judgeTimeoutMs: 3000, modelBudgetMs: 5000 });
        assert.equal(DEFAULT_SETTLE_MS, 1200);
        assert.ok(MODEL_BUDGET_MS < READ_TIMEOUT_MS + JUDGE_TIMEOUT_MS, "the budget is less than the two limits together, on purpose");
    });

    it("D2: the interval is floored at one second", () => {
        assert.equal(MIN_INTERVAL_MS, 1000);
        assert.equal(limitsFromEnv({ PIKVM_WATCH_INTERVAL_MS: "200" }).intervalMs, 1000);
        assert.equal(limitsFromEnv({ PIKVM_WATCH_INTERVAL_MS: "1500" }).intervalMs, 1500);
    });

    it("D1: each can be set, and nonsense is ignored", () => {
        assert.deepEqual(
            limitsFromEnv({ PIKVM_WATCH_SETTLE_MS: "800", PIKVM_WATCH_MIN_GAP_SEC: "10", PIKVM_WATCH_DAILY_CAP: "50.7", PIKVM_WATCH_READ_TIMEOUT_MS: "8000", PIKVM_WATCH_JUDGE_TIMEOUT_MS: "6000", PIKVM_WATCH_MODEL_BUDGET_MS: "12000" }),
            { intervalMs: 1000, settleMs: 800, minCheckGapMs: 10_000, dailyCap: 50, readTimeoutMs: 8000, judgeTimeoutMs: 6000, modelBudgetMs: 12_000 },
        );
        assert.deepEqual(
            limitsFromEnv({ PIKVM_WATCH_INTERVAL_MS: "nonsense", PIKVM_WATCH_SETTLE_MS: "x", PIKVM_WATCH_MIN_GAP_SEC: "-1", PIKVM_WATCH_DAILY_CAP: "0", PIKVM_WATCH_READ_TIMEOUT_MS: "soon", PIKVM_WATCH_JUDGE_TIMEOUT_MS: "-5", PIKVM_WATCH_MODEL_BUDGET_MS: "0" }),
            limitsFromEnv({}),
        );
    });

    it("D3: the variables of the removed paths do nothing", () => {
        assert.deepEqual(limitsFromEnv({ PIKVM_WATCH_FAST_INTERVAL_MS: "5000", PIKVM_WATCH_FAST_SETTLE_MS: "9", PIKVM_WATCH_FAST_MIN_GAP_SEC: "99", PIKVM_WATCH_FAST_DAILY_CAP: "1" }), limitsFromEnv({}));
    });
});
