// Writes the OCR benchmark's fixtures: for each toast (watch-fast-frames.mjs) on each desktop, the whole 1920 x 1080 frame as the
// Pi would serve it (JPEG quality 85) and the crop of the default notification zone (bottom right, what the fast path reads),
// the crop of the cells that changed (what the fast path reads: the zone diff says where the pop-up is), plus truth.json with the words each toast says.
//
//   node apps/web/e2e/watch-ocr-fixtures.mjs <out dir>
//
// Needs SHARP_MODULES (a node_modules with sharp), like the other watch runs.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { desktop, FRAME_SIZE, TOAST_DEFS, TOASTS, toastWords } from "./watch-fast-frames.mjs";

const out = process.argv[2];
if (!out) throw new Error("usage: watch-ocr-fixtures.mjs <out dir>");
mkdirSync(out, { recursive: true });
const modules = process.env.SHARP_MODULES ?? join(process.env.HOME, ".cache/pikvm-e2e/sharp/node_modules");
const sharp = createRequire(`${modules}/`)("sharp");
const { width: W, height: H } = FRAME_SIZE;
/** The default zone: x 0.62..1, y 0.55..1. */
const zone = { left: Math.floor(0.62 * W), top: Math.floor(0.55 * H), width: W - Math.floor(0.62 * W), height: H - Math.floor(0.55 * H) };
const grey = async (jpeg) => {
    const rgb = await sharp(jpeg).resize(128, 72, { fit: "fill" }).removeAlpha().raw().toBuffer();
    return Uint8Array.from({ length: 128 * 72 }, (_, i) => Math.round((rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3));
};
/** The rectangle (pixels) around the zone's cells that changed from `before` to `after`, padded by `pad` cells and kept inside the zone. */
function changedBox(before, after, pad) {
    const x0 = Math.floor(0.62 * 128), y0 = Math.floor(0.55 * 72);
    let minX = 128, minY = 72, maxX = -1, maxY = -1;
    for (let y = y0; y < 72; y++) for (let x = x0; x < 128; x++) if (Math.abs(before[y * 128 + x] - after[y * 128 + x]) >= 10) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const left = Math.max(x0, minX - pad), top = Math.max(y0, minY - pad), right = Math.min(128, maxX + 1 + pad), bottom = Math.min(72, maxY + 1 + pad);
    return { left: Math.floor((left * W) / 128), top: Math.floor((top * H) / 72), width: Math.ceil(((right - left) * W) / 128), height: Math.ceil(((bottom - top) * H) / 72) };
}
const truth = {};
for (const background of ["dark", "bright"]) {
    const idleGrid = await grey(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${desktop({ background })}</svg>`)).jpeg({ quality: 85 }).toBuffer());
    for (const name of Object.keys(TOAST_DEFS)) {
        const id = `${name}-${background}`;
        const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${desktop({ background })}${TOASTS[name]()}</svg>`);
        const frame = await sharp(svg).jpeg({ quality: 85 }).toBuffer();
        writeFileSync(join(out, `${id}.frame.jpg`), frame);
        writeFileSync(join(out, `${id}.crop.jpg`), await sharp(frame).extract(zone).jpeg({ quality: 90 }).toBuffer());
        const box = changedBox(idleGrid, await grey(frame), 2);
        box.width = Math.min(box.width, W - box.left);
        box.height = Math.min(box.height, H - box.top);
        writeFileSync(join(out, `${id}.tight.jpg`), await sharp(frame).extract(box).jpeg({ quality: 90 }).toBuffer());
        truth[id] = toastWords(name);
    }
}
writeFileSync(join(out, "truth.json"), JSON.stringify(truth, null, 2));
console.log(`${Object.keys(truth).length} fixtures in ${out}; zone crop ${zone.width}x${zone.height}`);
