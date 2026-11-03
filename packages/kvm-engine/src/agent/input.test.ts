import { afterEach, describe, expect, it } from "vitest";
import { createManualClock, type ManualClock } from "../clock/index";
import type { HidCommand } from "../target/wire";
import { parseChord } from "./chord";
import { AgentAbort, createAgentInput, LinkClosed, UnmappableText, type AgentInput } from "./input";

const NATIVE = { width: 1920, height: 1080 };

/** A link that records what is sent; the real wire format is proved against fake-kvmd by the Desk. */
function setup(mode: "absolute" | "relative" = "absolute", layout: "us" | "uk" = "us") {
    const clock = createManualClock(0);
    const sent: HidCommand[] = [];
    const state = { open: true, caps: false, mode };
    const input = createAgentInput({
        link: {
            send: (c) => void sent.push(c),
            isOpen: () => state.open,
            isAbsolute: () => state.mode === "absolute",
            isRelative: () => state.mode === "relative",
            capsOn: () => state.caps,
        },
        native: () => NATIVE,
        layout: () => layout,
        clock,
    });
    return { clock, sent, state, input };
}

/** Let an action run to its end on the manual clock. */
async function finish<T>(clock: ManualClock, action: Promise<T>): Promise<T> {
    let done = false;
    const settled = action.finally(() => {
        done = true;
    });
    settled.catch(() => undefined);
    for (let i = 0; i < 2000 && !done; i++) await clock.advanceAsync(10);
    return settled;
}

const never = new AbortController().signal;
const centre = { fx: 0.5, fy: 0.5 };
const downs = (sent: HidCommand[]) => sent.filter((c) => (c.event_type === "key" || c.event_type === "mouse_button") && c.event.state);
const ups = (sent: HidCommand[]) => sent.filter((c) => (c.event_type === "key" || c.event_type === "mouse_button") && !c.event.state);

let current: AgentInput | undefined;
afterEach(() => current?.releaseAll());

describe("aborting an action", () => {
    it("lifts a button held by a drag, and sends nothing else after the abort", async () => {
        const { clock, sent, input } = setup();
        current = input;
        const controller = new AbortController();
        const drag = input.drag({ fx: 0.1, fy: 0.1 }, { fx: 0.9, fy: 0.9 }, "left", controller.signal);
        const outcome = drag.catch((e: unknown) => e);
        // Run until the button is down and the pointer is part of the way across.
        for (let i = 0; i < 200 && !downs(sent).some((c) => c.event_type === "mouse_button"); i++) await clock.advanceAsync(10);
        await clock.advanceAsync(150);
        expect(input.held().buttons).toEqual(["left"]);
        const before = sent.length;
        controller.abort();
        await clock.advanceAsync(1000);
        expect(await outcome).toBeInstanceOf(AgentAbort);
        expect(input.held().buttons).toEqual([]);
        const after = sent.slice(before);
        expect(after).toEqual([{ event_type: "mouse_button", event: { button: "left", state: false } }]);
    });

    it("lifts a chord's modifiers and key when aborted between press and release", async () => {
        const { clock, sent, input } = setup();
        current = input;
        const controller = new AbortController();
        const outcome = input.chords([parseChord("ctrl+shift+delete")], controller.signal).catch((e: unknown) => e);
        await clock.advanceAsync(60); // modifiers down, key pressed, mid-hold
        expect(input.held().keys.length).toBeGreaterThan(0);
        controller.abort();
        await clock.advanceAsync(500);
        expect(await outcome).toBeInstanceOf(AgentAbort);
        expect(input.held()).toEqual({ keys: [], buttons: [] });
        expect(ups(sent)).toHaveLength(downs(sent).length);
    });

    it("an already-aborted signal sends nothing at all", async () => {
        const { sent, input } = setup();
        const controller = new AbortController();
        controller.abort();
        await expect(input.click(centre, "left", 1, controller.signal)).rejects.toBeInstanceOf(AgentAbort);
        expect(sent).toEqual([]);
    });

    it("stops typing mid-text and lifts the key and Shift it was holding", async () => {
        const { clock, sent, input } = setup();
        current = input;
        const controller = new AbortController();
        const outcome = input.typeText("HELLO WORLD", controller.signal).catch((e: unknown) => e);
        await clock.advanceAsync(100);
        controller.abort();
        await clock.advanceAsync(500);
        expect(await outcome).toBeInstanceOf(AgentAbort);
        expect(input.held().keys).toEqual([]);
        expect(sent.length).toBeLessThan(40);
        expect(ups(sent)).toHaveLength(downs(sent).length);
    });
});

describe("a closed socket", () => {
    it("refuses to start an action instead of queueing keys that would arrive later", async () => {
        const { sent, state, input } = setup();
        state.open = false;
        await expect(input.typeText("hello", never)).rejects.toBeInstanceOf(LinkClosed);
        await expect(input.click(centre, "left", 1, never)).rejects.toBeInstanceOf(LinkClosed);
        expect(sent).toEqual([]);
    });

    it("still sends the release for a key it pressed when the socket drops mid-action", async () => {
        const { clock, sent, state, input } = setup();
        current = input;
        const outcome = input.chords([parseChord("ctrl+c")], never).catch((e: unknown) => e);
        await clock.advanceAsync(20); // control is down
        state.open = false;
        await clock.advanceAsync(200);
        expect(await outcome).toBeInstanceOf(LinkClosed);
        expect(sent).toContainEqual({ event_type: "key", event: { key: "ControlLeft", state: false } });
        expect(input.held().keys).toEqual([]);
    });
});

describe("absolute pointer", () => {
    it("eases to the point and ends exactly on it", async () => {
        const { clock, sent, input } = setup();
        await finish(clock, input.moveTo({ fx: 0.25, fy: 0.25 }, never));
        sent.length = 0;
        await finish(clock, input.moveTo({ fx: 0.75, fy: 0.5 }, never));
        const moves = sent.filter((c) => c.event_type === "mouse_move");
        expect(moves.length).toBeGreaterThanOrEqual(4);
        const xs = moves.map((c) => (c.event_type === "mouse_move" ? c.event.to.x : 0));
        expect([...xs].sort((a, b) => a - b)).toEqual(xs);
        // Slow at the start and at the end: the first step covers less than an even share.
        const total = (xs.at(-1) ?? 0) - (xs[0] ?? 0);
        expect((xs[1] ?? 0) - (xs[0] ?? 0)).toBeLessThan(total / moves.length);
        const last = moves.at(-1);
        expect(last).toEqual({ event_type: "mouse_move", event: { to: { x: 16384, y: 0 } } });
        expect(input.pointer()).toEqual({ fx: 0.75, fy: 0.5 });
    });

    it("the very first move has no start to ease from and goes straight there", async () => {
        const { clock, sent, input } = setup();
        await finish(clock, input.moveTo(centre, never));
        expect(sent).toEqual([{ event_type: "mouse_move", event: { to: { x: 0, y: 0 } } }]);
    });

    it("clicks: move, settle, press, hold, release; a double click is two", async () => {
        const { clock, sent, input } = setup();
        await finish(clock, input.click(centre, "right", 2, never));
        const buttons = sent.filter((c) => c.event_type === "mouse_button");
        expect(buttons.map((c) => (c.event_type === "mouse_button" ? `${c.event.button}:${c.event.state}` : ""))).toEqual([
            "right:true",
            "right:false",
            "right:true",
            "right:false",
        ]);
        expect(sent[0]?.event_type).toBe("mouse_move");
    });

    it("drags: down at the start, moves, up at the end", async () => {
        const { clock, sent, input } = setup();
        await finish(clock, input.drag({ fx: 0.2, fy: 0.2 }, { fx: 0.8, fy: 0.8 }, "left", never));
        const kinds = sent.map((c) => (c.event_type === "mouse_button" ? (c.event.state ? "down" : "up") : c.event_type));
        expect(kinds.indexOf("down")).toBeGreaterThan(0);
        expect(kinds.lastIndexOf("up")).toBe(kinds.length - 1);
        expect(kinds.slice(kinds.indexOf("down") + 1, -1).every((k) => k === "mouse_move")).toBe(true);
    });

    it("scrolls down for a positive dy and right for a positive dx, as kvmd's wheel is inverted", async () => {
        const { clock, sent, input } = setup();
        await finish(clock, input.scroll(centre, 0, 3, never));
        const wheel = sent.filter((c) => c.event_type === "mouse_wheel");
        expect(wheel).toEqual(Array(3).fill({ event_type: "mouse_wheel", event: { delta: { x: 0, y: -1 } } }));
        sent.length = 0;
        await finish(clock, input.scroll(centre, 2, -1, never));
        const mixed = sent.filter((c) => c.event_type === "mouse_wheel");
        expect(mixed).toEqual([
            { event_type: "mouse_wheel", event: { delta: { x: 1, y: 1 } } },
            { event_type: "mouse_wheel", event: { delta: { x: 1, y: 0 } } },
        ]);
    });
});

describe("relative pointer", () => {
    const sum = (sent: HidCommand[]) =>
        sent.reduce(
            (acc, c) => (c.event_type === "mouse_relative" ? { x: acc.x + c.event.delta.x, y: acc.y + c.event.delta.y } : acc),
            { x: 0, y: 0 },
        );

    it("sweeps to the corner then steps by native pixels, in reports of at most 127", async () => {
        const { clock, sent, input } = setup("relative");
        await finish(clock, input.moveTo({ fx: 0.5, fy: 0.25 }, never));
        const reports = sent.filter((c) => c.event_type === "mouse_relative");
        expect(reports.every((c) => c.event_type === "mouse_relative" && Math.abs(c.event.delta.x) <= 127 && Math.abs(c.event.delta.y) <= 127)).toBe(true);
        const sweepReports = Math.ceil(1920 / 127) + 1;
        expect(sum(sent.slice(0, sweepReports))).toEqual({ x: -127 * sweepReports, y: -127 * sweepReports });
        expect(sum(sent.slice(sweepReports))).toEqual({ x: 960, y: 270 });
        expect(sent.some((c) => c.event_type === "mouse_move")).toBe(false);
    });

    it("a drag steps from where it pressed instead of sweeping with the button down", async () => {
        const { clock, sent, input } = setup("relative");
        await finish(clock, input.drag({ fx: 0.25, fy: 0.25 }, { fx: 0.75, fy: 0.5 }, "left", never));
        const down = sent.findIndex((c) => c.event_type === "mouse_button");
        const up = sent.length - 1;
        expect(sum(sent.slice(down, up))).toEqual({ x: 960, y: 270 });
    });
});

describe("typing", () => {
    it("types through the layout with Shift around the key, and never leaves Shift down", async () => {
        const { clock, sent, input } = setup();
        await finish(clock, input.typeText("a\"", never));
        const keys = sent.filter((c) => c.event_type === "key").map((c) => (c.event_type === "key" ? `${c.event.key}:${c.event.state ? "d" : "u"}` : ""));
        expect(keys).toEqual(["KeyA:d", "KeyA:u", "ShiftLeft:d", "Quote:d", "Quote:u", "ShiftLeft:u"]);
    });

    it("inverts case against the target's Caps Lock without toggling it", async () => {
        const { clock, sent, state, input } = setup();
        state.caps = true;
        await finish(clock, input.typeText("a", never));
        const keys = sent.filter((c) => c.event_type === "key").map((c) => (c.event_type === "key" ? c.event.key : ""));
        expect(keys).toEqual(["ShiftLeft", "KeyA", "KeyA", "ShiftLeft"]);
        expect(keys).not.toContain("CapsLock");
    });

    it("sends nothing when one character has no key, and names it", async () => {
        const { sent, input } = setup();
        await expect(input.typeText("hello w\u00f6rld", never)).rejects.toBeInstanceOf(UnmappableText);
        expect(sent).toEqual([]);
    });
});

describe("chords", () => {
    it("presses modifiers in order, taps the key, and releases in reverse", async () => {
        const { clock, sent, input } = setup();
        await finish(clock, input.chords([parseChord("ctrl+alt+Delete")], never));
        expect(sent.map((c) => (c.event_type === "key" ? `${c.event.key}:${c.event.state ? "d" : "u"}` : ""))).toEqual([
            "ControlLeft:d",
            "AltLeft:d",
            "Delete:d",
            "Delete:u",
            "AltLeft:u",
            "ControlLeft:u",
        ]);
    });

    it("a modifier alone is pressed and released", async () => {
        const { clock, sent, input } = setup();
        await finish(clock, input.chords([parseChord("super")], never));
        expect(sent).toEqual([
            { event_type: "key", event: { key: "MetaLeft", state: true } },
            { event_type: "key", event: { key: "MetaLeft", state: false } },
        ]);
    });
});
