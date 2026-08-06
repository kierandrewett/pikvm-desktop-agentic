import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    parseEndpoint,
    endpointRequestOptions,
    endpointIsTls,
    isUnixEndpointValue,
    unixEndpointValue,
} from "../src/endpoint";

test("a TCP endpoint keeps its host, port and scheme", () => {
    const tcp = parseEndpoint("http://127.0.0.1:47615");
    assert.equal(tcp.kind, "tcp");
    assert.equal(tcp.value, "http://127.0.0.1:47615");
    assert.equal(endpointIsTls(tcp), false);
    if (tcp.kind !== "tcp") return;
    assert.equal(tcp.hostname, "127.0.0.1");
    assert.equal(tcp.port, "47615");
    assert.equal(tcp.host, "127.0.0.1:47615");
});

test("a portless TCP endpoint gets the scheme's default port", () => {
    const plain = parseEndpoint("http://example.test");
    const tls = parseEndpoint("https://example.test");
    assert.equal(plain.kind === "tcp" && plain.port, "80");
    assert.equal(tls.kind === "tcp" && tls.port, "443");
    assert.equal(endpointIsTls(tls), true);
});

/**
 * The settings directory is "~/.config/PiKVM Desktop" on every platform we
 * ship to, so the socket path has a space in it in the default install. That
 * is exactly the case a URL-based parser gets wrong: new URL("unix:/a b.sock")
 * percent-encodes the space into %20 and the path stops naming a real file.
 * Parsing by prefix is why this is a plain slice, and this test is why it has
 * to stay one.
 */
test("a unix endpoint keeps a path with spaces in it byte for byte", () => {
    const path = "/home/someone/.config/PiKVM Desktop/daemon.sock";
    const value = unixEndpointValue(path);
    assert.equal(value, "unix:/home/someone/.config/PiKVM Desktop/daemon.sock");
    assert.equal(isUnixEndpointValue(value), true);
    const parsed = parseEndpoint(value);
    assert.equal(parsed.kind, "unix");
    if (parsed.kind !== "unix") return;
    assert.equal(parsed.socketPath, path);
    assert.ok(!parsed.socketPath.includes("%20"), "the path was percent-encoded");
    assert.equal(endpointIsTls(parsed), false);
});

/**
 * A trailing slash is stripped from TCP origins throughout main.ts, so it has
 * to be stripped here too — but a socket path is a filename, and "…/d.sock/"
 * and "…/d.sock" are the same file only because the trailing slash is not part
 * of the name. Strip it in both cases and neither surprises the caller.
 */
test("a trailing slash never reaches the socket path or the origin", () => {
    assert.equal(parseEndpoint("http://127.0.0.1:47615/").value, "http://127.0.0.1:47615");
    const unix = parseEndpoint("unix:/tmp/x.sock/");
    assert.equal(unix.kind === "unix" && unix.socketPath, "/tmp/x.sock");
});

test("a socket endpoint with no path is refused by name", () => {
    assert.throws(() => parseEndpoint("unix:"), /names no socket path/);
});

test("request options carry socketPath for a socket and host:port for TCP", () => {
    const unix = endpointRequestOptions(parseEndpoint("unix:/tmp/d.sock"), "/healthz", "GET", {
        accept: "application/json",
    });
    assert.equal(unix.socketPath, "/tmp/d.sock");
    assert.equal(unix.path, "/healthz");
    assert.equal(unix.port, undefined);
    assert.equal(unix.hostname, undefined);
    // Starlette builds absolute URLs from Host, so it cannot be absent.
    assert.deepEqual(unix.headers, { accept: "application/json", host: "localhost" });

    const tcp = endpointRequestOptions(parseEndpoint("http://127.0.0.1:47615"), "/healthz", "POST", {});
    assert.equal(tcp.socketPath, undefined);
    assert.equal(tcp.hostname, "127.0.0.1");
    assert.equal(tcp.port, "47615");
    assert.equal(tcp.method, "POST");
    assert.deepEqual(tcp.headers, { host: "127.0.0.1:47615" });
});

/**
 * The point of the whole module, proved end to end rather than asserted: a real
 * http server on a real unix socket, reached through the options this builds.
 * The directory name carries a space on purpose — see the parser test above.
 */
test("a request over a real unix socket reaches a real server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm endpoint "));
    const socketPath = join(dir, "daemon.sock");
    const server = createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
    });
    try {
        await new Promise<void>((done) => server.listen(socketPath, done));
        assert.ok(existsSync(socketPath), "the socket file was not created");

        const endpoint = parseEndpoint(unixEndpointValue(socketPath));
        const body = await new Promise<string>((done, fail) => {
            const req = httpRequest(
                endpointRequestOptions(endpoint, "/healthz", "GET", {}),
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (c) => chunks.push(c as Buffer));
                    res.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
                },
            );
            req.on("error", fail);
            req.end();
        });
        assert.deepEqual(JSON.parse(body), { path: "/healthz", host: "localhost" });
    } finally {
        await new Promise<void>((done) => server.close(() => done()));
        rmSync(dir, { recursive: true, force: true });
    }
});
