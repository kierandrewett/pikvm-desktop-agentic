import assert from "node:assert/strict";
import test from "node:test";
import { selectMcpLaunch } from "../src/mcp-launch-plan";
import type { HarnessRuntime } from "../src/harness-runtime";

const runtime: HarnessRuntime = {
    version: 3,
    desktopPid: process.pid,
    harnessOrigin: "http://127.0.0.1:47616",
    daemonOrigin: "http://127.0.0.1:47615",
    harnessExecutable: "/opt/pikvm/bin/pikvm-agent",
    harnessConfig: "/home/example/.config/PiKVM Desktop/harness.yaml",
    agentToken: "agent-token-that-is-at-least-thirty-two-characters",
    daemonActionToken: "daemon-action-token-that-is-at-least-thirty-two-characters",
    observerToken: "observer-token-that-is-at-least-thirty-two-characters",
};

test("ordinary desktop MCP clients receive only the managed computer facade", () => {
    const launch = selectMcpLaunch(runtime, "claude-cli");
    assert.equal(launch.args[1], "managed-mcp");
    assert.equal(launch.env.PIKVM_HARNESS_AGENT_TOKEN, runtime.agentToken);
    assert.equal(launch.env.PIKVM_AGENT_DAEMON_TOKEN, undefined);
    assert.equal(launch.env.PIKVM_HARNESS_OBSERVER_TOKEN, undefined);
});

test("guarded direct control remains an explicit compatibility choice", () => {
    const launch = selectMcpLaunch(runtime, "claude-cli", "direct");
    assert.equal(launch.args[1], "direct-mcp");
    assert.equal(
        launch.env.PIKVM_AGENT_DAEMON_TOKEN,
        runtime.daemonActionToken,
    );
    assert.equal(
        launch.env.PIKVM_HARNESS_OBSERVER_TOKEN,
        runtime.observerToken,
    );
    assert.equal(launch.env.PIKVM_HARNESS_AGENT_TOKEN, undefined);
    assert.equal(launch.env.PIKVM_AGENT_HARNESS_TOKEN, undefined);
});
