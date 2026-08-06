import assert from "node:assert/strict";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEndpoint } from "../src/endpoint";
import {
    bindArguments,
    HarnessManager,
    harnessDaemonSelectorEnvironment,
} from "../src/harness-manager";
import { readHarnessRuntime } from "../src/harness-runtime";
import type {
    ManagedService,
    ManagedServiceStart,
} from "../src/service-manager";

class FakeService {
    starts = 0;
    stops = 0;

    constructor(
        private readonly result: ManagedServiceStart = "started",
        private readonly ready = true,
    ) {}

    async start() {
        this.starts++;
        return this.result;
    }

    async waitUntilHealthy() {
        return this.ready;
    }

    stop() {
        this.stops++;
    }
}

test("forwards the managed daemon to default and disposable-lab configs", () => {
    assert.deepEqual(
        harnessDaemonSelectorEnvironment("http://127.0.0.1:47615"),
        {
            PIKVM_AGENT_DAEMON: "http://127.0.0.1:47615",
            PIKVM_LAB_DAEMON_URL: "http://127.0.0.1:47615",
        },
    );
});

test("bootstraps a secret-free config and publishes scoped client handoffs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-harness-manager-"));
    const configPath = join(dir, "harness.yaml");
    const runtimePath = join(dir, "harness-runtime.json");
    const managedClientRuntimePath = join(
        dir,
        "managed",
        "managed-client-runtime.json",
    );
    const service = new FakeService();
    const initCalls: string[][] = [];
    const manager = new HarnessManager({
        origin: "http://127.0.0.1:47616",
        daemonOrigin: "http://127.0.0.1:47615",
        command: "/opt/pikvm/bin/pikvm-agent",
        configPath,
        runtimePath,
        managedClientRuntimePath,
        cwd: dir,
        runInit: async (_command, args) => {
            initCalls.push(args);
            writeFileSync(configPath, "providers: {}\n");
        },
        service: service as unknown as ManagedService,
    });
    try {
        await manager.start();
        assert.deepEqual(initCalls, [
            [
                "harness",
                "init",
                "--out",
                configPath,
                "--oauth-clis",
                "auto",
                "--listen",
                "127.0.0.1:47616",
            ],
        ]);
        const runtime = readHarnessRuntime(runtimePath);
        assert.equal(runtime.daemonOrigin, "http://127.0.0.1:47615");
        assert.equal(runtime.harnessOrigin, "http://127.0.0.1:47616");
        assert.equal(runtime.observerToken, manager.observerToken);
        assert.equal(runtime.agentToken, manager.agentToken);
        assert.equal(runtime.daemonActionToken, manager.daemonActionToken);
        assert.equal(manager.accessToken.length >= 32, true);
        assert.equal(manager.agentToken.length >= 32, true);
        assert.equal(manager.daemonActionToken.length >= 32, true);
        assert.equal(manager.daemonHarnessToken.length >= 32, true);
        assert.notEqual(manager.daemonActionToken, manager.daemonHarnessToken);
        assert.equal(
            readFileSync(runtimePath, "utf8").includes("daemonHarnessToken"),
            false,
        );
        const managedRuntime = JSON.parse(
            readFileSync(managedClientRuntimePath, "utf8"),
        ) as Record<string, unknown>;
        assert.deepEqual(Object.keys(managedRuntime).sort(), [
            "agent_token",
            "agent_token_env",
            "harness_config",
            "schema_version",
        ]);
        assert.equal(managedRuntime.schema_version, 1);
        assert.equal(
            managedRuntime.agent_token_env,
            "PIKVM_HARNESS_AGENT_TOKEN",
        );
        assert.equal(managedRuntime.agent_token, manager.agentToken);
        assert.equal(managedRuntime.harness_config, configPath);
        assert.equal(service.starts, 1);
    } finally {
        manager.stop();
        assert.equal(service.stops, 1);
        assert.equal(existsSync(runtimePath), false);
        assert.equal(existsSync(managedClientRuntimePath), false);
        rmSync(dir, { recursive: true, force: true });
    }
});

test("fails closed when another credential-bound harness owns the port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-harness-manager-"));
    const configPath = join(dir, "harness.yaml");
    const runtimePath = join(dir, "harness-runtime.json");
    const managedClientRuntimePath = join(
        dir,
        "managed",
        "managed-client-runtime.json",
    );
    writeFileSync(configPath, "providers: {}\n");
    const service = new FakeService("conflict");
    const manager = new HarnessManager({
        origin: "http://127.0.0.1:47616",
        daemonOrigin: "http://127.0.0.1:47615",
        command: "/opt/pikvm/bin/pikvm-agent",
        configPath,
        runtimePath,
        managedClientRuntimePath,
        cwd: dir,
        service: service as unknown as ManagedService,
    });
    try {
        await assert.rejects(() => manager.start(), /already owns/);
        assert.equal(existsSync(runtimePath), false);
        assert.equal(existsSync(managedClientRuntimePath), false);
    } finally {
        manager.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * The two local services moved off fixed loopback ports onto unix sockets, so a
 * port collision stops being a class of failure at all. The harness was the one
 * that kept doing it: an orphan from a previous run owning 47616, this app
 * correctly refusing credential-blind adoption, and every workspace call coming
 * back 401 while it could not spawn its own.
 *
 * Measured on a real start with its own user-data-dir:
 *
 *     [harness] starting: …/pikvm-agent harness serve --config
 *         /tmp/pkvm-udd/harness.yaml --uds /tmp/pkvm-udd/run/harness.sock
 *     [harness] Chat workspace: unix:/tmp/pkvm-udd/run/harness.sock (/app/)
 *     ss -lx:   u_str LISTEN 2048 /tmp/pkvm-udd/run/harness.sock
 *     GET :25692/_agent/harness/api/runs?limit=1  ->  200
 *
 * with no port anywhere in either child's arguments.
 */
test("a socket endpoint is passed to the child as --uds, a port as --listen", () => {
    assert.deepEqual(
        bindArguments(parseEndpoint("unix:/home/you/.config/PiKVM Desktop/run/harness.sock")),
        ["--uds", "/home/you/.config/PiKVM Desktop/run/harness.sock"],
    );
    // The space survives: the endpoint is read by prefix, not through URL,
    // which would have percent-encoded it into a path no bind can open.
    assert.deepEqual(bindArguments(parseEndpoint("http://127.0.0.1:47616")), [
        "--listen",
        "127.0.0.1:47616",
    ]);
    // IPv6 loopback keeps the bare form `harness init` writes.
    assert.deepEqual(bindArguments(parseEndpoint("http://[::1]:47616")), [
        "--listen",
        "::1:47616",
    ]);
});

test("a socket harness seeds no listen address into the generated config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-harness-manager-"));
    const configPath = join(dir, "harness.yaml");
    const socketPath = join(dir, "harness.sock");
    const initCalls: string[][] = [];
    const service = new FakeService();
    const manager = new HarnessManager({
        origin: `unix:${socketPath}`,
        daemonOrigin: `unix:${join(dir, "daemon.sock")}`,
        command: "/opt/pikvm/bin/pikvm-agent",
        configPath,
        runtimePath: join(dir, "harness-runtime.json"),
        managedClientRuntimePath: join(dir, "managed", "managed-client-runtime.json"),
        cwd: dir,
        runInit: async (_command, args) => {
            initCalls.push(args);
            writeFileSync(configPath, "providers: {}\n");
        },
        service: service as unknown as ManagedService,
    });
    try {
        await manager.start();
        // No --listen at all: a socket has no host:port to seed one with, and
        // `harness serve --uds` never reads that field to bind. The generated
        // default stays in the file because the workspace's cross-origin
        // allowlist is still derived from it.
        assert.deepEqual(initCalls, [
            ["harness", "init", "--out", configPath, "--oauth-clis", "auto"],
        ]);
        const runtime = readHarnessRuntime(join(dir, "harness-runtime.json"));
        assert.equal(runtime.harnessOrigin, `unix:${socketPath}`);
        assert.equal(runtime.daemonOrigin, `unix:${join(dir, "daemon.sock")}`);
    } finally {
        manager.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});
