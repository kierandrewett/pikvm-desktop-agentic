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
};
