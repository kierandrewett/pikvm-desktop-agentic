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
