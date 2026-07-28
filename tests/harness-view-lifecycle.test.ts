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

test("rebuilt harness assets coalesce into one cache-bypassing renderer reload", async () => {
    const lifecycle = new HarnessViewLifecycle(
        "http://127.0.0.1:47616/app/",
        500,
        5,
    );
    let reloads = 0;

    lifecycle.scheduleAssetReload(() => reloads++);
    lifecycle.scheduleAssetReload(() => reloads++);
    lifecycle.scheduleAssetReload(() => reloads++);

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(reloads, 1);

    lifecycle.scheduleAssetReload(() => reloads++);
    lifecycle.stop();
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(reloads, 1);
});
