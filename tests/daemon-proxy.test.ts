import assert from "node:assert/strict";
import {
    createServer,
    get as httpGet,
    type IncomingMessage,
} from "node:http";
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
