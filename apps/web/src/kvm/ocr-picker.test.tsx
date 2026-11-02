// Failure mode K19 in FAILURE_MODES.md.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OcrPickerProvider, rectToPicturePixels, useOcrPicker, type OcrPicker, type PicturePixelRect } from "./ocr-picker";

// A 1600x900 picture shown 800x450 at (100, 50): two stream pixels per client pixel.
const BOX = { left: 100, top: 50, w: 800, h: 450 };
const NAT = { w: 1600, h: 900 };

describe("rectToPicturePixels", () => {
    it("maps a drag inside the picture to the stream's own pixels", () => {
        expect(rectToPicturePixels({ x0: 200, y0: 100, x1: 300, y1: 150 }, BOX, NAT)).toEqual({ left: 200, top: 100, right: 400, bottom: 200 });
    });

    it("takes the drag whichever way it was made", () => {
        expect(rectToPicturePixels({ x0: 300, y0: 150, x1: 200, y1: 100 }, BOX, NAT)).toEqual({ left: 200, top: 100, right: 400, bottom: 200 });
    });

    it("clips a drag that leaves the picture to the picture's edge", () => {
        expect(rectToPicturePixels({ x0: 50, y0: 20, x1: 500, y1: 600 }, BOX, NAT)).toEqual({ left: 0, top: 0, right: 800, bottom: 900 });
    });

    it("a tap, a sliver, or a drag wholly in the letterbox picks nothing", () => {
        expect(rectToPicturePixels({ x0: 200, y0: 100, x1: 203, y1: 102 }, BOX, NAT)).toBeNull();
        expect(rectToPicturePixels({ x0: 10, y0: 10, x1: 90, y1: 40 }, BOX, NAT)).toBeNull();
        expect(rectToPicturePixels({ x0: 200, y0: 100, x1: 400, y1: 300 }, null, NAT)).toBeNull();
    });
});

function Probe({ onPicker }: { onPicker: (p: OcrPicker) => void }) {
    onPicker(useOcrPicker());
    return null;
}

describe("the picker", () => {
    it("resolves to nothing on Escape, and the overlay goes away", async () => {
        let picker!: OcrPicker;
        render(
            <OcrPickerProvider controller={null}>
                <Probe onPicker={(p) => (picker = p)} />
            </OcrPickerProvider>,
        );
        let result: PicturePixelRect | null | undefined;
        act(() => {
            void picker.pick().then((r) => (result = r));
        });
        expect(screen.getByRole("application", { name: /Drag over the part of the screen/ })).toBeInTheDocument();

        fireEvent.keyDown(document, { key: "Escape" });
        await act(async () => {});
        expect(result).toBeNull();
        expect(screen.queryByRole("application")).toBeNull();
    });

    it("a second request supersedes the first rather than leaving it hanging", async () => {
        let picker!: OcrPicker;
        render(
            <OcrPickerProvider controller={null}>
                <Probe onPicker={(p) => (picker = p)} />
            </OcrPickerProvider>,
        );
        const results: Array<PicturePixelRect | null> = [];
        act(() => {
            void picker.pick().then((r) => results.push(r));
            void picker.pick().then((r) => results.push(r));
        });
        await act(async () => {});
        expect(results).toEqual([null]);
        act(() => picker.cancel());
        await act(async () => {});
        expect(results).toEqual([null, null]);
    });
});
