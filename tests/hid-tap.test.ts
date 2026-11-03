import assert from "node:assert/strict";
import test from "node:test";
import { clientOf, makeHidTap, type HidInputKind } from "../src/server/proxy/kvmd";

/** One client-to-server WebSocket frame, masked as a browser masks it. */
function frame(payload: string | Buffer, opcode = 0x1): Buffer {
    const body = typeof payload === "string" ? Buffer.from(payload) : payload;
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    const masked = Buffer.from(body.map((byte, i) => byte ^ mask[i & 3]!));
    const head =
        body.length < 126
            ? Buffer.from([0x80 | opcode, 0x80 | body.length])
            : Buffer.from([0x80 | opcode, 0x80 | 126, body.length >> 8, body.length & 0xff]);
    return Buffer.concat([head, mask, masked]);
}

const json = (event_type: string, event: unknown = {}) => frame(JSON.stringify({ event_type, event }));

function tap() {
    const seen = { activity: 0, input: [] as HidInputKind[], moves: [] as [number, number][] };
    const feed = makeHidTap({
        onActivity: () => void seen.activity++,
        onInput: (kind) => void seen.input.push(kind),
        onMouseMove: (x, y) => void seen.moves.push([x, y]),
    });
    return { seen, feed };
}

test("every kind of HID event is input, and its kind is named", () => {
    const { seen, feed } = tap();
    feed(json("key", { key: "KeyA", state: true }));
    feed(json("mouse_move", { to: { x: 5, y: -7 } }));
    feed(json("mouse_button", { button: "left", state: true }));
    feed(json("mouse_wheel", { delta: { x: 0, y: 1 } }));
    feed(json("mouse_relative", { delta: { x: 1, y: 1 }, squash: true }));
    assert.deepEqual(seen.input, ["key", "mouse_move", "mouse_button", "mouse_wheel", "mouse_relative"]);
    assert.deepEqual(seen.moves, [[5, -7]]);
});

test("a heartbeat is activity, as before, but never input", () => {
    const { seen, feed } = tap();
    feed(json("ping"));
    feed(frame("ping"));
    feed(frame(Buffer.from([0]), 0x2));
    feed(frame("not json at all"));
    feed(json("something_new"));
    assert.deepEqual(seen.input, []);
    assert.equal(seen.activity, 5);
});

test("control frames carry no input and no activity", () => {
    const { seen, feed } = tap();
    feed(frame(Buffer.alloc(0), 0x9)); // ping
    feed(frame(Buffer.alloc(0), 0xa)); // pong
    feed(frame(Buffer.from([0x03, 0xe8]), 0x8)); // close
    assert.deepEqual(seen, { activity: 0, input: [], moves: [] });
});

test("kvmd's binary frames are classified by their first byte", () => {
    const { seen, feed } = tap();
    for (const type of [1, 2, 3, 4, 5, 0, 9]) feed(frame(Buffer.from([type, 0, 0]), 0x2));
    assert.deepEqual(seen.input, ["key", "mouse_button", "mouse_move", "mouse_relative", "mouse_wheel"]);
});

test("frames split across chunks, and several in one chunk, are each seen once", () => {
    const { seen, feed } = tap();
    const a = json("key", { key: "KeyA", state: true });
    const b = json("mouse_button", { button: "left", state: false });
    const both = Buffer.concat([a, b]);
    feed(both.subarray(0, 5));
    assert.deepEqual(seen.input, []);
    feed(both.subarray(5, a.length + 3));
    assert.deepEqual(seen.input, ["key"]);
    feed(both.subarray(a.length + 3));
    assert.deepEqual(seen.input, ["key", "mouse_button"]);
    feed(Buffer.concat([a, b, a]));
    assert.deepEqual(seen.input, ["key", "mouse_button", "key", "mouse_button", "key"]);
});

test("garbage never throws into the socket pipeline", () => {
    const { seen, feed } = tap();
    assert.doesNotThrow(() => feed(Buffer.from([0x81, 0xff, 0xff, 0xff])));
    assert.doesNotThrow(() => feed(Buffer.alloc(3, 0xff)));
    assert.deepEqual(seen.input, []);
});

test("a tap with only the old callbacks still works", () => {
    let moves = 0;
    const feed = makeHidTap({ onActivity: () => undefined, onMouseMove: () => void moves++ });
    feed(json("mouse_move", { to: { x: 1, y: 2 } }));
    feed(json("key", { key: "KeyA", state: true }));
    assert.equal(moves, 1);
});

test("a relative move is read as its delta, from text and from kvmd's binary frame", () => {
    const seen: [number, number][] = [];
    const feed = makeHidTap({ onActivity: () => undefined, onMouseRelative: (dx, dy) => void seen.push([dx, dy]) });
    feed(json("mouse_relative", { delta: { x: 3, y: -4 }, squash: true }));
    feed(frame(Buffer.from([4, 1, 5, 0xfb]), 0x2)); // squash, then (5, -5)
    feed(frame(Buffer.from([4, 0, 1, 2, 3, 0xfe]), 0x2)); // two pairs add up: (4, 0)
    assert.deepEqual(seen, [
        [3, -4],
        [5, -5],
        [4, 0],
    ]);
});

test("an absolute move is read from kvmd's binary frame too: signed 16-bit, big-endian", () => {
    const { seen, feed } = tap();
    feed(frame(Buffer.from([3, 0x7f, 0xff, 0x80, 0x00]), 0x2));
    feed(frame(Buffer.from([3, 0x00, 0x0a, 0xff, 0xf6]), 0x2));
    assert.deepEqual(seen.moves, [
        [32767, -32768],
        [10, -10],
    ]);
    assert.deepEqual(seen.input, ["mouse_move", "mouse_move"]);
});

test("a binary mouse frame of any other length is input but never a position", () => {
    const moves: unknown[] = [];
    const feed = makeHidTap({
        onActivity: () => undefined,
        onMouseMove: (x, y) => void moves.push([x, y]),
        onMouseRelative: (dx, dy) => void moves.push([dx, dy]),
    });
    feed(frame(Buffer.from([3, 1, 2, 3]), 0x2));
    feed(frame(Buffer.from([3, 1, 2, 3, 4, 5]), 0x2));
    feed(frame(Buffer.from([4, 0, 1]), 0x2));
    feed(frame(Buffer.from([4, 0, 1, 2, 3]), 0x2));
    assert.deepEqual(moves, []);
});

test("a moves-only tap reads moves without being given an input callback", () => {
    const moves: [number, number][] = [];
    const feed = makeHidTap({ onActivity: () => undefined, onMouseMove: (x, y) => void moves.push([x, y]) });
    feed(frame(Buffer.from([3, 0, 1, 0, 2]), 0x2));
    feed(json("mouse_move", { to: { x: 7, y: 8 } }));
    assert.deepEqual(moves, [
        [1, 2],
        [7, 8],
    ]);
});

test("the client a socket names is read from its URL and taken out of what kvmd is sent", () => {
    assert.deepEqual(clientOf("/api/ws?client=abc_123-X"), { path: "/api/ws", client: "abc_123-X" });
    assert.deepEqual(clientOf("/api/ws?stream=0&client=abc&x=1"), { path: "/api/ws?stream=0&x=1", client: "abc" });
    assert.deepEqual(clientOf("/api/ws"), { path: "/api/ws", client: null });
    assert.deepEqual(clientOf("/api/ws?stream=0"), { path: "/api/ws?stream=0", client: null });
});

test("a client name that is not a plain id is no name, and is still not sent on", () => {
    for (const bad of ["", "a b", "a/b", "x".repeat(65), "é", "<script>"]) {
        const url = `/api/ws?client=${encodeURIComponent(bad)}`;
        assert.deepEqual(clientOf(url), { path: "/api/ws", client: null }, bad);
    }
});
