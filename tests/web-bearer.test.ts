/**
 * The web host's bearer (PIKVM_ACCESS_TOKEN), driven over real sockets through the route table and the real web-host sign-in.
 *
 * A request presenting `Authorization: Bearer` is judged by the bearer alone: a valid token is let through, a wrong one
 * is refused, and the rules of bearerVerdict (no Origin of another host, plain http only from loopback unless allowed,
 * no token configured = refuse) hold on every route. There is no loopback exemption for a request without one.
 * (The sessions, the password and the rest are in web-host-auth.test.ts.)
 */

import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { bearerVerdict, type SyncBearer } from "../src/server/auth";
import { createWebAuth } from "../src/server/web-auth";
import { call, run, stubTargets, upgradeStatus } from "./support/web-rig";

const TOKEN = "web-host-bearer-7f3a";
const KEY = Buffer.alloc(32, 3);

async function serve(token: string, allowHttp = false, peer?: string) {
    const auth = createWebAuth({ token, allowHttpBearer: allowHttp, trustProxy: false, sessionKey: KEY });
    return run(stubTargets(auth), peer);
}

const status = async (origin: string, path: string, headers: Record<string, string> = {}): Promise<number> =>
    (await call(origin, path, { headers })).status;
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

test("a valid bearer is accepted on the console and the forwarded kvmd routes", async () => {
    const s = await serve(TOKEN);
    try {
        assert.equal(await status(s.origin, "/app/api/v1/state", bearer(TOKEN)), 200);
        assert.equal(await status(s.origin, "/app/chat/api/conversations", bearer(TOKEN)), 200);
        assert.equal(await status(s.origin, "/anything-kvmd-owns", bearer(TOKEN)), 200);
    } finally {
        await s.close();
    }
});

test("a wrong bearer is refused 401 on every route", async () => {
    const s = await serve(TOKEN);
    try {
        assert.equal(await status(s.origin, "/app/api/v1/state", bearer("nope")), 401);
        assert.equal(await status(s.origin, "/app/chat/api/conversations", bearer("nope")), 401);
        assert.equal(await status(s.origin, "/anything-kvmd-owns", bearer("nope")), 401);
    } finally {
        await s.close();
    }
});

test("without a bearer a request has no loopback exemption: it is refused until it signs in", async () => {
    const s = await serve(TOKEN);
    try {
        assert.equal(await status(s.origin, "/app/api/v1/state"), 401);
        assert.equal(await status(s.origin, "/anything-kvmd-owns"), 401);
        assert.equal(await upgradeStatus(s.origin, "/app/chat/ws"), 0);
    } finally {
        await s.close();
    }
});

test("no token configured: every bearer is refused, even the correct-looking one", async () => {
    const s = await serve("");
    try {
        assert.equal(await status(s.origin, "/app/api/v1/state", bearer(TOKEN)), 401);
        assert.equal(await status(s.origin, "/app/api/v1/state", bearer("")), 401);
    } finally {
        await s.close();
    }
});

test("a bearer from a browser page (an Origin that is not this host) is refused", async () => {
    const s = await serve(TOKEN);
    try {
        assert.equal(await status(s.origin, "/app/api/v1/state", { ...bearer(TOKEN), origin: "https://evil.example" }), 401);
        // An Origin that is this very host is not a foreign page: accepted.
        assert.equal(await status(s.origin, "/app/api/v1/state", { ...bearer(TOKEN), origin: new URL(s.origin).origin }), 200);
    } finally {
        await s.close();
    }
});

test("a WebSocket upgrade with a bearer is judged by the same rules", async () => {
    const s = await serve(TOKEN);
    try {
        assert.equal(await upgradeStatus(s.origin, "/app/chat/ws", bearer(TOKEN)), 101);
        assert.equal(await upgradeStatus(s.origin, "/app/chat/ws", bearer("nope")), 0);
        assert.equal(await upgradeStatus(s.origin, "/app/chat/ws", { ...bearer(TOKEN), origin: "https://evil.example" }), 0);
    } finally {
        await s.close();
    }
});

test("plain http from a non-loopback peer is refused unless PIKVM_SYNC_ALLOW_HTTP is set", async () => {
    const refused = await serve(TOKEN, false, "203.0.113.9");
    try {
        assert.equal(await status(refused.origin, "/app/api/v1/state", bearer(TOKEN)), 401);
    } finally {
        await refused.close();
    }
    const allowed = await serve(TOKEN, true, "203.0.113.9");
    try {
        assert.equal(await status(allowed.origin, "/app/api/v1/state", bearer(TOKEN)), 200);
        assert.equal(await status(allowed.origin, "/app/api/v1/state", bearer("nope")), 401);
    } finally {
        await allowed.close();
    }
});

test("bearerVerdict: the loopback exemption does not apply to a presented bearer", () => {
    const fake = (remote: string, headers: Record<string, string>): IncomingMessage =>
        ({ socket: { remoteAddress: remote }, headers }) as unknown as IncomingMessage;
    const b: SyncBearer = { token: TOKEN, allowHttp: false };
    assert.equal(bearerVerdict(fake("127.0.0.1", { authorization: `Bearer ${TOKEN}` }), b), "allow");
    assert.equal(bearerVerdict(fake("203.0.113.9", { authorization: `Bearer ${TOKEN}` }), b), "deny");
    assert.equal(bearerVerdict(fake("127.0.0.1", { authorization: `Bearer ${TOKEN}`, origin: "https://x.example" }), b), "deny");
    assert.equal(bearerVerdict(fake("203.0.113.9", { authorization: `Bearer ${TOKEN}` }), { ...b, secureTransport: () => true }), "allow");
});
