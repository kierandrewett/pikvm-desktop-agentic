/**
 * Signing in to a server with the browser (src/server/sync/sign-in.ts), end to end. The "server" is the real web host's
 * sign-in (src/server/web-auth) over a real socket; the "browser" is these tests, which do what a person's browser does:
 * sign in, read the consent page, press Allow, and follow the redirect to the app's loopback listener, which is real too.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { ServerAlreadySaved, ServerError, ServerNotFound, ServerStore } from "../src/server-store";
import { createServerSync } from "../src/server/sync";
import { probeServer } from "../src/server/sync/remote";
import { createBrowserSignIn, SIGN_IN_TTL_MS, type BrowserSignIn, type SignInDeps, type SignInStatus } from "../src/server/sync/sign-in";
import { createWebAuth } from "../src/server/web-auth";
import { SESSION_COOKIE } from "../src/server/web-auth/session";
import { call, run, stubTargets, type Reply } from "./support/web-rig";

const TOKEN = "tok-3f9a1c7e2b8d4f60a5e1c9b7d3f2a801";
const KEY = Buffer.alloc(32, 9);

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-sign-in-"));
    dirs.push(dir);
    return dir;
};
const closers: Array<() => Promise<void> | void> = [];
after(async () => {
    for (const close of closers) await close();
    dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

interface Server {
    origin: string;
}

/** A server with the host's real sign-in (the access token method is enough: the flow does not care which method). */
async function server(): Promise<Server> {
    const auth = createWebAuth({ token: TOKEN, allowHttpBearer: false, trustProxy: false, sessionKey: KEY, log: () => undefined });
    const s = await run(stubTargets(auth));
    closers.push(s.close);
    return { origin: s.origin };
}

const form = (origin: string, path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Reply> =>
    call(origin, path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });

/** What a person does in the browser: signs in, reads the question, answers it. The address the browser is sent back to. */
async function answer(s: Server, url: string, decision: "allow" | "deny" = "allow"): Promise<URL> {
    const signedIn = await form(s.origin, "/app/auth", { token: TOKEN });
    const cookie = (signedIn.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "").split(";")[0]!;
    const here = new URL(url);
    const ask = await call(s.origin, here.pathname + here.search, { headers: { cookie } });
    assert.equal(ask.status, 200);
    const grant = /name="grant" value="([^"]+)"/.exec(ask.body)![1]!;
    const reply = await form(s.origin, "/app/auth/device", { grant, decision }, { cookie });
    assert.equal(reply.status, 303);
    return new URL(reply.headers.get("location")!);
}

interface Client {
    signIn: BrowserSignIn;
    store: ServerStore;
}

function client(over: Partial<SignInDeps> = {}): Client {
    const store = new ServerStore(tempDir());
    const signIn = createBrowserSignIn({
        save: (input) => store.add(input, probeServer),
        ensureRoom: () => {
            if (store.list().items.length > 0) throw new ServerAlreadySaved();
        },
        forget: (id) => {
            store.remove(id);
        },
        deviceName: () => "Test PC (PiKVM Desktop)",
        ...over,
    });
    closers.push(() => signIn.dispose());
    return { signIn, store };
}

/** The listener answers the browser only after the attempt has ended, so once the callback has been fetched the status is final. */
async function settled(signIn: BrowserSignIn, id: string): Promise<SignInStatus> {
    const status = signIn.status(id);
    assert.notEqual(status.state, "waiting", "the callback is answered only when the attempt is over");
    return status;
}

test("the whole way: the browser is sent to the server, the person says yes, and the server is saved with a device token that works", async () => {
    const s = await server();
    const { signIn, store } = client();
    const begun = await signIn.start({ origin: s.origin });
    const url = new URL(begun.url);
    assert.equal(url.origin, s.origin);
    assert.equal(url.pathname, "/app/auth/device");
    assert.equal(url.searchParams.get("name"), "Test PC (PiKVM Desktop)");
    assert.match(url.searchParams.get("port") ?? "", /^\d{4,5}$/);
    assert.equal(signIn.status(begun.id).state, "waiting");

    const back = await answer(s, begun.url);
    assert.equal(back.hostname, "127.0.0.1");
    const page = await fetch(back);
    assert.equal(page.status, 200);
    const text = await page.text();
    assert.match(text, /Signed in/);
    assert.ok(!text.includes(back.searchParams.get("code")!), "the page does not repeat the code");

    const done = await settled(signIn, begun.id);
    assert.equal(done.state, "done");
    assert.equal(store.list().items.length, 1);
    const saved = store.list().items[0]!;
    assert.equal(saved.origin, s.origin);
    assert.equal(saved.tokenSet, true);
    const credentials = store.credentials(saved.id)!;
    assert.match(credentials.token, /^pkd_[0-9a-f]{12}_/, "a device token, not the access token");
    assert.notEqual(credentials.token, TOKEN);
    await probeServer(credentials);
    assert.ok(!JSON.stringify(done).includes(credentials.token) && !JSON.stringify(signIn.status(begun.id)).includes(credentials.token), "the token is in no answer");
});

test("the listener ends with the attempt: the callback cannot be used twice", async () => {
    const s = await server();
    const { signIn } = client();
    const begun = await signIn.start({ origin: s.origin });
    const back = await answer(s, begun.url);
    assert.equal((await fetch(back)).status, 200);
    await settled(signIn, begun.id);
    await assert.rejects(fetch(back), "the port is closed once the attempt is over");
});

test("Cancel in the browser ends the attempt with a sentence, and saves nothing", async () => {
    const s = await server();
    const { signIn, store } = client();
    const begun = await signIn.start({ origin: s.origin });
    const back = await answer(s, begun.url, "deny");
    assert.equal(back.searchParams.get("error"), "access_denied");
    await fetch(back);
    assert.deepEqual(await settled(signIn, begun.id), { state: "failed", error: "You did not allow the sign-in." });
    assert.equal(store.list().items.length, 0);
});

test("a callback with another state is refused and the attempt carries on; the right one then finishes it", async () => {
    const s = await server();
    const { signIn, store } = client();
    const begun = await signIn.start({ origin: s.origin });
    const back = await answer(s, begun.url);
    const stray = new URL(back);
    stray.searchParams.set("state", "AAAAAAAAAAAAAAAAAAAAAA");
    assert.equal((await fetch(stray)).status, 400);
    assert.equal(signIn.status(begun.id).state, "waiting");
    assert.equal(store.list().items.length, 0);
    assert.equal((await fetch(back)).status, 200);
    assert.equal((await settled(signIn, begun.id)).state, "done");
});

test("the listener answers only its own address: another Host name (a page of another site) and other paths get nothing", async () => {
    const s = await server();
    const { signIn } = client();
    const begun = await signIn.start({ origin: s.origin });
    const back = await answer(s, begun.url);
    const status = (path: string, host: string, method = "GET"): Promise<number> =>
        new Promise((resolve, reject) => {
            const req = httpRequest({ host: "127.0.0.1", port: Number(back.port), path, method, headers: { host } }, (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
            });
            req.on("error", reject);
            req.end();
        });
    assert.equal(await status(back.pathname + back.search, "evil.example"), 404);
    assert.equal(await status(back.pathname + back.search, "localhost:" + back.port), 404, "by name, not by address");
    assert.equal(await status("/other" + back.search, back.host), 404);
    assert.equal(await status(back.pathname + back.search, back.host, "POST"), 404);
    assert.equal(signIn.status(begun.id).state, "waiting");
    assert.equal((await fetch(back)).status, 200);
    assert.equal((await settled(signIn, begun.id)).state, "done");
});

test("a server with only an access token says so before any browser is opened", async () => {
    const auth = await run(stubTargets());
    closers.push(auth.close);
    const { signIn } = client();
    await assert.rejects(signIn.start({ origin: auth.origin }), (error: unknown) => error instanceof ServerError && /does not offer browser sign-in/.test(error.message));
});

test("an address that is not https (or loopback) is refused before anything is asked of it", async () => {
    const { signIn } = client();
    await assert.rejects(signIn.start({ origin: "http://kvm.example.com" }), ServerError);
    await assert.rejects(signIn.start({ origin: "https://user:secret@kvm.example.com" }), ServerError);
});

test("one server at most: with one saved, a second sign-in is refused up front", async () => {
    const s = await server();
    const { signIn } = client();
    const first = await signIn.start({ origin: s.origin });
    await fetch(await answer(s, first.url));
    await settled(signIn, first.id);
    await assert.rejects(signIn.start({ origin: s.origin }), ServerAlreadySaved);
});

test("an attempt lasts a few minutes and then its listener is gone", async () => {
    const s = await server();
    const timers: { ms: number; run: () => void }[] = [];
    const { signIn } = client({
        after: (ms, run) => {
            timers.push({ ms, run });
            return () => undefined;
        },
    });
    const begun = await signIn.start({ origin: s.origin });
    const back = await answer(s, begun.url);
    timers.find((timer) => timer.ms === SIGN_IN_TTL_MS)!.run();
    assert.deepEqual(signIn.status(begun.id), { state: "failed", error: "The sign-in took too long. Start again." });
    await assert.rejects(fetch(back));
});

test("cancelling closes the listener at once; an id that is not an attempt is unknown", async () => {
    const s = await server();
    const { signIn } = client();
    const begun = await signIn.start({ origin: s.origin });
    const back = await answer(s, begun.url);
    signIn.cancel(begun.id);
    assert.deepEqual(signIn.status(begun.id), { state: "failed", error: "The sign-in was cancelled." });
    await assert.rejects(fetch(back));
    signIn.cancel("nope");
    assert.throws(() => signIn.status("nope"), ServerNotFound);
});

test("starting over replaces what was waiting, so abandoned attempts do not pile up listeners", async () => {
    const s = await server();
    const { signIn } = client();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await signIn.start({ origin: s.origin })).id);
    const states = ids.map((id) => signIn.status(id).state);
    assert.equal(states.filter((state) => state === "waiting").length, 3);
    assert.equal(states[4], "waiting", "the newest one is the live one");
    assert.equal(states[0], "failed");
});

test("the server refusing the trade ends the attempt with a fixed sentence and saves nothing", async () => {
    const s = await server();
    const fetchWrapper: typeof fetch = (input, init) =>
        String(input).endsWith("/app/auth/device/token") ? Promise.resolve(new Response('{"error":"secret detail"}', { status: 400 })) : fetch(input, init);
    const { signIn, store } = client({ fetch: fetchWrapper });
    const begun = await signIn.start({ origin: s.origin });
    const reply = await fetch(await answer(s, begun.url));
    const text = await reply.text();
    assert.ok(!text.includes("secret detail"));
    assert.deepEqual(await settled(signIn, begun.id), { state: "failed", error: "The server did not accept the sign-in. Start again." });
    assert.equal(store.list().items.length, 0);
});

test("a token the app could not keep is taken back from the server", async () => {
    const s = await server();
    const { signIn } = client({
        save: () => Promise.reject(new ServerError("The server refused the request.")),
    });
    const begun = await signIn.start({ origin: s.origin });
    await fetch(await answer(s, begun.url));
    assert.deepEqual(await settled(signIn, begun.id), { state: "failed", error: "The server refused the request." });
    const signedIn = await form(s.origin, "/app/auth", { token: TOKEN });
    const cookie = (signedIn.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "").split(";")[0]!;
    const list = await call(s.origin, "/app/api/v1/devices", { headers: { cookie } });
    assert.deepEqual(JSON.parse(list.body), { devices: [] });
});

/** The device tokens the server lists, for a browser signed in with the access token. */
async function deviceCount(s: Server): Promise<number> {
    const signedIn = await form(s.origin, "/app/auth", { token: TOKEN });
    const cookie = (signedIn.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "").split(";")[0]!;
    const list = JSON.parse((await call(s.origin, "/app/api/v1/devices", { headers: { cookie } })).body) as { devices: unknown[] };
    return list.devices.length;
}

test("forgetting the server also tells it to forget this app", async () => {
    const s = await server();
    const sync = createServerSync({ dir: tempDir(), live: { track: () => undefined, closeAll: () => undefined } });
    const begun = await sync.editor.signIn({ origin: s.origin });
    await fetch(await answer(s, begun.url));
    assert.equal(sync.editor.signInStatus(begun.id).state, "done");
    const id = sync.editor.list().items[0]!.id;
    assert.equal(await deviceCount(s), 1);

    // The revoke is sent in the background: take hold of the request itself instead of waiting for it.
    const real = globalThis.fetch;
    const revokes: Promise<unknown>[] = [];
    globalThis.fetch = (input, init) => {
        const sent = real(input, init);
        if (String(input).endsWith("/app/api/v1/devices/self")) revokes.push(sent);
        return sent;
    };
    try {
        sync.editor.remove(id);
        assert.equal(revokes.length, 1, "one request to the server, to revoke this app's token");
        await Promise.all(revokes);
    } finally {
        globalThis.fetch = real;
    }
    assert.equal(await deviceCount(s), 0, "the device token is revoked on the server");
});

test("cancelled while the server is being saved: it is not left saved, and its token is taken back", async () => {
    const s = await server();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const store = new ServerStore(tempDir());
    const { signIn } = client({
        save: async (input) => {
            started.resolve();
            await gate.promise;
            return store.add(input, probeServer);
        },
        forget: (id) => {
            store.remove(id);
        },
    });
    const begun = await signIn.start({ origin: s.origin });
    const reply = fetch(await answer(s, begun.url));
    await started.promise;
    signIn.cancel(begun.id);
    gate.resolve();
    assert.match(await (await reply).text(), /cancelled/);
    assert.deepEqual(signIn.status(begun.id), { state: "failed", error: "The sign-in was cancelled." });
    assert.equal(store.list().items.length, 0, "not left saved");
    assert.equal(await deviceCount(s), 0, "and the token the server made is revoked");
});
