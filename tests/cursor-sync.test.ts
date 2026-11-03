/**
 * The shared cursor over real sockets: pages' input sockets through the kvmd proxy, the hub, and the server-sent
 * stream every page reads. The Pi is a plain WebSocket server that records what reaches it.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, get as httpGet, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { CURSOR_PATH, type CursorUpdate } from "@pikvm/contracts/api";
import type { PiKvmControl } from "../src/pikvm-control";
import { createCursorHub, type CursorHub, type MouseMode } from "../src/server/cursor/hub";
import { createCursorRoutes } from "../src/server/cursor/routes";
import { createPiKvmProxy } from "../src/server/proxy/kvmd";

interface Host {
    readonly hub: CursorHub;
    readonly origin: string;
    readonly pi: { urls: string[]; frames: string[]; mode: MouseMode };
    close(): Promise<void>;
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
    for (const thing of open.splice(0).reverse()) await thing.close();
});

/** The host as the server wires it: the proxy reports into the hub, the route reads from it. */
async function host(mode: MouseMode = "absolute"): Promise<Host> {
    const pi = { urls: [] as string[], frames: [] as string[], mode };
    const upstream = createServer();
    const piSockets = new WebSocketServer({ server: upstream });
    piSockets.on("connection", (ws, req) => {
        pi.urls.push(req.url ?? "");
        ws.on("message", (data, binary) => pi.frames.push(binary ? `binary ${(data as Buffer).length}` : String(data)));
    });
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const hub = createCursorHub({ mode: () => pi.mode, resolution: () => ({ width: 1920, height: 1080 }) });
    const proxy = createPiKvmProxy({
        control: { proxyTarget: async () => ({ origin: new URL(upstreamUrl), headers: {}, rejectUnauthorized: false }) } as unknown as PiKvmControl,
        onHidMouseMove: (x, y, source) => hub.absolute(source, x, y),
        onHidMouseRelative: (dx, dy, source) => hub.relative(source, dx, dy),
    });
    const routes = createCursorRoutes(hub, 60_000);
    const server: Server = createServer((req, res) => {
        const path = (req.url ?? "").split("?", 1)[0] ?? "";
        if (routes.handles(path)) routes.handle(req, res);
        else void proxy.handleHttp(req, res);
    });
    server.on("upgrade", (req, socket, head) => void proxy.handleUpgrade(req, socket, head));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const made: Host = {
        hub,
        pi,
        origin: `127.0.0.1:${(server.address() as AddressInfo).port}`,
        async close() {
            hub.dispose();
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
            for (const ws of piSockets.clients) ws.terminate();
            await new Promise<void>((done) => upstream.close(() => done()));
        },
    };
    open.push(made);
    return made;
}

/** A page's input socket, named or not. */
async function page(h: Host, client?: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://${h.origin}/api/ws${client ? `?client=${client}` : ""}`);
    open.push({
        async close() {
            ws.terminate();
        },
    });
    await new Promise<void>((done, fail) => {
        ws.once("open", () => done());
        ws.once("error", fail);
    });
    return ws;
}

const move = (ws: WebSocket, x: number, y: number): void => ws.send(JSON.stringify({ event_type: "mouse_move", event: { to: { x, y } } }));
const nudge = (ws: WebSocket, dx: number, dy: number): void =>
    ws.send(JSON.stringify({ event_type: "mouse_relative", event: { delta: { x: dx, y: dy }, squash: true } }));

interface Reader {
    readonly seen: CursorUpdate[];
    /** The raw stream, comments included. */
    readonly raw: () => string;
    until(check: (seen: CursorUpdate[]) => boolean, what: string): Promise<void>;
    close(): void;
}

/** A page's cursor stream. */
async function listen(h: Host): Promise<Reader> {
    let text = "";
    const seen: CursorUpdate[] = [];
    const bell = new EventEmitter();
    const req = await new Promise<IncomingMessage>((done, fail) => {
        const r = httpGet({ host: "127.0.0.1", port: Number(h.origin.split(":")[1]), path: CURSOR_PATH }, done);
        r.on("error", fail);
    });
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
        text += chunk;
        for (const block of text.split("\n\n")) {
            if (block.startsWith("data: ")) {
                const update = JSON.parse(block.slice(6)) as CursorUpdate;
                if (!seen.some((u) => u.seq === update.seq)) seen.push(update);
            }
        }
        bell.emit("data");
    });
    req.on("error", () => undefined);
    const reader: Reader = {
        seen,
        raw: () => text,
        until(check, what) {
            return new Promise<void>((done, fail) => {
                const timer = setTimeout(() => fail(new Error(`timed out waiting for ${what}; saw ${JSON.stringify(seen)}`)), 3000);
                const test = (): void => {
                    if (!check(seen)) return;
                    clearTimeout(timer);
                    bell.off("data", test);
                    done();
                };
                bell.on("data", test);
                test();
            });
        },
        close: () => req.destroy(),
    };
    open.push({ async close() { reader.close(); } });
    return reader;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe("a page's moves reach every page", () => {
    it("moves from one page reach another page's stream, under the first page's name", async () => {
        const h = await host();
        const desk = await page(h, "desk-1");
        const phone = await listen(h);
        move(desk, 1200, -3400);
        await phone.until((s) => s.length === 1, "the move");
        assert.deepEqual(phone.seen[0], { x: 1200, y: -3400, source: "desk-1", seq: 1 });
    });

    it("the name is taken off the URL kvmd gets, and every frame still reaches the Pi untouched", async () => {
        const h = await host();
        const a = await page(h, "desk-1");
        const b = await new Promise<WebSocket>((done, fail) => {
            const ws = new WebSocket(`ws://${h.origin}/api/ws?stream=0&client=phone-2`);
            open.push({ async close() { ws.terminate(); } });
            ws.once("open", () => done(ws));
            ws.once("error", fail);
        });
        move(a, 1, 2);
        move(b, 3, 4);
        await pause(100);
        assert.deepEqual(h.pi.urls.sort(), ["/api/ws", "/api/ws?stream=0"]);
        const sentX = h.pi.frames.map((f) => {
            const frame: { event: { to: { x: number } } } = JSON.parse(f);
            return frame.event.to.x;
        });
        assert.deepEqual(sentX.sort(), [1, 3]);
    });

    it("a page sees its own moves come back under its own name, to be ignored by it", async () => {
        const h = await host();
        const me = await page(h, "me");
        const mine = await listen(h);
        move(me, 10, 20);
        await mine.until((s) => s.length === 1, "the echo");
        assert.equal(mine.seen[0]?.source, "me");
    });

    it("a page that gave no name, or a bad one, is a client of its own each time", async () => {
        const h = await host();
        const a = await page(h);
        const b = await page(h, "has%20space");
        const phone = await listen(h);
        move(a, 1, 1);
        await phone.until((s) => s.length === 1, "the first");
        await pause(30);
        move(b, 2, 2);
        await phone.until((s) => s.length === 2, "the second");
        const [first, second] = phone.seen;
        assert.match(first!.source, /^socket-\d+$/);
        assert.match(second!.source, /^socket-\d+$/);
        assert.notEqual(first!.source, second!.source);
        assert.deepEqual(h.pi.urls, ["/api/ws", "/api/ws"]);
    });

    it("kvmd's own page, which sends binary frames, moves the cursor too", async () => {
        const h = await host();
        const kvmdPage = await page(h, "full-ui");
        const phone = await listen(h);
        kvmdPage.send(Buffer.from([3, 0x01, 0x00, 0xff, 0x00]));
        await phone.until((s) => s.length === 1, "the move");
        assert.deepEqual([phone.seen[0]?.x, phone.seen[0]?.y, phone.seen[0]?.source], [256, -256, "full-ui"]);
        assert.deepEqual(h.pi.frames, ["binary 5"]);
    });

    it("many pages and many streams: each stream sees each position once, in order, and the last is the last move", async () => {
        const h = await host();
        const writers = await Promise.all(Array.from({ length: 5 }, (_, i) => page(h, `w${i}`)));
        const readers = await Promise.all(Array.from({ length: 40 }, () => listen(h)));
        for (let step = 1; step <= 30; step += 1) {
            for (const [i, ws] of writers.entries()) move(ws, step * 100 + i, -step * 100 - i);
            await pause(3);
        }
        const last = { x: 3004, y: -3004, source: "w4" };
        for (const reader of readers) {
            await reader.until((s) => s.at(-1)?.x === last.x, "the final position");
            assert.deepEqual([reader.seen.at(-1)?.x, reader.seen.at(-1)?.y, reader.seen.at(-1)?.source], [last.x, last.y, last.source]);
            const seqs = reader.seen.map((u) => u.seq);
            assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
            assert.equal(new Set(seqs).size, seqs.length);
        }
    });

    it("two pages writing at once leave one answer for everybody: the last write", async () => {
        const h = await host();
        const a = await page(h, "a");
        const b = await page(h, "b");
        const watcher = await listen(h);
        for (let i = 0; i < 50; i += 1) {
            move(a, i, i);
            move(b, -i, -i);
        }
        await pause(150);
        const final = h.hub.current()!;
        assert.equal(watcher.seen.at(-1)?.seq, final.seq);
        assert.deepEqual(watcher.seen.at(-1), final);
        assert.equal(final.source, "b");
    });
});

describe("a page that comes in later, or again", () => {
    it("is told the current position first", async () => {
        const h = await host();
        const desk = await page(h, "desk");
        move(desk, 700, 800);
        await pause(50);
        const reload = await listen(h);
        await reload.until((s) => s.length === 1, "the current position");
        assert.deepEqual(reload.seen[0], { x: 700, y: 800, source: "desk", seq: 1 });
    });

    it("hears nothing but a comment while the position is not known, and is told when it is", async () => {
        const h = await host();
        const early = await listen(h);
        await pause(50);
        assert.equal(early.seen.length, 0);
        assert.match(early.raw(), /^: cursor/);
        move(await page(h, "desk"), 5, 6);
        await early.until((s) => s.length === 1, "the first position");
    });

    it("gets the newest position after a reconnect, not the ones it missed", async () => {
        const h = await host();
        const desk = await page(h, "desk");
        const first = await listen(h);
        move(desk, 1, 1);
        await first.until((s) => s.length === 1, "the first");
        first.close();
        for (let i = 2; i <= 20; i += 1) {
            move(desk, i, i);
            await pause(2);
        }
        await pause(50);
        const again = await listen(h);
        await again.until((s) => s.length === 1, "the current");
        assert.equal(again.seen[0]?.x, 20);
    });

    it("a stream that closed is not written to again", async () => {
        const h = await host();
        const desk = await page(h, "desk");
        const gone = await listen(h);
        const stays = await listen(h);
        move(desk, 1, 1);
        await gone.until((s) => s.length === 1, "the first");
        gone.close();
        await pause(30);
        move(desk, 2, 2);
        await stays.until((s) => s.length === 2, "the second");
        assert.equal(gone.seen.length, 1);
    });
});

describe("relative moves", () => {
    it("tell nobody while no position is known; the first absolute move starts it; then relative moves follow", async () => {
        const h = await host("relative");
        const phone = await page(h, "phone");
        const watcher = await listen(h);
        nudge(phone, 50, 50);
        await pause(60);
        assert.equal(watcher.seen.length, 0);
        // An absolute move is dropped by a relative Pi, so the agent's account is what starts it here.
        h.hub.place("agent", 0, 0);
        await watcher.until((s) => s.length === 1, "the agent's position");
        nudge(phone, 1919 / 2, 0);
        await watcher.until((s) => s.length === 2, "the nudge");
        assert.ok(Math.abs((watcher.seen[1]?.x ?? 0) - 32767) <= 1);
        assert.equal(watcher.seen[1]?.source, "phone");
    });

    it("are read from kvmd's binary frame, squashed pairs and all", async () => {
        const h = await host("absolute");
        const page1 = await page(h, "p");
        const watcher = await listen(h);
        move(page1, 0, 0);
        await watcher.until((s) => s.length === 1, "the start");
        h.pi.mode = "relative";
        page1.send(Buffer.from([4, 1, 60, 0, 60, 0]));
        await watcher.until((s) => s.length === 2, "the nudge");
        const expected = Math.round((120 / 1919) * 65534);
        assert.ok(Math.abs((watcher.seen[1]?.x ?? 0) - expected) <= 1, `${watcher.seen[1]?.x} vs ${expected}`);
    });
});

describe("the stream", () => {
    it("refuses anything but a GET", async () => {
        const h = await host();
        const status = await new Promise<number>((done, fail) => {
            const r = httpGet({ host: "127.0.0.1", port: Number(h.origin.split(":")[1]), path: CURSOR_PATH, method: "POST" }, (res) => {
                res.resume();
                done(res.statusCode ?? 0);
            });
            r.on("error", fail);
            r.end();
        });
        assert.equal(status, 405);
    });
});

describe("a stream that reads slowly", () => {
    /** A response whose socket is full until the test drains it. */
    function stuck() {
        const res = Object.assign(new EventEmitter(), {
            writableNeedDrain: false,
            written: [] as string[],
            writeHead: () => res,
            write(chunk: string) {
                res.written.push(chunk);
                return true;
            },
        });
        const req = Object.assign(new EventEmitter(), { method: "GET" });
        return { req, res };
    }

    it("is not queued behind: while it is full only the newest position waits, and it is sent when the socket drains", () => {
        let now = 0;
        const hub = createCursorHub({
            mode: () => "absolute",
            resolution: () => undefined,
            clock: { now: () => now, setTimeout: () => () => undefined },
            frameMs: 0,
        });
        const routes = createCursorRoutes(hub, 60_000);
        const { req, res } = stuck();
        routes.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        res.writableNeedDrain = true;
        for (let i = 1; i <= 500; i += 1) {
            now += 1;
            hub.absolute("a", i, i);
        }
        assert.deepEqual(res.written, [": cursor\n\n"], "nothing is written into a full socket");
        res.writableNeedDrain = false;
        res.emit("drain");
        assert.equal(res.written.length, 2);
        assert.deepEqual(JSON.parse(res.written[1]!.slice(6)), { x: 500, y: 500, source: "a", seq: 500 });
        res.emit("drain");
        assert.equal(res.written.length, 2, "and only once");
        req.emit("close");
        hub.absolute("a", 9, 9);
        assert.equal(res.written.length, 2, "nothing after the page left");
    });

    it("a keep-alive does not take the place of the position that is waiting", () => {
        const hub = createCursorHub({ mode: () => "absolute", resolution: () => undefined, frameMs: 0 });
        const routes = createCursorRoutes(hub, 5);
        const { req, res } = stuck();
        routes.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        res.writableNeedDrain = true;
        hub.absolute("a", 3, 3);
        const { promise, resolve } = Promise.withResolvers<void>();
        // A real interval is what is under test: the keep-alive fires on its own timer while the socket is full.
        setTimeout(() => {
            res.writableNeedDrain = false;
            res.emit("drain");
            assert.match(res.written.at(-1) ?? "", /^data: .*"x":3/);
            req.emit("close");
            resolve();
        }, 30);
        return promise;
    });
});
