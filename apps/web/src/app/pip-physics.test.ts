/**
 * Failure modes: a released window leaves the area it lives in, bounces off the sides, never comes to rest, settles in the wrong
 * corner, is thrown at a speed that makes it unreadable, or a slow drag with a stop at the end is thrown anyway.
 */

import { describe, expect, it } from "vitest";
import { cornerFor, keepInside, step, throwOf, velocityOf, type Area, type Body } from "./pip-physics";

const area: Area = { width: 400, height: 600, w: 100, h: 60, inset: 10 };

function fly(from: Body, seconds: number): Body[] {
    const corner = cornerFor(from, area);
    const path: Body[] = [];
    let now = from;
    for (let t = 0; t < seconds; t += 1 / 60) {
        now = step(now, 1 / 60, area, corner);
        path.push(now);
    }
    return path;
}

describe("settling in a corner", () => {
    it("never leaves the area, even thrown very hard at a corner", () => {
        const path = fly({ x: 200, y: 300, ...throwOf(9000, -9000) }, 4);
        for (const b of path) {
            expect(b.x).toBeGreaterThanOrEqual(0);
            expect(b.x).toBeLessThanOrEqual(400 - 100);
            expect(b.y).toBeGreaterThanOrEqual(0);
            expect(b.y).toBeLessThanOrEqual(600 - 60);
        }
    });

    it("picks the corner the position and the throw point at", () => {
        expect(cornerFor({ x: 50, y: 50, vx: 0, vy: 0 }, area)).toEqual({ x: 10, y: 10 });
        expect(cornerFor({ x: 250, y: 450, vx: 0, vy: 0 }, area)).toEqual({ x: 290, y: 530 });
        expect(cornerFor({ x: 50, y: 450, vx: 1200, vy: 0 }, area)).toEqual({ x: 290, y: 530 });
    });

    it("comes to rest exactly on the corner, and does not run past the side it is thrown at", () => {
        const path = fly({ x: 200, y: 300, vx: 900, vy: 0 }, 5);
        expect(path.at(-1)).toEqual({ x: 290, y: 530, vx: 0, vy: 0 });
        expect(Math.max(...path.map((b) => b.x))).toBeLessThanOrEqual(300);
    });

    it("a long gap between frames stays stable", () => {
        const after = step({ x: 200, y: 300, vx: 4000, vy: 0 }, 5, area, { x: 290, y: 530 });
        expect(after.x).toBeLessThanOrEqual(300);
        expect(Number.isFinite(after.y)).toBe(true);
    });

    it("keeps a position inside the area, also when the area is smaller than the window", () => {
        expect(keepInside(-50, 9999, area)).toEqual({ x: 10, y: 530 });
        expect(keepInside(0, 0, { ...area, width: 50, height: 50 })).toEqual({ x: 10, y: 10 });
    });
});

describe("the throw", () => {
    it("is read from the last moments of the drag, in pixels per second", () => {
        const v = velocityOf(
            [
                { x: 0, y: 0, at: 0 },
                { x: 50, y: 10, at: 1000 },
                { x: 100, y: 10, at: 1050 },
                { x: 200, y: 10, at: 1100 },
            ],
            1100,
        );
        expect(v.vx).toBeCloseTo(2000, 0);
        expect(v.vy).toBe(0);
    });

    it("is nothing when the pointer stopped before it was let go", () => {
        expect(velocityOf([{ x: 0, y: 0, at: 0 }, { x: 300, y: 0, at: 40 }], 500)).toEqual({ vx: 0, vy: 0 });
    });

    it("is capped, whatever the flick", () => {
        const v = throwOf(50_000, 0);
        expect(Math.hypot(v.vx, v.vy)).toBeLessThanOrEqual(4200 + 1e-6);
    });
});
