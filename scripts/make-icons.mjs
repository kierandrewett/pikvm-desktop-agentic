// Regenerate packaging/icons from src/assets/icon.png (512px, the source of truth).
//
//     packaging/icons/NxN.png   the hicolor sizes the Linux packages install
//     packaging/icons/icon.ico  Windows: electron-packager and the installers
//     packaging/icons/icon.icns macOS: electron-packager
//
// The outputs are committed so a package build needs no ImageMagick; run this
// (`just icons`) only when the source icon changes. ImageMagick does the
// resizing. It cannot write a real .icns, so that one is assembled here: an
// icns file is a header followed by chunks, each a type tag, a length and a PNG.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "src/assets/icon.png");
const out = resolve(root, "packaging/icons");
mkdirSync(out, { recursive: true });

const magick = (...args) => execFileSync("magick", args, { stdio: ["ignore", "inherit", "inherit"] });

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
for (const size of SIZES) {
    magick(source, "-resize", `${size}x${size}`, "-strip", resolve(out, `${size}x${size}.png`));
}

magick(source, "-define", "icon:auto-resize=256,128,64,48,32,16", resolve(out, "icon.ico"));

// macOS icon types that carry a PNG: ic07 is 128px, ic08 256px, ic09 512px. (1024px would be ic10;
// the source is 512, and upscaling it would only make the file bigger.)
const ICNS = [
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
];
const chunks = ICNS.map(([tag, size]) => {
    const png = readFileSync(resolve(out, `${size}x${size}.png`));
    const header = Buffer.alloc(8);
    header.write(tag, 0, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
});
const body = Buffer.concat(chunks);
const head = Buffer.alloc(8);
head.write("icns", 0, "ascii");
head.writeUInt32BE(body.length + 8, 4);
writeFileSync(resolve(out, "icon.icns"), Buffer.concat([head, body]));

console.log(`icons written to ${out}`);
