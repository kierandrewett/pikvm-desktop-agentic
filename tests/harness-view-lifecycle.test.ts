import assert from "node:assert/strict";
import test from "node:test";
import { HarnessViewLifecycle } from "../src/harness-view-lifecycle";

test("managed auth can trigger exactly one renderer reload", () => {
    const lifecycle = new HarnessViewLifecycle(
        "http://127.0.0.1:47616/app/",
    );

    assert.equal(
        lifecycle.shouldBootstrapAuth("http://127.0.0.1:47616/app/"),
        true,
    );
    assert.equal(
        lifecycle.shouldBootstrapAuth("http://127.0.0.1:47616/app/"),
        false,
    );
    assert.equal(
        lifecycle.shouldBootstrapAuth("https://example.invalid/"),
        false,
    );
});

test("a failed document cannot consume the managed auth bootstrap", () => {
    const lifecycle = new HarnessViewLifecycle(
        "http://127.0.0.1:47616/app/",
    );

    lifecycle.beginLoad();
    lifecycle.failed();
    assert.equal(
        lifecycle.shouldBootstrapAuth("http://127.0.0.1:47616/app/"),
        false,
    );

    lifecycle.beginLoad();
    assert.equal(
        lifecycle.shouldBootstrapAuth("http://127.0.0.1:47616/app/"),
        true,
    );
});

test("initial load failures coalesce and a successful load cancels the retry", async () => {
    const lifecycle = new HarnessViewLifecycle(
        "http://127.0.0.1:47616/app/",
        5,
    );
    let retries = 0;
    lifecycle.scheduleRetry(() => retries++);
    lifecycle.scheduleRetry(() => retries++);
    lifecycle.loaded();

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(retries, 0);

    lifecycle.scheduleRetry(() => retries++);
    lifecycle.scheduleRetry(() => retries++);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(retries, 1);
});

test("a harness that never starts is retried more slowly, not twice a second forever", async () => {
    const lifecycle = new HarnessViewLifecycle(
        "http://127.0.0.1:47616/app/",
        10,
        800,
        40,
    );
    assert.equal(lifecycle.failureCount(), 0);

    /* Asserted on the SCHEDULE, not on a stopwatch.
     *
     * This used to time each retry with Date.now(). With a 10ms base and a 40ms
     * cap those measurements sit inside the scheduler's own noise: an overloaded
     * runner can fire the first timer at 45ms and the fourth at 42ms, and
     * "the fourth waits longer than the first" fails on a backoff that is
     * perfectly correct. It failed exactly once here, which is the worst kind of
     * red — enough to distrust the suite, not enough to reproduce. */
    const scheduled: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
        lifecycle.failed();
        scheduled.push(lifecycle.nextRetryDelayMs());
        await new Promise<void>((resolve) => lifecycle.scheduleRetry(resolve));
    }

    assert.equal(lifecycle.failureCount(), 6);
    // Doubling from the base, then held at the cap so the gap cannot grow
    // without bound either.
    assert.deepEqual(scheduled, [10, 20, 40, 40, 40, 40]);

    // Reaching the harness clears the streak, so a later blip starts fast again.
    lifecycle.loaded();
    assert.equal(lifecycle.failureCount(), 0);
});

test("rebuilt harness assets coalesce into one cache-bypassing renderer reload", async () => {
    const lifecycle = new HarnessViewLifecycle(
        "http://127.0.0.1:47616/app/",
        500,
        20,
    );
    let reloads = 0;

    lifecycle.scheduleAssetReload(() => reloads++);
    await new Promise((resolve) => setTimeout(resolve, 10));
    lifecycle.scheduleAssetReload(() => reloads++);
    await new Promise((resolve) => setTimeout(resolve, 10));
    lifecycle.scheduleAssetReload(() => reloads++);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(reloads, 1);

    lifecycle.scheduleAssetReload(() => reloads++);
    lifecycle.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(reloads, 1);
});
