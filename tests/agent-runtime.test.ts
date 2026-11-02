import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
    AGENT_EXECUTABLE,
    agentExecutablePaths,
    describeAgentRuntime,
    resolveAgentRuntime,
    type AgentRuntimeLocations,
} from "../src/agent-runtime.ts";

const LOCATIONS: AgentRuntimeLocations = {
    bundled: "/app/resources/agent/runtime/bin/pikvm-agent",
    workspace: "/repo/agent/.venv/bin/pikvm-agent",
};

/** Nothing on disk. */
const nothing = { exists: () => false };

/** Only the listed paths exist. */
const only = (...present: string[]) => ({ exists: (p: string) => present.includes(p) });

test("a missing runtime is a result, not a bare name handed to spawn", () => {
    const r = resolveAgentRuntime(LOCATIONS, nothing);
    assert.equal(r.found, false);
    assert.equal(r.command, null);
    if (r.found) return;
    // The whole point: the old code returned "pikvm-agent" here and spawn() ate it.
    assert.ok(!r.tried.includes(AGENT_EXECUTABLE));
    assert.ok(r.tried.every((t) => t.startsWith("/")), "a candidate must be a real path");
    assert.match(r.hint, /make agent-runtime/);
});

test("bundled outranks a development checkout", () => {
    // An installed app must never quietly run a developer's half-migrated venv.
    const r = resolveAgentRuntime(LOCATIONS, only(LOCATIONS.bundled, LOCATIONS.workspace));
    assert.equal(r.found && r.command, LOCATIONS.bundled);
    assert.equal(r.found && r.source, "bundled");
});

test("the workspace venv wins when nothing is bundled", () => {
    const r = resolveAgentRuntime(LOCATIONS, only(LOCATIONS.workspace));
    assert.equal(r.found && r.command, LOCATIONS.workspace);
    assert.equal(r.found && r.source, "workspace");
});

test("there is no third place to look", () => {
    /* The retired ~/dev/pikvm-agent checkout used to be a candidate, and so did
     * a PATH sweep. Both are gone: an installation that is neither shipped with
     * the app nor built in the tree has to be named by the override. */
    const r = resolveAgentRuntime(LOCATIONS, only("/home/u/dev/pikvm-agent/.venv/bin/pikvm-agent"));
    assert.equal(r.found, false);
    assert.equal(r.tried.length, 2);
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
    assert.deepEqual(r.tried, [LOCATIONS.bundled, LOCATIONS.workspace]);
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

/* Windows paths. FAILURE MODES: the bundled runtime is looked for at a POSIX path (bin/pikvm-agent) that
 * a Windows tree does not have, so the app reports "no runtime" beside a complete one; the answer uses the
 * separators of the machine running the check instead of the target; the dev checkout is looked for in
 * .venv/bin instead of .venv\Scripts; a POSIX result gains an .exe. */
test("agentExecutablePaths: Windows uses pikvm-agent.exe beside python.exe and .venv\\Scripts", () => {
    const paths = agentExecutablePaths("C:\\Program Files\\PiKVM Desktop\\resources\\agent", "win32");
    assert.equal(paths.bundled, "C:\\Program Files\\PiKVM Desktop\\resources\\agent\\runtime\\pikvm-agent.exe");
    assert.equal(paths.workspace, "C:\\Program Files\\PiKVM Desktop\\resources\\agent\\.venv\\Scripts\\pikvm-agent.exe");
});

test("agentExecutablePaths: POSIX keeps runtime/bin/pikvm-agent and .venv/bin, with no .exe", () => {
    for (const platform of ["linux", "darwin"] as const) {
        const paths = agentExecutablePaths("/usr/lib/pikvm-desktop/resources/agent", platform);
        assert.equal(paths.bundled, "/usr/lib/pikvm-desktop/resources/agent/runtime/bin/pikvm-agent");
        assert.equal(paths.workspace, "/usr/lib/pikvm-desktop/resources/agent/.venv/bin/pikvm-agent");
    }
});

test("agentExecutablePaths: forward slashes in a Windows base path are normalised", () => {
    assert.equal(
        agentExecutablePaths("C:/app/resources/agent", "win32").bundled,
        "C:\\app\\resources\\agent\\runtime\\pikvm-agent.exe",
    );
});

test("a Windows bundled runtime resolves when only the exe exists", () => {
    const { bundled, workspace } = agentExecutablePaths("D:\\agent", "win32");
    const found = resolveAgentRuntime({ bundled, workspace }, { exists: (p) => p === bundled });
    assert.equal(found.found, true);
    if (found.found) assert.equal(found.source, "bundled");
});
