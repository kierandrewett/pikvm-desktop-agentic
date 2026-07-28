import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const script = resolve(
    process.cwd(),
    "scripts",
    "inspect-electron-cdp.mjs",
);

test("CDP inspector refuses to fill an operator window", () => {
    const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: {
            ...process.env,
            PIKVM_CDP_FILL_MATCH: "/app/",
            PIKVM_CDP_FILL_SELECTOR: "textarea",
            PIKVM_CDP_FILL_VALUE: "synthetic prompt",
        },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /CDP inspector is read-only/);
    assert.match(result.stderr, /PIKVM_CDP_FILL_VALUE/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
});

test("CDP inspector refuses clicks and reloads", () => {
    const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: {
            ...process.env,
            PIKVM_CDP_CLICK_MATCH: "/app/",
            PIKVM_CDP_CLICK_LABEL: "Send",
            PIKVM_CDP_RELOAD_MATCH: "/app/",
        },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /CDP inspector is read-only/);
    assert.match(result.stderr, /PIKVM_CDP_CLICK_LABEL/);
    assert.match(result.stderr, /PIKVM_CDP_RELOAD_MATCH/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
});
