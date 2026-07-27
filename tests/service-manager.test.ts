import assert from "node:assert/strict";
import { createServer } from "node:http";
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
