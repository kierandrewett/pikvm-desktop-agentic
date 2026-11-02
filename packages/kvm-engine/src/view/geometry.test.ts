// Failure modes G1-G8: see FAILURE_MODES.md.

import { describe, expect, it } from "vitest";
import {
    clampToBox,
    clientToNorm,
    fracInBox,
    fracToNorm,
    insideBox,
    naturalSize,
    normToClient,
    normToFrac,
    pictureBox,
} from "./geometry";
import type { Box } from "./geometry";
import { viewElementRect, viewPictureBox } from "./transform";

const NAT = { w: 1600, h: 900 };

describe("pictureBox", () => {
    it("G1: has no box for an element with no area", () => {
        expect(pictureBox({ left: 0, top: 0, width: 0, height: 300 }, NAT)).toBeNull();
        expect(pictureBox({ left: 0, top: 0, width: 300, height: 0 }, NAT)).toBeNull();
        expect(pictureBox({ left: 0, top: 0, width: -4, height: 300 }, NAT)).toBeNull();
    });

    it("G2: pillarboxes a wide element, letterboxes a tall one, and adds no bars at the exact aspect", () => {
        const wide = pictureBox({ left: 0, top: 0, width: 1000, height: 500 }, NAT);
        expect(wide?.h).toBe(500);
        expect(wide?.w).toBeCloseTo(888.889, 2);
        expect(wide?.left).toBeCloseTo(55.556, 2);
        expect(wide?.top).toBe(0);

        const tall = pictureBox({ left: 10, top: 20, width: 400, height: 600 }, NAT);
        expect(tall).toEqual({ left: 10, top: 207.5, w: 400, h: 225 });

        const exact = pictureBox({ left: 5, top: 6, width: 800, height: 450 }, NAT);
        expect(exact).toEqual({ left: 5, top: 6, w: 800, h: 450 });
    });

    it("G7: falls back to 16:9 before the first frame has a size", () => {
        expect(naturalSize(0, 0)).toEqual({ w: 16, h: 9 });
        expect(naturalSize(undefined, 720)).toEqual({ w: 16, h: 720 });
        const box = pictureBox({ left: 0, top: 0, width: 160, height: 90 }, naturalSize(0, 0));
        expect(box).toEqual({ left: 0, top: 0, w: 160, h: 90 });
    });
});

describe("fracInBox", () => {
    const box: Box = { left: 100, top: 50, w: 200, h: 100 };

    it("G3: an unclamped point in the letterbox is not a KVM point", () => {
        expect(fracInBox(box, 99, 100)).toBeNull();
        expect(fracInBox(box, 150, 49)).toBeNull();
        expect(fracInBox(box, 301, 100)).toBeNull();
        expect(fracInBox(box, 150, 151)).toBeNull();
    });

    it("maps edges inclusively and the middle to one half", () => {
        expect(fracInBox(box, 100, 50)).toEqual({ fx: 0, fy: 0 });
        expect(fracInBox(box, 300, 150)).toEqual({ fx: 1, fy: 1 });
        expect(fracInBox(box, 200, 100)).toEqual({ fx: 0.5, fy: 0.5 });
    });

    it("G4: a held-button drag pins each axis to the nearest edge independently", () => {
        expect(fracInBox(box, 1000, 100, true)).toEqual({ fx: 1, fy: 0.5 });
        expect(fracInBox(box, -40, -40, true)).toEqual({ fx: 0, fy: 0 });
        expect(fracInBox(box, 200, 900, true)).toEqual({ fx: 0.5, fy: 1 });
    });

    it("refuses a missing or degenerate box, clamped or not", () => {
        expect(fracInBox(null, 1, 1, true)).toBeNull();
        expect(fracInBox({ left: 0, top: 0, w: 0, h: 10 }, 0, 0, true)).toBeNull();
    });
});

describe("HID units", () => {
    it("G5: spans -32767..32767 and never leaves kvmd's range", () => {
        expect(fracToNorm(0)).toBe(-32767);
        expect(fracToNorm(0.5)).toBe(0);
        expect(fracToNorm(1)).toBe(32767);
        expect(fracToNorm(-1)).toBe(-32768);
        expect(fracToNorm(7)).toBe(32767);
        for (let f = -2; f <= 2; f += 0.013) {
            const n = fracToNorm(f);
            expect(n).toBeGreaterThanOrEqual(-32768);
            expect(n).toBeLessThanOrEqual(32767);
        }
    });

    it("G6: client -> HID -> client round-trips to within a pixel", () => {
        const box: Box = { left: 37, top: 12, w: 911.5, h: 512.7 };
        for (const [x, y] of [
            [37, 12],
            [500, 300],
            [948.5, 524.7],
            [123.4, 456.7],
        ] as const) {
            const n = clientToNorm(box, x, y);
            expect(n).not.toBeNull();
            const back = normToClient(box, n!.x, n!.y)!;
            expect(Math.abs(back.x - x)).toBeLessThan(1);
            expect(Math.abs(back.y - y)).toBeLessThan(1);
        }
        expect(normToFrac(-32767)).toBe(0);
        expect(normToFrac(32767)).toBe(1);
    });

    it("maps clamped drags to the picture edge in HID units", () => {
        const box: Box = { left: 0, top: 0, w: 100, h: 100 };
        expect(clientToNorm(box, 500, -500, true)).toEqual({ x: 32767, y: -32767 });
        expect(clientToNorm(box, 500, -500)).toBeNull();
        expect(normToClient(null, 0, 0)).toBeNull();
    });

    it("pins a blob inside the box", () => {
        const box: Box = { left: 10, top: 10, w: 100, h: 50 };
        expect(clampToBox(box, 0, 500)).toEqual({ x: 10, y: 60 });
        expect(insideBox(box, 110, 60)).toBe(true);
        expect(insideBox(box, 111, 60)).toBe(false);
    });
});

describe("box under a transform", () => {
    it("G8: is the letterboxed picture inside the transformed element rectangle", () => {
        const pane = { left: 20, top: 30, width: 800, height: 450 };
        const view = { scale: 2, tx: -300, ty: -100 };
        const rect = viewElementRect(pane, view);
        expect(rect).toEqual({ left: -280, top: -70, width: 1600, height: 900 });
        expect(viewPictureBox(pane, view, NAT)).toEqual(pictureBox(rect, NAT));
    });
});
