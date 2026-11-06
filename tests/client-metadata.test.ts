/**
 * Client ID Metadata Documents (src/server/web-auth/client-metadata.ts). The host fetches a URL a stranger chose.
 * FAILURE MODES:
 *   C1. A name that resolves to a private, loopback, link-local or mapped address is fetched (request forgery), or only the first answer is checked.
 *   C2. The fetch goes to a name that was not the one checked.
 *   C3. A document that is not JSON, not 200, names another client_id, or lists a redirect URI a stranger could use (plain http to another machine).
 *   C4. A good document is refused, or a refused one is cached as good.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createClientMetadata, isClientMetadataUrl, isPublicAddress } from "../src/server/web-auth/client-metadata";

const ID = "https://agent.example.com/oauth/client.json";
const good = { client_id: ID, client_name: "Example Agent", redirect_uris: ["http://127.0.0.1:3000/callback", "https://agent.example.com/cb"] };
const json = (body: unknown, over: Partial<{ status: number; type: string }> = {}) => async () => ({ status: over.status ?? 200, type: over.type ?? "application/json", body: typeof body === "string" ? body : JSON.stringify(body) });

test("C1: only public addresses are fetched, and every answer of the name must be one", async () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) assert.equal(isPublicAddress(a), false, a);
    for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "172.32.0.1"]) assert.equal(isPublicAddress(a), true, a);
    let fetched = 0;
    const doc = createClientMetadata({ resolve: async () => ["93.184.216.34", "10.0.0.7"], fetch: async () => (fetched++, { status: 200, type: "application/json", body: JSON.stringify(good) }) });
    assert.equal(await doc(ID), undefined, "one private answer among public ones refuses the name");
    assert.equal(fetched, 0, "and nothing is fetched");
});

test("C2: the fetch goes to the address that was checked, with the name kept", async () => {
    const calls: { url: string; address: string }[] = [];
    const doc = createClientMetadata({ resolve: async () => ["93.184.216.34"], fetch: async (url, address) => (calls.push({ url: url.href, address }), { status: 200, type: "application/json", body: JSON.stringify(good) }) });
    assert.deepEqual(await doc(ID), { name: "Example Agent", redirectUris: good.redirect_uris });
    assert.deepEqual(calls, [{ url: ID, address: "93.184.216.34" }]);
});

test("C3: a document is refused unless it is 200 JSON naming this client_id with acceptable redirects", async () => {
    const resolve = async () => ["93.184.216.34"];
    const bad: [string, () => Promise<{ status: number; type: string; body: string }>][] = [
        ["not found", json(good, { status: 404 })],
        ["html", json(good, { type: "text/html" })],
        ["not json", json("<html>", { type: "application/json" })],
        ["another client_id", json({ ...good, client_id: "https://evil.example/c.json" })],
        ["no redirect uris", json({ ...good, redirect_uris: [] })],
        ["http to another machine", json({ ...good, redirect_uris: ["http://evil.example/cb"] })],
        ["a script address", json({ ...good, redirect_uris: ["javascript:alert(1)"] })],
    ];
    for (const [what, fetch] of bad) assert.equal(await createClientMetadata({ resolve, fetch })(ID), undefined, what);
    for (const id of ["http://agent.example.com/c.json", "https://agent.example.com", "https://user:pw@agent.example.com/c.json", "https://agent.example.com/c.json#x"]) assert.equal(isClientMetadataUrl(id), false, id);
});

test("C4: a good document is kept for a while, a refused one is kept refused", async () => {
    let now = 1_000_000;
    let fetched = 0;
    const doc = createClientMetadata({ now: () => now, resolve: async () => ["93.184.216.34"], fetch: async () => (fetched++, { status: 200, type: "application/json", body: JSON.stringify(good) }) });
    await doc(ID);
    await doc(ID);
    assert.equal(fetched, 1);
    now += 6 * 60_000;
    await doc(ID);
    assert.equal(fetched, 2, "refetched after five minutes");
});

/*
 * The one GET (`makeFetchChecked`), with a stand-in for https.request.
 * FAILURE MODES: a redirect is followed; a body past the cap is read to the end; a silent server holds the request open.
 */
import { EventEmitter } from "node:events";
import { makeFetchChecked, type RequestFn } from "../src/server/web-auth/client-metadata";

function fakeRequest(drive: (res: EventEmitter & { statusCode?: number; headers: Record<string, string> }, req: EventEmitter & { destroy(e?: Error): void }) => void, seen: { options?: Record<string, unknown>; destroyed?: Error }): RequestFn {
    return ((options: Record<string, unknown>, onResponse: (res: unknown) => void) => {
        seen.options = options;
        const req = Object.assign(new EventEmitter(), {
            end() {
                const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-type": "application/json" } });
                onResponse(res);
                drive(res, req);
            },
            destroy(e?: Error) {
                seen.destroyed = e;
                if (e) req.emit("error", e);
            },
        });
        return req;
    }) as unknown as RequestFn;
}

test("C5: the connection goes to the checked address with the name as Host and SNI, and the request carries a timeout", async () => {
    const seen: { options?: Record<string, unknown> } = {};
    const get = makeFetchChecked(fakeRequest((res) => (res.emit("data", Buffer.from("{}")), res.emit("end")), seen));
    const out = await get(new URL(ID), "93.184.216.34");
    assert.equal(out.body, "{}");
    assert.equal(seen.options!.host, "93.184.216.34");
    assert.equal(seen.options!.servername, "agent.example.com");
    assert.equal((seen.options!.headers as Record<string, string>).host, "agent.example.com");
    assert.equal(seen.options!.timeout, 5000);
});

test("C6: a redirect is never followed: its status comes back and the document is refused", async () => {
    const calls: string[] = [];
    const redirecting = makeFetchChecked(
        ((o: Record<string, unknown>, onResponse: (res: unknown) => void) => {
            calls.push(String(o.host));
            const req = Object.assign(new EventEmitter(), {
                end() {
                    const res = Object.assign(new EventEmitter(), { statusCode: 302, headers: { location: "https://10.0.0.1/secret.json", "content-type": "application/json" } });
                    onResponse(res);
                    res.emit("end");
                },
                destroy() {},
            });
            return req;
        }) as unknown as RequestFn,
    );
    const doc = createClientMetadata({ resolve: async () => ["93.184.216.34"], fetch: redirecting });
    assert.equal(await doc(ID), undefined);
    assert.deepEqual(calls, ["93.184.216.34"], "exactly one request: the Location was not followed");
});

test("C7: a body past 16 KiB stops the read and fails the fetch", async () => {
    const seen: { destroyed?: Error } = {};
    const get = makeFetchChecked(fakeRequest((res) => (res.emit("data", Buffer.alloc(10_000)), res.emit("data", Buffer.alloc(10_000)), res.emit("end")), seen));
    await assert.rejects(get(new URL(ID), "93.184.216.34"), /too large/);
    assert.match(String(seen.destroyed), /too large/);
});

test("C8: a server that goes silent past the timeout is cut off", async () => {
    const seen: { destroyed?: Error } = {};
    const get = makeFetchChecked(fakeRequest((_res, req) => req.emit("timeout"), seen));
    await assert.rejects(get(new URL(ID), "93.184.216.34"), /took too long/);
    assert.match(String(seen.destroyed), /took too long/);
});

test("C9: an operator-trusted host may resolve to a private address (a tailnet service); any other still may not", async () => {
    const fetch = async () => ({ status: 200, type: "application/json", body: JSON.stringify({ ...good, client_id: "https://exe.example.net/c.json", redirect_uris: ["https://exe.example.net/cb"] }) });
    const resolve = async () => ["100.107.62.125"];
    const url = "https://exe.example.net/c.json";
    assert.equal(await createClientMetadata({ resolve, fetch })(url), undefined, "not trusted: a tailnet address is refused");
    assert.deepEqual(await createClientMetadata({ resolve, fetch, trustedHosts: ["EXE.example.net"] })(url), { name: "Example Agent", redirectUris: ["https://exe.example.net/cb"] });
    assert.equal(await createClientMetadata({ resolve, fetch, trustedHosts: ["other.example.net"] })(url), undefined, "only the exact host named");
});
