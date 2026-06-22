/**
 * Sharp-backed `ImageOps` for the headless server (no Electron / `nativeImage`).
 *
 * `sharp` is a NATIVE module (libvips) and is loaded LAZILY: importing this file
 * never throws, and if sharp isn't installed/built for the host the ops simply
 * return `null` and the control core falls back to the un-processed JPEG (a full
 * frame is still sent — just not downscaled/cropped). This keeps the headless
 * entry importable even on a host where sharp hasn't been rebuilt yet, while
 * loudly logging once so the operator knows to install it for proper behaviour.
 *
 * NOTE: sharp must be present in node_modules and built for the host platform.
 * See package.json `optionalDependencies` and the headless run notes.
 */

import type { ImageOps, ImageRegion } from "./image-ops";

// Lazily resolved sharp factory (or null once we know it's unavailable).
type SharpFactory = (input: Buffer) => SharpInstance;
interface SharpInstance {
    resize(opts: { width: number; height: number; fit: "fill" }): SharpInstance;
    extract(opts: { left: number; top: number; width: number; height: number }): SharpInstance;
    jpeg(opts: { quality: number }): SharpInstance;
    toBuffer(): Promise<Buffer>;
}

let sharpFactory: SharpFactory | null | undefined;
let warned = false;

// Resolve `sharp` from node_modules at runtime (kept external by the build, so
// `require` reaches the real installed package rather than a bundled copy).
// eslint-disable-next-line no-eval
const nodeRequire: NodeRequire = eval("require");

function getSharp(): SharpFactory | null {
    if (sharpFactory !== undefined) return sharpFactory;
    try {
        sharpFactory = nodeRequire("sharp") as SharpFactory;
    } catch (err) {
        sharpFactory = null;
        if (!warned) {
            warned = true;
            console.warn(
                "[image-ops] `sharp` is not available — screenshots will be sent un-resized/un-cropped. " +
                    "Install it for the headless host (`npm install sharp`).",
                err instanceof Error ? err.message : err,
            );
        }
    }
    return sharpFactory;
}

export const sharpImageOps: ImageOps = {
    async resize(jpeg, width, height, quality) {
        const sharp = getSharp();
        if (!sharp) return null;
        try {
            return await sharp(jpeg).resize({ width, height, fit: "fill" }).jpeg({ quality }).toBuffer();
        } catch {
            return null;
        }
    },
    async crop(jpeg, region: ImageRegion, quality) {
        const sharp = getSharp();
        if (!sharp) return null;
        try {
            return await sharp(jpeg)
                .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
                .jpeg({ quality })
                .toBuffer();
        } catch {
            return null;
        }
    },
};
