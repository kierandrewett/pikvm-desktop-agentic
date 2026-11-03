/**
 * Electron-backed `ImageOps` — uses `nativeImage` (Chromium's image pipeline) for
 * crop/resize/encode. This is the implementation the desktop app injects into the
 * control core, preserving the exact behaviour the code had before the abstraction.
 */

import { nativeImage } from "electron";
import type { ImageOps, ImageRegion } from "./image-ops";

export const electronImageOps: ImageOps = {
    async resize(jpeg, width, height, quality) {
        try {
            return nativeImage.createFromBuffer(jpeg).resize({ width, height, quality: "good" }).toJPEG(quality);
        } catch {
            return null;
        }
    },
    async crop(jpeg, region: ImageRegion, quality) {
        try {
            return nativeImage
                .createFromBuffer(jpeg)
                .crop({ x: region.x, y: region.y, width: region.width, height: region.height })
                .toJPEG(quality);
        } catch {
            return null;
        }
    },
    async gray(jpeg, width, height) {
        try {
            // toBitmap is 4 bytes a pixel (B, G, R, A); the grey is the mean of the three colours.
            const bitmap = nativeImage.createFromBuffer(jpeg).resize({ width, height, quality: "good" }).toBitmap();
            const out = new Uint8Array(width * height);
            for (let i = 0; i < out.length; i++) {
                out[i] = Math.round(((bitmap[i * 4] ?? 0) + (bitmap[i * 4 + 1] ?? 0) + (bitmap[i * 4 + 2] ?? 0)) / 3);
            }
            return out;
        } catch {
            return null;
        }
    },
};
