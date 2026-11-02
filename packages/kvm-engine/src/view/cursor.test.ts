// Failure modes C1-C5: see FAILURE_MODES.md.

import { describe, expect, it } from "vitest";
import { paintMouseCursor, paintTrackpadCursor } from "./cursor";
import type { CursorPaintInput } from "./cursor";

const box = { left: 100, top: 50, w: 400, h: 200 };
const base: CursorPaintInput = {
    modalOpen: false,
    backgrounded: false,
    hidOpen: true,
    box,
    x: 200,
    y: 100,
    dragging: false,
};

describe("paintMouseCursor", () => {
    it("shows the blob over the picture", () => {
        expect(paintMouseCursor(base)).toEqual({ show: true, style: "", x: 200, y: 100 });
    });

    it("C1: hides it and hands the pointer back under a dialog or in a background window", () => {
        expect(paintMouseCursor({ ...base, modalOpen: true })).toEqual({ show: false, style: "" });
        expect(paintMouseCursor({ ...base, backgrounded: true })).toEqual({ show: false, style: "" });
    });

    it("C2: says not-allowed while the input socket is down", () => {
        expect(paintMouseCursor({ ...base, hidOpen: false })).toEqual({ show: false, style: "not-allowed" });
        // ... but a dialog still wins: the pointer belongs to the dialog.
        expect(paintMouseCursor({ ...base, hidOpen: false, modalOpen: true })).toEqual({ show: false, style: "" });
    });

    it("C3: hovering in the letterbox hides the blob and returns the real pointer", () => {
        expect(paintMouseCursor({ ...base, x: 50, y: 100 })).toEqual({ show: false, style: "default" });
        expect(paintMouseCursor({ ...base, x: 200, y: 260 })).toEqual({ show: false, style: "default" });
    });

    it("C4: a drag outside pins the blob to the picture's edge", () => {
        expect(paintMouseCursor({ ...base, x: 900, y: -40, dragging: true })).toEqual({ show: true, style: "", x: 500, y: 50 });
    });

    it("with no picture measured, hover still shows the blob where the pointer is", () => {
        expect(paintMouseCursor({ ...base, box: null, x: 5, y: 5 })).toEqual({ show: true, style: "", x: 5, y: 5 });
    });
});

describe("paintTrackpadCursor", () => {
    const t = { trackpadActive: true, relative: false, hidOpen: true, modalOpen: false, at: { x: 7, y: 9 } };

    it("C5: shows at the virtual cursor for a known (absolute) position", () => {
        expect(paintTrackpadCursor(t)).toEqual({ show: true, x: 7, y: 9 });
    });

    it("C5: hides when the position is a guess or nothing can be driven", () => {
        expect(paintTrackpadCursor({ ...t, relative: true })).toEqual({ show: false });
        expect(paintTrackpadCursor({ ...t, hidOpen: false })).toEqual({ show: false });
        expect(paintTrackpadCursor({ ...t, modalOpen: true })).toEqual({ show: false });
        expect(paintTrackpadCursor({ ...t, at: null })).toEqual({ show: false });
    });

    it("C5: leaves a mouse-owned blob alone", () => {
        expect(paintTrackpadCursor({ ...t, trackpadActive: false })).toBeNull();
    });
});
