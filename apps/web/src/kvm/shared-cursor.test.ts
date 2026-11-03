// The shared cursor on this page: the stream it reads, and the picture that draws it. Failure modes K30-K37 in FAILURE_MODES.md.

import { createManualClock } from "@pikvm/kvm-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCursorSync, newClientId, type CursorEvent, type StreamSource } from "./cursor-sync";
import { createFieldFocus } from "./field-focus";
import { createPictureController, type PictureController } from "./picture-controller";
import { createKvmSession } from "./session";
import { openRig } from "./test-support";

/** A stream the test feeds by hand. */
class FakeStream implements StreamSource {
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    closed = false;
    close(): void {
        this.closed = true;
    }
    send(update: { x: number; y: number; source: string; seq: number } | string): void {
        this.onmessage?.(new MessageEvent("message", { data: typeof update === "string" ? update : JSON.stringify(update) }));
    }
}

function streams() {
    const opened: FakeStream[] = [];
    const urls: string[] = [];
    return {
        opened,
        urls,
        open: (url: string): StreamSource => {
            urls.push(url);
            const s = new FakeStream();
            opened.push(s);
            return s;
        },
        get live(): FakeStream {
            const s = opened.at(-1);
            if (!s) throw new Error("no stream was opened");
            return s;
        },
    };
}

/** A document that can be hidden and shown. */
function fakeDocument() {
    const listeners = new Set<() => void>();
    const doc = {
        hidden: false,
        addEventListener: (_: "visibilitychange", l: () => void) => void listeners.add(l),
        removeEventListener: (_: "visibilitychange", l: () => void) => void listeners.delete(l),
    };
    return {
        doc,
        setHidden(value: boolean) {
            doc.hidden = value;
            for (const l of [...listeners]) l();
        },
        listeners,
    };
}

describe("K30: the stream", () => {
    it("names this page, and says which updates are its own", () => {
        const s = streams();
        const sync = createCursorSync({ clientId: "me", open: s.open });
        const heard: CursorEvent[] = [];
        sync.subscribe((e) => heard.push(e));
        sync.start();
        s.live.send({ x: 1, y: 2, source: "me", seq: 1 });
        s.live.send({ x: 3, y: 4, source: "phone", seq: 2 });
        expect(heard.map((e) => [e.x, e.y, e.own])).toEqual([
            [1, 2, true],
            [3, 4, false],
        ]);
        expect(s.urls).toEqual(["/app/api/v1/cursor"]);
    });

    it("K31: each update is heard once and in order: a repeat or a straggler is not news", () => {
        const s = streams();
        const sync = createCursorSync({ clientId: "me", open: s.open });
        const heard: number[] = [];
        sync.subscribe((e) => heard.push(e.seq));
        sync.start();
        for (const seq of [1, 2, 2, 5, 3, 4, 6]) s.live.send({ x: seq, y: 0, source: "a", seq });
        expect(heard).toEqual([1, 2, 5, 6]);
    });

    it("K31: a message that is not an update is ignored, and the ones after it still arrive", () => {
        const s = streams();
        const sync = createCursorSync({ clientId: "me", open: s.open });
        const heard: number[] = [];
        sync.subscribe((e) => heard.push(e.seq));
        sync.start();
        for (const junk of ["", "null", "{", '{"x":"1","y":2,"source":"a","seq":1}', '{"x":1,"y":2}', "[]"]) s.live.send(junk);
        s.live.send({ x: 1, y: 1, source: "a", seq: 1 });
        expect(heard).toEqual([1]);
    });

    it("K32: a host that restarted counts from the start again: after an error the next sequence number is taken whatever it is", () => {
        const s = streams();
        const sync = createCursorSync({ clientId: "me", open: s.open });
        const heard: number[] = [];
        sync.subscribe((e) => heard.push(e.seq));
        sync.start();
        s.live.send({ x: 0, y: 0, source: "a", seq: 500 });
        s.live.send({ x: 0, y: 0, source: "a", seq: 1 });
        expect(heard).toEqual([500]);
        s.live.onerror?.(new Event("error"));
        s.live.send({ x: 7, y: 7, source: "a", seq: 1 });
        expect(heard).toEqual([500, 1]);
    });

    it("K33: a listener that comes late is told the newest position at once", () => {
        const s = streams();
        const sync = createCursorSync({ clientId: "me", open: s.open });
        sync.start();
        s.live.send({ x: 1, y: 1, source: "a", seq: 1 });
        s.live.send({ x: 9, y: 9, source: "a", seq: 2 });
        const heard: number[] = [];
        sync.subscribe((e) => heard.push(e.x));
        expect(heard).toEqual([9]);
        expect(sync.latest()?.x).toBe(9);
    });

    it("K33: a listener that left hears nothing more, and one leaving while it is told does not stop the rest", () => {
        const s = streams();
        const sync = createCursorSync({ clientId: "me", open: s.open });
        sync.start();
        const a: number[] = [];
        const b: number[] = [];
        let offA = (): void => undefined;
        offA = sync.subscribe((e) => {
            a.push(e.x);
            offA();
        });
        sync.subscribe((e) => b.push(e.x));
        s.live.send({ x: 1, y: 1, source: "x", seq: 1 });
        s.live.send({ x: 2, y: 2, source: "x", seq: 2 });
        expect(a).toEqual([1]);
        expect(b).toEqual([1, 2]);
    });

    it("K34: a page that is hidden holds no stream, and takes a fresh one, with the current position, when it is shown", () => {
        const s = streams();
        const d = fakeDocument();
        const sync = createCursorSync({ clientId: "me", open: s.open, document: d.doc });
        sync.start();
        const first = s.live;
        d.setHidden(true);
        expect(first.closed).toBe(true);
        first.send({ x: 5, y: 5, source: "a", seq: 9 });
        expect(sync.latest()).toBeNull();
        d.setHidden(false);
        expect(s.opened).toHaveLength(2);
        expect(s.live).not.toBe(first);
        s.live.send({ x: 6, y: 6, source: "a", seq: 3 });
        expect(sync.latest()?.x).toBe(6);
    });

    it("K34: a page that starts hidden opens nothing until it is shown", () => {
        const s = streams();
        const d = fakeDocument();
        d.doc.hidden = true;
        const sync = createCursorSync({ open: s.open, document: d.doc });
        sync.start();
        expect(s.opened).toHaveLength(0);
        d.setHidden(false);
        expect(s.opened).toHaveLength(1);
    });

    it("stopping closes the stream and the page's listener, and starting twice opens one stream", () => {
        const s = streams();
        const d = fakeDocument();
        const sync = createCursorSync({ open: s.open, document: d.doc });
        sync.start();
        sync.start();
        expect(s.opened).toHaveLength(1);
        expect(d.listeners.size).toBe(1);
        sync.stop();
        expect(s.live.closed).toBe(true);
        expect(d.listeners.size).toBe(0);
        d.setHidden(false);
        expect(s.opened).toHaveLength(1);
    });

    it("where there is no EventSource it does nothing", () => {
        const sync = createCursorSync({ document: fakeDocument().doc });
        sync.start();
        expect(sync.latest()).toBeNull();
        expect(() => sync.stop()).not.toThrow();
    });

    it("names pages with plain, different ids", () => {
        const ids = new Set(Array.from({ length: 200 }, () => newClientId()));
        expect(ids.size).toBe(200);
        for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    });
});

describe("K35: the session names its input socket", () => {
    it("the event socket's URL carries the id that this page's own updates come back under", async () => {
        const urls: string[] = [];
        const clock = createManualClock(0);
        const session = createKvmSession({
            clock,
            cursor: createCursorSync({ clientId: "pg-test", open: streams().open }),
            bindLifecycle: false,
            http: { request: async () => ({ status: 404, body: Buffer.alloc(0), headers: {} }) } as never,
            socket: (url) => {
                urls.push(url);
                return { isOpen: () => false, send: () => undefined, close: () => undefined };
            },
        });
        session.start();
        await clock.settle();
        expect(urls).toHaveLength(1);
        expect(new URL(urls[0] ?? "").searchParams.get("client")).toBe("pg-test");
        expect(session.cursor.clientId).toBe("pg-test");
        await session.stop();
    });
});

// ---- the picture ------------------------------------------------------------------------------------------------------

const made: PictureController[] = [];
afterEach(() => {
    for (const c of made.splice(0)) c.dispose();
    vi.unstubAllGlobals();
});

async function mount(init: { coarse?: boolean; known?: { x: number; y: number; source: string; seq: number } } = {}) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: init.coarse ?? true, addEventListener: () => undefined, removeEventListener: () => undefined })),
    );
    const s = streams();
    const sync = createCursorSync({ clientId: "me", open: s.open });
    sync.start();
    if (init.known) s.live.send(init.known);
    const rig = await openRig({ cursor: sync });
    const pane = document.createElement("div");
    const img = document.createElement("img");
    const video = document.createElement("video");
    const freeze = document.createElement("canvas");
    const cursor = document.createElement("div");
    const remote = document.createElement("div");
    const lens = document.createElement("canvas");
    pane.append(img, video, freeze, cursor, remote, lens);
    document.body.appendChild(pane);
    const controller = createPictureController({
        session: rig.session,
        elements: { pane, img, video, freeze, cursor, remote, lens },
        focus: createFieldFocus(rig.clock),
        desktop: !(init.coarse ?? true),
        prefs: { active: true, touchMode: "trackpad", touchHid: "abs", dragLock: false, modalOpen: false, windowFocused: true, watching: false },
    });
    made.push(controller);
    // A real pane has a size; jsdom has none.
    controller.pointer.send({ type: "env", env: { pane: { left: 0, top: 0, width: 800, height: 450 }, nat: { w: 1600, h: 900 } } });
    return { rig, controller, cursor, remote, send: (x: number, y: number, source: string, seq: number) => s.live.send({ x, y, source, seq }) };
}

describe("K36: the picture follows the shared cursor", () => {
    it("the trackpad's blob moves to where another client put the pointer, and no second pointer is drawn", async () => {
        const { controller, cursor, remote, send } = await mount();
        send(0, 0, "desk", 1);
        expect(controller.pointer.machine.virtualCursor).toEqual({ x: 0, y: 0 });
        send(-16384, 16384, "desk", 2); // a quarter of the way across, three quarters down
        expect(cursor.style.display).toBe("block");
        expect(parseFloat(cursor.style.left)).toBeCloseTo(200, 0);
        expect(parseFloat(cursor.style.top)).toBeCloseTo(337.5, 0);
        expect(remote.style.display).not.toBe("block");
    });

    it("the same point of the picture survives a resize", async () => {
        const { controller, cursor, send } = await mount();
        send(-16384, 16384, "desk", 1);
        controller.pointer.send({ type: "env", env: { pane: { left: 0, top: 0, width: 400, height: 225 } } });
        expect(parseFloat(cursor.style.left)).toBeCloseTo(100, 0);
        expect(parseFloat(cursor.style.top)).toBeCloseTo(168.75, 0);
    });

    it("without a trackpad blob (a mouse), another client's pointer is drawn as theirs, and leaves when this client moves", async () => {
        const { controller, cursor, remote, send } = await mount({ coarse: false });
        send(-16384, -16384, "phone", 1);
        expect(remote.style.display).toBe("block");
        expect(parseFloat(remote.style.left)).toBeCloseTo(200, 0);
        expect(parseFloat(remote.style.top)).toBeCloseTo(112.5, 0);
        expect(cursor.style.display).not.toBe("block");
        controller.pointer.send({ type: "move", id: 1, kind: "mouse", x: 300, y: 200, buttons: 0 });
        expect(remote.style.display).toBe("none");
    });

    it("K37: this page's own moves come back and change nothing, whoever else moved in between", async () => {
        const { controller, send } = await mount();
        send(100, 100, "desk", 1);
        send(5000, 5000, "me", 2);
        expect(controller.pointer.machine.virtualCursor).toEqual({ x: 100, y: 100 });
    });

    it("K37: while a finger is down on this page the other client's moves wait, and none of it is ever sent to the target", async () => {
        const { rig, controller, send } = await mount();
        const before = rig.sent().length;
        controller.pointer.send({ type: "down", id: 1, kind: "touch", x: 400, y: 225, button: 0 });
        send(20000, 20000, "desk", 1);
        expect(controller.pointer.machine.virtualCursor).toEqual({ x: 0, y: 0 });
        controller.pointer.send({ type: "up", id: 1, kind: "touch", button: 0 });
        rig.clock.advance(2000);
        expect(controller.pointer.machine.virtualCursor).toEqual({ x: 20000, y: 20000 });
        expect(rig.sent().slice(before).filter((l) => l.includes("mouse_move"))).toEqual([]);
    });

    it("a page that opens with the host's position already known draws it at once", async () => {
        const { controller, cursor } = await mount({ known: { x: -16384, y: 16384, source: "desk", seq: 4 } });
        expect(controller.pointer.machine.virtualCursor).toEqual({ x: -16384, y: 16384 });
        expect(cursor.style.display).toBe("block");
    });
});
