import { describe, expect, it } from "vitest";
import { clientToNorm, fracToNorm, NORM_MAX, NORM_MIN, pictureBox } from "../view/geometry";
import { insideFrame, normToPixel, pixelFrac, pixelToNorm, referenceSize, regionToNative } from "./frame";

describe("referenceSize", () => {
    it("keeps the aspect and caps the long edge", () => {
        expect(referenceSize({ width: 1920, height: 1080 })).toEqual({ width: 1280, height: 720 });
        expect(referenceSize({ width: 3840, height: 2160 })).toEqual({ width: 1280, height: 720 });
        expect(referenceSize({ width: 1080, height: 1920 })).toEqual({ width: 720, height: 1280 });
        expect(referenceSize({ width: 1024, height: 768 }, 512)).toEqual({ width: 512, height: 384 });
    });

    it("never enlarges a small screen", () => {
        expect(referenceSize({ width: 320, height: 180 })).toEqual({ width: 320, height: 180 });
        expect(referenceSize({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
    });

    it("never collapses a thin strip to nothing", () => {
        expect(referenceSize({ width: 6000, height: 2 }, 1000).height).toBeGreaterThanOrEqual(1);
    });
});

describe("reference pixels and kvmd's absolute units", () => {
    // Three resolutions the agent meets: the fake's own, a laptop, and a big monitor that is downscaled.
    const frames = [
        { width: 320, height: 180 },
        { width: 1280, height: 720 },
        { width: 1024, height: 768 },
    ];

    it.each(frames)("every pixel of a $width x $height frame round-trips through the units", (size) => {
        for (let y = 0; y < size.height; y += size.height > 300 ? 7 : 1) {
            for (let x = 0; x < size.width; x += size.width > 300 ? 5 : 1) {
                expect(normToPixel(size, pixelToNorm(size, { x, y }))).toEqual({ x, y });
            }
        }
        const last = { x: size.width - 1, y: size.height - 1 };
        expect(normToPixel(size, pixelToNorm(size, last))).toEqual(last);
        expect(normToPixel(size, pixelToNorm(size, { x: 0, y: 0 }))).toEqual({ x: 0, y: 0 });
    });

    it("stays inside kvmd's range at the corners, and clamps what is off the screen", () => {
        const size = { width: 1280, height: 720 };
        const tl = pixelToNorm(size, { x: 0, y: 0 });
        const br = pixelToNorm(size, { x: 1279, y: 719 });
        expect(tl.x).toBeGreaterThanOrEqual(NORM_MIN);
        expect(tl.x).toBeLessThan(NORM_MIN + 65534 / 1280);
        expect(br.x).toBeLessThanOrEqual(NORM_MAX);
        expect(br.x).toBeGreaterThan(NORM_MAX - 65534 / 1280);
        // Off the screen is pinned to the picture's edge, not refused: a click near a border should still land on it.
        expect(pixelToNorm(size, { x: 99999, y: -5 })).toEqual({ x: fracToNorm(1), y: fracToNorm(0) });
    });

    it("agrees with where a person's pointer lands on the same spot of the KVM picture", () => {
        // The KVM screen shows the picture at any size and offset; the agent's pixel and a
        // person's finger on the matching spot must reach the same absolute unit.
        const ref = { width: 1280, height: 720 };
        const box = pictureBox({ left: 130, top: 48, width: 1011, height: 640 }, { w: 1920, h: 1080 });
        expect(box).not.toBeNull();
        for (const p of [
            { x: 0, y: 0 },
            { x: 640, y: 360 },
            { x: 1279, y: 719 },
            { x: 17, y: 703 },
        ]) {
            const f = pixelFrac(ref, p);
            const person = clientToNorm(box, box!.left + f.fx * box!.w, box!.top + f.fy * box!.h);
            const agent = pixelToNorm(ref, p);
            expect(Math.abs(agent.x - person!.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(agent.y - person!.y)).toBeLessThanOrEqual(1);
        }
    });
});

describe("insideFrame", () => {
    it("rejects the edge, negatives and non-numbers", () => {
        const size = { width: 100, height: 50 };
        expect(insideFrame(size, { x: 99, y: 49 })).toBe(true);
        expect(insideFrame(size, { x: 100, y: 0 })).toBe(false);
        expect(insideFrame(size, { x: -1, y: 0 })).toBe(false);
        expect(insideFrame(size, { x: Number.NaN, y: 0 })).toBe(false);
    });
});

describe("regionToNative", () => {
    const reference = { width: 1280, height: 720 };
    const native = { width: 1920, height: 1080 };

    it("scales a reference region up to whole native pixels", () => {
        expect(regionToNative(reference, native, { x: 100, y: 100, width: 200, height: 100 })).toEqual({
            x: 150,
            y: 150,
            width: 300,
            height: 150,
        });
    });

    it("clamps to the screen and refuses an empty or outside region", () => {
        expect(regionToNative(reference, native, { x: -50, y: -50, width: 100, height: 100 })).toEqual({
            x: 0,
            y: 0,
            width: 75,
            height: 75,
        });
        expect(regionToNative(reference, native, { x: 1200, y: 700, width: 500, height: 500 })).toEqual({
            x: 1800,
            y: 1050,
            width: 120,
            height: 30,
        });
        expect(regionToNative(reference, native, { x: 2000, y: 0, width: 10, height: 10 })).toBeNull();
        expect(regionToNative(reference, native, { x: 10, y: 10, width: 0, height: 10 })).toBeNull();
    });
});
