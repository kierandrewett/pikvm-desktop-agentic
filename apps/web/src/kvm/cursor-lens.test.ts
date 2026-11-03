// The painter's side of the lens (failure modes L1, L3-L9 and L11-L16 in packages/kvm-engine/src/view/FAILURE_MODES.md):
// that the finger's speed is read off the moves' OWN times, that the delays are waited out by the painter's own
// clock (a finger that has stopped sends no move), and that what the engine decides reaches the canvas.
// The decisions themselves are the engine's and are tested there.

import { LENS_HIDE_DELAY_MS, LENS_SHOW_DELAY_MS, createManualClock, type PointerMachine } from "@pikvm/kvm-engine";
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
    const flags = { hidOpen: true, modalOpen: false };
    let queued: (() => void) | null = null;
    const painter = createPainter({
        pane,
        cursor,
        remote: document.createElement("div"),
        lens,
        clock,
        machine,
        source: () => source,
        hidOpen: () => flags.hidOpen,
        modalOpen: () => flags.modalOpen,
        backgrounded: () => false,
        frame: (cb) => {
            queued = cb;
            return 1;
        },
        cancelFrame: () => {
            queued = null;
        },
    });
    const t = {
        painter,
        lens,
        clock,
        flags,
        machine: machine as unknown as {
            currentView: { scale: number };
            pointersDown: number;
            trackpadActive: boolean;
            environment: { mouseMode: string };
            virtualCursorClient: { x: number; y: number };
        },
        /** Run the queued animation frame, if any (the painter draws on it and queues the next). */
        frame() {
            const cb = queued;
            queued = null;
            cb?.();
        },
        /** An animation frame is waiting. */
        get looping() {
            return queued !== null;
        },
        /** Time passes, a frame at a time (16 ms), the finger sending nothing. */
        wait(ms: number) {
            for (let spent = 0; spent < ms; spent += 16) {
                clock.advance(Math.min(16, ms - spent));
                t.frame();
            }
        },
        /** A touch and two slow moves: the decision to show is made, the lens is not up yet. */
        slowTouch() {
            painter.lens();
            painter.lens(1, 90_016);
            painter.lens(1, 90_032);
        },
        get on() {
            return lens.classList.contains("on");
        },
    };
    return t;
}

describe("the lens painter", () => {
    it("L1: the speed comes from the moves' own times, not from when they were handled", () => {
        const t = setup();
        t.painter.lens();
        // A frame's worth of moves handled in one instant (the clock never moves): 1 px each, 16 ms apart on the
        // events' own clock = 62 px/s, a slow finger. Read off the handling time they would be 1 px per 1 ms.
        for (let i = 1; i <= 6; i++) t.painter.lens(1, 90_000 + i * 16);
        t.wait(LENS_SHOW_DELAY_MS + 16);
        expect(t.on).toBe(true);
    });

    it("L1: with no timestamp the moment of the call stands in", () => {
        const t = setup();
        t.painter.lens();
        for (let i = 0; i < 6; i++) {
            t.clock.advance(16);
            t.painter.lens(1);
        }
        t.wait(LENS_SHOW_DELAY_MS + 16);
        expect(t.on).toBe(true);
    });

    it("L3/L4: nothing for a touch alone or a fast finger; it shows for a slow one, after the show delay", () => {
        const t = setup();
        t.painter.lens();
        t.wait(1000);
        expect(t.on).toBe(false);
        for (let i = 1; i <= 6; i++) t.painter.lens(24, 90_000 + i * 16); // 1500 px/s
        t.wait(1000);
        expect(t.on).toBe(false);
        const slow = setup();
        slow.slowTouch();
        slow.frame();
        expect(slow.on).toBe(false);
        slow.wait(LENS_SHOW_DELAY_MS + 16);
        expect(slow.on).toBe(true);
    });

    it("L11/L12: a slow finger that stops sends no more moves, and the lens still comes up when the delay is over, not before", () => {
        const t = setup();
        t.slowTouch();
        expect(t.looping).toBe(true); // the painter keeps the clock running for the waiting change
        t.wait(LENS_SHOW_DELAY_MS - 32);
        expect(t.on).toBe(false);
        t.wait(48);
        expect(t.on).toBe(true);
        t.wait(5000); // and it stays while the finger rests
        expect(t.on).toBe(true);
    });

    it("L11: a slow stretch under the delay shows nothing, and speeding up in it cancels the wait", () => {
        const t = setup();
        t.slowTouch();
        t.wait(LENS_SHOW_DELAY_MS - 48);
        for (let i = 3; i <= 8; i++) t.painter.lens(24, 90_000 + i * 16); // fast again
        t.wait(2000);
        expect(t.on).toBe(false);
        expect(t.looping).toBe(false); // nothing waiting: no frame loop for a lens that is not coming
    });

    it("L4/L6/L13: speeding up takes it away and slowing down brings it back, each after its delay; one size throughout", () => {
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
        move(0.8, 20);
        expect(t.on).toBe(true);
        expect(t.lens.style.width).toBe("96px");
        move(20, 4); // fast, but not for the hide delay yet
        expect(t.on).toBe(true);
        move(20, 20);
        expect(t.on).toBe(false);
        move(0.8, 30);
        expect(t.on).toBe(true);
        expect(t.lens.style.width).toBe("96px");
        expect(t.lens.style.height).toBe("96px");
    });

    it("L8: sits 24 px above the cursor, and below it only where there is no room above", () => {
        const t = setup();
        t.slowTouch();
        t.wait(LENS_SHOW_DELAY_MS + 16);
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

    it("L9/L14: a lift hides it after the hide delay, not at once, and it stays where it was meanwhile", () => {
        const t = setup();
        t.slowTouch();
        t.wait(LENS_SHOW_DELAY_MS + 16);
        expect(t.on).toBe(true);
        const top = t.lens.style.top;
        t.machine.pointersDown = 0;
        t.frame();
        expect(t.on).toBe(true);
        t.wait(LENS_HIDE_DELAY_MS - 48);
        expect(t.on).toBe(true);
        expect(t.lens.style.top).toBe(top);
        t.wait(64);
        expect(t.on).toBe(false);
        expect(t.looping).toBe(false); // and the frame loop has stopped
    });

    it("L14: a new touch inside the hide delay cancels it and the lens stays up; after it, a new touch starts from nothing", () => {
        const t = setup();
        t.slowTouch();
        t.wait(LENS_SHOW_DELAY_MS + 16);
        t.machine.pointersDown = 0;
        t.wait(LENS_HIDE_DELAY_MS / 2);
        expect(t.on).toBe(true);
        t.machine.pointersDown = 1;
        t.painter.lens(); // the next touch
        t.wait(5000);
        expect(t.on).toBe(true); // resting under the new finger keeps it
        t.machine.pointersDown = 0;
        t.wait(LENS_HIDE_DELAY_MS + 32);
        expect(t.on).toBe(false);
        t.machine.pointersDown = 1;
        t.painter.lens();
        t.painter.lens(1, 91_000);
        t.wait(5000);
        expect(t.on).toBe(false); // one move is not enough
    });

    it("L9/L13: a second finger (a pinch) hides it after the hide delay, and its going cancels that", () => {
        const t = setup();
        t.slowTouch();
        t.wait(LENS_SHOW_DELAY_MS + 16);
        t.machine.pointersDown = 2;
        t.wait(LENS_HIDE_DELAY_MS / 2);
        expect(t.on).toBe(true);
        t.machine.pointersDown = 1;
        t.wait(2000);
        expect(t.on).toBe(true);
        t.machine.pointersDown = 2;
        t.wait(LENS_HIDE_DELAY_MS + 32);
        expect(t.on).toBe(false);
    });

    it("L16: the hard limits hide it in that frame, with no delay, and it does not come back by itself", () => {
        const limits: [string, (t: ReturnType<typeof setup>) => void, (t: ReturnType<typeof setup>) => void][] = [
            [
                "dialog open",
                (t) => {
                    t.flags.modalOpen = true;
                },
                (t) => {
                    t.flags.modalOpen = false;
                },
            ],
            [
                "socket down",
                (t) => {
                    t.flags.hidOpen = false;
                },
                (t) => {
                    t.flags.hidOpen = true;
                },
            ],
            [
                "relative mouse",
                (t) => {
                    t.machine.environment.mouseMode = "relative";
                },
                (t) => {
                    t.machine.environment.mouseMode = "absolute";
                },
            ],
            [
                "trackpad off",
                (t) => {
                    t.machine.trackpadActive = false;
                },
                (t) => {
                    t.machine.trackpadActive = true;
                },
            ],
            [
                "zoomed past the lens's usefulness",
                (t) => {
                    t.machine.currentView.scale = 2.6;
                },
                (t) => {
                    t.machine.currentView.scale = 1;
                },
            ],
        ];
        for (const [name, on, off] of limits) {
            const t = setup();
            t.slowTouch();
            t.wait(LENS_SHOW_DELAY_MS + 16);
            expect(t.on, name).toBe(true);
            on(t);
            t.frame();
            expect(t.on, name).toBe(false);
            expect(t.looping, name).toBe(false);
            off(t);
            t.wait(5000);
            expect(t.on, `${name}: not back by itself`).toBe(false);
            // the finger must be slow for the show delay again
            t.painter.lens(1);
            t.clock.advance(16);
            t.painter.lens(1);
            t.frame();
            expect(t.on, `${name}: not at once`).toBe(false);
            t.wait(LENS_SHOW_DELAY_MS + 16);
            expect(t.on, `${name}: after the delay`).toBe(true);
        }
    });

    it("L16: a hard limit that holds while a show waits drops the wait", () => {
        const t = setup();
        t.slowTouch();
        t.flags.modalOpen = true;
        t.frame();
        t.flags.modalOpen = false;
        t.wait(5000);
        expect(t.on).toBe(false);
    });

    it("L15: a new touch drops a show that was waiting; the frame loop is one frame at most and stops with the painter", () => {
        const t = setup();
        t.slowTouch();
        t.wait(LENS_SHOW_DELAY_MS / 2);
        t.painter.lens(); // another touch
        t.wait(5000);
        expect(t.on).toBe(false);
        t.slowTouch();
        expect(t.looping).toBe(true);
        t.painter.dispose();
        expect(t.looping).toBe(false);
    });

    it("L7: where the picture alone is nearly 3x, it never shows", () => {
        const t = setup();
        t.machine.currentView.scale = 2.6;
        t.slowTouch();
        t.wait(2000);
        expect(t.on).toBe(false);
    });
});
