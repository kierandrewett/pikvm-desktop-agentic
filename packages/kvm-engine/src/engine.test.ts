import { afterEach, describe, expect, it } from "vitest";
import { createKeyboard, createManualClock, createTargetLink, type TargetLink } from "./index";
import { FakeHttp, FakeSocketHub } from "./testing/fake-socket";

// The pieces composed the way the app composes them: keyboard -> link -> socket, with the
// target's Caps LED coming back over the same socket.

const links: TargetLink[] = [];
afterEach(async () => {
    await Promise.all(links.splice(0).map((l) => l.stop()));
});

async function engine() {
    const clock = createManualClock(1_000_000);
    const hub = new FakeSocketHub();
    const link = createTargetLink({ url: "ws://kvm/api/ws", socket: hub.factory, http: new FakeHttp(), clock });
    links.push(link);
    const keyboard = createKeyboard({ clock, target: link });
    link.start();
    await clock.settle();
    hub.last.serverOpen();
    await clock.settle();
    return { clock, hub, link, keyboard };
}

const keyStrokes = (hub: FakeSocketHub): string[] =>
    hub.last.commands().map((c) => `${String(c.event["key"])}:${c.event["state"] ? "down" : "up"}`);

describe("keyboard over the link", () => {
    it("typed characters reach the socket as kvmd key events, in order", async () => {
        const { clock, hub, keyboard } = await engine();
        keyboard.sendChar("H");
        keyboard.sendChar("i");
        await clock.advanceAsync(1000);
        expect(keyStrokes(hub)).toEqual([
            "ShiftLeft:down",
            "KeyH:down",
            "KeyH:up",
            "ShiftLeft:up",
            "KeyI:down",
            "KeyI:up",
        ]);
    });

    it("the Caps LED reported by the Pi decides letter case, end to end", async () => {
        const { clock, hub, keyboard } = await engine();
        hub.last.serverMessage({ event_type: "hid", event: { keyboard: { leds: { caps: true } } } });
        keyboard.sendChar("h");
        await clock.advanceAsync(1000);
        // With the target's Caps Lock on, lowercase needs Shift.
        expect(keyStrokes(hub)).toEqual(["ShiftLeft:down", "KeyH:down", "KeyH:up", "ShiftLeft:up"]);
    });

    it("pressing Caps Lock flips the expectation immediately and a stale LED report cannot undo it", async () => {
        const { clock, hub, link, keyboard } = await engine();
        hub.last.serverMessage({ event_type: "hid", event: { keyboard: { leds: { caps: false } } } });
        keyboard.sendChord([], "CapsLock");
        keyboard.sendChar("h");
        await clock.advanceAsync(100);
        hub.last.serverMessage({ event_type: "hid", event: { keyboard: { leds: { caps: false } } } }); // the pre-toggle report
        expect(link.capsOn()).toBe(true);
        // h was queued behind the toggle and played after it: caps now on, so lowercase needs Shift.
        expect(keyStrokes(hub)).toContain("ShiftLeft:down");
    });

    it("keys typed while the socket is down are delivered on reconnect if still fresh, releases always", async () => {
        const { clock, hub, keyboard } = await engine();
        hub.last.serverClose();
        await clock.settle();
        keyboard.keydown({ code: "ControlLeft", key: "Control", ctrlKey: true }, false);
        await clock.advanceAsync(1500);
        keyboard.keyup({ code: "ControlLeft", key: "Control" });
        await clock.advanceAsync(60_000);
        hub.last.serverOpen();
        await clock.settle();
        // The stale press is gone; the release is not, so the target is never left holding Ctrl.
        expect(keyStrokes(hub)).toEqual(["ControlLeft:up"]);
    });
});
