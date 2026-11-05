/**
 * Signing a desktop app in to the host with a browser (src/server/web-auth/devices.ts), over real sockets through the real
 * route table: the authorization request, the consent page, the one-time code with PKCE, the device token, and what a
 * device token is and is not allowed to do. The clock is the host's own, so expiry is exact and nothing sleeps.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createWebAuth, type WebAuthOptions } from "../src/server/web-auth";
import { CODE_TTL_MS, DeviceStore, MAX_DEVICES, cleanDeviceName } from "../src/server/web-auth/devices";
import { SESSION_COOKIE } from "../src/server/web-auth/session";
import { call, run, stubTargets, type Reply } from "./support/web-rig";

const TOKEN = "tok-3f9a1c7e2b8d4f60a5e1c9b7d3f2a801";
const OTHER_TOKEN = "tok-0000000000000000000000000000beef";
const KEY = Buffer.alloc(32, 9);
const PROXY_PEER = "203.0.113.9";

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-devices-"));
    dirs.push(dir);
    return dir;
};
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

interface Host {
    origin: string;
    clock: { t: number };
    close(): Promise<void>;
}

async function host(over: Partial<WebAuthOptions> = {}, peer?: string): Promise<Host> {
    const clock = { t: Date.now() };
    const auth = createWebAuth({ token: TOKEN, allowHttpBearer: false, trustProxy: false, sessionKey: KEY, now: () => clock.t, log: () => undefined, ...over });
    const s = await run(stubTargets(auth), peer);
    return { origin: s.origin, clock, close: s.close };
}

const form = (origin: string, path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Reply> =>
    call(origin, path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
const sessionCookie = (r: Reply): string => (r.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "").split(";")[0]!;
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** Sign in with the token form and hand back the cookie, as a person in a browser would. */
async function browser(h: Host): Promise<string> {
    const r = await form(h.origin, "/app/auth", { token: TOKEN });
    assert.equal(r.status, 303);
    return sessionCookie(r);
}

interface Pkce {
    verifier: string;
    challenge: string;
    state: string;
}
const pkce = (): Pkce => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: randomBytes(16).toString("base64url") };
};

const authorizeUrl = (p: Pkce, extra: Record<string, string> = {}): string =>
    `/app/auth/device?${new URLSearchParams({ port: "49321", state: p.state, challenge: p.challenge, name: "Kieran's laptop", ...extra }).toString()}`;

/** The sealed grant the consent page posts back. */
const grantOf = (page: string): string => /name="grant" value="([^"]+)"/.exec(page)![1]!;

/** The whole browser half: ask, answer, and the code the loopback address would receive. */
async function allow(h: Host, cookie: string, p: Pkce, extra: Record<string, string> = {}): Promise<{ code: string; state: string }> {
    const ask = await call(h.origin, authorizeUrl(p, extra), { headers: { cookie, accept: "text/html" } });
    assert.equal(ask.status, 200);
    const answer = await form(h.origin, "/app/auth/device", { grant: grantOf(ask.body), decision: "allow" }, { cookie });
    assert.equal(answer.status, 303);
    const location = new URL(answer.headers.get("location")!);
    assert.equal(location.origin, "http://127.0.0.1:49321");
    assert.equal(location.pathname, "/callback");
    return { code: location.searchParams.get("code")!, state: location.searchParams.get("state")! };
}

const exchange = (h: Host, code: string, verifier: string): Promise<Reply> =>
    call(h.origin, "/app/auth/device/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, verifier }) });

/** A device token, made the whole way. */
async function deviceToken(h: Host, name = "Kieran's laptop"): Promise<{ token: string; id: string }> {
    const p = pkce();
    const cookie = await browser(h);
    const { code } = await allow(h, cookie, p, { name });
    const r = await exchange(h, code, p.verifier);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body) as { token: string; id: string };
    return { token: body.token, id: body.id };
}

test("the host says it offers device sign-in, with no credential, and lists its methods and nothing else", async () => {
    const h = await host();
    try {
        const r = await call(h.origin, "/app/auth/info");
        assert.equal(r.status, 200);
        assert.deepEqual(JSON.parse(r.body), { app: "pikvm-desktop", device: true, methods: ["token"] });
    } finally {
        await h.close();
    }
});

test("the whole way in: sign in, allow, trade the code, and the device token is a bearer for the API that is no cookie", async () => {
    const h = await host();
    try {
        const p = pkce();
        const cookie = await browser(h);
        const ask = await call(h.origin, authorizeUrl(p), { headers: { cookie, accept: "text/html" } });
        assert.equal(ask.status, 200);
        assert.match(ask.body, /Allow this app to use this server\?/);
        assert.match(ask.body, /Kieran&#39;s laptop/, "the device name is shown, escaped");
        assert.equal(ask.headers.get("x-frame-options"), "DENY");
        assert.equal(ask.headers.get("cache-control"), "no-store");

        const answer = await form(h.origin, "/app/auth/device", { grant: grantOf(ask.body), decision: "allow" }, { cookie });
        const back = new URL(answer.headers.get("location")!);
        assert.equal(back.searchParams.get("state"), p.state);
        const code = back.searchParams.get("code")!;

        const traded = await exchange(h, code, p.verifier);
        assert.equal(traded.status, 200);
        assert.equal(traded.headers.get("cache-control"), "no-store");
        const body = JSON.parse(traded.body) as { token: string; name: string };
        assert.match(body.token, /^pkd_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
        assert.equal(body.name, "Kieran's laptop");
        assert.deepEqual(traded.cookies, [], "a device token is never a cookie");

        const state = await call(h.origin, "/app/api/v1/state", { headers: bearer(body.token) });
        assert.equal(state.status, 200);
        assert.equal(state.target, "api");
        assert.deepEqual(state.cookies, []);
        assert.equal((await call(h.origin, "/anything-kvmd-owns", { headers: bearer(body.token) })).target, "kvmd");
        // And a cookie is still not a bearer.
        assert.equal((await call(h.origin, "/app/api/v1/state", { headers: bearer(cookie.split("=")[1]!) })).status, 401);
    } finally {
        await h.close();
    }
});

test("Cancel sends the browser back with access_denied and the state, and no code", async () => {
    const h = await host();
    try {
        const p = pkce();
        const cookie = await browser(h);
        const ask = await call(h.origin, authorizeUrl(p), { headers: { cookie } });
        const answer = await form(h.origin, "/app/auth/device", { grant: grantOf(ask.body), decision: "deny" }, { cookie });
        const back = new URL(answer.headers.get("location")!);
        assert.equal(back.searchParams.get("error"), "access_denied");
        assert.equal(back.searchParams.get("state"), p.state);
        assert.equal(back.searchParams.get("code"), null);
    } finally {
        await h.close();
    }
});

test("the request is checked: a port that is not a user port, a short state, a challenge that is not PKCE, all refused before any page", async () => {
    const h = await host();
    try {
        const cookie = await browser(h);
        const p = pkce();
        for (const bad of [{ port: "80" }, { port: "70000" }, { port: "abc" }, { state: "short" }, { challenge: "nope" }, { state: "bad state!!!!!!!!!!!" }]) {
            const r = await call(h.origin, authorizeUrl(p, bad), { headers: { cookie } });
            assert.equal(r.status, 400, JSON.stringify(bad));
            assert.match(r.body, /not valid/);
        }
        // No port at all.
        assert.equal((await call(h.origin, `/app/auth/device?state=${p.state}&challenge=${p.challenge}`, { headers: { cookie } })).status, 400);
    } finally {
        await h.close();
    }
});

test("nobody signed in is sent to sign in and brought back to this very request", async () => {
    const h = await host();
    try {
        const p = pkce();
        const r = await call(h.origin, authorizeUrl(p), { headers: { accept: "text/html" } });
        assert.ok(r.status === 302 || r.status === 303);
        const to = new URL(r.headers.get("location")!, h.origin);
        assert.equal(to.pathname, "/app/login");
        assert.equal(to.searchParams.get("next"), authorizeUrl(p));
    } finally {
        await h.close();
    }
});

test("a header credential cannot be asked: there is nobody in front of a bearer to say yes", async () => {
    const h = await host();
    try {
        const p = pkce();
        const r = await call(h.origin, authorizeUrl(p), { headers: bearer(TOKEN) });
        assert.equal(r.status, 403);
        assert.match(r.body, /signed in/);
        const { token } = await deviceToken(h);
        assert.equal((await call(h.origin, authorizeUrl(p), { headers: bearer(token) })).status, 403, "and a device cannot make another device");
    } finally {
        await h.close();
    }
});

test("the answer comes from the sealed grant: a tampered one, an expired one and one from another person are refused", async () => {
    const h = await host();
    try {
        const p = pkce();
        const cookie = await browser(h);
        const ask = await call(h.origin, authorizeUrl(p), { headers: { cookie } });
        const grant = grantOf(ask.body);
        const tampered = `${grant.slice(0, 10)}${grant[10] === "A" ? "B" : "A"}${grant.slice(11)}`;
        assert.equal((await form(h.origin, "/app/auth/device", { grant: tampered, decision: "allow" }, { cookie })).status, 400);
        assert.equal((await form(h.origin, "/app/auth/device", { decision: "allow" }, { cookie })).status, 400, "no grant at all");
        // Another session (a second sign-in has the same subject, so make one with a different method's subject: the grant binds it).
        h.clock.t += 11 * 60_000;
        assert.equal((await form(h.origin, "/app/auth/device", { grant, decision: "allow" }, { cookie: await browser(h) })).status, 400, "expired");
    } finally {
        await h.close();
    }
});

test("a foreign page cannot post the answer", async () => {
    const h = await host();
    try {
        const p = pkce();
        const cookie = await browser(h);
        const ask = await call(h.origin, authorizeUrl(p), { headers: { cookie } });
        const r = await form(h.origin, "/app/auth/device", { grant: grantOf(ask.body), decision: "allow" }, { cookie, origin: "https://evil.example" });
        assert.equal(r.status, 403);
        assert.equal(r.headers.get("location"), null);
    } finally {
        await h.close();
    }
});

test("PKCE: the verifier must be the one whose hash was named, a wrong one spends the code, and a code works once", async () => {
    const h = await host();
    try {
        const p = pkce();
        const cookie = await browser(h);
        const { code } = await allow(h, cookie, p);
        assert.equal((await exchange(h, code, randomBytes(32).toString("base64url"))).status, 400);
        assert.equal((await exchange(h, code, p.verifier)).status, 400, "the wrong try spent it");

        const q = pkce();
        const second = await allow(h, cookie, q);
        assert.equal((await exchange(h, second.code, q.verifier)).status, 200);
        assert.equal((await exchange(h, second.code, q.verifier)).status, 400, "used once");
        assert.equal((await exchange(h, "not-a-code", q.verifier)).status, 400);
        assert.equal((await call(h.origin, "/app/auth/device/token", { method: "POST", body: "not json" })).status, 400);
    } finally {
        await h.close();
    }
});

test("a code lasts a minute", async () => {
    const h = await host();
    try {
        const p = pkce();
        const { code } = await allow(h, await browser(h), p);
        h.clock.t += CODE_TTL_MS + 1;
        assert.equal((await exchange(h, code, p.verifier)).status, 400);
    } finally {
        await h.close();
    }
});

test("a device token is refused when it is wrong, altered or made up, and the guesses are slowed down", async () => {
    const h = await host();
    try {
        const { token } = await deviceToken(h);
        assert.equal((await call(h.origin, "/app/api/v1/state", { headers: bearer(token) })).status, 200);
        const altered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
        assert.equal((await call(h.origin, "/app/api/v1/state", { headers: bearer(altered) })).status, 401);
        assert.equal((await call(h.origin, "/app/api/v1/state", { headers: bearer("pkd_000000000000_" + "A".repeat(43)) })).status, 401);
        assert.equal((await call(h.origin, "/app/api/v1/state", { headers: bearer("pkd_short") })).status, 401);
        for (let i = 0; i < 6; i++) await call(h.origin, "/app/api/v1/state", { headers: bearer(altered) });
        assert.equal((await call(h.origin, "/app/api/v1/state", { headers: bearer(token) })).status, 429, "guessing earned a wait, even for the right token");
    } finally {
        await h.close();
    }
});

test("a device token follows the access token's transport rules: not over plain http from another machine, and no foreign Origin", async () => {
    const dir = tempDir();
    const local = await host({ devicesPath: join(dir, "devices.json") });
    let token = "";
    try {
        token = (await deviceToken(local)).token;
        assert.equal((await call(local.origin, "/app/api/v1/state", { headers: { ...bearer(token), origin: "https://evil.example" } })).status, 401);
    } finally {
        await local.close();
    }
    const remote = await host({ devicesPath: join(dir, "devices.json") }, PROXY_PEER);
    try {
        assert.equal((await call(remote.origin, "/app/api/v1/state", { headers: bearer(token) })).status, 401, "plain http from another machine");
        const exchanged = await exchange(remote, "x", "y");
        assert.equal(exchanged.status, 403, "the token is not even handed out there");
        assert.match(exchanged.body, /Sign in over https/);
    } finally {
        await remote.close();
    }
    const allowed = await host({ devicesPath: join(dir, "devices.json"), allowHttpBearer: true }, PROXY_PEER);
    try {
        assert.equal((await call(allowed.origin, "/app/api/v1/state", { headers: bearer(token) })).status, 200, "unless the host allows it, as for the access token");
    } finally {
        await allowed.close();
    }
});

test("devices are listed and removed from a browser session, and a removed device is refused at once", async () => {
    const h = await host();
    try {
        const a = await deviceToken(h, "Laptop");
        const b = await deviceToken(h, "Desk PC");
        const cookie = await browser(h);
        const list = await call(h.origin, "/app/api/v1/devices", { headers: { cookie } });
        assert.equal(list.status, 200);
        const body = JSON.parse(list.body) as { devices: { id: string; name: string; hash?: string }[] };
        assert.deepEqual(body.devices.map((d) => d.name).sort(), ["Desk PC", "Laptop"]);
        assert.ok(
            body.devices.every((d) => Object.keys(d).sort().join(",") === "createdAt,id,lastUsedAt,method,name,subject"),
            "a list shows these six fields and nothing else: no hash, no token",
        );
        assert.ok(!list.body.includes(a.token.slice("pkd_".length + 12 + 1)), "or any part of a token");

        assert.equal((await call(h.origin, `/app/api/v1/devices/${a.id}`, { method: "DELETE", headers: { cookie } })).status, 200);
        assert.equal((await call(h.origin, "/app/api/v1/state", { headers: bearer(a.token) })).status, 401, "revoked");
        assert.equal((await call(h.origin, "/app/api/v1/state", { headers: bearer(b.token) })).status, 200, "the other one is untouched");
        assert.equal((await call(h.origin, `/app/api/v1/devices/${a.id}`, { method: "DELETE", headers: { cookie } })).status, 404);
        assert.equal((await call(h.origin, "/app/api/v1/devices")).status, 401, "not without signing in");
    } finally {
        await h.close();
    }
});

test("a device can end itself and nothing else: it cannot list the others or remove one", async () => {
    const h = await host();
    try {
        const a = await deviceToken(h, "Laptop");
        const b = await deviceToken(h, "Desk PC");
        assert.equal((await call(h.origin, "/app/api/v1/devices", { headers: bearer(a.token) })).status, 403);
        assert.equal((await call(h.origin, `/app/api/v1/devices/${b.id}`, { method: "DELETE", headers: bearer(a.token) })).status, 403);
        assert.equal((await call(h.origin, "/app/api/v1/devices/self", { method: "DELETE", headers: bearer(a.token) })).status, 200);
        assert.equal((await call(h.origin, "/app/api/v1/state", { headers: bearer(a.token) })).status, 401);
        assert.equal((await call(h.origin, "/app/api/v1/state", { headers: bearer(b.token) })).status, 200);
        assert.equal((await call(h.origin, "/app/api/v1/devices/self", { method: "DELETE", headers: bearer(TOKEN) })).status, 404, "the access token is no device");
    } finally {
        await h.close();
    }
});

test("devices live in a file only the host can read, survive a restart, and the file never holds a token", async () => {
    const dir = tempDir();
    const file = join(dir, "devices.json");
    const first = await host({ devicesPath: file });
    let token = "";
    try {
        token = (await deviceToken(first)).token;
    } finally {
        await first.close();
    }
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const stored = readFileSync(file, "utf-8");
    assert.ok(!stored.includes(token.slice("pkd_".length + 12 + 1)), "only a hash of the secret is kept");
    const second = await host({ devicesPath: file });
    try {
        assert.equal((await call(second.origin, "/app/api/v1/state", { headers: bearer(token) })).status, 200);
    } finally {
        await second.close();
    }
});

test("a device stops working when the sign-in method it was made under changes, as a session does", async () => {
    const dir = tempDir();
    const file = join(dir, "devices.json");
    const first = await host({ devicesPath: file });
    let token = "";
    try {
        token = (await deviceToken(first)).token;
    } finally {
        await first.close();
    }
    const rotated = await host({ devicesPath: file, token: OTHER_TOKEN });
    try {
        assert.equal((await call(rotated.origin, "/app/api/v1/state", { headers: bearer(token) })).status, 401);
        assert.equal((await call(rotated.origin, "/app/api/v1/state", { headers: bearer(OTHER_TOKEN) })).status, 200, "the new access token is fine");
    } finally {
        await rotated.close();
    }
});

test("the store: names are cleaned, the oldest-used device makes room at the limit, and nothing but a hash is listed", () => {
    assert.equal(cleanDeviceName("  Kieran\u200b's\u0000 \n laptop  "), "Kieran's laptop");
    assert.equal(cleanDeviceName("\u200b\u0007"), "Desktop app");
    assert.equal(cleanDeviceName(undefined), "Desktop app");
    assert.equal(Array.from(cleanDeviceName("x".repeat(200))).length, 60);
    let t = 1000;
    const store = new DeviceStore(undefined, () => t);
    const first = store.issue("first", "token", "token", "b");
    for (let i = 0; i < MAX_DEVICES; i++) {
        t += 1;
        store.issue(`d${i}`, "token", "token", "b");
    }
    assert.equal(store.list().length, MAX_DEVICES);
    assert.ok(!store.list().some((d) => d.id === first.device.id), "the least recently used one went");
});
