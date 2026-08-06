import assert from "node:assert/strict";
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    activeManagedClientRuntimePath,
    buildDirectMcpLaunch,
    buildManagedMcpLaunch,
    readHarnessRuntime,
    removeManagedClientRuntime,
    withHarnessAuthorization,
    writeHarnessRuntime,
    writeManagedClientRuntime,
    type HarnessRuntime,
} from "../src/harness-runtime";

const fixture = (): HarnessRuntime => ({
    version: 3,
    desktopPid: process.pid,
    harnessOrigin: "http://127.0.0.1:47616",
    daemonOrigin: "http://127.0.0.1:47615",
    harnessExecutable: "/opt/pikvm/bin/pikvm-agent",
    harnessConfig: "/home/example/.config/PiKVM Desktop/harness.yaml",
    agentToken: "agent-token-that-is-at-least-thirty-two-characters",
    daemonActionToken: "daemon-action-token-that-is-at-least-thirty-two-characters",
    observerToken: "observer-token-that-is-at-least-thirty-two-characters",
});

test("runtime handoff is owner-only and excludes operator approval credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-runtime-"));
    const path = join(dir, "harness-runtime.json");
    try {
        writeHarnessRuntime(path, fixture());
        assert.equal(readFileSync(path, "utf8").includes("observerToken"), true);
        assert.equal(readFileSync(path, "utf8").includes("accessToken"), false);
        assert.equal(readFileSync(path, "utf8").includes("agentToken"), true);
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

test("active managed runtime location is stable without entering client config", () => {
    assert.equal(
        activeManagedClientRuntimePath({
            PIKVM_MANAGED_CLIENT_RUNTIME: "/tmp/pikvm/active.json",
        }),
        "/tmp/pikvm/active.json",
    );
    assert.equal(
        activeManagedClientRuntimePath({
            XDG_RUNTIME_DIR: "/run/user/1000",
        }),
        "/run/user/1000/pikvm-agent/managed/managed-client-runtime.json",
    );
    assert.throws(
        () =>
            activeManagedClientRuntimePath({
                PIKVM_MANAGED_CLIENT_RUNTIME: "relative/runtime.json",
            }),
        /absolute path/,
    );
});

test("desktop publishes and revokes only its reduced managed capability", () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-managed-runtime-"));
    const path = join(dir, "private", "managed-client-runtime.json");
    const runtime = fixture();
    try {
        writeManagedClientRuntime(path, runtime);
        const document = JSON.parse(
            readFileSync(path, "utf8"),
        ) as Record<string, unknown>;
        assert.deepEqual(document, {
            schema_version: 1,
            harness_config:
                "/home/example/.config/PiKVM Desktop/harness.yaml",
            agent_token_env: "PIKVM_HARNESS_AGENT_TOKEN",
            agent_token:
                "agent-token-that-is-at-least-thirty-two-characters",
        });
        assert.equal(JSON.stringify(document).includes("daemonActionToken"), false);
        assert.equal(JSON.stringify(document).includes("observerToken"), false);
        if (process.platform !== "win32") {
            assert.equal(statSync(path).mode & 0o077, 0);
        }
        assert.equal(
            removeManagedClientRuntime(path, "another-desktop-token"),
            false,
        );
        assert.equal(existsSync(path), true);
        assert.equal(
            removeManagedClientRuntime(path, runtime.agentToken),
            true,
        );
        assert.equal(existsSync(path), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("legacy runtime tells the operator to restart the desktop for managed MCP", () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-runtime-"));
    const path = join(dir, "harness-runtime.json");
    try {
        writeFileSync(
            path,
            JSON.stringify({
                version: 1,
                desktopPid: process.pid,
                harnessOrigin: "http://127.0.0.1:47616",
                daemonOrigin: "http://127.0.0.1:47615",
                harnessExecutable: "/opt/pikvm/bin/pikvm-agent",
                harnessConfig:
                    "/home/example/.config/PiKVM Desktop/harness.yaml",
                observerToken:
                    "observer-token-that-is-at-least-thirty-two-characters",
            }),
            { mode: 0o600 },
        );
        assert.throws(
            () => readHarnessRuntime(path),
            /restart PiKVM Desktop to enable managed MCP/i,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("explicit direct compatibility launches the guarded visible MCP boundary", () => {
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

test("ordinary Claude compatibility launches the managed operator harness", () => {
    const launch = buildManagedMcpLaunch(fixture(), "claude-cli");
    assert.equal(launch.command, "/opt/pikvm/bin/pikvm-agent");
    assert.deepEqual(launch.args, [
        "harness",
        "managed-mcp",
        "--config",
        "/home/example/.config/PiKVM Desktop/harness.yaml",
        "--caller-label",
        "claude-cli",
    ]);
    assert.equal(
        launch.env.PIKVM_HARNESS_AGENT_TOKEN,
        "agent-token-that-is-at-least-thirty-two-characters",
    );
    assert.equal(launch.env.PIKVM_AGENT_DAEMON_TOKEN, undefined);
    assert.equal(launch.env.PIKVM_HARNESS_OBSERVER_TOKEN, undefined);
    assert.equal(launch.env.PIKVM_AGENT_HARNESS_TOKEN, undefined);
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

/**
 * The handoff file is read by processes that are not this one — the MCP
 * launcher runs as a child of whatever client the user configured — so what it
 * accepts IS the contract. Moving the two local services onto unix sockets
 * therefore had to move through here first: a runtime file naming
 * `unix:/…/harness.sock` used to be rejected as "must use loopback HTTP",
 * which would have broken the managed MCP handoff the moment the app started
 * using sockets.
 *
 * Observed with the app running on its own user-data-dir, harness-runtime.json
 * holding `"harnessOrigin": "unix:/tmp/pkvm-udd/run/harness.sock"`. Driving
 * dist/mcp-launcher.js over stdio: initialize answered, then
 *
 *     computer_status {"run_id":"does-not-exist"}
 *       ->  "managed harness run was not found"
 *
 * which is a 404 from the harness, so the whole chain — launcher, runtime file,
 * managed-mcp child, socket — carried a real HTTP round trip.
 */
test("a unix endpoint is as local as a loopback port, and nothing else is", () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-runtime-"));
    const path = join(dir, "harness-runtime.json");
    const socketRuntime = {
        ...fixture(),
        harnessOrigin: "unix:/home/you/.config/PiKVM Desktop/run/harness.sock",
        daemonOrigin: "unix:/home/you/.config/PiKVM Desktop/run/daemon.sock",
    };
    try {
        writeHarnessRuntime(path, socketRuntime);
        const read = readHarnessRuntime(path, { requireLiveDesktop: false });
        // The space in the settings directory survives the round trip.
        assert.equal(
            read.harnessOrigin,
            "unix:/home/you/.config/PiKVM Desktop/run/harness.sock",
        );
        assert.equal(
            read.daemonOrigin,
            "unix:/home/you/.config/PiKVM Desktop/run/daemon.sock",
        );
        // A relative socket path resolves against whatever working directory
        // the MCP client happened to have, which is not a selection of
        // anything, and a remote origin must still be refused outright.
        assert.throws(
            () =>
                writeHarnessRuntime(path, {
                    ...fixture(),
                    harnessOrigin: "unix:run/harness.sock",
                }),
            /absolute socket path/,
        );
        assert.throws(
            () =>
                writeHarnessRuntime(path, {
                    ...fixture(),
                    daemonOrigin: "http://198.51.100.7:47615",
                }),
            /loopback HTTP or a unix socket/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * The child loads the same harness YAML the desktop does, and that file's
 * `listen` is only where the harness would bind by DEFAULT. The desktop moves
 * it — to a free port when the configured one is taken, and now onto a socket —
 * without rewriting a file that carries the operator's provider settings. A
 * child left to infer the address from the YAML sends every managed and direct
 * MCP call at an address nothing is listening on, which is a bug that predates
 * the sockets and only became unmissable with them.
 */
test("both MCP launches tell the child where the harness actually is", () => {
    const socketRuntime = {
        ...fixture(),
        harnessOrigin: "unix:/home/you/.config/PiKVM Desktop/run/harness.sock",
        daemonOrigin: "unix:/home/you/.config/PiKVM Desktop/run/daemon.sock",
    };
    const managed = buildManagedMcpLaunch(socketRuntime, "claude-cli");
    const direct = buildDirectMcpLaunch(socketRuntime, "claude-cli");

    assert.equal(
        managed.env.PIKVM_HARNESS_ENDPOINT,
        "unix:/home/you/.config/PiKVM Desktop/run/harness.sock",
    );
    assert.equal(
        direct.env.PIKVM_HARNESS_ENDPOINT,
        "unix:/home/you/.config/PiKVM Desktop/run/harness.sock",
    );
    // The daemon selection travels the same way it always has, socket or not.
    assert.equal(
        direct.env.PIKVM_AGENT_DAEMON,
        "unix:/home/you/.config/PiKVM Desktop/run/daemon.sock",
    );
    // Still no capability the caller did not earn.
    assert.equal(managed.env.PIKVM_AGENT_DAEMON_TOKEN, undefined);
    assert.equal(direct.env.PIKVM_HARNESS_AGENT_TOKEN, undefined);
});
