import { describe, expect, it } from "vitest";
import { createOutboundQueue, QUEUE_MAX, QUEUE_STALE_MS } from "./outbound-queue";
import type { HidCommand } from "./wire";

// Failure modes 10-12 in FAILURE_MODES.md.

const down = (key: string): HidCommand => ({ event_type: "key", event: { key, state: true } });
const up = (key: string): HidCommand => ({ event_type: "key", event: { key, state: false } });
const btnUp: HidCommand = { event_type: "mouse_button", event: { button: "left", state: false } };
const move = (x: number): HidCommand => ({ event_type: "mouse_move", event: { to: { x, y: 0 } } });

describe("outbound queue", () => {
    it("delivers fresh items in order", () => {
        const q = createOutboundQueue();
        q.push(down("KeyA"), 0);
        q.push(up("KeyA"), 10);
        expect(q.drain(100)).toEqual([down("KeyA"), up("KeyA")]);
        expect(q.size()).toBe(0);
    });

    it("drops items older than the staleness limit but never a release", () => {
        const q = createOutboundQueue();
        q.push(down("KeyA"), 0);
        q.push(up("KeyA"), 1);
        q.push(btnUp, 2);
        q.push(move(5), 3);
        q.push(down("KeyB"), 5000);
        expect(q.drain(5000 + 100)).toEqual([up("KeyA"), btnUp, down("KeyB")]);
    });

    it("the boundary is exclusive: exactly 2s old is stale", () => {
        const q = createOutboundQueue();
        q.push(down("KeyA"), 0);
        expect(q.drain(QUEUE_STALE_MS - 1)).toHaveLength(1);
        q.push(down("KeyA"), 0);
        expect(q.drain(QUEUE_STALE_MS)).toHaveLength(0);
    });

    it("is capped; new non-releases are the ones lost", () => {
        const q = createOutboundQueue();
        for (let i = 0; i < QUEUE_MAX + 50; i++) q.push(move(i), 0);
        const out = q.drain(1);
        expect(out).toHaveLength(QUEUE_MAX);
        expect(out[0]).toEqual(move(0));
        expect(out[QUEUE_MAX - 1]).toEqual(move(QUEUE_MAX - 1));
    });

    it("a release arriving at the cap still gets through, evicting the oldest non-release", () => {
        const q = createOutboundQueue();
        for (let i = 0; i < QUEUE_MAX; i++) q.push(move(i), 0);
        q.push(up("KeyA"), 0);
        const out = q.drain(1);
        expect(out).toHaveLength(QUEUE_MAX);
        expect(out[0]).toEqual(move(1));
        expect(out[out.length - 1]).toEqual(up("KeyA"));
    });

    it("a queue of nothing but releases grows past the cap rather than dropping one", () => {
        const q = createOutboundQueue();
        for (let i = 0; i < QUEUE_MAX + 3; i++) q.push(up(`Key${i}`), 0);
        expect(q.drain(10_000)).toHaveLength(QUEUE_MAX + 3);
    });
});
