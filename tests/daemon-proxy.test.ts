import assert from "node:assert/strict";
import {
    createServer,
    get as httpGet,
    type IncomingMessage,
} from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import test from "node:test";
import { createDaemonProxy } from "../src/daemon-proxy";

const listen = async (
    handler: Parameters<typeof createServer>[0],
): Promise<{ origin: string; close: () => Promise<void> }> => {
    const server = createServer(handler);
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert(address && typeof address === "object");
    return {
        origin: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise<void>((resolve) => server.close(() => resolve())),
    };
};

const read = async (
    origin: string,
    path: string,
    authorization?: string,
): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
        const request = httpGet(
            `${origin}${path}`,
            {
                headers: authorization ? { authorization } : {},
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () =>
                    resolve({
                        status: response.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString("utf8"),
                    }),
                );
            },
        );
        request.on("error", reject);
    });

test("daemon proxy replaces renderer authorization with its action capability", async () => {
    let receivedAuthorization = "";
    let receivedPath = "";
    const daemon = await listen((request: IncomingMessage, response) => {
        receivedAuthorization = String(request.headers.authorization ?? "");
        receivedPath = request.url ?? "";
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
    });
    const proxy = createDaemonProxy({
        origin: daemon.origin,
        bearerToken: "desktop-daemon-action-token-0123456789abcdef",
    });
    const front = await listen(proxy.handleHttp);

    try {
        const result = await read(
            front.origin,
            "/_agent/daemon/sessions?limit=1",
            "Bearer renderer-controlled-value",
        );
        assert.equal(result.status, 200);
        assert.equal(receivedPath, "/sessions?limit=1");
        assert.equal(
            receivedAuthorization,
            "Bearer desktop-daemon-action-token-0123456789abcdef",
        );
    } finally {
        await front.close();
        await daemon.close();
    }
});

test("the harness proxy carries the operator capability under its own prefix", async () => {
    /* The conversation is served from the desktop's origin, so its API has to
     * come back same-origin — /api/* on that server is already the kvmd proxy
     * the console needs for HID and streaming, hence a prefix of its own.
     *
     * The capability here is STRONGER than the daemon's: it authorises computer
     * input and approvals. It is handed to the proxy, never to a renderer, so a
     * page that asks for authority it was not given still gets the desktop's. */
    let receivedAuthorization = "";
    let receivedPath = "";
    const harness = await listen((request: IncomingMessage, response) => {
        receivedAuthorization = String(request.headers.authorization ?? "");
        receivedPath = request.url ?? "";
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"runs":[]}');
    });
    const proxy = createDaemonProxy({
        origin: harness.origin,
        bearerToken: "desktop-operator-capability-abcdef0123456789",
        prefix: "/_agent/harness",
    });
    const front = await listen(proxy.handleHttp);

    try {
        const result = await read(
            front.origin,
            "/_agent/harness/api/runs?limit=5",
            "Bearer desktop-managed",
        );
        assert.equal(result.status, 200);
        assert.equal(result.body, '{"runs":[]}');
        // The prefix is stripped, and only the prefix.
        assert.equal(receivedPath, "/api/runs?limit=5");
        // The sentinel the page sends is discarded, whatever it says.
        assert.equal(
            receivedAuthorization,
            "Bearer desktop-operator-capability-abcdef0123456789",
        );
    } finally {
        await front.close();
        await harness.close();
    }
});

test("a half-configured harness mounts no route at all", () => {
    // An origin with no token would put an UNAUTHENTICATED path to the operator
    // API on this server, which is worse than having no path to it.
    const server = readFileSync(resolve(process.cwd(), "src/server.ts"), "utf8");
    assert.match(server, /deps\.harnessOrigin && deps\.harnessToken\s*\n\s*\?\s*createDaemonProxy/);
    assert.match(server, /res\.writeHead\(503[\s\S]*?harness proxy not configured/);
});

test("the harness route refuses anything that did not come from the workspace", () => {
    /* The auth gate above it exempts loopback, which is right for a desktop app
     * talking to itself and wrong for a PAGE in the user's browser: it can POST
     * to 127.0.0.1 cross-origin and the operator capability gets attached
     * server-side. CORS hides the reply, which is no comfort when the point was
     * the side effect — this route can start a run or answer an approval.
     *
     * A custom header cannot be set cross-origin without a preflight, and this
     * server answers preflights for nobody. Asserted on the source because the
     * check lives in the route table rather than in the proxy. */
    const server = readFileSync(resolve(process.cwd(), "src/server.ts"), "utf8");
    assert.match(server, /const WORKSPACE_HEADER = "x-pikvm-workspace";/);
    assert.match(server, /if \(req\.headers\[WORKSPACE_HEADER\] !== "1"\) \{[\s\S]*?403/);
    // And it is required for the harness route specifically, not the daemon one,
    // whose existing callers do not send it.
    const harnessRoute = server.slice(server.indexOf('path.startsWith("/harness/")'));
    assert.ok(harnessRoute.indexOf("WORKSPACE_HEADER") < harnessRoute.indexOf("harnessProxy.handleHttp"));
});

/**
 * The same proxy, over a unix socket instead of a port.
 *
 * The daemon answers only to us, so a loopback port bought it nothing that a
 * socket does not: the port could be held by an orphan of a previous run, and
 * anything on the box could connect to it, where a socket is a file with an
 * owner and a mode.
 *
 * Everything the TCP tests above check has to keep holding across that change,
 * so this asserts the same three things — the path is stripped to the daemon's
 * own, the renderer's authorization is discarded and replaced with the action
 * capability, and the body comes back untouched. Host is "localhost" because
 * there is no host:port to name, and Starlette needs SOMETHING to build
 * absolute URLs from.
 *
 * The directory carries a space on purpose: the real socket lives under
 * "~/.config/PiKVM Desktop", and a path that gets percent-encoded on the way
 * through names no file that can be opened.
 */
test("the daemon proxy works over a unix socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm proxy "));
    const socketPath = join(dir, "daemon.sock");
    let seen = { authorization: "", path: "", host: "" };
    const daemon = createServer((request: IncomingMessage, response) => {
        seen = {
            authorization: String(request.headers.authorization ?? ""),
            path: request.url ?? "",
            host: String(request.headers.host ?? ""),
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
    });
    await new Promise<void>((done) => daemon.listen(socketPath, done));
    const proxy = createDaemonProxy({
        origin: `unix:${socketPath}`,
        bearerToken: "desktop-daemon-action-token-0123456789abcdef",
    });
    const front = await listen(proxy.handleHttp);

    try {
        const result = await read(
            front.origin,
            "/_agent/daemon/sessions?limit=1",
            "Bearer renderer-controlled-value",
        );
        assert.equal(result.status, 200);
        assert.equal(result.body, '{"ok":true}');
        assert.equal(seen.path, "/sessions?limit=1");
        assert.equal(seen.authorization, "Bearer desktop-daemon-action-token-0123456789abcdef");
        assert.equal(seen.host, "localhost");
    } finally {
        await front.close();
        await new Promise<void>((done) => daemon.close(() => done()));
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A daemon that is not there answers 502 whichever transport it is not there on. */
test("an absent unix socket answers 502 rather than hanging", async () => {
    const proxy = createDaemonProxy({
        origin: "unix:/nonexistent/pikvm-desktop-test/daemon.sock",
        bearerToken: "t",
    });
    const front = await listen(proxy.handleHttp);
    try {
        const result = await read(front.origin, "/_agent/daemon/healthz");
        assert.equal(result.status, 502);
        assert.match(result.body, /daemon_unreachable/);
    } finally {
        await front.close();
    }
});
