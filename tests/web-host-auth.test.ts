/**
 * The web host's own sign-in (src/server/web-auth), over real sockets through the real route table: the access token, the
 * password, sessions, the places a secret may travel, the rate limit, and how bearer, Basic and the cookie stay apart.
 * OpenID Connect has its own file (web-oidc.test.ts), with a fake provider.
 *
 * The clock is the host's own (`now`), so expiry, renewal and the backoff are exact and nothing sleeps.
 */

import assert from "node:assert/strict";
import { randomBytes, scrypt as nodeScrypt } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { after, before } from "node:test";
import { gate, loginPage, sessionValue, SESSION_COOKIE as DESKTOP_COOKIE } from "../src/server/auth";
import { createWebAuth, safeNext, type WebAuthOptions } from "../src/server/web-auth";
import { anyMethod, bindProblem, webAuthFromEnv } from "../src/server/web-auth/config";
import { AttemptLimiter } from "../src/server/web-auth/limiter";
import { createPasswordLogin, hashPassword, hashPasswordCommand, parseBasic, parseHash, type Scrypt } from "../src/server/web-auth/password";
import { loadSessionKey, Sessions, SESSION_COOKIE } from "../src/server/web-auth/session";
import { call, run, stubTargets, transcript, upgradeStatus, type Reply } from "./support/web-rig";

const TOKEN = "tok-3f9a1c7e2b8d4f60a5e1c9b7d3f2a801";
const USER = "kieran";
const PASSWORD = "correct horse battery staple";
const COST = { N: 16384, r: 8, p: 1 };
const KEY = Buffer.alloc(32, 9);
const DAY = 24 * 60 * 60_000;
const PROXY_PEER = "203.0.113.9";

const logs: string[] = [];
let derivations = 0;
let HASH = "";

/** Real scrypt, counted: the unknown-user path must do the same work as the wrong-password path. */
const counting: Scrypt = (password, salt, keylen, options) => {
    derivations += 1;
    const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
    nodeScrypt(password.normalize("NFKC"), salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
    return promise;
};

before(async () => {
    HASH = await hashPassword(PASSWORD, COST);
});

interface Host {
    origin: string;
    clock: { t: number };
    close(): Promise<void>;
}

async function host(over: Partial<WebAuthOptions> = {}, peer?: string): Promise<Host> {
    const clock = { t: Date.now() };
    const auth = createWebAuth({
        token: "",
        allowHttpBearer: false,
        trustProxy: false,
        sessionKey: KEY,
        now: () => clock.t,
        scrypt: counting,
        log: (line) => logs.push(line),
        ...over,
    });
    const s = await run(stubTargets(auth), peer);
    return { origin: s.origin, clock, close: s.close };
}

const hashed = (): Partial<WebAuthOptions> => ({ password: { user: USER, secret: HASH, plain: false } });
const plain = (): Partial<WebAuthOptions> => ({ password: { user: USER, secret: PASSWORD, plain: true } });

function form(origin: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Reply> {
    return call(origin, "/app/auth", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(fields).toString(),
    });
}

const sessionCookie = (r: Reply): string => (r.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "").split(";")[0]!;
const basic = (user: string, password: string): Record<string, string> => ({
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
});
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const state = (origin: string, headers: Record<string, string> = {}): Promise<Reply> => call(origin, "/app/api/v1/state", { headers });

/** Sign in with the token form and hand back the cookie. */
async function signedIn(h: Host): Promise<string> {
    const r = await form(h.origin, { token: TOKEN });
    assert.equal(r.status, 303);
    return sessionCookie(r);
}

/* ── the access token ──────────────────────────────────────────────────────────────────────── */

test("token: a bearer is accepted, a wrong one refused, and neither ever becomes a cookie", async () => {
    const h = await host({ token: TOKEN });
    try {
        const ok = await state(h.origin, bearer(TOKEN));
        assert.equal(ok.status, 200);
        assert.equal(ok.target, "api");
        assert.deepEqual(ok.cookies, []);
        const wrong = await state(h.origin, bearer("nope"));
        assert.equal(wrong.status, 401);
        assert.equal(wrong.body, '{"error":"Unauthorized"}');
        assert.deepEqual(wrong.cookies, []);
        assert.equal((await call(h.origin, "/app/chat/api/conversations", { headers: bearer(TOKEN) })).target, "chat");
        assert.equal((await call(h.origin, "/anything-kvmd-owns", { headers: bearer(TOKEN) })).target, "kvmd");
        assert.equal((await call(h.origin, "/anything-kvmd-owns", { headers: bearer("nope") })).status, 401);
    } finally {
        await h.close();
    }
});

test("token: no ?token=, and nothing at all gets in on a loopback peer", async () => {
    const h = await host({ token: TOKEN });
    try {
        assert.equal((await call(h.origin, `/app/api/v1/state?token=${TOKEN}`)).status, 401);
        assert.equal((await state(h.origin)).status, 401);
        const page = await state(h.origin, { accept: "text/html" });
        assert.equal(page.status, 302);
        assert.equal(page.headers.get("location"), "/app/login?next=%2Fapp%2Fapi%2Fv1%2Fstate");
        const home = await call(h.origin, "/app/kvm", { headers: { accept: "text/html" } });
        assert.equal(home.headers.get("location"), "/app/login?next=%2Fapp%2Fkvm");
        assert.equal((await call(h.origin, "/app/", { headers: { accept: "text/html" } })).headers.get("location"), "/app/login");
    } finally {
        await h.close();
    }
});

test("token: a bearer from a browser page (a foreign Origin) is refused, this host's own is not", async () => {
    const h = await host({ token: TOKEN });
    try {
        assert.equal((await state(h.origin, { ...bearer(TOKEN), origin: "https://evil.example" })).status, 401);
        assert.equal((await state(h.origin, { ...bearer(TOKEN), origin: h.origin })).status, 200);
    } finally {
        await h.close();
    }
});

test("token: the sign-in form takes the token and sets a session that works on REST, SSE and a WebSocket", async () => {
    const h = await host({ token: TOKEN });
    try {
        const wrong = await form(h.origin, { token: "wrong" });
        assert.equal(wrong.status, 303);
        assert.equal(wrong.headers.get("location"), "/app/login?error=1");
        assert.equal(sessionCookie(wrong), "");

        const right = await form(h.origin, { token: TOKEN });
        assert.equal(right.status, 303);
        assert.equal(right.headers.get("location"), "/app/");
        const cookie = sessionCookie(right);
        assert.ok(cookie.length > 20);

        assert.equal((await state(h.origin, { cookie })).target, "api");
        const sse = await call(h.origin, "/app/api/v1/cursor", { headers: { cookie, accept: "text/event-stream" } });
        assert.equal(sse.target, "cursor");
        assert.match(sse.body, /^data: /);
        assert.equal(await upgradeStatus(h.origin, "/app/chat/ws", { cookie }), 101);
        assert.equal(await upgradeStatus(h.origin, "/api/ws", { cookie }), 101);
        assert.equal(await upgradeStatus(h.origin, "/app/chat/ws"), 0);
        // The chat socket keeps its same-origin check for a signed-in page of another site.
        assert.equal(await upgradeStatus(h.origin, "/app/chat/ws", { cookie, origin: "https://evil.example" }), 403);
    } finally {
        await h.close();
    }
});

test("token: the form POST is same-origin only", async () => {
    const h = await host({ token: TOKEN });
    try {
        for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }]) {
            const r = await form(h.origin, { token: TOKEN }, headers);
            assert.equal(r.status, 403, JSON.stringify(headers));
            assert.equal(sessionCookie(r), "");
        }
        assert.equal((await form(h.origin, { token: TOKEN }, { origin: h.origin })).status, 303);
        assert.equal((await form(h.origin, { token: TOKEN }, { "sec-fetch-site": "same-origin" })).status, 303);
    } finally {
        await h.close();
    }
});

test("token: a tampered, expired or foreign cookie is refused, and sign-out clears it", async () => {
    const h = await host({ token: TOKEN });
    try {
        const cookie = await signedIn(h);
        const [name, value] = cookie.split("=") as [string, string];
        const [body, mac] = value.split(".") as [string, string];

        const flipped = `${name}=${body}.${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
        assert.equal((await state(h.origin, { cookie: flipped })).status, 401);
        const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
        const forged = Buffer.from(JSON.stringify({ ...claims, s: "someone-else", exp: Number(claims["exp"]) + 1e12 })).toString("base64url");
        assert.equal((await state(h.origin, { cookie: `${name}=${forged}.${mac}` })).status, 401);
        assert.equal((await state(h.origin, { cookie: `${name}=garbage` })).status, 401);
        assert.equal((await state(h.origin, { cookie: `${name}=%` })).status, 401);
        // A record made for another purpose, with the right key, is not a session.
        const flow = new Sessions(KEY, () => h.clock.t).flow({ state: "s", nonce: "n", verifier: "v", next: "/app/" });
        assert.equal((await state(h.origin, { cookie: `${name}=${flow}` })).status, 401);
        // Another host's cookie (another key).
        const other = new Sessions(randomBytes(32), () => h.clock.t).issue("token", "token", TOKEN);
        assert.equal((await state(h.origin, { cookie: `${name}=${other}` })).status, 401);

        assert.equal((await state(h.origin, { cookie })).status, 200);
        h.clock.t += 29 * DAY;
        assert.equal((await state(h.origin, { cookie })).status, 200);
        h.clock.t += 2 * DAY;
        assert.equal((await state(h.origin, { cookie })).status, 401);
        assert.equal((await upgradeStatus(h.origin, "/app/chat/ws", { cookie })), 0);

        const out = await call(h.origin, "/app/logout");
        assert.equal(out.status, 303);
        assert.equal(out.headers.get("location"), "/app/login?bye=1");
        assert.match(out.cookies[0]!, /^__pikvm_session=; HttpOnly; Path=\/; SameSite=Lax; Max-Age=0/);
    } finally {
        await h.close();
    }
});

test("token: a session ends when the token changes", async () => {
    const a = await host({ token: TOKEN });
    const cookie = await signedIn(a);
    await a.close();
    const b = await host({ token: `${TOKEN}-rotated` });
    try {
        assert.equal((await state(b.origin, { cookie })).status, 401);
    } finally {
        await b.close();
    }
});

test("token: the cookie carries no secret, and is HttpOnly, SameSite=Lax, Path=/, 30 days", async () => {
    const h = await host({ token: TOKEN });
    try {
        const r = await form(h.origin, { token: TOKEN });
        const header = r.cookies[0]!;
        assert.match(header, /; HttpOnly/);
        assert.match(header, /; Path=\//);
        assert.match(header, /; SameSite=Lax/);
        assert.match(header, /; Max-Age=2592000/);
        assert.ok(!/; Secure/.test(header), "plain http: not Secure");
        const body = Buffer.from(header.split("=")[1]!.split(".")[0]!, "base64url").toString();
        assert.ok(!body.includes(TOKEN));
        const claims = JSON.parse(body) as { m: string; s: string; exp: number; iat: number };
        assert.equal(claims.m, "token");
        assert.equal(claims.exp - claims.iat, 30 * DAY);
    } finally {
        await h.close();
    }
});

/* ── where a secret may travel ─────────────────────────────────────────────────────────────── */

test("transport: the form, Basic and the typed token are refused over plain http from another machine", async () => {
    const h = await host({ token: TOKEN, ...plain() }, PROXY_PEER);
    try {
        const token = await form(h.origin, { token: TOKEN });
        assert.equal(token.status, 403);
        assert.match(token.body, /Sign in over https\./);
        assert.equal(sessionCookie(token), "");
        const pass = await form(h.origin, { user: USER, password: PASSWORD });
        assert.equal(pass.status, 403);
        assert.match(pass.body, /Sign in over https\./);
        const viaBasic = await state(h.origin, basic(USER, PASSWORD));
        assert.equal(viaBasic.status, 403);
        assert.equal(viaBasic.body, '{"error":"Sign in over https."}');
        // A bearer follows its own old rule: refused here as well.
        assert.equal((await state(h.origin, bearer(TOKEN))).status, 401);
    } finally {
        await h.close();
    }
});

test("transport: PIKVM_SYNC_ALLOW_HTTP lets only the bearer through; nothing lets the form through", async () => {
    const h = await host({ token: TOKEN, allowHttpBearer: true, ...plain() }, PROXY_PEER);
    try {
        assert.equal((await state(h.origin, bearer(TOKEN))).status, 200);
        assert.equal((await form(h.origin, { token: TOKEN })).status, 403);
        assert.equal((await state(h.origin, basic(USER, PASSWORD))).status, 403);
    } finally {
        await h.close();
    }
});

test("transport: an https PIKVM_PUBLIC_URL, or a trusted X-Forwarded-Proto: https, lets them through", async () => {
    const declared = await host({ token: TOKEN, ...plain(), publicOrigin: "https://kvm.example.com" }, PROXY_PEER);
    try {
        const r = await form(declared.origin, { token: TOKEN });
        assert.equal(r.status, 303);
        assert.match(r.cookies[0]!, /; Secure/);
        assert.equal((await state(declared.origin, basic(USER, PASSWORD))).status, 200);
        assert.equal((await state(declared.origin, bearer(TOKEN))).status, 200);
    } finally {
        await declared.close();
    }
    const trusted = await host({ token: TOKEN, ...plain(), trustProxy: true }, PROXY_PEER);
    try {
        const https = { "x-forwarded-proto": "https" };
        const r = await form(trusted.origin, { token: TOKEN }, https);
        assert.equal(r.status, 303);
        assert.match(r.cookies[0]!, /; Secure/);
        assert.equal((await state(trusted.origin, { ...basic(USER, PASSWORD), ...https })).status, 200);
        assert.equal((await state(trusted.origin, { ...bearer(TOKEN), ...https })).status, 200);
        // The proxy says http: refused.
        assert.equal((await form(trusted.origin, { token: TOKEN }, { "x-forwarded-proto": "http" })).status, 403);
        // Several hops: the last one is the trusted proxy's.
        assert.equal((await state(trusted.origin, { ...basic(USER, PASSWORD), "x-forwarded-proto": "https, http" })).status, 403);
        assert.equal((await state(trusted.origin, { ...basic(USER, PASSWORD), "x-forwarded-proto": "http, https" })).status, 200);
        assert.equal((await form(trusted.origin, { token: TOKEN })).status, 403, "no header: plain http from another machine");
    } finally {
        await trusted.close();
    }
});

test("transport: X-Forwarded-Proto is ignored unless PIKVM_TRUST_PROXY is set", async () => {
    const h = await host({ token: TOKEN, ...plain() }, PROXY_PEER);
    try {
        const r = await form(h.origin, { token: TOKEN }, { "x-forwarded-proto": "https" });
        assert.equal(r.status, 403);
        assert.equal((await state(h.origin, { ...basic(USER, PASSWORD), "x-forwarded-proto": "https" })).status, 403);
    } finally {
        await h.close();
    }
    // And a peer on this machine without a trusted header is the host's own business: local development works.
    const local = await host({ token: TOKEN, ...plain(), publicOrigin: "http://localhost:8080" });
    try {
        const r = await form(local.origin, { token: TOKEN });
        assert.equal(r.status, 303);
        assert.ok(!/; Secure/.test(r.cookies[0]!), "an http PIKVM_PUBLIC_URL does not mark the cookie Secure");
    } finally {
        await local.close();
    }
});

test("cookie flags: Secure when PIKVM_PUBLIC_URL is https or the trusted proxy says https, otherwise not", async () => {
    const cases: Array<[Partial<WebAuthOptions>, Record<string, string>, boolean]> = [
        [{ publicOrigin: "https://kvm.example.com" }, {}, true],
        [{ trustProxy: true }, { "x-forwarded-proto": "https" }, true],
        [{ trustProxy: true }, {}, false],
        [{ trustProxy: false }, { "x-forwarded-proto": "https" }, false],
        [{}, {}, false],
    ];
    for (const [over, headers, secure] of cases) {
        const h = await host({ token: TOKEN, ...over });
        try {
            const r = await form(h.origin, { token: TOKEN }, headers);
            assert.equal(r.status, 303, JSON.stringify([over, headers]));
            assert.equal(/; Secure/.test(r.cookies[0]!), secure, JSON.stringify([over, headers]));
            const out = await call(h.origin, "/app/logout", { headers });
            assert.equal(/; Secure/.test(out.cookies[0]!), secure);
        } finally {
            await h.close();
        }
    }
});

/* ── the password ──────────────────────────────────────────────────────────────────────────── */

test("password: a hashed password signs in, and the session works on REST, SSE and a WebSocket", async () => {
    const h = await host(hashed());
    try {
        const right = await form(h.origin, { user: USER, password: PASSWORD });
        assert.equal(right.status, 303);
        assert.equal(right.headers.get("location"), "/app/");
        const cookie = sessionCookie(right);
        assert.equal((await state(h.origin, { cookie })).target, "api");
        assert.equal((await call(h.origin, "/app/api/v1/cursor", { headers: { cookie } })).target, "cursor");
        assert.equal(await upgradeStatus(h.origin, "/app/chat/ws", { cookie }), 101);
        const claims = JSON.parse(Buffer.from(cookie.split("=")[1]!.split(".")[0]!, "base64url").toString()) as { m: string; s: string };
        assert.deepEqual([claims.m, claims.s], ["password", USER]);
    } finally {
        await h.close();
    }
});

test("password: a plain password works the same", async () => {
    const h = await host(plain());
    try {
        assert.equal((await form(h.origin, { user: USER, password: PASSWORD })).status, 303);
        assert.equal((await form(h.origin, { user: USER, password: "nope" })).headers.get("location"), "/app/login?error=1");
        assert.equal((await form(h.origin, { user: "nobody", password: PASSWORD })).headers.get("location"), "/app/login?error=1");
    } finally {
        await h.close();
    }
});

test("password: an unknown user and a wrong password get the same answer, and the same work", async () => {
    const h = await host(hashed());
    try {
        derivations = 0;
        const wrongPassword = await form(h.origin, { user: USER, password: "wrong" });
        const afterWrong = derivations;
        const unknownUser = await form(h.origin, { user: "nobody", password: "wrong" });
        const afterUnknown = derivations - afterWrong;
        const unknownRight = await form(h.origin, { user: "nobody", password: PASSWORD });
        assert.equal(afterWrong, 1, "the password is checked");
        assert.equal(afterUnknown, 1, "and checked for an unknown user too (against a dummy hash)");
        assert.equal(derivations, 3);
        for (const r of [wrongPassword, unknownUser, unknownRight]) {
            assert.equal(r.status, 303);
            assert.equal(r.headers.get("location"), "/app/login?error=1");
            assert.equal(r.body, "");
            assert.equal(sessionCookie(r), "");
        }
        // Both shown to the user as one sentence.
        const page = await call(h.origin, "/app/login?error=1", { headers: { accept: "text/html" } });
        assert.match(page.body, />That did not work\.</);
        assert.ok(!/wrong password|unknown user|no such user/i.test(page.body));
    } finally {
        await h.close();
    }
});

test("password: Authorization: Basic works for scripts, with no cookie, and is wrong-proof", async () => {
    const h = await host({ ...hashed(), limiter: { freeFailures: 100 } });
    try {
        const ok = await state(h.origin, basic(USER, PASSWORD));
        assert.equal(ok.status, 200);
        assert.deepEqual(ok.cookies, []);
        assert.equal((await state(h.origin, basic(USER, "wrong"))).status, 401);
        assert.equal((await state(h.origin, basic("nobody", PASSWORD))).status, 401);
        assert.equal((await state(h.origin, { authorization: "Basic !!!not-base64" })).status, 401);
        assert.equal((await state(h.origin, { authorization: `Basic ${Buffer.from("no-colon").toString("base64")}` })).status, 401);
        // A password with a colon in it.
        const colon = await host({ password: { user: USER, secret: "a:b:c", plain: true } });
        try {
            assert.equal((await state(colon.origin, basic(USER, "a:b:c"))).status, 200);
        } finally {
            await colon.close();
        }
        assert.equal(await upgradeStatus(h.origin, "/app/chat/ws", basic(USER, PASSWORD)), 101);
        assert.equal(await upgradeStatus(h.origin, "/app/chat/ws", basic(USER, "wrong")), 0);
    } finally {
        await h.close();
    }
});

test("password: a session ends when the password or the user changes", async () => {
    const a = await host(plain());
    const cookie = sessionCookie(await form(a.origin, { user: USER, password: PASSWORD }));
    await a.close();
    for (const password of [{ user: USER, secret: "another password", plain: true }, { user: "someone", secret: PASSWORD, plain: true }]) {
        const b = await host({ password });
        try {
            assert.equal((await state(b.origin, { cookie })).status, 401);
        } finally {
            await b.close();
        }
    }
    const same = await host(plain());
    try {
        assert.equal((await state(same.origin, { cookie })).status, 200, "the same configuration and key: a restart keeps sessions");
    } finally {
        await same.close();
    }
});

test("password: failures slow an address down exponentially, answer 429 with Retry-After, and recover", async () => {
    const h = await host(plain());
    try {
        const wrong = (): Promise<Reply> => form(h.origin, { user: USER, password: "wrong" });
        for (let i = 0; i < 4; i++) assert.equal((await wrong()).status, 303, `attempt ${i + 1}`);
        // The fourth failure started a wait of one second; the right password is refused until it is over.
        const blocked = await form(h.origin, { user: USER, password: PASSWORD });
        assert.equal(blocked.status, 429);
        assert.equal(blocked.headers.get("retry-after"), "1");
        assert.match(blocked.body, /Too many attempts\. Try again in 1 second\./);
        assert.equal(sessionCookie(blocked), "");
        const viaBasic = await state(h.origin, basic(USER, PASSWORD));
        assert.equal(viaBasic.status, 429);
        assert.equal(viaBasic.headers.get("retry-after"), "1");

        h.clock.t += 1001;
        assert.equal((await wrong()).status, 303);
        const second = await state(h.origin, basic(USER, PASSWORD));
        assert.equal(second.status, 429);
        assert.equal(second.headers.get("retry-after"), "2", "twice as long");
        h.clock.t += 2001;
        assert.equal((await wrong()).status, 303);
        assert.equal((await state(h.origin, basic(USER, PASSWORD))).headers.get("retry-after"), "4");

        h.clock.t += 4001;
        const right = await form(h.origin, { user: USER, password: PASSWORD });
        assert.equal(right.status, 303);
        assert.ok(sessionCookie(right));
        // A success clears the address: three more mistakes cost nothing again.
        for (let i = 0; i < 3; i++) assert.equal((await wrong()).status, 303);
        assert.equal((await form(h.origin, { user: USER, password: PASSWORD })).status, 303);
    } finally {
        await h.close();
    }
});

test("password: the form, Basic and a wrong bearer share one count; a signed-in session is never slowed", async () => {
    const h = await host({ token: TOKEN, ...plain() });
    try {
        const cookie = sessionCookie(await form(h.origin, { user: USER, password: PASSWORD }));
        await state(h.origin, basic(USER, "x"));
        await state(h.origin, bearer("x"));
        await form(h.origin, { token: "x" });
        await form(h.origin, { user: USER, password: "x" });
        assert.equal((await state(h.origin, basic(USER, PASSWORD))).status, 429);
        assert.equal((await state(h.origin, bearer(TOKEN))).status, 429);
        assert.equal((await state(h.origin, { cookie })).status, 200);
        assert.equal(await upgradeStatus(h.origin, "/app/chat/ws", { cookie }), 101);
    } finally {
        await h.close();
    }
});

test("password: addresses count apart behind a trusted proxy (its last hop), and not at all by a header it is not trusted for", async () => {
    const trusted = await host({ ...plain(), trustProxy: true, publicOrigin: "https://kvm.example.com" }, PROXY_PEER);
    try {
        const from = (ip: string): Record<string, string> => ({ "x-forwarded-for": ip });
        for (let i = 0; i < 4; i++) await state(trusted.origin, { ...basic(USER, "x"), ...from("198.51.100.1") });
        assert.equal((await state(trusted.origin, { ...basic(USER, PASSWORD), ...from("198.51.100.1") })).status, 429);
        assert.equal((await state(trusted.origin, { ...basic(USER, PASSWORD), ...from("198.51.100.2") })).status, 200);
        // A client cannot pick its own bucket by prepending: only the last hop, the one the proxy appended, counts.
        assert.equal((await state(trusted.origin, { ...basic(USER, PASSWORD), ...from("198.51.100.3, 198.51.100.1") })).status, 429);
        assert.equal((await state(trusted.origin, { ...basic(USER, PASSWORD), ...from("198.51.100.1, 198.51.100.4") })).status, 200);
    } finally {
        await trusted.close();
    }
    const untrusted = await host({ ...plain(), publicOrigin: "https://kvm.example.com" }, PROXY_PEER);
    try {
        for (let i = 0; i < 4; i++) await state(untrusted.origin, { ...basic(USER, "x"), "x-forwarded-for": `198.51.100.${i + 10}` });
        // Rotating a forged X-Forwarded-For buys nothing: they all are the one peer.
        assert.equal((await state(untrusted.origin, { ...basic(USER, PASSWORD), "x-forwarded-for": "198.51.100.99" })).status, 429);
    } finally {
        await untrusted.close();
    }
});

test("password: one ceiling for every address together", async () => {
    const h = await host({ ...plain(), trustProxy: true, publicOrigin: "https://kvm.example.com", limiter: { ceiling: 4, freeFailures: 100 } }, PROXY_PEER);
    try {
        const from = (n: number): Record<string, string> => ({ "x-forwarded-for": `198.51.100.${n}` });
        for (let n = 1; n <= 4; n++) assert.equal((await state(h.origin, { ...basic(USER, "x"), ...from(n) })).status, 401);
        const blocked = await state(h.origin, { ...basic(USER, PASSWORD), ...from(200) });
        assert.equal(blocked.status, 429);
        assert.equal(blocked.headers.get("retry-after"), "60");
        h.clock.t += 60_001;
        assert.equal((await state(h.origin, { ...basic(USER, PASSWORD), ...from(200) })).status, 200);
    } finally {
        await h.close();
    }
});

test("limiter: waits double up to a ceiling, and old or surplus addresses are forgotten", () => {
    let t = 1_000_000;
    const limiter = new AttemptLimiter({ now: () => t, freeFailures: 1, baseMs: 1000, maxMs: 5000, maxEntries: 3 });
    limiter.fail("a");
    assert.equal(limiter.wait("a"), 0);
    const expected = [1000, 2000, 4000, 5000, 5000];
    for (const ms of expected) {
        limiter.fail("a");
        assert.equal(limiter.wait("a"), ms);
        t += ms;
    }
    limiter.succeed("a");
    assert.equal(limiter.wait("a"), 0);
    for (const address of ["b", "c", "d", "e"]) {
        limiter.fail(address);
        limiter.fail(address);
    }
    assert.equal(limiter.wait("b"), 0, "the oldest was dropped to stay within the cap");
    assert.ok(limiter.wait("e") > 0);
});

/* ── bearer, Basic and the cookie stay apart ───────────────────────────────────────────────── */

test("separation: a host with only a password refuses a bearer, whatever it carries", async () => {
    const h = await host(plain());
    try {
        assert.equal((await state(h.origin, bearer(TOKEN))).status, 401);
        assert.equal((await state(h.origin, bearer(PASSWORD))).status, 401);
        assert.equal((await state(h.origin, bearer(""))).status, 401);
        const cookie = sessionCookie(await form(h.origin, { user: USER, password: PASSWORD }));
        // Not even with a good session alongside: a bearer is judged alone.
        assert.equal((await state(h.origin, { ...bearer("x"), cookie })).status, 401);
        assert.equal((await state(h.origin, { cookie })).status, 200);
        assert.equal(await upgradeStatus(h.origin, "/app/chat/ws", bearer(PASSWORD)), 0);
    } finally {
        await h.close();
    }
});

test("separation: a host with only a token refuses Basic, and a browser with no cookie", async () => {
    const h = await host({ token: TOKEN });
    try {
        assert.equal((await state(h.origin, basic(USER, TOKEN))).status, 401);
        assert.equal((await state(h.origin, basic("", TOKEN))).status, 401);
        assert.equal((await state(h.origin, basic(TOKEN, TOKEN))).status, 401);
        assert.equal((await form(h.origin, { user: USER, password: TOKEN })).headers.get("location"), "/app/login?error=1");
        assert.equal((await state(h.origin)).status, 401);
        assert.equal((await state(h.origin, { accept: "text/html" })).status, 302);
        assert.equal((await state(h.origin, { accept: "text/html", ...basic(USER, TOKEN) })).status, 401);
    } finally {
        await h.close();
    }
});

test("separation: each header credential is judged alone, and a cookie is neither a bearer nor a password", async () => {
    const h = await host({ token: TOKEN, ...plain(), limiter: { freeFailures: 1000 } });
    try {
        const cookie = sessionCookie(await form(h.origin, { token: TOKEN }));
        const value = cookie.split("=")[1]!;
        // A session beside a wrong bearer or a wrong Basic: refused, never "falls through" to the cookie.
        assert.equal((await state(h.origin, { cookie, ...bearer("wrong") })).status, 401);
        assert.equal((await state(h.origin, { cookie, ...basic(USER, "wrong") })).status, 401);
        // A valid bearer or Basic beside a bad cookie: allowed, by the header alone.
        assert.equal((await state(h.origin, { cookie: `${SESSION_COOKIE}=junk`, ...bearer(TOKEN) })).status, 200);
        assert.equal((await state(h.origin, { cookie: `${SESSION_COOKIE}=junk`, ...basic(USER, PASSWORD) })).status, 200);
        // The session value is no bearer and no password.
        assert.equal((await state(h.origin, bearer(value))).status, 401);
        assert.equal((await state(h.origin, basic(USER, value))).status, 401);
        assert.equal((await state(h.origin, basic(value, value))).status, 401);
        // The token is not the password and the password is not the token.
        assert.equal((await state(h.origin, bearer(PASSWORD))).status, 401);
        assert.equal((await state(h.origin, basic(USER, TOKEN))).status, 401);
        // Other schemes are not ours: the cookie decides.
        assert.equal((await state(h.origin, { cookie, authorization: "Digest abc" })).status, 200);
        assert.equal((await state(h.origin, { authorization: "Digest abc" })).status, 401);
        // Neither header ever mints a session.
        for (const headers of [bearer(TOKEN), basic(USER, PASSWORD)]) {
            assert.deepEqual((await state(h.origin, headers)).cookies, []);
        }
    } finally {
        await h.close();
    }
});

/* ── renewal, the secret, the login page ───────────────────────────────────────────────────── */

test("sessions: renewed when more than a day old, not before", async () => {
    const h = await host({ token: TOKEN });
    try {
        const cookie = await signedIn(h);
        h.clock.t += DAY / 2;
        assert.deepEqual((await state(h.origin, { cookie })).cookies, []);
        h.clock.t += DAY;
        const renewed = await state(h.origin, { cookie });
        assert.equal(renewed.status, 200);
        const fresh = sessionCookie(renewed);
        assert.ok(fresh && fresh !== cookie);
        // The old one still has its own end date; the new one runs 30 days from now.
        h.clock.t += 29 * DAY;
        assert.equal((await state(h.origin, { cookie: fresh })).status, 200);
        assert.equal((await state(h.origin, { cookie })).status, 401);
    } finally {
        await h.close();
    }
});

test("session secret: kept in the data directory with mode 0600 so sessions survive a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-secret-"));
    try {
        const first = loadSessionKey("", dir);
        assert.equal(first.length, 32);
        assert.equal(statSync(join(dir, "session-secret")).mode & 0o777, 0o600);
        assert.ok(loadSessionKey("", dir).equals(first));
        writeFileSync(join(dir, "session-secret"), "short\n");
        assert.equal(loadSessionKey("", dir).length, 32, "a damaged file is replaced");
        assert.ok(loadSessionKey("x".repeat(40), dir).equals(Buffer.from("x".repeat(40))));
        assert.throws(() => loadSessionKey("too short", dir), /at least 32/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the sign-in page offers only the configured methods", async () => {
    const cases: Array<[Partial<WebAuthOptions>, { user: boolean; token: boolean; oidc: boolean }]> = [
        [{ token: TOKEN }, { user: false, token: true, oidc: false }],
        [plain(), { user: true, token: false, oidc: false }],
        [{ token: TOKEN, ...plain() }, { user: true, token: true, oidc: false }],
        [
            {
                oidc: { issuer: "https://id.example.com", clientId: "c", clientSecret: "", scopes: "openid", allowedGroups: ["g"], allowedEmails: [], allowedSubjects: [], redirectUri: "https://kvm.example.com/app/auth/callback" },
                publicOrigin: "https://kvm.example.com",
            },
            { user: false, token: false, oidc: true },
        ],
    ];
    for (const [over, want] of cases) {
        const h = await host(over);
        try {
            const page = await call(h.origin, "/app/login?next=%2Fapp%2Fsettings", { headers: { accept: "text/html" } });
            assert.equal(page.status, 200);
            assert.equal(page.headers.get("cache-control"), "no-store");
            assert.equal(page.body.includes('name="user"') && page.body.includes('name="password"'), want.user);
            assert.equal(page.body.includes('name="token"'), want.token);
            assert.equal(page.body.includes("Sign in with id.example.com"), want.oidc);
            if (want.oidc) assert.match(page.body, /href="\/app\/auth\?next=%2Fapp%2Fsettings"/);
            else assert.match(page.body, /name="next" value="\/app\/settings"/);
            assert.ok(!page.body.includes("<script"), "no script");
            if (want.user || want.token) assert.match(page.body, /<label for="[a-z]+">/);
        } finally {
            await h.close();
        }
    }
});

test("the sign-in page: one generic error, tied to its field when there is one form, and the next path escaped", () => {
    const both = loginPage(true, false, { password: true, token: true, errorText: "That did not work.", next: '/app/"><script>' });
    assert.equal(both.match(/role="alert"/g)?.length, 1);
    assert.ok(!both.includes("<script>"), "escaped");
    assert.ok(both.indexOf('role="alert"') < both.indexOf('<form'), "above the forms when there are several");
    const one = loginPage(true, false, { password: true, errorText: "That did not work." });
    assert.match(one, /id="p"[^>]*aria-invalid="true" aria-describedby="signin-error"/);
    assert.ok(one.indexOf('id="p"') < one.indexOf('id="signin-error"') && one.indexOf('id="signin-error"') < one.indexOf('<button type="submit">'));
    assert.equal(one.match(/autofocus/g)?.length, 1);
});

test("public paths: the sign-in page and the PWA files need no session, the OIDC callback among them", async () => {
    const h = await host({ token: TOKEN });
    try {
        for (const path of ["/app/login", "/app/manifest.webmanifest", "/app/sw.js", "/app/icon.png", "/favicon.ico"]) {
            assert.notEqual((await call(h.origin, path)).status, 401, path);
        }
        // Not configured here, so the start and the callback answer 404 rather than 401: they are public.
        assert.equal((await call(h.origin, "/app/auth")).status, 404);
        assert.equal((await call(h.origin, "/app/auth/callback?code=x&state=y")).status, 404);
        assert.equal((await call(h.origin, "/app/auth/callback/extra")).status, 401);
    } finally {
        await h.close();
    }
});

test("next: only a same-site path survives", () => {
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "evil", "", "/a\\b", "/a\nb", "/\t/evil.example", "\\\\evil", "javascript:alert(1)", "/" + "a".repeat(3000)]) {
        assert.equal(safeNext(bad), "/app/", JSON.stringify(bad.slice(0, 20)));
    }
    assert.equal(safeNext(undefined), "/app/");
    assert.equal(safeNext("/app/settings?x=1#y"), "/app/settings?x=1#y");
    assert.equal(safeNext("/"), "/");
});

test("next: a post with a bad return path lands on the front page", async () => {
    const h = await host({ token: TOKEN });
    try {
        for (const next of ["//evil.example/x", "https://evil.example", "/\\evil.example"]) {
            const r = await form(h.origin, { token: TOKEN, next });
            assert.equal(r.headers.get("location"), "/app/", next);
        }
        assert.equal((await form(h.origin, { token: TOKEN, next: "/app/settings" })).headers.get("location"), "/app/settings");
        const failed = await form(h.origin, { token: "wrong", next: "/app/settings" });
        assert.equal(failed.headers.get("location"), "/app/login?error=1&next=%2Fapp%2Fsettings");
        const failedBad = await form(h.origin, { token: "wrong", next: "//evil.example" });
        assert.equal(failedBad.headers.get("location"), "/app/login?error=1");
    } finally {
        await h.close();
    }
});

/* ── password hashes and the command ───────────────────────────────────────────────────────── */

test("hash: written as scrypt$N$r$p$salt$hash, checked, and read back with its limits", async () => {
    assert.match(HASH, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.notEqual(await hashPassword(PASSWORD, COST), HASH, "a fresh salt each time");
    const login = createPasswordLogin({ user: USER, secret: HASH, plain: false });
    assert.equal(await login.check(USER, PASSWORD), true);
    assert.equal(await login.check(USER, `${PASSWORD}!`), false);
    assert.equal(await login.check("other", PASSWORD), false);
    assert.equal(await login.check(USER, ""), false);
    const parsed = parseHash(HASH);
    assert.deepEqual([parsed.N, parsed.r, parsed.p], [16384, 8, 1]);
    const [prefix, , r, p, salt, key] = HASH.split("$");
    for (const bad of [
        "",
        "bcrypt$16384$8$1$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA==",
        `${prefix}$8192$${r}$${p}$${salt}$${key}`,
        `${prefix}$20000$${r}$${p}$${salt}$${key}`,
        `${prefix}$16384$0$${p}$${salt}$${key}`,
        `${prefix}$16384$${r}$${p}$AA==$${key}`,
        `${prefix}$16384$${r}$${p}$${salt}$AA==`,
        `${prefix}$67108864$32$${p}$${salt}$${key}`,
        `${HASH}$extra`,
    ]) {
        assert.throws(() => parseHash(bad), /PIKVM_LOGIN_PASSWORD_HASH/, bad);
    }
    assert.deepEqual(parseBasic(`Basic ${Buffer.from("u:p:q").toString("base64")}`), ["u", "p:q"]);
    assert.equal(parseBasic("Bearer x"), undefined);
});

test("--hash-password reads the password from stdin and prints the hash line only", async () => {
    const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
    const printed: string[] = [];
    const log = console.log;
    Object.defineProperty(process, "stdin", { value: Readable.from([Buffer.from(`${PASSWORD}\n`)]), configurable: true });
    console.log = (...args: unknown[]): void => void printed.push(args.join(" "));
    let code: number;
    try {
        code = await hashPasswordCommand();
    } finally {
        console.log = log;
        Object.defineProperty(process, "stdin", stdin);
    }
    assert.equal(code, 0);
    assert.equal(printed.length, 1);
    assert.match(printed[0]!, /^scrypt\$65536\$8\$2\$[^$\s]+\$[^$\s]+$/);
    assert.ok(!printed[0]!.includes(PASSWORD));
    assert.equal(await createPasswordLogin({ user: USER, secret: printed[0]!, plain: false }).check(USER, PASSWORD), true);
});

/* ── configuration ─────────────────────────────────────────────────────────────────────────── */

test("a host with no sign-in method refuses any HOST but loopback, and says which three groups to set", () => {
    const env = (values: Record<string, string>) => (name: string) => values[name] ?? "";
    assert.equal(anyMethod(env({})), false);
    for (const host of ["127.0.0.1", "::1", "localhost"]) assert.equal(bindProblem(host, false), undefined);
    const message = bindProblem("0.0.0.0", false)!;
    assert.match(message, /HOST=0\.0\.0\.0/);
    for (const name of ["PIKVM_ACCESS_TOKEN", "PIKVM_LOGIN_USER", "PIKVM_LOGIN_PASSWORD_HASH", "PIKVM_LOGIN_PASSWORD", "PIKVM_OIDC_ISSUER", "PIKVM_OIDC_CLIENT_ID", "PIKVM_PUBLIC_URL"]) {
        assert.ok(message.includes(name), name);
    }
    assert.equal(bindProblem("0.0.0.0", true), undefined);
    assert.equal(anyMethod(env({ PIKVM_ACCESS_TOKEN: "x" })), true);
    assert.equal(anyMethod(env({ PIKVM_LOGIN_USER: "x" })), true);
    assert.equal(anyMethod(env({ PIKVM_OIDC_ISSUER: "https://id.example.com" })), true);
    assert.equal(webAuthFromEnv(env({}), tmpdir()).auth, undefined);
});

test("the environment is checked: what is missing or contradictory stops the host, with a sentence that holds no secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-config-"));
    const setup = (values: Record<string, string>) => webAuthFromEnv((name) => values[name] ?? "", dir);
    try {
        assert.throws(() => setup({ PIKVM_LOGIN_USER: "u" }), /needs PIKVM_LOGIN_PASSWORD_HASH/);
        assert.throws(() => setup({ PIKVM_LOGIN_PASSWORD: "pw-secret-1" }), /need PIKVM_LOGIN_USER/);
        assert.throws(() => setup({ PIKVM_LOGIN_USER: "u", PIKVM_LOGIN_PASSWORD: "a", PIKVM_LOGIN_PASSWORD_HASH: HASH }), /not both/);
        assert.throws(() => setup({ PIKVM_LOGIN_USER: "u", PIKVM_LOGIN_PASSWORD_HASH: "plaintext-secret-2" }), (err: Error) => /scrypt\$N/.test(err.message) && !err.message.includes("plaintext-secret-2"));
        assert.throws(() => setup({ PIKVM_OIDC_ISSUER: "https://id.example.com", PIKVM_OIDC_CLIENT_ID: "c" }), /needs PIKVM_PUBLIC_URL/);
        assert.throws(() => setup({ PIKVM_OIDC_ISSUER: "http://id.example.com", PIKVM_OIDC_CLIENT_ID: "c", PIKVM_PUBLIC_URL: "https://kvm.example.com" }), /https/);
        assert.throws(() => setup({ PIKVM_OIDC_ISSUER: "https://id.example.com", PIKVM_PUBLIC_URL: "https://kvm.example.com" }), /needs PIKVM_OIDC_CLIENT_ID/);
        assert.throws(() => setup({ PIKVM_OIDC_CLIENT_ID: "c" }), /PIKVM_OIDC_ISSUER is not/);
        assert.throws(() => setup({ PIKVM_ACCESS_TOKEN: "t", PIKVM_PUBLIC_URL: "http://kvm.example.com" }), /PIKVM_PUBLIC_URL/);
        assert.throws(() => setup({ PIKVM_ACCESS_TOKEN: "t", PIKVM_PUBLIC_URL: "https://kvm.example.com/some/path" }), /PIKVM_PUBLIC_URL/);
        assert.throws(() => setup({ PIKVM_ACCESS_TOKEN: "t", PIKVM_SESSION_SECRET: "short" }), /at least 32/);

        const open = setup({ PIKVM_OIDC_ISSUER: "https://id.example.com", PIKVM_OIDC_CLIENT_ID: "c", PIKVM_PUBLIC_URL: "https://kvm.example.com/" });
        assert.match(open.warnings.join("\n"), /are all empty: every user the provider signs in will be refused/);
        assert.deepEqual(open.auth?.methods, ["OIDC (id.example.com)"]);
        const allowed = setup({ PIKVM_OIDC_ISSUER: "https://id.example.com", PIKVM_OIDC_CLIENT_ID: "c", PIKVM_PUBLIC_URL: "https://kvm.example.com", PIKVM_OIDC_ALLOWED_GROUPS: "kvm" });
        assert.deepEqual(allowed.warnings, []);
        const bySubject = setup({ PIKVM_OIDC_ISSUER: "https://id.example.com", PIKVM_OIDC_CLIENT_ID: "c", PIKVM_PUBLIC_URL: "https://kvm.example.com", PIKVM_OIDC_ALLOWED_SUBJECTS: "u1, u2" });
        assert.deepEqual(bySubject.warnings, []);
        const all = setup({ PIKVM_ACCESS_TOKEN: "t", PIKVM_LOGIN_USER: "u", PIKVM_LOGIN_PASSWORD: "p", PIKVM_OIDC_ISSUER: "https://id.example.com", PIKVM_OIDC_CLIENT_ID: "c", PIKVM_PUBLIC_URL: "https://kvm.example.com", PIKVM_OIDC_ALLOWED_EMAILS: "a@example.com" });
        assert.deepEqual(all.auth?.methods, ["access token", "password", "OIDC (id.example.com)"]);
        assert.match(all.warnings.join("\n"), /plain password/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/* ── the desktop's gate and the web host's sign-in do not weaken each other ────────────────── */

test("the desktop's token cookie and ?token= mean nothing to a web host, and its session means nothing to the desktop gate", async () => {
    const h = await host({ token: TOKEN });
    try {
        assert.equal((await state(h.origin, { cookie: `${DESKTOP_COOKIE}=${sessionValue(TOKEN)}` })).status, 401);
        assert.equal((await state(h.origin, { cookie: `${DESKTOP_COOKIE}=${TOKEN}` })).status, 401);
        const web = await signedIn(h);
        const desktopGate = (cookie: string): string => gate({ headers: { cookie }, socket: { remoteAddress: PROXY_PEER }, url: "/app/api/v1/state" } as never, "/app/api/v1/state", TOKEN);
        assert.equal(desktopGate(web), "deny", "a web session is not the desktop's cookie");
        assert.equal(desktopGate(`${DESKTOP_COOKIE}=${sessionValue(TOKEN)}`), "allow", "and the desktop's gate is unchanged");
    } finally {
        await h.close();
    }
});

/* ── nothing secret is ever said ───────────────────────────────────────────────────────────── */

test("no secret appears in any response, header, log line or error", () => {
    const secrets = [TOKEN, PASSWORD, HASH, HASH.split("$").at(-1)!, KEY.toString("base64"), KEY.toString("base64url"), KEY.toString("hex")];
    const everything = [...transcript, ...logs].join("\n");
    assert.ok(transcript.length > 50, "the run above made its calls");
    for (const secret of secrets) assert.ok(!everything.includes(secret), `leaked: ${secret.slice(0, 8)}...`);
    // Refusals are logged by kind and address only.
    assert.ok(logs.length > 0 && logs.every((line) => /^\[web\] sign-in refused \((password|token|basic|bearer)\) from /.test(line)), logs.slice(0, 3).join("|"));
});

after(() => {
    transcript.length = 0;
    logs.length = 0;
});
