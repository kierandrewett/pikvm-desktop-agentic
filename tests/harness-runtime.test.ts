import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    buildDirectMcpLaunch,
    readHarnessRuntime,
    withHarnessAuthorization,
    writeHarnessRuntime,
    type HarnessRuntime,
} from "../src/harness-runtime";

const fixture = (): HarnessRuntime => ({
    version: 2,
    desktopPid: process.pid,
    harnessOrigin: "http://127.0.0.1:47616",
    daemonOrigin: "http://127.0.0.1:47615",
    harnessExecutable: "/opt/pikvm/bin/pikvm-agent",
    harnessConfig: "/home/example/.config/PiKVM Desktop/harness.yaml",
    daemonActionToken: "daemon-action-token-that-is-at-least-thirty-two-characters",
    observerToken: "observer-token-that-is-at-least-thirty-two-characters",
});

test("runtime handoff is owner-only and serializes only guarded-direct credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-runtime-"));
    const path = join(dir, "harness-runtime.json");
    try {
        writeHarnessRuntime(path, fixture());
        assert.equal(readFileSync(path, "utf8").includes("observerToken"), true);
        assert.equal(readFileSync(path, "utf8").includes("accessToken"), false);
        assert.equal(readFileSync(path, "utf8").includes("agentToken"), false);
        assert.equal(readFileSync(path, "utf8").includes("daemonHarnessToken"), false);
        assert.equal(readFileSync(path, "utf8").includes("daemonActionToken"), true);
        if (process.platform !== "win32") {
            const mode = readHarnessRuntime(path, { requireLiveDesktop: false }).mode;
            assert.equal(mode & 0o077, 0);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("runtime handoff refuses group-readable credentials", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "pikvm-runtime-"));
    const path = join(dir, "harness-runtime.json");
    try {
        writeHarnessRuntime(path, fixture());
        chmodSync(path, 0o640);
        assert.throws(
            () => readHarnessRuntime(path, { requireLiveDesktop: false }),
            /owner-only/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("Claude compatibility launches the guarded visible MCP boundary", () => {
    const launch = buildDirectMcpLaunch(fixture(), "claude-cli");
    assert.equal(launch.command, "/opt/pikvm/bin/pikvm-agent");
    assert.deepEqual(launch.args, [
        "harness",
        "direct-mcp",
        "--config",
        "/home/example/.config/PiKVM Desktop/harness.yaml",
        "--mode",
        "guarded",
        "--caller-label",
        "claude-cli",
    ]);
    assert.equal(launch.env.PIKVM_AGENT_DAEMON, "http://127.0.0.1:47615");
    assert.equal(
        launch.env.PIKVM_AGENT_DAEMON_TOKEN,
        "daemon-action-token-that-is-at-least-thirty-two-characters",
    );
    assert.equal(
        launch.env.PIKVM_HARNESS_OBSERVER_TOKEN,
        "observer-token-that-is-at-least-thirty-two-characters",
    );
    assert.equal(launch.env.PIKVM_AGENT_HARNESS_TOKEN, undefined);
    assert.equal(launch.env.PIKVM_AGENT_TRUSTED_APPROVAL_CLIENT, undefined);
    assert.equal(JSON.stringify(launch).includes("mcp_server"), false);
});

test("desktop auth replaces the renderer sentinel case-insensitively", () => {
    assert.deepEqual(
        withHarnessAuthorization(
            {
                Accept: "application/json",
                authorization: "Bearer desktop-managed",
            },
            "operator-secret",
        ),
        {
            Accept: "application/json",
            Authorization: "Bearer operator-secret",
        },
    );
});
