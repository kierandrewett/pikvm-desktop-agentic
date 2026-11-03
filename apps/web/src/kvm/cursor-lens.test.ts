// The painter's side of the lens (failure modes L1, L3-L9 in packages/kvm-engine/src/view/FAILURE_MODES.md):
// that the finger's speed is read off the moves' OWN times, and that what the engine decides reaches the canvas.
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
    pane.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 700, right: 390, bottom: 700, x: 0, y: 0, toJSON: () => ({}) });
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
        machine: machine as unknown as { currentView: { scale: number }; pointersDown: number; virtualCursorClient: { x: number; y: number } },
        /** Run the queued animation frame, if any (the painter draws on it and queues the next). */
        frame() {
            const cb = queued;
            queued = null;
            cb?.();
        },
    };
}

describe("the lens painter", () => {
    it("L1: the speed comes from the moves' own times, not from when they were handled", () => {
        const t = setup();
        t.painter.lens();
        // A frame's worth of moves handled in one instant (the clock never moves): 1 px each, 16 ms apart on the
        // events' own clock = 62 px/s, a slow finger. Read off the handling time they would be 1 px per 1 ms.
        for (let i = 1; i <= 6; i++) t.painter.lens(1, 90_000 + i * 16);
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(true);
    });

    it("L1: with no timestamp the moment of the call stands in", () => {
        const t = setup();
        t.painter.lens();
        for (let i = 0; i < 6; i++) {
            t.clock.advance(16);
            t.painter.lens(1);
        }
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(true);
    });

    it("L3/L4: nothing for a touch alone or a fast finger; it shows for a slow one, on the first frame", () => {
        const t = setup();
        t.painter.lens();
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(false);
        for (let i = 1; i <= 6; i++) t.painter.lens(24, 90_000 + i * 16); // 1500 px/s
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(false);
        const slow = setup();
        slow.painter.lens();
        slow.painter.lens(1, 90_016);
        slow.painter.lens(1, 90_032);
        slow.frame();
        expect(slow.lens.classList.contains("on")).toBe(true);
    });

    it("L4/L6: speeding up takes it away and slowing down brings it back; one size throughout", () => {
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
        expect(t.lens.classList.contains("on")).toBe(true);
        expect(t.lens.style.width).toBe("96px");
        move(20, 8);
        expect(t.lens.classList.contains("on")).toBe(false);
        move(0.8, 30);
        expect(t.lens.classList.contains("on")).toBe(true);
        expect(t.lens.style.width).toBe("96px");
        expect(t.lens.style.height).toBe("96px");
    });

    it("L8: sits 24 px above the cursor, and below it only where there is no room above", () => {
        const t = setup();
        t.painter.lens();
        t.painter.lens(1, 90_016);
        t.painter.lens(1, 90_032);
        t.frame();
        expect(t.lens.style.left).toBe("200px");
        expect(t.lens.style.top).toBe(`${150 - 72}px`);
        t.machine.virtualCursorClient = { x: 200, y: 60 };
        t.frame();
        expect(t.lens.style.top).toBe(`${60 + 72}px`);
        t.machine.virtualCursorClient = { x: 200, y: 150 }; // fits above again, but not with room to spare: stays below
        t.frame();
        expect(t.lens.style.top).toBe(`${150 + 72}px`);
        t.machine.virtualCursorClient = { x: 200, y: 300 };
        t.frame();
        expect(t.lens.style.top).toBe(`${300 - 72}px`);
    });

    it("L9: a lift hides it on the next frame, with no linger, and a new touch starts from nothing", () => {
        const t = setup();
        t.painter.lens();
        t.painter.lens(1, 90_016);
        t.painter.lens(1, 90_032);
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(true);
        t.machine.pointersDown = 0;
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(false);
        t.machine.pointersDown = 1;
        t.painter.lens(); // the next touch
        t.painter.lens(1, 91_000);
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(false); // one move is not enough
    });

    it("L9: a second finger (a pinch) hides it", () => {
        const t = setup();
        t.painter.lens();
        t.painter.lens(1, 90_016);
        t.painter.lens(1, 90_032);
        t.frame();
        t.machine.pointersDown = 2;
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(false);
    });

    it("L7: where the picture alone is nearly 3x, it never shows", () => {
        const t = setup();
        t.machine.currentView.scale = 2.6;
        t.painter.lens();
        t.painter.lens(1, 90_016);
        t.painter.lens(1, 90_032);
        t.frame();
        expect(t.lens.classList.contains("on")).toBe(false);
    });
});
