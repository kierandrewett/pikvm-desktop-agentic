// The painter's side of the lens (failure modes L3, L5-L8, L11 in packages/kvm-engine/src/view/FAILURE_MODES.md):
// that the finger's speed is read off the moves' OWN times, and that what it decides reaches the canvas.
// The decisions themselves are the engine's and are tested there.

import { createManualClock, type PointerMachine } from "@pikvm/kvm-engine";
import { describe, expect, it } from "vitest";
import { createPainter } from "./cursor-lens";

function setup() {
    const clock = createManualClock(5_000_000);
    const pane = document.createElement("div");
    const cursor = document.createElement("div");
    const lens = document.createElement("canvas");
    const source = document.createElement("img");
    const ctx = {
        fillRect: () => undefined,
        drawImage: () => undefined,
        beginPath: () => undefined,
        arc: () => undefined,
        fill: () => undefined,
        stroke: () => undefined,
    };
    lens.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
    const machine = {
        trackpadActive: true,
        pointersDown: 1,
        virtualCursorClient: { x: 200, y: 150 },
        environment: { mouseMode: "absolute", nat: { w: 1600, h: 900 } },
        currentView: { scale: 1, tx: 0, ty: 0 },
        pictureBox: { left: 0, top: 0, w: 800, h: 450 },
    } as unknown as PointerMachine;
    let queued: (() => void) | null = null;
    const painter = createPainter({
        pane,
        cursor,
        remote: document.createElement("div"),
        lens,
        clock,
        machine,
        source: () => source,
        hidOpen: () => true,
        modalOpen: () => false,
        backgrounded: () => false,
        frame: (cb) => {
            queued = cb;
            return 1;
        },
        cancelFrame: () => {
            queued = null;
        },
    });
    return {
        painter,
        lens,
        clock,
        machine: machine as unknown as { currentView: { scale: number } },
        /** Run the queued animation frame, if any (the painter draws on it and queues the next). */
        frame() {
            const cb = queued;
            queued = null;
            cb?.();
        },
    };
}

describe("the lens painter", () => {
    it("L3: the speed comes from the moves' own times, not from when they were handled", () => {
        const t = setup();
        t.painter.lens(); // a touch began
        // A frame's worth of moves handled in one instant (the clock never moves): 1 px each, 16 ms apart on the
        // events' own clock = 62 px/s, a slow finger. Read off the handling time they would be 1 px per 1 ms.
        for (let i = 1; i <= 6; i++) t.painter.lens(1, 90_000 + i * 16);
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(true);
        expect(Number(t.lens.dataset.mag)).toBeGreaterThan(4.5);
    });

    it("L3: a fast finger on its own clock hides it, whatever the handling times say", () => {
        const t = setup();
        t.painter.lens();
        for (let i = 1; i <= 6; i++) {
            t.clock.advance(16);
            t.painter.lens(24, 90_000 + i * 16); // 1500 px/s
        }
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(false);
        expect(t.lens.dataset.mag).toBeUndefined();
    });

    it("L3: with no timestamp the moment of the call stands in", () => {
        const t = setup();
        t.painter.lens();
        for (let i = 0; i < 6; i++) {
            t.clock.advance(16);
            t.painter.lens(1);
        }
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(true);
    });

    it("L6: a slow move shows it on the first frame, with no wait", () => {
        const t = setup();
        t.painter.lens();
        expect(t.lens.classList.contains("on")).toBe(false); // a touch alone is not enough
        t.painter.lens(1, 90_016);
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(true);
        expect(t.lens.style.left).toBe("200px");
    });

    it("L5/L11: a touch that has not moved shows nothing, and a new touch drops the last gesture's lens", () => {
        const t = setup();
        t.painter.lens();
        t.clock.advance(2000);
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(false);
        t.painter.lens(1, 90_016);
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(true);
        t.painter.lens(); // the next touch
        expect(t.lens.classList.contains("on")).toBe(false);
        expect(t.lens.dataset.mag).toBeUndefined();
    });

    it("L8: speeding up takes it away and slowing down brings it back, with the zoom following", () => {
        const t = setup();
        t.painter.lens();
        let at = 90_000;
        const move = (px: number, n: number) => {
            for (let i = 0; i < n; i++) {
                t.clock.advance(16);
                at += 16;
                t.painter.lens(px, at);
                t.frame();
            }
        };
        move(0.8, 10);
        const slow = Number(t.lens.dataset.mag);
        move(2.4, 8);
        const mid = Number(t.lens.dataset.mag);
        expect(slow).toBeGreaterThan(mid);
        expect(mid).toBeGreaterThan(1.3);
        move(20, 8);
        expect(t.lens.classList.contains("on")).toBe(false);
        move(0.8, 30);
        expect(t.lens.classList.contains("on")).toBe(true);
        expect(Number(t.lens.dataset.mag)).toBeGreaterThan(4.5);
    });

    it("L13: where the picture alone is as close as the lens could make it, it never shows", () => {
        const t = setup();
        t.machine.currentView.scale = 4;
        t.painter.lens();
        t.painter.lens(1, 90_016);
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(false);
    });
});
