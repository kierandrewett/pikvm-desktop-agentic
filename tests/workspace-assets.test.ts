import assert from "node:assert/strict";
import { createServer, get as httpGet } from "node:http";
import test from "node:test";
import { resolve } from "node:path";
import {
    createWorkspaceAssets,
    WORKSPACE_API_BASE,
    WORKSPACE_PREFIX,
} from "../src/workspace-assets";

/* Pointed at the real build output. The default resolves from __dirname, which
 * is dist/ at runtime but a temp directory under the test runner — which is the
 * reason the directory is injectable at all. */
const workspaceAssets = createWorkspaceAssets(
    resolve(process.cwd(), "agent", "pikvm_agent", "harness_ui"),
);

const listen = async () => {
    const server = createServer((req, res) => {
        const path = (req.url ?? "/").split("?")[0]!;
        if (workspaceAssets.handles(path) && workspaceAssets.serve(path, res)) return;
        res.writeHead(404);
        res.end("nope");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    assert(address && typeof address === "object");
    return {
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
    };
};

const fetchRaw = (origin: string, path: string) =>
    new Promise<{ status: number; location?: string; type?: string; body: string }>((resolve, reject) => {
        httpGet(`${origin}${path}`, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
                resolve({
                    status: res.statusCode ?? 0,
                    location: res.headers.location,
                    type: String(res.headers["content-type"] ?? ""),
                    body: Buffer.concat(chunks).toString("utf8"),
                }),
            );
        }).on("error", reject);
    });

test("the workspace mount redirects to its trailing slash", async () => {
    // Assets are referenced relatively, so a document at /_agent/workspace would
    // resolve "./app.js" against the PARENT and load nothing.
    const s = await listen();
    try {
        const r = await fetchRaw(s.origin, WORKSPACE_PREFIX);
        assert.equal(r.status, 302);
        assert.equal(r.location, WORKSPACE_PREFIX + "/");
    } finally {
        await s.close();
    }
});

test("the document tells the bundle where its API is, without an inline script", async () => {
    const s = await listen();
    try {
        const doc = await fetchRaw(s.origin, WORKSPACE_PREFIX + "/");
        assert.equal(doc.status, 200);
        assert.match(doc.type, /text\/html/);
        // A file, not an inline tag: the document ships script-src 'self' with no
        // unsafe-inline, so an inline tag would be blocked and the app would fall
        // back to same-origin /api/*, which here is the kvmd proxy.
        assert.match(doc.body, /<script src="\.\/host-config\.js"><\/script>/);
        assert.doesNotMatch(doc.body, /<script>[^<]*__PIKVM_HARNESS_API_BASE__/);
        // And it must come before the module that reads it.
        assert.ok(doc.body.indexOf("host-config.js") < doc.body.indexOf('<script type="module"'));

        const cfg = await fetchRaw(s.origin, WORKSPACE_PREFIX + "/host-config.js");
        assert.equal(cfg.status, 200);
        assert.match(cfg.type, /javascript/);
        assert.match(
            cfg.body,
            new RegExp(
                `window\\.__PIKVM_HARNESS_API_BASE__ = ${JSON.stringify(WORKSPACE_API_BASE).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};`,
            ),
        );
        /* And the managed-auth sentinel. sessionStorage is per BROWSING CONTEXT,
         * so seeding the native view did nothing for a frame in the console —
         * it came up asking for a token nobody has. Not a secret: the proxy
         * attaches the real credential and discards whatever a page sends. */
        assert.match(cfg.body, /sessionStorage\.setItem\("pikvm-harness-token", "desktop-managed"\)/);
    } finally {
        await s.close();
    }
});

test("built assets are served and escapes are refused", async () => {
    const s = await listen();
    try {
        const app = await fetchRaw(s.origin, WORKSPACE_PREFIX + "/app.js");
        assert.equal(app.status, 200);
        assert.match(app.type, /javascript/);
        assert.ok(app.body.length > 1000);

        // Nothing outside the build directory is reachable, however it is spelled.
        for (const escape of [
            "/../../package.json",
            "/../../../etc/passwd",
            "/..%2f..%2fpackage.json",
        ]) {
            const r = await fetchRaw(s.origin, WORKSPACE_PREFIX + escape);
            assert.notEqual(r.status, 200, `served something for ${escape}`);
        }
    } finally {
        await s.close();
    }
});
