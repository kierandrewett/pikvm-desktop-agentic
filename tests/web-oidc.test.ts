/**
 * The web host as an OpenID Connect relying party, against a fake provider run in this process: discovery, a JWKS
 * with a generated key, an authorize endpoint that redirects back with a code, and a token endpoint that checks the
 * PKCE verifier and the client's credentials, then signs an id_token. The browser's part (follow the redirects, carry
 * the cookies) is played by `signIn` below, one real HTTP request per hop.
 *
 * The host's clock is the fake provider's too (`clock`), so expiry and the sign-in record's lifetime are exact.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach } from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { createWebAuth, type WebAuthOptions } from "../src/server/web-auth";
import { Sessions } from "../src/server/web-auth/session";
import { call, run, stubTargets, transcript, upgradeStatus, type Reply } from "./support/web-rig";

const PUBLIC = "https://kvm.example.com";
const CLIENT_ID = "kvm-client";
const CLIENT_SECRET = "oidc-client-secret-91c4d7a2e6b1";
const KEY = Buffer.alloc(32, 5);
const MINUTE = 60_000;

const clock = { t: Date.now() };
const logs: string[] = [];

type Claims = Record<string, unknown>;

interface Keys {
    alg: string;
    kid: string;
    privateKey: CryptoKey;
    jwk: JWK;
}

async function makeKeys(alg: "ES256" | "RS256" | "EdDSA", kid: string): Promise<Keys> {
    const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
    return { alg, kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: "sig" } };
}

interface Issued {
    code: string;
    challenge: string;
    nonce: string;
    redirectUri: string;
}

/** The provider. Everything a test may want to bend is a field, put back to normal by `reset()`. */
class Provider {
    server!: Server;
    origin = "";
    keys!: Keys;
    published: JWK[] = [];
    issued = new Map<string, Issued>();
    authorizeQueries: URLSearchParams[] = [];
    tokenRequests: Array<{ authorization: string | undefined; body: URLSearchParams }> = [];
    jwksCalls = 0;
    discoveryCalls = 0;
    lastIdToken = "";
    lastCode = "";
    discoveryIssuer: string | undefined;
    discoveryExtra: Record<string, unknown> = {};
    authMethods: string[] | undefined;
    /** Claims for the next id_token, from the defaults. */
    claims: (base: Claims) => Claims = (base) => base;
    /** How the next id_token is made, from its claims. */
    sign: (claims: Claims) => Promise<string> = (claims) => this.signWith(this.keys, claims);
    tokenStatus = 200;
    omitIdToken = false;

    async start(): Promise<void> {
        this.keys = await makeKeys("ES256", "k1");
        this.reset();
        this.server = createServer((req, res) => void this.handle(req, res));
        await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
        this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }

    reset(): void {
        this.published = [this.keys.jwk];
        this.issued.clear();
        this.authorizeQueries = [];
        this.tokenRequests = [];
        this.jwksCalls = this.discoveryCalls = 0;
        this.lastIdToken = this.lastCode = "";
        this.discoveryIssuer = undefined;
        this.discoveryExtra = {};
        this.authMethods = undefined;
        this.claims = (base) => base;
        this.sign = (claims) => this.signWith(this.keys, claims);
        this.tokenStatus = 200;
        this.omitIdToken = false;
    }

    signWith(keys: Keys, claims: Claims): Promise<string> {
        return new SignJWT(claims as never).setProtectedHeader({ alg: keys.alg, kid: keys.kid }).sign(keys.privateKey);
    }

    private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", this.origin);
        if (url.pathname === "/.well-known/openid-configuration") {
            this.discoveryCalls += 1;
            return this.send(res, 200, {
                issuer: this.discoveryIssuer ?? this.origin,
                authorization_endpoint: `${this.origin}/authorize`,
                token_endpoint: `${this.origin}/token`,
                jwks_uri: `${this.origin}/jwks`,
                ...(this.authMethods ? { token_endpoint_auth_methods_supported: this.authMethods } : {}),
                ...this.discoveryExtra,
            });
        }
        if (url.pathname === "/jwks") {
            this.jwksCalls += 1;
            return this.send(res, 200, { keys: this.published });
        }
        if (url.pathname === "/authorize") {
            const q = url.searchParams;
            this.authorizeQueries.push(q);
            const code = randomBytes(12).toString("hex");
            this.issued.set(code, { code, challenge: q.get("code_challenge") ?? "", nonce: q.get("nonce") ?? "", redirectUri: q.get("redirect_uri") ?? "" });
            this.lastCode = code;
            const back = new URL(q.get("redirect_uri")!);
            back.searchParams.set("code", code);
            back.searchParams.set("state", q.get("state")!);
            res.writeHead(302, { location: back.href });
            return void res.end();
        }
        if (url.pathname === "/token" && req.method === "POST") {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            const body = new URLSearchParams(Buffer.concat(chunks).toString());
            this.tokenRequests.push({ authorization: req.headers.authorization, body });
            const issued = this.issued.get(body.get("code") ?? "");
            this.issued.delete(body.get("code") ?? "");
            const verifierOk = issued && createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url") === issued.challenge;
            if (this.tokenStatus !== 200) return this.send(res, this.tokenStatus, { error: "server_error" });
            if (!issued || !verifierOk || body.get("redirect_uri") !== issued.redirectUri || body.get("grant_type") !== "authorization_code") {
                return this.send(res, 400, { error: "invalid_grant" });
            }
            const now = Math.floor(clock.t / 1000);
            const base: Claims = {
                iss: this.origin,
                aud: CLIENT_ID,
                sub: "user-1",
                iat: now,
                exp: now + 300,
                nonce: issued.nonce,
                email: "kieran@example.com",
                groups: ["kvm-admins", "everyone"],
            };
            this.lastIdToken = await this.sign(this.claims(base));
            return this.send(res, 200, { token_type: "Bearer", access_token: "access-token-never-used", ...(this.omitIdToken ? {} : { id_token: this.lastIdToken }) });
        }
        res.writeHead(404);
        res.end();
    }

    close(): Promise<void> {
        return new Promise((done) => {
            this.server.closeAllConnections();
            this.server.close(() => done());
        });
    }
}

const provider = new Provider();
before(() => provider.start());
after(() => provider.close());
beforeEach(() => {
    provider.reset();
    clock.t = Date.now();
});

interface Host {
    origin: string;
    close(): Promise<void>;
}

async function host(over: Partial<WebAuthOptions> = {}, oidc: Partial<NonNullable<WebAuthOptions["oidc"]>> = {}, peer?: string): Promise<Host> {
    const auth = createWebAuth({
        token: "",
        allowHttpBearer: false,
        trustProxy: false,
        sessionKey: KEY,
        publicOrigin: PUBLIC,
        now: () => clock.t,
        jwksCooldownMs: 0,
        log: (line) => logs.push(line),
        oidc: {
            issuer: provider.origin,
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            scopes: "openid email profile groups",
            allowedGroups: ["kvm-admins"],
            allowedEmails: [],
            allowedSubjects: [],
            redirectUri: `${PUBLIC}/app/auth/callback`,
            ...oidc,
        },
        ...over,
    });
    return run(stubTargets(auth), peer);
}

const cookieNamed = (r: Reply, name: string): string => (r.cookies.find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0]!;
const sessionOf = (r: Reply): string => cookieNamed(r, "__pikvm_session");
const state = (origin: string, headers: Record<string, string> = {}): Promise<Reply> => call(origin, "/app/api/v1/state", { headers });

interface Attempt {
    start: Reply;
    callback: Reply;
    session: string;
    flowCookie: string;
}

/** The browser: start at the host, go to the provider, come back with the code. `tweak` bends the way back. */
async function signIn(
    h: Host,
    opts: { next?: string; tweakCallback?: (url: URL) => void; flowCookie?: (cookie: string) => string; beforeCallback?: () => void } = {},
): Promise<Attempt> {
    const start = await call(h.origin, `/app/auth${opts.next === undefined ? "" : `?next=${encodeURIComponent(opts.next)}`}`);
    assert.equal(start.status, 302, `start: ${start.body}`);
    const flowCookie = cookieNamed(start, "__pikvm_oidc");
    const authorize = await fetch(start.headers.get("location")!, { redirect: "manual" });
    assert.equal(authorize.status, 302);
    const back = new URL(authorize.headers.get("location")!);
    opts.tweakCallback?.(back);
    opts.beforeCallback?.();
    const callback = await call(h.origin, back.pathname + back.search, {
        headers: { cookie: opts.flowCookie ? opts.flowCookie(flowCookie) : flowCookie },
    });
    return { start, callback, session: sessionOf(callback), flowCookie };
}

/** Refused as a failed sign-in: no session, a sentence, and the sign-in record cleared. */
function assertFailed(a: Attempt, status = 502): void {
    assert.equal(a.callback.status, status, a.callback.body.slice(0, 200));
    assert.equal(a.session, "");
    assert.match(a.callback.body, /Sign-in failed\. Try again\./);
    assert.ok(a.callback.cookies.some((c) => /^__pikvm_oidc=; .*Max-Age=0/.test(c)), "the record is cleared");
}

/* ── the way in ────────────────────────────────────────────────────────────────────────────── */

test("a sign-in with the right group ends in a session that works on REST, SSE and a WebSocket", async () => {
    const h = await host();
    try {
        const a = await signIn(h);
        assert.equal(a.callback.status, 303);
        assert.equal(a.callback.headers.get("location"), "/app/");
        assert.ok(a.session);

        assert.equal((await state(h.origin, { cookie: a.session })).target, "api");
        const sse = await call(h.origin, "/app/api/v1/cursor", { headers: { cookie: a.session, accept: "text/event-stream" } });
        assert.equal(sse.target, "cursor");
        assert.equal(await upgradeStatus(h.origin, "/app/chat/ws", { cookie: a.session }), 101);
        assert.equal((await state(h.origin)).status, 401);

        const claims = JSON.parse(Buffer.from(a.session.split("=")[1]!.split(".")[0]!, "base64url").toString()) as { m: string; s: string };
        assert.deepEqual([claims.m, claims.s], ["oidc", "user-1"]);
    } finally {
        await h.close();
    }
});

test("the authorization request carries state, nonce and an S256 challenge, and the code is exchanged with the verifier", async () => {
    const h = await host();
    try {
        const a = await signIn(h);
        assert.equal(a.callback.status, 303);
        const q = provider.authorizeQueries[0]!;
        assert.equal(q.get("response_type"), "code");
        assert.equal(q.get("client_id"), CLIENT_ID);
        assert.equal(q.get("redirect_uri"), `${PUBLIC}/app/auth/callback`);
        assert.equal(q.get("scope"), "openid email profile groups");
        assert.equal(q.get("code_challenge_method"), "S256");
        assert.match(q.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
        assert.ok(q.get("state")!.length >= 24 && q.get("nonce")!.length >= 24);
        // The provider checked sha256(verifier) = challenge (a wrong one is invalid_grant); it was sent, not the challenge.
        const token = provider.tokenRequests[0]!;
        assert.notEqual(token.body.get("code_verifier"), q.get("code_challenge"));
        assert.equal(token.body.get("redirect_uri"), `${PUBLIC}/app/auth/callback`);
        assert.equal(token.body.get("client_id"), CLIENT_ID);
        assert.equal(token.body.get("client_secret"), null);
        assert.equal(token.authorization, `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
        assert.equal(provider.discoveryCalls, 1);
        assert.equal(provider.jwksCalls, 1);
        // Two sign-ins never share a state, a nonce or a challenge.
        await signIn(h);
        const [first, second] = provider.authorizeQueries;
        for (const key of ["state", "nonce", "code_challenge"]) assert.notEqual(first!.get(key), second!.get(key), key);
        assert.equal(provider.discoveryCalls, 1, "discovery is cached");
    } finally {
        await h.close();
    }
});

test("the sign-in record: HttpOnly, SameSite=Lax, only on the sign-in paths, ten minutes, Secure with an https PIKVM_PUBLIC_URL", async () => {
    const h = await host();
    try {
        const a = await signIn(h);
        const record = a.start.cookies.find((c) => c.startsWith("__pikvm_oidc="))!;
        assert.match(record, /; HttpOnly/);
        assert.match(record, /; Path=\/app\/auth(;|$)/);
        assert.match(record, /; SameSite=Lax/);
        assert.match(record, /; Max-Age=600/);
        assert.match(record, /; Secure/);
        const body = Buffer.from(record.split("=")[1]!.split(".")[0]!, "base64url").toString();
        assert.ok(!body.includes(CLIENT_SECRET));
        assert.match(a.callback.cookies.find((c) => c.startsWith("__pikvm_session="))!, /; Secure/);
    } finally {
        await h.close();
    }
    const plain = await host({ publicOrigin: "http://localhost:8080" });
    try {
        const a = await signIn(plain);
        assert.ok(!/; Secure/.test(a.start.cookies[0]!));
        assert.ok(!/; Secure/.test(a.callback.cookies.find((c) => c.startsWith("__pikvm_session="))!));
    } finally {
        await plain.close();
    }
});

test("every signing algorithm on the allow list works: ES256, RS256, EdDSA", async () => {
    const original = provider.keys;
    try {
        for (const alg of ["RS256", "EdDSA", "ES256"] as const) {
            provider.keys = await makeKeys(alg, `kid-${alg}`);
            provider.published = [provider.keys.jwk];
            const h = await host();
            try {
                const a = await signIn(h);
                assert.equal(a.callback.status, 303, alg);
            } finally {
                await h.close();
            }
        }
    } finally {
        provider.keys = original;
    }
});

test("a public client (no secret) sends none and relies on PKCE alone; a provider that lists only client_secret_post gets it in the body", async () => {
    const h = await host({}, { clientSecret: "" });
    try {
        assert.equal((await signIn(h)).callback.status, 303);
        const token = provider.tokenRequests[0]!;
        assert.equal(token.authorization, undefined);
        assert.equal(token.body.get("client_secret"), null);
    } finally {
        await h.close();
    }
    provider.reset();
    provider.authMethods = ["client_secret_post"];
    const post = await host();
    try {
        assert.equal((await signIn(post)).callback.status, 303);
        const token = provider.tokenRequests[0]!;
        assert.equal(token.authorization, undefined);
        assert.equal(token.body.get("client_secret"), CLIENT_SECRET);
    } finally {
        await post.close();
    }
});

test("the sign-in page offers the provider by its host", async () => {
    const h = await host();
    try {
        const page = await call(h.origin, "/app/login", { headers: { accept: "text/html" } });
        assert.match(page.body, new RegExp(`Sign in with ${provider.origin.replace("http://", "").replace(".", "\\.")}`));
        assert.match(page.body, /href="\/app\/auth"/);
        assert.ok(!page.body.includes('name="user"') && !page.body.includes('name="token"'));
    } finally {
        await h.close();
    }
});

/* ── the id_token is checked ───────────────────────────────────────────────────────────────── */

const unsigned = (claims: Claims): Promise<string> => {
    const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    return Promise.resolve(`${part({ alg: "none", typ: "JWT" })}.${part(claims)}.`);
};
const hmac = async (claims: Claims, secret: string): Promise<string> =>
    new SignJWT(claims as never).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret));

test("an id_token that is wrong in any way signs nobody in", async () => {
    const strangerKeys = await makeKeys("ES256", "k1");
    const now = (): number => Math.floor(clock.t / 1000);
    const cases: Array<[string, (c: Claims) => Claims, ((c: Claims) => Promise<string>)?]> = [
        ["wrong audience", (c) => ({ ...c, aud: "someone-else" })],
        ["audience list without this client", (c) => ({ ...c, aud: ["a", "b"] })],
        ["two audiences and no azp", (c) => ({ ...c, aud: [CLIENT_ID, "other"] })],
        ["wrong issuer", (c) => ({ ...c, iss: "https://evil.example" })],
        ["no issuer", (c) => ({ ...c, iss: undefined })],
        ["expired", (c) => ({ ...c, exp: now() - 3600 })],
        ["no expiry", (c) => ({ ...c, exp: undefined })],
        ["not yet valid", (c) => ({ ...c, nbf: now() + 3600 })],
        ["wrong nonce", (c) => ({ ...c, nonce: "another-nonce" })],
        ["no nonce", (c) => ({ ...c, nonce: undefined })],
        ["no subject", (c) => ({ ...c, sub: undefined })],
        ["bad signature (another key, the same kid)", (c) => c, (c) => provider.signWith(strangerKeys, c)],
        ["alg none", (c) => c, unsigned],
        ["alg HS256 with the client secret", (c) => c, (c) => hmac(c, CLIENT_SECRET)],
        ["alg HS256 with the issuer's public key as the secret", (c) => c, (c) => hmac(c, JSON.stringify(provider.keys.jwk))],
    ];
    for (const [name, claims, sign] of cases) {
        provider.reset();
        provider.claims = claims;
        if (sign) provider.sign = sign;
        const h = await host();
        try {
            const a = await signIn(h);
            assertFailed(a);
            assert.equal((await state(h.origin, { cookie: a.session })).status, 401, name);
            assert.ok(logs.at(-1)!.startsWith("[web] OIDC sign-in refused: "), `${name}: ${logs.at(-1)}`);
        } finally {
            await h.close();
        }
    }
});

test("a token slightly out of date is forgiven, an hour out is not", async () => {
    const now = (): number => Math.floor(clock.t / 1000);
    provider.claims = (c) => ({ ...c, exp: now() - 30 });
    const h = await host();
    try {
        assert.equal((await signIn(h)).callback.status, 303, "30 s past exp is within the skew");
        provider.claims = (c) => ({ ...c, exp: now() - 120 });
        assertFailed(await signIn(h));
        provider.claims = (c) => ({ ...c, aud: [CLIENT_ID, "other"], azp: CLIENT_ID });
        assert.equal((await signIn(h)).callback.status, 303, "several audiences are fine when the token was issued to this client");
    } finally {
        await h.close();
    }
});

test("a token endpoint that errors, or sends no id_token, signs nobody in", async () => {
    const h = await host();
    try {
        provider.tokenStatus = 500;
        assertFailed(await signIn(h));
        provider.tokenStatus = 200;
        provider.omitIdToken = true;
        assertFailed(await signIn(h));
    } finally {
        await h.close();
    }
});

test("the JWKS is refetched for an unknown key id, no more often than the cooldown, and a bad provider document is refused", async () => {
    const h = await host();
    try {
        assert.equal((await signIn(h)).callback.status, 303);
        const rotated = await makeKeys("ES256", "k2");
        provider.published = [provider.keys.jwk, rotated.jwk];
        provider.sign = (claims) => provider.signWith(rotated, claims);
        assert.equal((await signIn(h)).callback.status, 303);
        assert.equal(provider.jwksCalls, 2, "refetched once, for the new key");
    } finally {
        await h.close();
    }
    provider.reset();
    const slow = await host({ jwksCooldownMs: 10 * MINUTE });
    try {
        assert.equal((await signIn(slow)).callback.status, 303);
        const rotated = await makeKeys("ES256", "k3");
        provider.published = [provider.keys.jwk, rotated.jwk];
        provider.sign = (claims) => provider.signWith(rotated, claims);
        assertFailed(await signIn(slow));
        assert.equal(provider.jwksCalls, 1, "inside the cooldown the key set is not fetched again");
    } finally {
        await slow.close();
    }
});

test("a discovery document naming another issuer, or an endpoint that is not https, is refused at the start", async () => {
    for (const break_ of [
        (): void => void (provider.discoveryIssuer = "https://evil.example"),
        (): void => void (provider.discoveryExtra = { authorization_endpoint: "http://idp.example.com/authorize" }),
        (): void => void (provider.discoveryExtra = { jwks_uri: "ftp://idp.example.com/jwks" }),
        (): void => void (provider.discoveryExtra = { token_endpoint: undefined }),
    ]) {
        provider.reset();
        break_();
        const h = await host();
        try {
            const start = await call(h.origin, "/app/auth");
            assert.equal(start.status, 502);
            assert.match(start.body, /Sign-in failed\./);
            assert.equal(cookieNamed(start, "__pikvm_oidc"), "");
        } finally {
            await h.close();
        }
    }
});

/* ── state, the record and the way back ────────────────────────────────────────────────────── */

test("a wrong state, a missing, damaged or expired record, or an error from the provider ends before any token request", async () => {
    const h = await host();
    try {
        const wrongState = await signIn(h, { tweakCallback: (u) => u.searchParams.set("state", "forged-state") });
        assertFailed(wrongState, 400);
        const noRecord = await signIn(h, { flowCookie: () => "" });
        assert.equal(noRecord.callback.status, 400);
        assert.match(noRecord.callback.body, /That sign-in expired\. Start again\./);
        const damaged = await signIn(h, { flowCookie: (c) => c.replace("=", "=x") });
        assert.equal(damaged.callback.status, 400);
        const asSession = await signIn(h, { flowCookie: () => `__pikvm_oidc=${sessionPlaceholder()}` });
        assert.equal(asSession.callback.status, 400);
        const late = await signIn(h, { beforeCallback: () => void (clock.t += 11 * MINUTE) });
        assert.equal(late.callback.status, 400);
        const denied = await signIn(h, {
            tweakCallback: (u) => {
                u.searchParams.delete("code");
                u.searchParams.set("error", "access_denied");
            },
        });
        assertFailed(denied, 403);
        assert.equal(provider.tokenRequests.length, 0, "none of them got as far as the token endpoint");
        for (const a of [wrongState, noRecord, damaged, asSession, late, denied]) assert.equal(a.session, "");
    } finally {
        await h.close();
    }
});

/** A value the host itself sealed, for the session purpose: not a sign-in record, whatever its shape. */
function sessionPlaceholder(): string {
    return new Sessions(KEY, () => clock.t).issue("oidc", "user-1", "material");
}

test("a code is good once: the provider refuses the second exchange", async () => {
    const h = await host();
    try {
        const first = await signIn(h);
        assert.equal(first.callback.status, 303);
        // The same callback again, with the same record: the code is spent.
        const replay = await call(h.origin, `/app/auth/callback?code=${provider.lastCode}&state=${provider.authorizeQueries[0]!.get("state")}`, {
            headers: { cookie: first.flowCookie },
        });
        assert.equal(replay.status, 502);
        assert.equal(sessionOf(replay), "");
    } finally {
        await h.close();
    }
});

test("a return path off this site is replaced by the front page", async () => {
    const h = await host();
    try {
        for (const next of ["//evil.example", "/\\evil.example", "https://evil.example/x", "javascript:alert(1)", "evil", "/\t/evil.example"]) {
            const a = await signIn(h, { next });
            assert.equal(a.callback.status, 303, next);
            assert.equal(a.callback.headers.get("location"), "/app/", next);
        }
        const kept = await signIn(h, { next: "/app/settings?tab=about" });
        assert.equal(kept.callback.headers.get("location"), "/app/settings?tab=about");
    } finally {
        await h.close();
    }
});

/* ── who may come in ───────────────────────────────────────────────────────────────────────── */

test("the allow rules: a group, a verified email, or a subject; nothing else", async () => {
    type Row = [string, Partial<NonNullable<WebAuthOptions["oidc"]>>, Claims, number];
    const rows: Row[] = [
        ["in an allowed group", { allowedGroups: ["kvm-admins"] }, {}, 303],
        ["in any one of the allowed groups", { allowedGroups: ["x", "everyone"] }, {}, 303],
        ["in none of them", { allowedGroups: ["other"] }, {}, 403],
        ["group names are exact", { allowedGroups: ["KVM-ADMINS", "kvm"] }, {}, 403],
        ["groups as a single string", { allowedGroups: ["solo"] }, { groups: "solo" }, 303],
        ["no groups claim, none allowed by email", { allowedGroups: ["kvm-admins"] }, { groups: undefined }, 403],
        ["a listed email, verified, in any case", { allowedGroups: [], allowedEmails: ["kieran@example.com"] }, { email: "Kieran@Example.com", email_verified: true, groups: [] }, 303],
        ["an email that is not listed, even verified", { allowedGroups: [], allowedEmails: ["other@example.com"] }, { email_verified: true }, 403],
        ["a listed email with no email_verified claim", { allowedGroups: [], allowedEmails: ["kieran@example.com"] }, {}, 403],
        ["a listed email the provider calls unverified", { allowedGroups: [], allowedEmails: ["kieran@example.com"] }, { email_verified: false }, 403],
        ["a listed email whose email_verified is the string 'true'", { allowedGroups: [], allowedEmails: ["kieran@example.com"] }, { email_verified: "true" }, 403],
        ["a listed email the provider verified", { allowedGroups: [], allowedEmails: ["kieran@example.com"] }, { email_verified: true }, 303],
        ["a group is enough without any email", { allowedGroups: ["kvm-admins"], allowedEmails: ["other@example.com"] }, { email: undefined }, 303],
        ["an allowed subject, with neither groups nor an email", { allowedGroups: [], allowedSubjects: ["user-1"] }, { groups: undefined, email: undefined }, 303],
        ["an allowed subject among others", { allowedGroups: [], allowedSubjects: ["x", "user-1"] }, { groups: undefined, email: undefined }, 303],
        ["a subject that is not listed", { allowedGroups: [], allowedSubjects: ["user-2"] }, {}, 403],
        ["subjects are exact and case-sensitive", { allowedGroups: [], allowedSubjects: ["USER-1", "user-"] }, {}, 403],
        ["all three lists empty: everybody is refused", { allowedGroups: [], allowedEmails: [], allowedSubjects: [] }, { email_verified: true }, 403],
    ];
    for (const [name, oidc, extra, status] of rows) {
        provider.reset();
        provider.claims = (c) => ({ ...c, ...extra });
        const h = await host({}, oidc);
        try {
            const a = await signIn(h);
            assert.equal(a.callback.status, status, name);
            if (status === 403) {
                assert.equal(a.session, "", name);
                assert.match(a.callback.body, /That account is not allowed here\./);
                assert.equal((await state(h.origin)).status, 401);
            } else {
                assert.ok(a.session, name);
            }
        } finally {
            await h.close();
        }
    }
});

test("a session ends when the allow rules change", async () => {
    const a = await host();
    const session = (await signIn(a)).session;
    await a.close();
    const stricter = await host({}, { allowedGroups: ["kvm-admins", "more"], allowedEmails: [] });
    try {
        assert.equal((await state(stricter.origin, { cookie: session })).status, 401);
    } finally {
        await stricter.close();
    }
    const same = await host();
    try {
        assert.equal((await state(same.origin, { cookie: session })).status, 200);
    } finally {
        await same.close();
    }
});

test("a tampered or expired OIDC session is refused, and sign-out clears it", async () => {
    const h = await host();
    try {
        const { session } = await signIn(h);
        const [name, value] = session.split("=") as [string, string];
        const [body, mac] = value.split(".") as [string, string];
        assert.equal((await state(h.origin, { cookie: `${name}=${body}.${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}` })).status, 401);
        const forged = Buffer.from(JSON.stringify({ ...(JSON.parse(Buffer.from(body, "base64url").toString()) as object), s: "admin" })).toString("base64url");
        assert.equal((await state(h.origin, { cookie: `${name}=${forged}.${mac}` })).status, 401);
        assert.equal((await state(h.origin, { cookie: session })).status, 200);
        const out = await call(h.origin, "/app/logout");
        assert.equal(out.status, 303);
        assert.match(out.cookies[0]!, /^__pikvm_session=; HttpOnly; Path=\/; SameSite=Lax; Max-Age=0; Secure$/);
        clock.t += 31 * 24 * 60 * MINUTE;
        assert.equal((await state(h.origin, { cookie: session })).status, 401);
    } finally {
        await h.close();
    }
});

const OIDC_HOST_TOKEN = "tok-for-oidc-test-0123456789abcdef";

test("OIDC beside the other methods: the provider's session is not a bearer, and a bearer is not a session", async () => {
    const h = await host({ token: OIDC_HOST_TOKEN });
    try {
        const { session } = await signIn(h);
        assert.equal((await state(h.origin, { authorization: `Bearer ${session.split("=")[1]}` })).status, 401);
        const viaBearer = await state(h.origin, { authorization: `Bearer ${OIDC_HOST_TOKEN}` });
        assert.equal(viaBearer.status, 200);
        assert.deepEqual(viaBearer.cookies, []);
        assert.equal((await state(h.origin, { cookie: session, authorization: "Bearer wrong" })).status, 401);
    } finally {
        await h.close();
    }
});

/* ── nothing secret is ever said ───────────────────────────────────────────────────────────── */

test("no id_token, code, client secret or verifier appears in any response, header or log line", async () => {
    const h = await host();
    try {
        const a = await signIn(h);
        assert.equal(a.callback.status, 303);
        const idToken = provider.lastIdToken;
        const code = provider.lastCode;
        const verifier = provider.tokenRequests[0]!.body.get("code_verifier")!;
        provider.claims = (c) => ({ ...c, aud: "wrong" });
        const failed = await signIn(h);
        assertFailed(failed);
        const everything = [...transcript, ...logs].join("\n");
        const secrets = [["id_token", idToken], ["code", code], ["client secret", CLIENT_SECRET], ["verifier", verifier], ["rejected id_token", provider.lastIdToken]] as const;
        for (const [name, secret] of secrets) assert.ok(!everything.includes(secret), `${name} leaked`);
        // Nor the signed part of a token, which is the part that says who somebody is.
        assert.ok(!everything.includes(idToken.split(".")[1]!), "the id_token's claims leaked");
        assert.ok(logs.length > 0 && logs.every((line) => line.startsWith("[web] ")));
    } finally {
        await h.close();
    }
});
