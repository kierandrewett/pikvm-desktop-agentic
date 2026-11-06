/**
 * Remote servers: this app using a saved PiKVM Desktop server instead of its own.
 *
 * Two real control servers stand for the two ends: the "remote" has an access token and a PiKVM list of its own, and
 * the "local" is this desktop. A hand-written fake http server stands in for a remote where a test scripts the answer
 * (a server-sent event stream, a WebSocket, a refusal, a server that goes away, a server that is saved but not in use).
 *
 * Two rules sit under every test. No reply, log or error of `/servers`, `/pikvms` or the forwarder carries the access
 * token or a PiKVM password. And a PiKVM password goes only to the server in use, only over https (or http to a
 * loopback host), and this app neither caches nor writes it.
 */

import { Macro, PikvmEntry, ServerEntry, ServerList } from "@pikvm/contracts/api";
import type { ChatServer } from "@pikvm/chat-server";
import { Schema } from "effect";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as openSocket, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type Duplex } from "node:stream";
import test from "node:test";
import type { PiKvmControl } from "../src/pikvm-control";
import { startControlServer } from "../src/server";
import { isRemotePath } from "../src/server/sync/forward";
import { SettingsStore } from "../src/settings";
import { TargetStore } from "../src/target-store";
import { noImages, stubChat } from "./support/chat-stub";

const JSON_HEADERS = { "content-type": "application/json" };
const REMOTE_TOKEN = "remote-access-token-0123";
const REMOTE_PASSWORD = "remote-pikvm-password-9";
const LOCAL_PASSWORD = "local-pikvm-password-7";
const NEW_PASSWORD = "forwarded-pikvm-password-3";
const SECRETS = [REMOTE_TOKEN, REMOTE_PASSWORD, LOCAL_PASSWORD, NEW_PASSWORD];
/** The probe every save and every use makes: a signed-in read of the server's state. */
const PROBE_PATH = "/app/api/v1/state";
/** What a fake server answers when it stores a PiKVM. It carries `passwordSet` and never the password. */
const FAKE_ENTRY = {
    id: "fake-1",
    name: "Fake PiKVM",
    origin: "https://fake-pikvm.example/",
    username: "root",
    passwordSet: true,
    isDefault: true,
    active: true,
};

interface Running {
    origin: string;
    dir: string;
    settings: SettingsStore;
    store: TargetStore;
    close(): Promise<void>;
}

const control = {
    setTarget: () => {},
    proxyTarget: async () => ({ origin: new URL("https://kvm.example.test:8443"), headers: {}, rejectUnauthorized: false }),
    getHidState: () => undefined,
    lastInputAt: () => 0,
    noteObservedMouse: () => {},
    warm: () => {},
    mouseNudge: async () => {},
} as unknown as PiKvmControl;

/** A control server on a temporary data folder. `token` turns it into a server others may use. */
async function start(options: { token?: string; macros?: unknown[]; files?: Record<string, unknown>; chat?: Partial<ChatServer> } = {}): Promise<Running> {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-sync-test-"));
    if (options.macros) writeFileSync(join(dir, "macros.json"), JSON.stringify({ macros: options.macros }));
    for (const [name, body] of Object.entries(options.files ?? {})) writeFileSync(join(dir, name), JSON.stringify(body));
    const settings = new SettingsStore(join(dir, "settings.json"));
    settings.patch({ jiggler: false, accessToken: options.token ?? "" });
    const store = new TargetStore(dir);
    const server = startControlServer({ control, settings, images: noImages, createChat: stubChat(options.chat), pikvms: store }, 0);
    await new Promise<void>((done) => server.once("listening", done));
    const { port } = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${port}`,
        dir,
        settings,
        store,
        close: async () => {
            await server.shutdown();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** Two servers: a remote one with state of its own, a local one with different state. */
async function pair(localChat?: Partial<ChatServer>) {
    const remote = await start({ token: REMOTE_TOKEN, macros: [macro("r1", "Remote one"), macro("r2", "Remote two")] });
    remote.settings.patch({ jiggler: true });
    remote.store.add({ name: "Remote PiKVM", origin: "https://remote-pikvm.example/", username: "admin", password: REMOTE_PASSWORD });

    const local = await start({ macros: [macro("l1", "Local one")], chat: localChat });
    local.settings.patch({ jiggler: false });
    local.store.add({ name: "Local PiKVM", origin: "https://local-pikvm.example/", username: "root", password: LOCAL_PASSWORD });
    return {
        remote,
        local,
        async close() {
            await local.close();
            await remote.close();
        },
    };
}

/** The macros a server holds, from its file: the server's own store keeps its list in memory, so ask the file. */
function macroIds(r: Running): string[] {
    const file = join(r.dir, "macros.json");
    try {
        return (JSON.parse(readFileSync(file, "utf8")) as { macros: { id: string }[] }).macros.map((m) => m.id);
    } catch {
        return [];
    }
}

const macro = (id: string, label: string) => ({ id, label, pinned: true, steps: [{ type: "text", text: label }] });

async function put(origin: string, path: string, body: unknown, method = "PUT"): Promise<Response> {
    return fetch(`${origin}${path}`, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });
}

const listServers = async (origin: string) => Schema.decodeUnknownSync(ServerList)(await (await fetch(`${origin}/app/api/v1/servers`)).json());

/** Save a server by its address and token, and return its id. */
async function saveServer(local: Running, origin: string, token = REMOTE_TOKEN): Promise<string> {
    const res = await put(local.origin, "/app/api/v1/servers", { origin, token }, "POST");
    assert.equal(res.status, 200);
    return Schema.decodeUnknownSync(ServerEntry)(await res.json()).id;
}

/** Save a server and use it. */
async function connect(local: Running, origin: string, token = REMOTE_TOKEN): Promise<string> {
    const id = await saveServer(local, origin, token);
    assert.equal((await fetch(`${local.origin}/app/api/v1/servers/${id}/use`, { method: "POST", headers: JSON_HEADERS, body: "{}" })).status, 200);
    return id;
}

function assertNoSecrets(text: string, ...more: string[]): void {
    for (const secret of [...SECRETS, ...more]) assert.ok(!text.includes(secret), "a reply carried a secret");
}

/** Every file under `dir` whose text holds `secret`, by path relative to `dir`. */
function filesHolding(dir: string, secret: string, base = dir): string[] {
    const found: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) found.push(...filesHolding(path, secret, base));
        else if (readFileSync(path, "utf8").includes(secret)) found.push(relative(base, path));
    }
    return found;
}

/** Runs `run` and returns what it printed to the console, so a test can check nothing secret was logged. */
async function logged<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const saved = methods.map((m) => console[m]);
    for (const m of methods) console[m] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
        return { result: await run(), output: lines.join("\n") };
    } finally {
        methods.forEach((m, i) => (console[m] = saved[i]!));
    }
}

/* ---------------------------------------------------------------- the server list */

test("servers: the list starts with this computer, and a saved server is probed before it is kept", async () => {
    const { local, remote, close } = await pair();
    try {
        assert.deepEqual(await listServers(local.origin), { items: [], localActive: true, editable: true });

        const badToken = await put(local.origin, "/app/api/v1/servers", { origin: remote.origin, token: "not-the-token" }, "POST");
        assert.equal(badToken.status, 400);
        const badTokenText = await badToken.text();
        assert.match(badTokenText, /did not accept the access token/);
        assertNoSecrets(badTokenText, "not-the-token");
        assert.deepEqual(await listServers(local.origin), { items: [], localActive: true, editable: true });

        // An address that is not acceptable is refused before anything is sent.
        const plain = await put(local.origin, "/app/api/v1/servers", { origin: "http://remote.example/", token: "t" }, "POST");
        assert.equal(plain.status, 400);
        assert.match(await plain.text(), /must use https/);
        const credentials = await put(local.origin, "/app/api/v1/servers", { origin: "https://u:p@remote.example/", token: "t" }, "POST");
        assert.equal(credentials.status, 400);
        assert.deepEqual(await listServers(local.origin), { items: [], localActive: true, editable: true });

        const id = await saveServer(local, remote.origin);
        const listed = await listServers(local.origin);
        assert.deepEqual(listed.items, [
            { id, name: new URL(remote.origin).host, origin: remote.origin, tokenSet: true, active: false, state: "ok" },
        ]);
        assert.equal(listed.localActive, true);
        assertNoSecrets(JSON.stringify(listed));
    } finally {
        await close();
    }
});

test("servers: a server is used only once it answers; the list says which one is in use, and a forgotten one is not used", async () => {
    const { local, remote, close } = await pair();
    try {
        const id = await saveServer(local, remote.origin);
        assert.equal((await fetch(`${local.origin}/app/api/v1/servers/nope/use`, { method: "POST", headers: JSON_HEADERS, body: "{}" })).status, 404);

        const used = await fetch(`${local.origin}/app/api/v1/servers/${id}/use`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
        assert.equal(used.status, 200);
        const usedList = Schema.decodeUnknownSync(ServerList)(await used.json());
        assert.equal(usedList.localActive, false);
        assert.equal(usedList.items[0]?.active, true);

        // The server's macros are what this app now shows; this computer's own are untouched.
        const macros = (await (await fetch(`${local.origin}/app/api/v1/macros`)).json()) as { macros: { id: string }[] };
        assert.deepEqual(macros.macros.map((m) => m.id), ["r1", "r2"]);
        assert.deepEqual(macroIds(local), ["l1"]);

        const back = await fetch(`${local.origin}/app/api/v1/servers/local/use`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
        assert.equal(Schema.decodeUnknownSync(ServerList)(await back.json()).localActive, true);

        // Forgetting the one in use leaves this computer's own server in use.
        await fetch(`${local.origin}/app/api/v1/servers/${id}/use`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
        const gone = await fetch(`${local.origin}/app/api/v1/servers/${id}`, { method: "DELETE", headers: JSON_HEADERS });
        assert.equal(gone.status, 200);
        assert.deepEqual(Schema.decodeUnknownSync(ServerList)(await gone.json()), { items: [], localActive: true, editable: true });
        assert.equal((await fetch(`${local.origin}/app/api/v1/servers/${id}`, { method: "DELETE", headers: JSON_HEADERS })).status, 404);
        assert.deepEqual(macroIds(remote), ["r1", "r2"]);
    } finally {
        await close();
    }
});

test("servers: a host that owns its state shows no saved servers and refuses every change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-servers-pinned-"));
    const settings = new SettingsStore(join(dir, "settings.json"));
    const server = startControlServer({ control, settings, images: noImages, createChat: stubChat() }, 0);
    await new Promise<void>((done) => server.once("listening", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        assert.deepEqual(await listServers(origin), { items: [], localActive: true, editable: false });
        assert.equal((await put(origin, "/app/api/v1/servers", { origin: "https://s.example", token: "t" }, "POST")).status, 403);
        assert.equal((await fetch(`${origin}/app/api/v1/servers/x/use`, { method: "POST", headers: JSON_HEADERS, body: "{}" })).status, 403);
        assert.equal((await fetch(`${origin}/app/api/v1/servers/local/use`, { method: "POST", headers: JSON_HEADERS, body: "{}" })).status, 403);
        assert.equal((await fetch(`${origin}/app/api/v1/servers/x`, { method: "DELETE", headers: JSON_HEADERS })).status, 403);
    } finally {
        await server.shutdown();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("servers: one saved server at most: a second is refused with 409, and nothing is stored or changed", async () => {
    const { local, remote, close } = await pair();
    try {
        const id = await saveServer(local, remote.origin);
        const before = await listServers(local.origin);
        const tokensBefore = readFileSync(join(local.dir, "server-tokens.json"), "utf8");

        // Refused before the address is checked or probed, so the new token is never sent anywhere or kept.
        const second = await put(local.origin, "/app/api/v1/servers", { origin: "https://second-pikvm.example/", token: "second-token" }, "POST");
        assert.equal(second.status, 409);
        const text = await second.text();
        assert.match(text, /A server is already saved\. Forget it first\./);
        assertNoSecrets(text, "second-token");

        assert.deepEqual(await listServers(local.origin), before);
        assert.equal(readFileSync(join(local.dir, "server-tokens.json"), "utf8"), tokensBefore);
        assert.deepEqual(filesHolding(local.dir, "second-token"), []);
        assert.deepEqual(filesHolding(local.dir, "second-pikvm.example"), []);

        // The first one is untouched and still usable with its own token.
        assert.equal((await fetch(`${local.origin}/app/api/v1/servers/${id}/use`, { method: "POST", headers: JSON_HEADERS, body: "{}" })).status, 200);
    } finally {
        await close();
    }
});

test("servers: forgetting the saved server makes room for another", async () => {
    const { local, remote, close } = await pair();
    try {
        const id = await saveServer(local, remote.origin);
        assert.equal((await fetch(`${local.origin}/app/api/v1/servers/${id}`, { method: "DELETE", headers: JSON_HEADERS })).status, 200);

        const again = await saveServer(local, remote.origin);
        assert.notEqual(again, id);
        assert.equal((await listServers(local.origin)).items.length, 1);
        assert.deepEqual(filesHolding(local.dir, REMOTE_TOKEN), ["server-tokens.json"]);
    } finally {
        await close();
    }
});

test("servers: a hand-edited file with two saved servers is read as one, and the extra token is cleared on the next write", async () => {
    const local = await start({
        files: {
            "servers.json": {
                version: 1,
                active: "b",
                items: [
                    { id: "a", name: "First", origin: "https://first-pikvm.example/", state: "ok" },
                    { id: "b", name: "Second", origin: "https://second-pikvm.example/", state: "ok" },
                ],
            },
            "server-tokens.json": { a: "token-a", b: "token-b" },
        },
    });
    try {
        // Only the first entry is read; the one in use was the dropped entry, so this computer's server is in use.
        const listed = await listServers(local.origin);
        assert.deepEqual(listed.items.map((item) => [item.id, item.tokenSet, item.active]), [["a", true, false]]);
        assert.equal(listed.localActive, true);

        // Any write rewrites both files without the extra entry's token.
        const back = await fetch(`${local.origin}/app/api/v1/servers/local/use`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
        assert.equal(back.status, 200);
        assert.deepEqual(JSON.parse(readFileSync(join(local.dir, "server-tokens.json"), "utf8")), { a: "token-a" });
        assert.deepEqual(filesHolding(local.dir, "token-b"), []);
        assert.deepEqual(filesHolding(local.dir, "second-pikvm.example"), []);
        assert.equal((await listServers(local.origin)).items.length, 1);
    } finally {
        await local.close();
    }
});

/* ---------------------------------------------------------------- the forwarder */

test("forwarder: which paths go to the server while connected, and which stay here", () => {
    const at = (path: string, query = "") => isRemotePath(path, new URL(`http://x${path}${query}`));
    // kvmd's own front page only as its native view; the rest of kvmd and every API and chat path go.
    assert.equal(at("/", "?native=1"), true);
    assert.equal(at("/"), false);
    assert.equal(at("/api/info"), true);
    assert.equal(at("/app/api/v1/macros"), true);
    assert.equal(at("/app/api/v1/pikvms"), true);
    assert.equal(at("/app/api/v1/state/events"), true);
    assert.equal(at("/app/chat/ws"), true);
    assert.equal(at("/app/mcp"), true, "an agent using this app's MCP address reaches the server's PiKVM while connected");
    assert.equal(at("/app/mcpx"), false);
    // This app's own: its web files, its saved-server list, and the agent redirects.
    assert.equal(at("/app/index.html"), false);
    assert.equal(at("/app/apixyz"), false);
    assert.equal(at("/app/api/v1/servers"), false);
    assert.equal(at("/app/api/v1/servers/abc/use"), false);
    assert.equal(at("/_agent/x"), false);
});

test("forwarder: after use, the macros and PiKVMs are the server's, and this app's copy is left alone", async () => {
    const { local, remote, close } = await pair();
    try {
        await connect(local, remote.origin);

        const macros = (await (await fetch(`${local.origin}/app/api/v1/macros`)).json()) as { macros: { id: string }[] };
        assert.deepEqual(macros.macros.map((m) => m.id), ["r1", "r2"]);

        const saved = await put(local.origin, "/app/api/v1/macros", { macros: [macro("w1", "Written here")] });
        assert.equal(saved.status, 200);
        assert.deepEqual(macroIds(remote), ["w1"]);
        assert.deepEqual(macroIds(local), ["l1"]);
        const stored = (JSON.parse(readFileSync(join(local.dir, "macros.json"), "utf8")) as { macros: unknown }).macros;
        Schema.decodeUnknownSync(Schema.Array(Macro))(stored);

        const added = await put(local.origin, "/app/api/v1/pikvms", { name: "Second", origin: "https://second.example/", username: "s", password: NEW_PASSWORD }, "POST");
        assert.equal(added.status, 200);
        const addedText = await added.text();
        assertNoSecrets(addedText, NEW_PASSWORD);
        const entry = Schema.decodeUnknownSync(PikvmEntry)(JSON.parse(addedText));
        assert.equal(entry.passwordSet, true);
        assert.equal(remote.store.entries().length, 2);
        assert.equal(local.store.entries().length, 1);

        // Listing the server's PiKVMs through this app never shows a password.
        const listed = await (await fetch(`${local.origin}/app/api/v1/pikvms`)).text();
        assert.ok(listed.includes("Second"));
        assertNoSecrets(listed, NEW_PASSWORD);

        // Activated on the server: its PiKVM is the one it uses; this app's own active one is untouched.
        const activated = await fetch(`${local.origin}/app/api/v1/pikvms/${entry.id}/activate`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
        assert.equal(activated.status, 200);
        assertNoSecrets(await activated.text(), NEW_PASSWORD);
        assert.equal(remote.store.resolve().origin, "https://second.example/");
        assert.equal(local.store.resolve().origin, "https://local-pikvm.example/");

        // A refusal by the server comes through with its own status.
        const missing = await fetch(`${local.origin}/app/api/v1/pikvms/nope`, { method: "DELETE", headers: JSON_HEADERS });
        assert.equal(missing.status, 404);

        // A write that is not JSON is refused before it can leave.
        const text = await fetch(`${local.origin}/app/api/v1/macros`, { method: "PUT", headers: { "content-type": "text/plain" }, body: "[]" });
        assert.equal(text.status, 415);
    } finally {
        await close();
    }
});

test("forwarder: the PiKVM's own paths go to the server too, with the server's bearer token", async () => {
    const { local, close } = await pair();
    const seen: string[] = [];
    const fake = await fakeRemote((req, res) => {
        if (req.url?.startsWith("/api/info")) {
            seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
            return reply(res, 200, { kvmd: "from-the-server" });
        }
        reply(res, 404, {});
    });
    try {
        await connect(local, fake.origin, "fake-tok");
        const res = await fetch(`${local.origin}/api/info?fields=auth`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { kvmd: "from-the-server" });
        assert.deepEqual(seen, ["GET /api/info?fields=auth Bearer fake-tok"]);
    } finally {
        await fake.close();
        await close();
    }
});

test("forwarder: only the bearer token leaves; the page's cookie and own authorization are dropped, its Origin becomes the server's, and a Set-Cookie does not come back", async () => {
    const { local, close } = await pair();
    const seen: Record<string, string | string[] | undefined>[] = [];
    const fake = await fakeRemote((req, res) => {
        seen.push(req.headers);
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "planted=1", "x-remote": "yes" });
        res.end(JSON.stringify({ macros: [] }));
    });
    try {
        await connect(local, fake.origin, "fake-tok");
        const res = await fetch(`${local.origin}/app/api/v1/macros`, {
            headers: { cookie: "__agent_session=abc", authorization: "Bearer page-credential", origin: "https://page.example", accept: "application/json" },
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("set-cookie"), null);
        assert.equal(res.headers.get("x-remote"), "yes");
        const headers = seen[0]!;
        assert.equal(headers["authorization"], "Bearer fake-tok");
        assert.equal(headers["cookie"], undefined);
        assert.equal(headers["origin"], fake.origin);
        assert.equal(headers["accept"], "application/json");
    } finally {
        await fake.close();
        await close();
    }
});

test("forwarder: server-sent events stream through as they arrive", async () => {
    const { local, close } = await pair();
    const closed = deferred();
    const released = deferred();
    const fake = await fakeRemote((req, res) => {
        if (req.url === "/app/api/v1/state/events") {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write("data: one\n\n");
            void released.promise.then(() => res.write("data: two\n\n"));
            res.on("close", closed.resolve);
            return;
        }
        reply(res, 404, {});
    });
    try {
        await connect(local, fake.origin, "tok");
        const controller = new AbortController();
        const res = await fetch(`${local.origin}/app/api/v1/state/events`, { signal: controller.signal });
        assert.equal(res.headers.get("content-type"), "text/event-stream");
        const reader = res.body!.getReader();
        let text = "";
        // The first event arrives while the stream is still open.
        while (!text.includes("one")) text += new TextDecoder().decode((await reader.read()).value);
        released.resolve();
        while (!text.includes("two")) text += new TextDecoder().decode((await reader.read()).value);
        assert.match(text, /data: one\n\ndata: two/);
        // A page that goes away ends the upstream stream too.
        controller.abort();
        await closed.promise;
    } finally {
        await fake.close();
        await close();
    }
});

test("forwarder: a WebSocket upgrade is relayed to the server, both ways, with the server's bearer token", async () => {
    const { local, close } = await pair();
    let auth: string | string[] | undefined;
    const fake = await fakeRemote(
        (_req, res) => reply(res, 404, {}),
        (req, socket: Duplex, head) => {
            auth = req.headers["authorization"];
            socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake-accept\r\n\r\n");
            // Bytes sent with the handshake, and everything after it, come straight back.
            if (head.length > 0) socket.write(head);
            socket.on("data", (chunk: Buffer) => socket.write(chunk));
            socket.on("error", () => {});
        },
    );
    try {
        await connect(local, fake.origin, "fake-tok");
        const port = Number(new URL(local.origin).port);
        const answer = await talk(
            port,
            "GET /api/ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\nping",
            "\r\n\r\nping",
        );
        assert.match(answer, /^HTTP\/1\.1 101 /);
        assert.equal(auth, "Bearer fake-tok");
    } finally {
        await fake.close();
        await close();
    }
});

test("forwarder: switching to this computer ends what is open to the server (event stream and WebSocket), and a new request goes local", async () => {
    const { local, close } = await pair();
    const upstreamStream = deferred();
    const upstreamSocket = deferred();
    const fake = await fakeRemote(
        (req, res) => {
            if (req.url === "/app/api/v1/state/events") {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                res.write("data: remote\n\n");
                res.on("close", upstreamStream.resolve);
                return;
            }
            reply(res, 404, {});
        },
        (_req, socket: Duplex) => {
            socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake-accept\r\n\r\n");
            // The peer's end arrives as `end` (the upgraded socket stays half-open), its full close after that.
            socket.on("end", upstreamSocket.resolve);
            socket.on("close", upstreamSocket.resolve);
            socket.on("error", () => {});
        },
    );
    let socket: Held | undefined;
    try {
        await connect(local, fake.origin, "fake-tok");
        const reader = (await fetch(`${local.origin}/app/api/v1/state/events`)).body!.getReader();
        let text = "";
        while (!text.includes("remote")) text += new TextDecoder().decode((await reader.read()).value);
        socket = await holdUpgrade(Number(new URL(local.origin).port), "/app/chat/ws");
        assert.match(socket.status, /^HTTP\/1\.1 101 /);

        const back = await fetch(`${local.origin}/app/api/v1/servers/local/use`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
        assert.equal(back.status, 200);

        // Both ends let go: this page's side of each relay, and the server's side.
        const ended = await within(reader.read().then((r) => (r.done ? "ended" : "data"), () => "ended"), "the event stream");
        assert.equal(ended, "ended");
        await within(socket.closed, "the WebSocket");
        await within(upstreamStream.promise, "the server's event stream");
        await within(upstreamSocket.promise, "the server's WebSocket");

        const macros = (await (await fetch(`${local.origin}/app/api/v1/macros`)).json()) as { macros: { id: string }[] };
        const ids = macros.macros.map((m) => m.id);
        assert.ok(ids.includes("l1") && !ids.includes("r1"), "a new request goes to this computer");
    } finally {
        socket?.socket.destroy();
        await fake.close();
        await close();
    }
});

test("forwarder: switching to a server ends the WebSocket open on this computer, and the reconnect reaches the server", async () => {
    let localUpgrades = 0;
    const { local, close } = await pair({
        handleUpgrade: (_req: IncomingMessage, socket: Duplex) => {
            localUpgrades++;
            socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: local-accept\r\n\r\n");
            socket.on("error", () => {});
        },
    });
    let remoteUpgrades = 0;
    const fake = await fakeRemote(
        (_req, res) => reply(res, 404, {}),
        (_req, socket: Duplex) => {
            remoteUpgrades++;
            socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake-accept\r\n\r\n");
            socket.on("error", () => {});
        },
    );
    const port = Number(new URL(local.origin).port);
    let first: Held | undefined;
    let again: Held | undefined;
    try {
        first = await holdUpgrade(port, "/app/chat/ws");
        assert.match(first.status, /^HTTP\/1\.1 101 /);
        assert.equal(localUpgrades, 1);

        await connect(local, fake.origin, "fake-tok");
        await within(first.closed, "the WebSocket open here");

        again = await holdUpgrade(port, "/app/chat/ws");
        assert.match(again.status, /^HTTP\/1\.1 101 /);
        assert.equal(remoteUpgrades, 1);
        assert.equal(localUpgrades, 1);
    } finally {
        first?.socket.destroy();
        again?.socket.destroy();
        await fake.close();
        await close();
    }
});

test("forwarder: a server that goes away is a 502 with a plain sentence, and the list says unreachable", async () => {
    const { local, remote, close } = await pair();
    const fake = await fakeRemote((req, res) => {
        req.resume();
        reply(res, 200, { macros: [] });
    });
    try {
        const id = await connect(local, fake.origin, "secret-tok-1");
        assert.equal((await fetch(`${local.origin}/app/api/v1/macros`)).status, 200);
        await fake.close();

        const res = await fetch(`${local.origin}/app/api/v1/macros`);
        assert.equal(res.status, 502);
        const text = await res.text();
        assert.match(text, /Could not reach/);
        assertNoSecrets(text, "secret-tok-1");
        const saved = (await listServers(local.origin)).items.find((s) => s.id === id);
        assert.equal(saved?.state, "unreachable");
        assert.equal(saved?.tokenSet, true);
        // Forgetting it works, and this app's own state is served again.
        assert.equal((await fetch(`${local.origin}/app/api/v1/servers/${id}`, { method: "DELETE", headers: JSON_HEADERS })).status, 200);
        const back = (await (await fetch(`${local.origin}/app/api/v1/macros`)).json()) as { macros: { id: string }[] };
        assert.deepEqual(back.macros.map((m) => m.id), ["l1"]);
        assert.deepEqual(macroIds(remote), ["r1", "r2"]);
    } finally {
        await fake.close();
        await close();
    }
});

test("forwarder: a refused token is a 502, never a 401 the page would take for its own sign-in", async () => {
    const { local, close } = await pair();
    let refuse = false;
    const fake = await fakeRemote((req, res) => {
        req.resume();
        if (refuse) return reply(res, 401, { error: "Unauthorized" });
        reply(res, 200, { macros: [] });
    });
    try {
        await connect(local, fake.origin, "tok");
        refuse = true;
        const res = await fetch(`${local.origin}/app/api/v1/macros`);
        assert.equal(res.status, 502);
        assert.match(await res.text(), /access token/);
    } finally {
        await fake.close();
        await close();
    }
});

/* ---------------------------------------------------------------- the PiKVM password */

test("password: a PiKVM added through the forwarder reaches the server in use and no other, and no reply, log or file here holds it", async () => {
    const local = await start();
    const inUse: string[] = [];
    const notInUse: string[] = [];
    const inUseServer = await fakeRemote(pikvmAnswer(inUse));
    // The one saved server is the one in use. A second server that is never saved is a tripwire: nothing may reach it.
    const otherServer = await fakeRemote(pikvmAnswer(notInUse));
    try {
        await connect(local, inUseServer.origin, "tok-in-use");

        const { result, output } = await logged(() =>
            put(local.origin, "/app/api/v1/pikvms", { name: "Second", origin: "https://second.example/", username: "s", password: NEW_PASSWORD }, "POST"),
        );
        assert.equal(result.status, 200);
        const text = await result.text();

        // The password reached the server in use, and only it.
        assert.equal(inUse.length, 1);
        assert.ok(inUse[0]!.includes(NEW_PASSWORD));
        assert.deepEqual(notInUse, []);

        // The reply says only that a password is set, and nothing here printed or kept it.
        assertNoSecrets(text, NEW_PASSWORD, "tok-in-use", "tok-other");
        const body = JSON.parse(text) as Record<string, unknown>;
        assert.equal(body["passwordSet"], true);
        assert.ok(!("password" in body));
        assert.ok(!output.includes(NEW_PASSWORD));
        assert.ok(!output.includes("tok-in-use"));
        assert.deepEqual(filesHolding(local.dir, NEW_PASSWORD), []);
        assert.ok(!local.store.entries().some((e) => e.name === "Second"));
    } finally {
        await inUseServer.close();
        await otherServer.close();
        await local.close();
    }
});

test("password: with a real server in use, the password is stored only there, and its replies carry passwordSet alone", async () => {
    const { local, remote, close } = await pair();
    try {
        await connect(local, remote.origin);
        const { result, output } = await logged(() =>
            put(local.origin, "/app/api/v1/pikvms", { name: "Second", origin: "https://second.example/", username: "s", password: NEW_PASSWORD }, "POST"),
        );
        assert.equal(result.status, 200);
        const text = await result.text();
        assertNoSecrets(text, NEW_PASSWORD);
        assert.ok(!output.includes(NEW_PASSWORD));
        const entry = Schema.decodeUnknownSync(PikvmEntry)(JSON.parse(text));
        assert.equal(entry.passwordSet, true);

        // Activating it on the server makes the server use the password it was given.
        const activated = await fetch(`${local.origin}/app/api/v1/pikvms/${entry.id}/activate`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
        assert.equal(activated.status, 200);
        assertNoSecrets(await activated.text(), NEW_PASSWORD);
        assert.equal(remote.store.resolve().password, NEW_PASSWORD);

        // The list through this app shows passwordSet, never the password, and this app keeps nothing of it.
        assertNoSecrets(await (await fetch(`${local.origin}/app/api/v1/pikvms`)).text(), NEW_PASSWORD);
        assert.deepEqual(filesHolding(local.dir, NEW_PASSWORD), []);
        assert.ok(!local.store.entries().some((e) => e.name === "Second"));
    } finally {
        await close();
    }
});

test("password: a failed forward (unreachable, refused, or a relayed error) carries no password, and nothing is logged", async () => {
    const local = await start();
    let mode: "ok" | "refuse" | "error" = "ok";
    const fake = await fakeRemote((req, res) => {
        req.resume();
        if (mode === "refuse") return reply(res, 401, { error: "Unauthorized" });
        if (mode === "error") return reply(res, 400, { error: "That PiKVM is already saved." });
        reply(res, 200, FAKE_ENTRY);
    });
    const body = { name: "Fail", origin: "https://fail.example/", username: "f", password: NEW_PASSWORD };
    try {
        await connect(local, fake.origin, "tok-fail");

        mode = "refuse";
        const refused = await logged(() => put(local.origin, "/app/api/v1/pikvms", body, "POST"));
        assert.equal(refused.result.status, 502);
        const refusedText = await refused.result.text();
        assert.match(refusedText, /did not accept the access token/);
        assertNoSecrets(refusedText, NEW_PASSWORD, "tok-fail");
        assert.ok(!refused.output.includes(NEW_PASSWORD));

        // A server's own refusal is relayed as it came, and it has no password in it either.
        mode = "error";
        const relayed = await logged(() => put(local.origin, "/app/api/v1/pikvms", body, "POST"));
        assert.equal(relayed.result.status, 400);
        const relayedText = await relayed.result.text();
        assert.deepEqual(JSON.parse(relayedText), { error: "That PiKVM is already saved." });
        assertNoSecrets(relayedText, NEW_PASSWORD);
        assert.ok(!relayed.output.includes(NEW_PASSWORD));

        await fake.close();
        const down = await logged(() => put(local.origin, "/app/api/v1/pikvms", body, "POST"));
        assert.equal(down.result.status, 502);
        const downText = await down.result.text();
        assert.match(downText, /Could not reach/);
        assertNoSecrets(downText, NEW_PASSWORD, "tok-fail");
        assert.ok(!down.output.includes(NEW_PASSWORD));
        assert.deepEqual(filesHolding(local.dir, NEW_PASSWORD), []);
    } finally {
        await fake.close();
        await local.close();
    }
});

/** A fake that records the body of every PiKVM it is sent, and answers with a PiKVM entry that carries no password. */
function pikvmAnswer(seen: string[]) {
    return (req: IncomingMessage, res: ServerResponse) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => (body += chunk));
        req.on("end", () => {
            if (req.method === "POST" && req.url === "/app/api/v1/pikvms") seen.push(body);
            reply(res, 200, FAKE_ENTRY);
        });
    };
}

/* ---------------------------------------------------------------- helpers */

function reply(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

/** A promise and the function that resolves it, for a test that releases something at a set moment. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
}

/**
 * A plain http server whose answers the test writes, and optionally its WebSocket upgrades. It answers the probe that
 * every save and use makes, so a test only writes what it is testing.
 */
async function fakeRemote(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    upgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
) {
    const server = createServer((req, res) => {
        if (req.url === PROBE_PATH && req.method === "GET") return reply(res, 200, {});
        handler(req, res);
    });
    // closeAllConnections() does not reach a socket that was upgraded, so keep those to end them here.
    const upgraded = new Set<Duplex>();
    if (upgrade)
        server.on("upgrade", (req, socket, head) => {
            upgraded.add(socket);
            socket.on("close", () => upgraded.delete(socket));
            upgrade(req, socket, head);
        });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return {
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () =>
            new Promise<void>((done) => {
                if (!server.listening) return done();
                for (const socket of upgraded) socket.destroy();
                server.closeAllConnections();
                server.close(() => done());
            }),
    };
}

/** Send raw bytes to this app's port and read until `until` shows up in what comes back. */
function talk(port: number, request: string, until: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = openSocket(port, "127.0.0.1");
        let text = "";
        socket.on("data", (chunk: Buffer) => {
            text += chunk.toString("utf8");
            if (text.includes(until)) {
                socket.destroy();
                resolve(text);
            }
        });
        socket.on("error", reject);
        socket.on("close", () => reject(new Error(`closed before "${until}": ${text.slice(0, 200)}`)));
        socket.write(request);
    });
}

/** A WebSocket upgrade kept open: `status` is the reply's first line, `closed` settles when the connection ends. */
type Held = { status: string; socket: Socket; closed: Promise<void> };

function holdUpgrade(port: number, path: string): Promise<Held> {
    return new Promise((resolve, reject) => {
        const socket = openSocket(port, "127.0.0.1");
        const closed = new Promise<void>((done) => socket.once("close", () => done()));
        let text = "";
        socket.on("error", () => {});
        socket.on("data", (chunk: Buffer) => {
            text += chunk.toString("utf8");
            if (text.includes("\r\n\r\n")) resolve({ status: text.slice(0, text.indexOf("\r\n")), socket, closed });
        });
        socket.on("close", () => reject(new Error(`closed before the reply: ${text.slice(0, 200)}`)));
        socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
}

/** Waits for `promise`, or fails after `ms` saying what did not end. */
function within<T>(promise: Promise<T>, what: string, ms = 3000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`still open after ${ms} ms: ${what}`)), ms);
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
