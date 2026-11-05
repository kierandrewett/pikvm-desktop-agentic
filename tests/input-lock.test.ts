/**
 * The input lock over real sockets: while the agent holds the target, what a person sends through the kvmd proxy (the
 * input socket and the HTTP routes) never reaches the Pi and is told to nobody, and the sockets stay open. The Pi is a
 * plain server that records what reaches it. "Nothing arrived" is shown by a marker sent after it, which arrives in order.
 */

import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import type { PiKvmControl } from "../src/pikvm-control";
import { createPiKvmProxy, type HidInputKind } from "../src/server/proxy/kvmd";

interface Rig {
    readonly origin: string;
    /** The Pi's side: every text frame and every HTTP request that reached it. */
    readonly pi: { frames: string[]; requests: string[] };
    /** Sent after what a page sent, over the same socket: when it arrives, everything before it has been judged. */
    marker(ws: WebSocket): Promise<void>;
    readonly told: HidInputKind[];
    lock: { on: boolean };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
});

async function rig(): Promise<Rig> {
    const pi: Rig["pi"] = { frames: [], requests: [] };
    const seen = new Map<string, () => void>();
    const upstream = createServer((req, res) => {
        pi.requests.push(`${req.method} ${req.url}`);
        req.resume();
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true,"result":{}}');
    });
    const sockets = new WebSocketServer({ server: upstream });
    sockets.on("connection", (ws) => {
        ws.on("message", (data, binary) => {
            const text = binary ? `binary ${(data as Buffer)[0]}` : String(data);
            pi.frames.push(text);
            seen.get(text)?.();
        });
    });
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    const upstreamUrl = new URL(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);

    const lock = { on: false };
    const told: HidInputKind[] = [];
    const gate = Promise.withResolvers<void>();
    const proxy = createPiKvmProxy({
        control: {
            proxyTarget: async () => {
                await gate.promise;
                return { origin: upstreamUrl, headers: {}, rejectUnauthorized: false };
            },
        } as unknown as PiKvmControl,
        inputLocked: () => lock.on,
        onHidInput: (kind) => void told.push(kind),
    });
    gate.resolve();
    const server: Server = createServer((req, res) => void proxy.handleHttp(req, res));
    server.on("upgrade", (req, socket, head) => void proxy.handleUpgrade(req, socket, head));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

    let marks = 0;
    const made: Rig = {
        origin: `127.0.0.1:${(server.address() as AddressInfo).port}`,
        pi,
        told,
        lock,
        async marker(ws) {
            const text = `marker ${++marks}`;
            const arrived = new Promise<void>((done) => seen.set(text, done));
            ws.send(text);
            await arrived;
        },
    };
    closers.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        for (const ws of sockets.clients) ws.terminate();
        await new Promise<void>((done) => upstream.close(() => done()));
    });
    return made;
}

async function socket(r: Rig): Promise<WebSocket> {
    const ws = new WebSocket(`ws://${r.origin}/api/ws`);
    await new Promise<void>((done, fail) => {
        ws.once("open", () => done());
        ws.once("error", fail);
    });
    closers.push(async () => ws.terminate());
    return ws;
}

/** A control frame may come between the pieces of a message; its answer shows the pieces before it have been judged. */
function pong(ws: WebSocket): Promise<void> {
    return new Promise((done) => {
        ws.once("pong", () => done());
        ws.ping();
    });
}

const key = (ws: WebSocket, code = "KeyA"): void => ws.send(JSON.stringify({ event_type: "key", event: { key: code, state: true } }));

function post(r: Rig, path: string): Promise<number> {
    return new Promise((done, fail) => {
        const req = httpRequest({ host: "127.0.0.1", port: Number(r.origin.split(":")[1]), path, method: "POST" }, (res) => {
            res.resume();
            done(res.statusCode ?? 0);
        });
        req.on("error", fail);
        req.end();
    });
}

describe("the input lock at the kvmd proxy", () => {
    it("unlocked, a key reaches the Pi and is told as input", async () => {
        const r = await rig();
        const ws = await socket(r);
        key(ws);
        await r.marker(ws);
        assert.equal(r.pi.frames.filter((f) => f.includes("KeyA")).length, 1);
        assert.deepEqual(r.told, ["key"]);
    });

    it("locked, input on the socket is dropped and told to nobody, while a heartbeat still passes and the socket stays open", async () => {
        const r = await rig();
        const ws = await socket(r);
        r.lock.on = true;
        key(ws, "KeyB");
        ws.send(JSON.stringify({ event_type: "mouse_move", event: { to: { x: 1, y: 1 } } }));
        ws.send(Buffer.from([1, 1, 4]));
        ws.send("ping");
        await r.marker(ws);
        assert.deepEqual(r.pi.frames.filter((f) => f !== "ping" && !f.startsWith("marker")), [], "no input reached the Pi");
        assert.ok(r.pi.frames.includes("ping"), "the heartbeat did");
        assert.deepEqual(r.told, []);
        assert.equal(ws.readyState, WebSocket.OPEN);
    });

    it("the lock beginning part-way through: what came before reached the Pi, what comes after does not, and the next unlock works again", async () => {
        const r = await rig();
        const ws = await socket(r);
        // Each is judged when it arrives, so the lock is only changed once the one before has been through.
        key(ws, "KeyBefore");
        await r.marker(ws);
        r.lock.on = true;
        key(ws, "KeyDuring");
        await r.marker(ws);
        r.lock.on = false;
        key(ws, "KeyAfter");
        await r.marker(ws);
        const keys = r.pi.frames.filter((f) => f.includes("Key"));
        assert.deepEqual(keys.map((f) => (JSON.parse(f) as { event: { key: string } }).event.key), ["KeyBefore", "KeyAfter"]);
    });

    it("a message split over several frames is dropped whole while locked, and one that began unlocked goes through whole", async () => {
        const r = await rig();
        const ws = await socket(r);
        const whole = JSON.stringify({ event_type: "key", event: { key: "KeySplit", state: true } });
        r.lock.on = true;
        ws.send(whole.slice(0, 10), { fin: false });
        ws.send(whole.slice(10), { fin: true });
        await r.marker(ws);
        assert.equal(r.pi.frames.filter((f) => f.includes("KeySplit")).length, 0);

        r.lock.on = false;
        ws.send(whole.slice(0, 10), { fin: false });
        await pong(ws);
        r.lock.on = true;
        ws.send(whole.slice(10), { fin: true });
        await r.marker(ws);
        assert.equal(r.pi.frames.filter((f) => f.includes("KeySplit")).length, 1, "sent whole: the lock is read once, at the first frame");
    });

    it("locked, the HTTP input routes answer 423 and nothing reaches the Pi; other routes are untouched", async () => {
        const r = await rig();
        r.lock.on = true;
        assert.equal(await post(r, "/api/hid/events/send_key?key=KeyA&state=1"), 423);
        assert.equal(await post(r, "/api/hid/print"), 423);
        assert.deepEqual(r.pi.requests, []);
        assert.deepEqual(r.told, []);
        assert.equal(await post(r, "/api/atx/click?button=power"), 200);
        assert.deepEqual(r.pi.requests, ["POST /api/atx/click?button=power"]);
    });

    it("an HTTP input that arrived before the lock but found the target after it is refused", async () => {
        const r = await rig();
        // A target that is slow to find: the lock begins while the request waits for it.
        const slow = Promise.withResolvers<void>();
        const proxy = createPiKvmProxy({
            control: {
                proxyTarget: async () => {
                    await slow.promise;
                    return { origin: new URL(`http://${r.origin}`), headers: {}, rejectUnauthorized: false };
                },
            } as unknown as PiKvmControl,
            inputLocked: () => r.lock.on,
        });
        const server = createServer((req, res) => void proxy.handleHttp(req, res));
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        closers.push(async () => {
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
        });
        const port = (server.address() as AddressInfo).port;
        const answer = new Promise<number>((done, fail) => {
            const req = httpRequest({ host: "127.0.0.1", port, path: "/api/hid/events/send_key?key=KeyA&state=1", method: "POST" }, (res) => {
                res.resume();
                done(res.statusCode ?? 0);
            });
            req.on("error", fail);
            req.end();
        });
        r.lock.on = true;
        slow.resolve();
        assert.equal(await answer, 423);
        assert.deepEqual(r.pi.requests, []);
    });
});
