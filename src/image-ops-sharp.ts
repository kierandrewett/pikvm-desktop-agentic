/**
 * Sharp-backed `ImageOps` for the web host, where Electron's `nativeImage` does not exist. It must give the agent the
 * same picture the desktop gives it (see image-ops.ts): the same crop bounds, JPEG out, a grey read-out by the mean of
 * the three colours.
 *
 * sharp is a native module, so the bundle leaves it external and the image installs it beside `dist/`. A host that
 * cannot load it says so at start rather than quietly sending the agent full-size frames its coordinates do not match.
 */

import type { ImageOps } from "./image-ops";

interface SharpImage {
    resize(width: number, height: number, options?: { fit: "fill"; kernel?: string }): SharpImage;
    extract(region: { left: number; top: number; width: number; height: number }): SharpImage;
    jpeg(options: { quality: number }): SharpImage;
    removeAlpha(): SharpImage;
    raw(): SharpImage;
    toBuffer(): Promise<Buffer>;
}
type SharpFactory = (input: Buffer) => SharpImage;

export function createSharpImageOps(load: () => SharpFactory = () => require("sharp") as SharpFactory): ImageOps {
    let sharp: SharpFactory;
    try {
        sharp = load();
    } catch (err) {
        throw new Error(
            `The image library (sharp) could not be loaded, so the agent cannot be given scaled screenshots: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
    return {
        async resize(jpeg, width, height, quality) {
            try {
                return await sharp(jpeg).resize(width, height, { fit: "fill" }).jpeg({ quality }).toBuffer();
            } catch {
                return null;
            }
        },
        async crop(jpeg, region, quality) {
            try {
                return await sharp(jpeg)
                    .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
                    .jpeg({ quality })
                    .toBuffer();
            } catch {
                return null;
            }
        },
        async gray(jpeg, width, height) {
            try {
                // Three channels a pixel, B, G and R alike here: the grey is the mean of the three, as in the desktop's.
                const rgb = await sharp(jpeg).resize(width, height, { fit: "fill" }).removeAlpha().raw().toBuffer();
                const out = new Uint8Array(width * height);
                for (let i = 0; i < out.length; i++) {
                    out[i] = Math.round(((rgb[i * 3] ?? 0) + (rgb[i * 3 + 1] ?? 0) + (rgb[i * 3 + 2] ?? 0)) / 3);
                }
                return out;
            } catch {
                return null;
            }
        },
    };
}
