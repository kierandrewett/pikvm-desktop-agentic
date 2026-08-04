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

    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
        lifecycle.failed();
        const started = Date.now();
        await new Promise<void>((resolve) => {
            lifecycle.scheduleRetry(() => {
                delays.push(Date.now() - started);
                resolve();
            });
        });
    }

    assert.equal(lifecycle.failureCount(), 6);
    // Doubling from the base delay, then held at the cap so the gap cannot grow
    // without bound either.
    assert.ok(delays[1]! >= delays[0]!, `expected backoff, got ${delays.join(",")}`);
    assert.ok(delays[3]! > delays[0]!, `expected backoff, got ${delays.join(",")}`);
    assert.ok(delays.every((d) => d < 200), `capped, got ${delays.join(",")}`);

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
