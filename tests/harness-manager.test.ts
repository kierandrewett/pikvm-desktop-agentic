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
import { HarnessManager } from "../src/harness-manager";
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

test("bootstraps a secret-free config and publishes scoped client handoffs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-harness-manager-"));
    const configPath = join(dir, "harness.yaml");
    const runtimePath = join(dir, "harness-runtime.json");
    const service = new FakeService();
    const initCalls: string[][] = [];
    const manager = new HarnessManager({
        origin: "http://127.0.0.1:47616",
        daemonOrigin: "http://127.0.0.1:47615",
        command: "/opt/pikvm/bin/pikvm-agent",
        configPath,
        runtimePath,
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
        assert.equal(service.starts, 1);
    } finally {
        manager.stop();
        assert.equal(service.stops, 1);
        assert.equal(existsSync(runtimePath), false);
        rmSync(dir, { recursive: true, force: true });
    }
});

test("fails closed when another credential-bound harness owns the port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-harness-manager-"));
    const configPath = join(dir, "harness.yaml");
    const runtimePath = join(dir, "harness-runtime.json");
    writeFileSync(configPath, "providers: {}\n");
    const service = new FakeService("conflict");
    const manager = new HarnessManager({
        origin: "http://127.0.0.1:47616",
        daemonOrigin: "http://127.0.0.1:47615",
        command: "/opt/pikvm/bin/pikvm-agent",
        configPath,
        runtimePath,
        cwd: dir,
        service: service as unknown as ManagedService,
    });
    try {
        await assert.rejects(() => manager.start(), /already owns/);
        assert.equal(existsSync(runtimePath), false);
    } finally {
        manager.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});
