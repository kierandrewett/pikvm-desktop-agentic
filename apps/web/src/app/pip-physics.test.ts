/**
 * Failure modes: a thrown window leaves the area it lives in, never comes to rest (it drifts for ever), is thrown at a
 * speed that makes it unreadable, or a slow drag with a stop at the end is thrown anyway.
 */

import { describe, expect, it } from "vitest";
import { atRest, keepInside, step, throwOf, velocityOf, type Area, type Body } from "./pip-physics";

const area: Area = { width: 400, height: 600, w: 100, h: 60, inset: 10 };

function fly(from: Body, seconds: number): Body[] {
    const path: Body[] = [];
    let now = from;
    for (let t = 0; t < seconds; t += 1 / 60) {
        now = step(now, 1 / 60, area);
        path.push(now);
    }
    return path;
}

describe("flight", () => {
    it("never leaves the area, even thrown very hard at a corner", () => {
        const path = fly({ x: 200, y: 300, ...throwOf(9000, -9000) }, 8);
        for (const b of path) {
            expect(b.x).toBeGreaterThanOrEqual(10);
            expect(b.x).toBeLessThanOrEqual(400 - 100 - 10);
            expect(b.y).toBeGreaterThanOrEqual(10);
            expect(b.y).toBeLessThanOrEqual(600 - 60 - 10);
        }
    });

    it("bounces off an edge, losing some speed, and then comes to rest", () => {
        const path = fly({ x: 280, y: 200, vx: 900, vy: 0 }, 10);
        const hit = path.findIndex((b) => b.vx < 0);
        expect(hit).toBeGreaterThanOrEqual(0);
        expect(Math.abs(path[hit]!.vx)).toBeLessThan(900);
        expect(atRest(path.at(-1)!)).toBe(true);
        expect(path.at(-1)!.vx).toBe(0);
    });

    it("a long gap between frames does not carry the window through an edge", () => {
        const after = step({ x: 280, y: 200, vx: 4000, vy: 0 }, 5, area);
        expect(after.x).toBeLessThanOrEqual(290);
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
