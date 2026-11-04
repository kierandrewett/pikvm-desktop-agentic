/**
 * `GET /app/api/v1/session`: who the host's sign-in says is asking, through the real server and the real HttpApi.
 *
 * A cookie session (token, password, oidc) can be signed out of; a bearer or Basic header has no session. A host with no sign-in of
 * its own (the desktop, or a web host on loopback with no method) says `signIn: false`. Never a secret in the body.
 */

import { SessionView } from "@pikvm/contracts/api";
import { Schema } from "effect";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PiKvmControl } from "../src/pikvm-control";
import { startControlServer } from "../src/server";
import { SettingsStore } from "../src/settings";
import { createWebAuth, type WebAuthOptions } from "../src/server/web-auth";
import { Sessions } from "../src/server/web-auth/session";
import { noImages, stubChat } from "./support/chat-stub";

const TOKEN = "session-test-token-3b8f1d9a7c2e4605";
const USER = "kieran";
const PASSWORD = "session test password 8841";
const KEY = Buffer.alloc(32, 11);
const OIDC = {
    issuer: "https://id.example.com",
    clientId: "c",
    clientSecret: "client-secret-never-in-a-body",
    scopes: "openid",
    allowedGroups: ["kvm"],
    allowedEmails: [],
    allowedSubjects: [],
    redirectUri: "https://kvm.example.com/app/auth/callback",
};

interface Running {
    origin: string;
    close(): Promise<void>;
}

async function start(webAuth?: WebAuthOptions): Promise<Running> {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-session-test-"));
    const control = {
        setTarget: () => {},
        proxyTarget: async () => ({ origin: new URL("https://kvm.example.test"), headers: {}, rejectUnauthorized: false }),
        getHidState: () => undefined,
        lastInputAt: () => 0,
        noteObservedMouse: () => {},
    } as unknown as PiKvmControl;
    const server: Server = startControlServer(
        {
            control,
            settings: new SettingsStore(join(dir, "settings.json")),
            images: noImages,
            createChat: stubChat(),
            ...(webAuth ? { webAuth: createWebAuth(webAuth) } : {}),
        },
        0,
    );
    await new Promise<void>((done) => server.once("listening", done));
    return {
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () =>
            new Promise<void>((done) => {
                server.closeAllConnections();
                server.close(() => {
                    rmSync(dir, { recursive: true, force: true });
                    done();
                });
            }),
    };
}

const options = (over: Partial<WebAuthOptions> = {}): WebAuthOptions => ({
    token: TOKEN,
    allowHttpBearer: false,
    trustProxy: false,
    sessionKey: KEY,
    password: { user: USER, secret: PASSWORD, plain: true },
    oidc: OIDC,
    publicOrigin: "https://kvm.example.com",
    ...over,
});

async function session(origin: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; view?: SessionView }> {
    const res = await fetch(`${origin}/app/api/v1/session`, { headers });
    const text = await res.text();
    return { status: res.status, text, ...(res.status === 200 ? { view: Schema.decodeUnknownSync(SessionView)(JSON.parse(text)) } : {}) };
}

async function cookieFrom(origin: string, fields: Record<string, string>): Promise<string> {
    const res = await fetch(`${origin}/app/auth`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
    });
    assert.equal(res.status, 303);
    return res.headers.getSetCookie()[0]!.split(";")[0]!;
}

const basic = (user: string, password: string): string => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

test("a host with no sign-in of its own says so, and a forged header changes nothing", async () => {
    const s = await start();
    try {
        const plain = await session(s.origin);
        assert.equal(plain.status, 200);
        assert.deepEqual(plain.view, { signIn: false });
        const forged = await session(s.origin, { "x-pikvm-signed-in": JSON.stringify({ method: "password", subject: "root" }) });
        assert.deepEqual(forged.view, { signIn: false });
    } finally {
        await s.close();
    }
});

test("each method reports how it got in, and only a cookie session can sign out", async () => {
    const s = await start(options());
    try {
        const token = await session(s.origin, { cookie: await cookieFrom(s.origin, { token: TOKEN }) });
        assert.deepEqual(token.view, { signIn: true, method: "token", subject: "token", canSignOut: true });

        const password = await session(s.origin, { cookie: await cookieFrom(s.origin, { user: USER, password: PASSWORD }) });
        assert.deepEqual(password.view, { signIn: true, method: "password", subject: USER, canSignOut: true });

        const material = [OIDC.issuer, OIDC.clientId, OIDC.allowedGroups.join(","), "", ""].join("\0");
        const cookie = `__pikvm_session=${new Sessions(KEY, Date.now).issue("oidc", "user-77", material)}`;
        const oidc = await session(s.origin, { cookie });
        assert.deepEqual(oidc.view, { signIn: true, method: "oidc", subject: "user-77", canSignOut: true });

        const bearer = await session(s.origin, { authorization: `Bearer ${TOKEN}` });
        assert.deepEqual(bearer.view, { signIn: true, method: "bearer", subject: "access token", canSignOut: false });

        const viaBasic = await session(s.origin, { authorization: basic(USER, PASSWORD) });
        assert.deepEqual(viaBasic.view, { signIn: true, method: "basic", subject: USER, canSignOut: false });
    } finally {
        await s.close();
    }
});

test("the session read is behind the gate, and a forged header does not pose as another method", async () => {
    const s = await start(options());
    try {
        assert.equal((await session(s.origin)).status, 401);
        assert.equal((await session(s.origin, { authorization: "Bearer wrong" })).status, 401);
        assert.equal((await session(s.origin, { cookie: "__pikvm_session=junk" })).status, 401);
        const forged = await session(s.origin, {
            authorization: `Bearer ${TOKEN}`,
            "x-pikvm-signed-in": JSON.stringify({ method: "oidc", subject: "admin" }),
        });
        assert.deepEqual(forged.view, { signIn: true, method: "bearer", subject: "access token", canSignOut: false });
        const page = await fetch(`${s.origin}/app/api/v1/session`, { headers: { accept: "text/html" }, redirect: "manual" });
        assert.equal(page.status, 302);
    } finally {
        await s.close();
    }
});

test("the body carries no token, cookie, password, secret or id_token", async () => {
    const s = await start(options());
    try {
        const cookie = await cookieFrom(s.origin, { user: USER, password: PASSWORD });
        const replies = [
            await session(s.origin, { cookie }),
            await session(s.origin, { authorization: `Bearer ${TOKEN}` }),
            await session(s.origin, { authorization: basic(USER, PASSWORD) }),
        ];
        for (const r of replies) {
            assert.deepEqual(Object.keys(JSON.parse(r.text)).sort(), ["canSignOut", "method", "signIn", "subject"]);
            for (const secret of [TOKEN, PASSWORD, OIDC.clientSecret, cookie.split("=")[1]!, KEY.toString("base64"), KEY.toString("hex")]) {
                assert.ok(!r.text.includes(secret), "a secret is in the body");
            }
        }
    } finally {
        await s.close();
    }
});
