import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
    AGENT_EXECUTABLE,
    describeAgentRuntime,
    resolveAgentRuntime,
    type AgentRuntimeLocations,
} from "../src/agent-runtime.ts";

const LOCATIONS: AgentRuntimeLocations = {
    bundled: "/app/resources/agent/runtime/bin/pikvm-agent",
    workspace: "/repo/agent/.venv/bin/pikvm-agent",
    legacy: "/home/u/dev/pikvm-agent/.venv/bin/pikvm-agent",
};

/** Nothing on disk, nothing on PATH. */
const nothing = { exists: () => false, onPath: () => null };

/** Only the listed paths exist. */
const only = (...present: string[]) => ({
    exists: (p: string) => present.includes(p),
    onPath: () => null,
});

test("a missing runtime is a result, not a bare name handed to spawn", () => {
    const r = resolveAgentRuntime(LOCATIONS, nothing);
    assert.equal(r.found, false);
    assert.equal(r.command, null);
    if (r.found) return;
    // The whole point: the old code returned "pikvm-agent" here and spawn() ate it.
    assert.ok(!r.tried.includes(AGENT_EXECUTABLE));
    assert.match(r.hint, /make agent-runtime/);
});

test("PATH counts only when a lookup actually finds it", () => {
    const found = resolveAgentRuntime(LOCATIONS, {
        exists: () => false,
        onPath: () => "/usr/local/bin/pikvm-agent",
    });
    assert.equal(found.found, true);
    assert.equal(found.command, "/usr/local/bin/pikvm-agent");
    assert.equal(found.found && found.source, "path");

    assert.equal(resolveAgentRuntime(LOCATIONS, nothing).found, false);
});

test("bundled outranks a development checkout", () => {
    // An installed app must never quietly run a developer's half-migrated venv.
    const r = resolveAgentRuntime(LOCATIONS, only(LOCATIONS.bundled, LOCATIONS.workspace));
    assert.equal(r.found && r.command, LOCATIONS.bundled);
    assert.equal(r.found && r.source, "bundled");
});

test("the workspace venv wins when nothing is bundled", () => {
    const r = resolveAgentRuntime(LOCATIONS, only(LOCATIONS.workspace, LOCATIONS.legacy!));
    assert.equal(r.found && r.command, LOCATIONS.workspace);
    assert.equal(r.found && r.source, "workspace");
});

test("the retired checkout is last, and only when it is the only thing left", () => {
    const r = resolveAgentRuntime(LOCATIONS, only(LOCATIONS.legacy!));
    assert.equal(r.found && r.command, LOCATIONS.legacy);
    assert.equal(r.found && r.source, "legacy");

    // Dropping it is a one-line change once nothing depends on it.
    const withoutLegacy = resolveAgentRuntime(
        { bundled: LOCATIONS.bundled, workspace: LOCATIONS.workspace },
        only(LOCATIONS.legacy!),
    );
    assert.equal(withoutLegacy.found, false);
});

test("an explicit override outranks everything, including a bundled runtime", () => {
    const r = resolveAgentRuntime(
        { ...LOCATIONS, configured: "/opt/mine/pikvm-agent" },
        only("/opt/mine/pikvm-agent", LOCATIONS.bundled),
    );
    assert.equal(r.found && r.command, "/opt/mine/pikvm-agent");
    assert.equal(r.found && r.source, "override");
});

test("an override that does not exist falls through rather than killing the app", () => {
    // A stale setting pointing at a deleted venv is the common case, and it must
    // not be more fatal than having no setting at all.
    const r = resolveAgentRuntime(
        { ...LOCATIONS, configured: "/gone/pikvm-agent" },
        only(LOCATIONS.bundled),
    );
    assert.equal(r.found && r.command, LOCATIONS.bundled);
    assert.ok(r.tried.includes("/gone/pikvm-agent"));
});

test("env overrides are tried in the order given, after the settings value", () => {
    const r = resolveAgentRuntime(
        { ...LOCATIONS, configured: "/gone", env: ["/env/first", "/env/second"] },
        only("/env/first", "/env/second"),
    );
    assert.equal(r.found && r.command, "/env/first");
    assert.deepEqual(r.tried, ["/gone", "/env/first"]);
});

test("undefined env entries are skipped, not treated as candidates", () => {
    const r = resolveAgentRuntime(
        { ...LOCATIONS, env: [undefined, "/env/set"] },
        only("/env/set"),
    );
    assert.equal(r.found && r.command, "/env/set");
    assert.deepEqual(r.tried, ["/env/set"]);
});

test("tried lists everything considered, so a failure can be explained", () => {
    const r = resolveAgentRuntime(LOCATIONS, nothing);
    assert.deepEqual(r.tried, [
        LOCATIONS.bundled,
        LOCATIONS.workspace,
        LOCATIONS.legacy,
        `${AGENT_EXECUTABLE} (PATH)`,
    ]);
});

test("the failure description names the paths and the fix", () => {
    const line = describeAgentRuntime(resolveAgentRuntime(LOCATIONS, nothing));
    assert.match(line, /NOT FOUND/);
    assert.ok(line.includes(LOCATIONS.bundled));
    assert.match(line, /uv venv agent\/\.venv/);
});

test("the success description names which candidate won", () => {
    const line = describeAgentRuntime(resolveAgentRuntime(LOCATIONS, only(LOCATIONS.bundled)));
    assert.ok(line.includes(LOCATIONS.bundled));
    assert.match(line, /\(bundled\)/);
});
