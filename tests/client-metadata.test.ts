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
