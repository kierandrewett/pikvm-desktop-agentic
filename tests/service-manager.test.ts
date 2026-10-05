import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagedService } from "../src/service-manager";

test("adopts an already healthy daemon without spawning another process", async () => {
    const server = createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const logs: string[] = [];
    const service = new ManagedService({
        name: "daemon",
        origin: `http://127.0.0.1:${address.port}`,
        healthPath: "/healthz",
        command: "/definitely/not/a/real/program",
        args: [],
        log: (line) => logs.push(line),
    });
    try {
        assert.equal(await service.start(), "adopted");
        assert.match(logs.join("\n"), /adopting/);
    } finally {
        service.stop();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("a credential-bound harness refuses to adopt an unknown existing service", async () => {
    const server = createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const service = new ManagedService({
        name: "harness",
        origin: `http://127.0.0.1:${address.port}`,
        healthPath: "/api/health",
        command: "/definitely/not/a/real/program",
        args: [],
        adoptExisting: false,
    });
    try {
        assert.equal(await service.start(), "conflict");
    } finally {
        service.stop();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

/**
 * The health probe over a unix socket.
 *
 * It used to build its request with `new URL(healthPath, origin + "/")`, which
 * cannot express a socket: there is no host:port for the health path to resolve
 * against. Adoption is decided entirely by this probe — start() only spawns a
 * child when it comes back false — so a health check that could not speak the
 * transport would have meant spawning a second daemon on top of a healthy one.
 *
 * The directory name has a space in it because the real socket lives under
 * "~/.config/PiKVM Desktop".
 */
test("a daemon on a unix socket is seen as healthy and adopted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm svc "));
    const socketPath = join(dir, "daemon.sock");
    let probedPath = "";
    const server = createServer((req, res) => {
        probedPath = req.url ?? "";
        res.writeHead(200);
        res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const logs: string[] = [];
    const service = new ManagedService({
        name: "daemon",
        origin: `unix:${socketPath}`,
        healthPath: "/healthz",
        command: "/definitely/not/a/real/program",
        args: [],
        log: (line) => logs.push(line),
    });
    try {
        assert.equal(await service.healthy(), true);
        assert.equal(probedPath, "/healthz");
        // Healthy → adopted, so the bogus command above is never run.
        assert.equal(await service.start(), "adopted");
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A socket that is not there is unhealthy, not an exception. */
test("an absent socket reads as unhealthy rather than throwing", async () => {
    const service = new ManagedService({
        name: "daemon",
        origin: "unix:/nonexistent/pikvm-desktop-test/daemon.sock",
        healthPath: "/healthz",
        command: "/definitely/not/a/real/program",
        args: [],
    });
    assert.equal(await service.healthy(), false);
});

/** So is an endpoint string that does not parse — this is polled, not thrown. */
test("an unparseable endpoint reads as unhealthy rather than throwing", async () => {
    const service = new ManagedService({
        name: "daemon",
        origin: "unix:",
        healthPath: "/healthz",
        command: "/definitely/not/a/real/program",
        args: [],
    });
    assert.equal(await service.healthy(), false);
});

/**
 * The restart ceiling counted crashes, not crash LOOPS.
 *
 * `restarts` only ever went up. MAX_RESTARTS exists to catch a service that
 * cannot start at all — a bad command, a missing venv, a config it refuses —
 * and the give-up line says as much ("likely misconfigured"). But the desktop
 * stays open for days on a KVM, so five unrelated crashes hours apart, each one
 * restarted successfully and each one recovered, hit exactly the same ceiling as
 * five in ten seconds. After that the daemon was never restarted again for the
 * rest of the session, and the only trace was one log line calling a service
 * that had been running fine all week misconfigured.
 *
 * A child that survives a decent while did not fail to START, so its exit ends
 * the consecutive run. Only back-to-back failures are a loop.
 *
 * stableRunMs is injected here (120ms) because the real 60s threshold is not
 * something a test can wait out; the production default is STABLE_RUN_MS.
 */
test("a service that ran a while resets the consecutive-restart count", async () => {
    const logs: string[] = [];
    const service = new ManagedService({
        name: "daemon",
        origin: "unix:/nonexistent/pikvm-desktop-test/never.sock", // never healthy → always spawns
        healthPath: "/healthz",
        // Lives ~300ms, comfortably past the 120ms stability threshold below.
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(1), 300)"],
        stableRunMs: 120,
        log: (line) => logs.push(line),
    });
    try {
        await service.start();
        // Long enough for several live-then-die cycles: each child survives the
        // threshold, so each exit resets and none of them accumulate.
        await new Promise((r) => setTimeout(r, 9000));
        const resets = logs.filter((l) => l.includes("restart count reset")).length;
        const gaveUp = logs.some((l) => l.includes("giving up"));
        assert.ok(resets >= 1, `expected at least one reset, got logs:\n${logs.join("\n")}`);
        assert.equal(gaveUp, false, "a service that keeps recovering must not be given up on");
    } finally {
        service.stop();
    }
});

/** A genuine crash loop still hits the ceiling and stops. */
test("a service that dies instantly is given up on", async () => {
    const logs: string[] = [];
    const service = new ManagedService({
        name: "daemon",
        origin: "unix:/nonexistent/pikvm-desktop-test/never.sock",
        healthPath: "/healthz",
        command: process.execPath,
        args: ["-e", "process.exit(1)"], // dies at once, every time
        /* Comfortably above node's own startup cost. A child that exits the
         * instant it is up still LIVED ~150ms, so a threshold near that reads a
         * crash loop as a series of stable runs — which is exactly what the
         * first draft of this test did, and why it caught it. The production
         * STABLE_RUN_MS of 60s has no such ambiguity. */
        stableRunMs: 1500,
        log: (line) => logs.push(line),
    });
    try {
        await service.start();
        // 5 restarts at RESTART_DELAY_MS (2s) apart, plus room to give up.
        await new Promise((r) => setTimeout(r, 13000));
        assert.ok(
            logs.some((l) => l.includes("giving up after 5 rapid restarts")),
            `expected it to give up, got logs:\n${logs.join("\n")}`,
        );
        assert.ok(!logs.some((l) => l.includes("restart count reset")), "nothing survived long enough to reset");
    } finally {
        service.stop();
    }
});

test("a started service is told the app's pid so it can exit with the app", async () => {
    // parent_watch.py reads this; without it a crashed app leaves the service
    // holding the sockets and every later app gets 401 from it.
    const logs: string[] = [];
    let resolveSeen!: () => void;
    const seen = new Promise<void>((resolve) => (resolveSeen = resolve));
    const service = new ManagedService({
        name: "probe",
        origin: "unix:/nonexistent/pikvm-test.sock",
        healthPath: "/healthz",
        command: process.execPath,
        args: ["-e", "console.log('parent=' + process.env.PIKVM_AGENT_PARENT_PID); setTimeout(() => {}, 5000)"],
        log: (line) => {
            logs.push(line);
            if (line.startsWith("[probe] parent=")) resolveSeen();
        },
    });
    try {
        assert.equal(await service.start(), "started");
        await Promise.race([seen, new Promise((resolve) => setTimeout(resolve, 5000))]);
        assert.match(logs.join("\n"), new RegExp(`parent=${process.pid}\\b`));
    } finally {
        service.stop();
    }
});
