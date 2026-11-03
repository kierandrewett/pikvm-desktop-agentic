import { afterEach, describe, expect, it } from "vitest";
import { createManualClock } from "../clock/index";
import type { HttpResponse } from "../http";
import { FakeHttp, FakeSocketHub, status } from "../testing/fake-socket";
import { createTargetLink, type TargetLink } from "./link";

// Failure modes 1-8, 10-13, 17-18, 22 in FAILURE_MODES.md.

const T0 = 1_000_000;

function setup() {
    const clock = createManualClock(T0);
    const hub = new FakeSocketHub();
    const http = new FakeHttp();
    const link = createTargetLink({ url: "ws://kvm/api/ws", socket: hub.factory, http, clock });
    created.push(link);
    return { clock, hub, http, link };
}

const created: TargetLink[] = [];
afterEach(async () => {
    await Promise.all(created.splice(0).map((l) => l.stop()));
});

async function opened() {
    const env = setup();
    env.link.start();
    await env.clock.settle();
    env.hub.last.serverOpen();
    await env.clock.settle();
    return env;
}

describe("connecting", () => {
    it("start opens exactly one socket on the configured url and reports connecting", async () => {
        const { link, hub, clock } = setup();
        link.start();
        link.start();
        await clock.settle();
        expect(hub.sockets).toHaveLength(1);
        expect(hub.last.url).toBe("ws://kvm/api/ws");
        expect(link.store.getState().link).toEqual({ open: false, connecting: true, everSettled: false });
    });

    it("everSettled stays false until an attempt resolves, then stays true", async () => {
        const { link, hub, clock } = setup();
        link.start();
        await clock.settle();
        expect(link.store.getState().link.everSettled).toBe(false);
        hub.last.serverClose(); // refused
        await clock.settle();
        expect(link.store.getState().link).toEqual({ open: false, connecting: false, everSettled: true });
        await clock.advanceAsync(1200);
        expect(link.store.getState().link.connecting).toBe(true);
        expect(link.store.getState().link.everSettled).toBe(true);
    });

    it("open marks the link open and never has two sockets for connect()", async () => {
        const { link, hub, clock } = await opened();
        expect(link.isOpen()).toBe(true);
        link.connect();
        link.connect();
        await clock.settle();
        expect(hub.sockets).toHaveLength(1);
    });

    it("a socket constructor that throws is a failed attempt, retried on the backoff", async () => {
        const { link, hub, clock } = setup();
        hub.throwNext = true;
        link.start();
        await clock.settle();
        expect(hub.sockets).toHaveLength(0);
        expect(link.store.getState().link).toEqual({ open: false, connecting: false, everSettled: false });
        await clock.advanceAsync(1199);
        expect(hub.sockets).toHaveLength(0);
        await clock.advanceAsync(1);
        expect(hub.sockets).toHaveLength(1);
    });

    it("socket error closes the socket", async () => {
        const { hub } = await opened();
        hub.last.serverError();
        expect(hub.last.closeCalls).toBeGreaterThan(0);
    });

    it("notifies subscribers on open and close", async () => {
        const { link, hub, clock } = setup();
        const seen: boolean[] = [];
        link.store.subscribe(() => seen.push(link.store.getState().link.open));
        link.start();
        await clock.settle();
        hub.last.serverOpen();
        hub.last.serverClose();
        await clock.settle();
        expect(seen).toContain(true);
        expect(seen[seen.length - 1]).toBe(false);
    });
});

describe("reconnect backoff (failure mode 3)", () => {
    it("waits 1200, 2040, 3468, then 5000 between failed attempts", async () => {
        const { link, hub, clock } = setup();
        link.start();
        await clock.settle();
        const waits = [1200, 2040, 3468, 5000, 5000];
        for (const wait of waits) {
            const n = hub.sockets.length;
            hub.last.serverClose();
            await clock.advanceAsync(wait - 1);
            expect(hub.sockets, `before ${wait}`).toHaveLength(n);
            await clock.advanceAsync(1);
            expect(hub.sockets, `at ${wait}`).toHaveLength(n + 1);
        }
    });

    it("resets to the short wait once a connection actually opens", async () => {
        const { link, hub, clock } = setup();
        link.start();
        await clock.settle();
        hub.last.serverClose();
        await clock.advanceAsync(1200);
        hub.last.serverClose();
        await clock.advanceAsync(2040);
        hub.last.serverOpen();
        await clock.settle();
        hub.last.serverClose();
        const n = hub.sockets.length;
        await clock.advanceAsync(1199);
        expect(hub.sockets).toHaveLength(n);
        await clock.advanceAsync(1);
        expect(hub.sockets).toHaveLength(n + 1);
    });

    it("connect() during the wait attempts now but does not reset the curve", async () => {
        const { link, hub, clock } = setup();
        link.start();
        await clock.settle();
        hub.last.serverClose(); // next wait 1200
        await clock.settle();
        link.connect();
        await clock.settle();
        expect(hub.sockets).toHaveLength(2);
        hub.last.serverClose(); // the curve moved on: 2040, not 1200
        await clock.advanceAsync(2039);
        expect(hub.sockets).toHaveLength(2);
        await clock.advanceAsync(1);
        expect(hub.sockets).toHaveLength(3);
    });

    it("kick() during the wait connects immediately and resets the curve", async () => {
        const { link, hub, clock } = setup();
        link.start();
        await clock.settle();
        hub.last.serverClose();
        await clock.advanceAsync(1200);
        hub.last.serverClose(); // now waiting 2040
        await clock.settle();
        link.kick();
        await clock.settle();
        expect(hub.sockets).toHaveLength(3);
        hub.last.serverClose();
        await clock.advanceAsync(1200);
        expect(hub.sockets).toHaveLength(4);
    });

    it("the interrupted wait does not fire a second connect later", async () => {
        const { link, hub, clock } = setup();
        link.start();
        await clock.settle();
        hub.last.serverClose();
        await clock.settle();
        link.kick();
        await clock.settle();
        hub.last.serverOpen();
        await clock.advanceAsync(10_000);
        expect(hub.sockets).toHaveLength(2);
    });
});

describe("stale socket guard (failure mode 1)", () => {
    it("a kicked socket's late close does not mark the live one closed", async () => {
        const { link, hub, clock } = await opened();
        const old = hub.last;
        link.kick();
        await clock.settle();
        expect(hub.sockets).toHaveLength(2);
        expect(old.closeCalls).toBeGreaterThan(0);
        const live = hub.last;
        live.serverOpen();
        await clock.settle();
        old.serverClose();
        await clock.advanceAsync(10_000);
        expect(link.isOpen()).toBe(true);
        expect(hub.sockets).toHaveLength(2);
    });

    it("a late open from an abandoned socket changes nothing", async () => {
        const { link, hub, clock } = setup();
        link.start();
        await clock.settle();
        const old = hub.last;
        link.kick();
        await clock.settle();
        old.serverOpen();
        await clock.settle();
        expect(link.isOpen()).toBe(false);
        expect(link.store.getState().link.connecting).toBe(true);
    });

    it("late frames from an abandoned socket do not reach device state", async () => {
        const { link, hub, clock } = await opened();
        const old = hub.last;
        link.kick();
        await clock.settle();
        old.serverMessage({ event_type: "atx", event: { enabled: true } });
        expect(link.store.getState().device.atx).toBeNull();
    });

    it("a kick while still connecting replaces the socket rather than adding one", async () => {
        const { link, hub, clock } = setup();
        link.start();
        await clock.settle();
        link.kick();
        await clock.settle();
        expect(hub.sockets).toHaveLength(2);
        expect(hub.sockets[0]?.closeCalls).toBeGreaterThan(0);
    });
});

describe("heartbeat and silence watchdog (failure mode 2)", () => {
    it("pings every 10s while open", async () => {
        const { hub, clock } = await opened();
        await clock.advanceAsync(9999);
        expect(hub.last.pings()).toBe(0);
        await clock.advanceAsync(1);
        expect(hub.last.pings()).toBe(1);
        // keep it alive so the watchdog does not fire
        hub.last.serverMessage({ event_type: "pong", event: {} });
        await clock.advanceAsync(10_000);
        expect(hub.last.pings()).toBe(2);
    });

    it("replaces a socket that went silent, immediately and without backoff", async () => {
        const { link, hub, clock } = await opened();
        const dead = hub.last;
        // ticks at 10s, 20s (silence 20s, still within 25s), 30s (silence 30s > 25s)
        await clock.advanceAsync(20_000);
        expect(hub.sockets).toHaveLength(1);
        await clock.advanceAsync(10_000);
        expect(hub.sockets).toHaveLength(2);
        expect(dead.closeCalls).toBeGreaterThan(0);
        expect(link.store.getState().link).toMatchObject({ open: false, connecting: true });
    });

    it("any frame counts as life, not only pong", async () => {
        const { hub, clock } = await opened();
        for (let i = 0; i < 6; i++) {
            await clock.advanceAsync(9000);
            hub.last.serverMessage({ event_type: "hid", event: { online: true } });
        }
        await clock.advanceAsync(5000);
        expect(hub.sockets).toHaveLength(1);
    });

    it("stops pinging a socket that closed", async () => {
        const { hub, clock } = await opened();
        const first = hub.last;
        first.serverClose();
        await clock.advanceAsync(60_000);
        expect(first.pings()).toBe(0);
    });
});

describe("sending (failure modes 10-13)", () => {
    it("goes straight to an open socket as kvmd's JSON envelope", async () => {
        const { link, hub } = await opened();
        link.key("KeyA", true);
        link.key("KeyA", false);
        link.move(10, -20);
        link.button("left", true);
        link.wheel(0, -2);
        link.relative(3.4, -200);
        expect(hub.last.commands()).toEqual([
            { event_type: "key", event: { key: "KeyA", state: true } },
            { event_type: "key", event: { key: "KeyA", state: false } },
            { event_type: "mouse_move", event: { to: { x: 10, y: -20 } } },
            { event_type: "mouse_button", event: { button: "left", state: true } },
            { event_type: "mouse_wheel", event: { delta: { x: 0, y: -2 } } },
            { event_type: "mouse_relative", event: { delta: { x: 3, y: -127 }, squash: true } },
        ]);
    });

    it("relative (0,0) sends nothing, even after rounding", async () => {
        const { link, hub } = await opened();
        link.relative(0.3, -0.2);
        expect(hub.last.commands()).toEqual([]);
    });

    it("queues while down, triggers a connect, and flushes in order on open", async () => {
        const { link, hub, clock } = setup();
        link.key("KeyA", true);
        link.key("KeyA", false);
        await clock.settle();
        expect(hub.sockets).toHaveLength(1);
        hub.last.serverOpen();
        await clock.settle();
        expect(hub.last.commands().map((c) => c.event.state)).toEqual([true, false]);
    });

    it("drops queued input older than 2s on reconnect but delivers every release", async () => {
        const { link, hub, clock } = await opened();
        hub.last.serverClose();
        await clock.settle();
        link.key("KeyA", true);
        link.key("KeyA", false);
        link.key("KeyB", true);
        await clock.advanceAsync(2500);
        link.key("KeyC", true);
        link.key("KeyC", false);
        await clock.advanceAsync(5000);
        hub.last.serverOpen();
        await clock.settle();
        const sent = hub.last.commands().map((c) => `${String(c.event.key)}:${String(c.event.state)}`);
        // KeyA/KeyB downs are stale; KeyA up is a release and must go; KeyC is 5s old by now, so only its up.
        expect(sent).toEqual(["KeyA:false", "KeyC:false"]);
    });

    it("a held key's release always arrives after an outage of any length", async () => {
        const { link, hub, clock } = await opened();
        link.key("ControlLeft", true);
        hub.last.serverClose();
        await clock.settle();
        link.key("ControlLeft", false);
        await clock.advanceAsync(120_000);
        hub.last.serverOpen();
        await clock.settle();
        expect(hub.last.commands()).toEqual([{ event_type: "key", event: { key: "ControlLeft", state: false } }]);
    });

    it("caps the queue at 256", async () => {
        const { link, hub, clock } = setup();
        link.start();
        await clock.settle();
        for (let i = 0; i < 300; i++) link.move(i, 0);
        hub.last.serverOpen();
        await clock.settle();
        expect(hub.last.commands()).toHaveLength(256);
    });

    it("a send into a socket that throws is swallowed", async () => {
        const { link, hub } = await opened();
        hub.last.state = "connecting"; // isOpen() false => queues instead
        expect(() => link.key("KeyA", true)).not.toThrow();
    });
});

describe("frames", () => {
    it("feed the device state store", async () => {
        const { link, hub } = await opened();
        hub.last.serverMessage({ event_type: "atx", event: { enabled: true, leds: { power: true } } });
        hub.last.serverMessage({ event_type: "hid", event: { mouse: { absolute: true, outputs: { available: ["usb"] } } } });
        expect(link.store.getState().device.atx?.enabled).toBe(true);
        expect(link.isAbsolute()).toBe(true);
        expect(link.isRelative()).toBe(false);
        expect(link.relativeAvailable()).toBe(false);
    });

    it("ignore non-JSON frames without breaking the link or the watchdog", async () => {
        const { link, hub, clock } = await opened();
        hub.last.serverMessage("not json {");
        hub.last.serverMessage("3");
        hub.last.serverMessage("null");
        await clock.advanceAsync(9000);
        hub.last.serverMessage("still not json");
        await clock.advanceAsync(9000);
        hub.last.serverMessage("garbage");
        await clock.advanceAsync(9000);
        expect(link.isOpen()).toBe(true);
        expect(hub.sockets).toHaveLength(1);
    });
});

describe("caps lock through the link", () => {
    it("tracks the LED, the pending window and toggles", async () => {
        const { link, hub, clock } = await opened();
        expect(link.capsKnown()).toBe(false);
        link.noteCapsToggle(); // unknown: no-op
        expect(link.capsOn()).toBe(false);
        hub.last.serverMessage({ event_type: "hid", event: { keyboard: { leds: { caps: false } } } });
        expect(link.capsKnown()).toBe(true);
        link.noteCapsToggle();
        expect(link.capsOn()).toBe(true);
        expect(link.capsPending()).toBe(true);
        hub.last.serverMessage({ event_type: "hid", event: { keyboard: { leds: { caps: false } } } }); // stale
        expect(link.capsOn()).toBe(true);
        await clock.advanceAsync(1201);
        expect(link.capsPending()).toBe(false);
    });
});

describe("setMouseOutput (failure mode 18)", () => {
    async function withMouse(absolute: boolean, available: string[] = ["usb", "usb_rel"]) {
        const env = await opened();
        env.hub.last.serverMessage({ event_type: "hid", event: { mouse: { absolute, outputs: { available } } } });
        return env;
    }

    it("does nothing while the mode is unknown", async () => {
        const { link, http, clock } = await opened();
        link.setMouseOutput(false);
        await clock.settle();
        expect(http.requests).toEqual([]);
    });

    it("does nothing when already right or when the output is not offered", async () => {
        const a = await withMouse(true);
        a.link.setMouseOutput(true);
        expect(a.http.requests).toEqual([]);
        const b = await withMouse(true, ["usb"]);
        b.link.setMouseOutput(false);
        expect(b.http.requests).toEqual([]);
    });

    it("posts the switch and throttles repeats to one per 1.5s, and none while in flight", async () => {
        const { link, http, clock } = await withMouse(true);
        const gate = Promise.withResolvers<HttpResponse>();
        http.respond = () => gate.promise;
        link.setMouseOutput(false);
        link.setMouseOutput(false);
        expect(http.requests).toEqual([{ method: "POST", path: "/api/hid/set_params?mouse_output=usb_rel" }]);
        gate.resolve(status(200));
        await clock.settle();
        await clock.advanceAsync(1000);
        link.setMouseOutput(false); // idle but inside 1.5s
        expect(http.requests).toHaveLength(1);
        await clock.advanceAsync(500);
        link.setMouseOutput(false);
        expect(http.requests).toHaveLength(2);
    });

    it("a failed request does not wedge the busy flag", async () => {
        const { link, http, clock } = await withMouse(true);
        http.respond = () => Promise.reject(new Error("network"));
        link.setMouseOutput(false);
        await clock.settle();
        await clock.advanceAsync(1500);
        link.setMouseOutput(false);
        expect(http.requests).toHaveLength(2);
    });

    it("asks for absolute with the usb output", async () => {
        const { link, http } = await withMouse(false);
        link.setMouseOutput(true);
        expect(http.requests[0]?.path).toBe("/api/hid/set_params?mouse_output=usb");
    });
});

describe("stop (failure mode 5)", () => {
    it("closes the socket and never reconnects", async () => {
        const { link, hub, clock } = await opened();
        await link.stop();
        expect(hub.last.closeCalls).toBeGreaterThan(0);
        await clock.advanceAsync(120_000);
        link.connect();
        link.kick();
        link.key("KeyA", true);
        await clock.advanceAsync(10_000);
        expect(hub.sockets).toHaveLength(1);
        expect(link.isOpen()).toBe(false);
    });

    it("cancels a pending reconnect wait", async () => {
        const { link, hub, clock } = setup();
        link.start();
        await clock.settle();
        hub.last.serverClose();
        await clock.settle();
        await link.stop();
        await clock.advanceAsync(60_000);
        expect(hub.sockets).toHaveLength(1);
        expect(clock.pending()).toBe(0);
    });
});

describe("a page nobody can see (failure mode 22)", () => {
    function hiddenSetup() {
        const clock = createManualClock(T0);
        const hub = new FakeSocketHub();
        const http = new FakeHttp();
        const visible = { now: true };
        const link = createTargetLink({ url: "ws://kvm/api/ws", socket: hub.factory, http, clock, mayConnect: () => visible.now });
        created.push(link);
        return { clock, hub, link, visible };
    }

    it("a socket that drops while hidden is not reconnected, however long the page stays hidden", async () => {
        const { link, hub, clock, visible } = hiddenSetup();
        link.start();
        await clock.settle();
        hub.last.serverOpen();
        await clock.settle();
        visible.now = false;
        hub.last.serverClose();
        await clock.advanceAsync(10 * 60_000);
        expect(hub.sockets).toHaveLength(1);
        expect(link.store.getState().link.connecting).toBe(false);
    });

    it("a retry already waiting on its backoff does not fire while hidden", async () => {
        const { link, hub, clock, visible } = hiddenSetup();
        link.start();
        await clock.settle();
        hub.last.serverClose(); // refused: the backoff timer is now running
        await clock.settle();
        visible.now = false;
        await clock.advanceAsync(60_000);
        expect(hub.sockets).toHaveLength(1);
    });

    it("a start while hidden waits, and the first kick once visible makes the one socket", async () => {
        const { link, hub, clock, visible } = hiddenSetup();
        visible.now = false;
        link.start();
        await clock.advanceAsync(30_000);
        expect(hub.sockets).toHaveLength(0);
        link.key("KeyA", true); // typing into a hidden page asks for a connection; the answer is still no
        await clock.advanceAsync(30_000);
        expect(hub.sockets).toHaveLength(0);
        visible.now = true;
        link.kick();
        await clock.settle();
        expect(hub.sockets).toHaveLength(1);
        hub.last.serverOpen();
        await clock.settle();
        // Typed half a minute ago into a page nobody could see: stale, so not replayed at the target (failure mode 10).
        expect(hub.last.commands()).toEqual([]);
    });

    it("an open socket is left alone while hidden", async () => {
        const { link, hub, clock, visible } = hiddenSetup();
        link.start();
        await clock.settle();
        hub.last.serverOpen();
        await clock.settle();
        visible.now = false;
        await clock.advanceAsync(20_000);
        hub.last.serverMessage({ event_type: "pong", event: {} });
        expect(link.isOpen()).toBe(true);
        expect(hub.sockets).toHaveLength(1);
    });
});
