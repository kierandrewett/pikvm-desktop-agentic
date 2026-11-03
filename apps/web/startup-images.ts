import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { Plugin } from "vite";

/**
 * The launch splash of the installed iPhone app. iOS shows a blank white (or black) screen while a home-screen web
 * app starts, unless the page names an `apple-touch-startup-image` whose media query matches the device exactly:
 * width, height and pixel ratio in CSS pixels, and the orientation. So this writes one PNG per current iPhone screen
 * (portrait and landscape) at BUILD time, from the app's own icon on the app's dark background, and puts the
 * matching <link> tags in index.html. Nothing is checked in: the images follow the icon.
 *
 * It is pure Node (zlib only): the icon is a palette or RGB(A) PNG, the output an RGB PNG. The web image installs no
 * image library, and the repo has none.
 */

export interface Screen {
    /** The marketing name, for the docs and the tests. */
    readonly name: string;
    /** CSS pixels, portrait. iOS reports the same device-width and device-height whatever the orientation. */
    readonly width: number;
    readonly height: number;
    readonly ratio: 2 | 3;
}

/** The iPhone screens in use (iPhone 8 to the iPhone 17 line), one per distinct (width, height, ratio). */
export const SCREENS: readonly Screen[] = [
    { name: "iPhone 17 Pro Max, 16 Pro Max", width: 440, height: 956, ratio: 3 },
    { name: "iPhone 17 Pro, 17, 16 Pro", width: 402, height: 874, ratio: 3 },
    { name: "iPhone Air", width: 420, height: 912, ratio: 3 },
    { name: "iPhone 16 Plus, 15 Plus, 15 Pro Max, 14 Pro Max", width: 430, height: 932, ratio: 3 },
    { name: "iPhone 16, 15, 15 Pro, 14 Pro", width: 393, height: 852, ratio: 3 },
    { name: "iPhone 16e, 14, 13, 13 Pro, 12, 12 Pro", width: 390, height: 844, ratio: 3 },
    { name: "iPhone 14 Plus, 13 Pro Max, 12 Pro Max", width: 428, height: 926, ratio: 3 },
    { name: "iPhone 13 mini, 12 mini, 11 Pro, XS, X", width: 375, height: 812, ratio: 3 },
    { name: "iPhone 11 Pro Max, XS Max", width: 414, height: 896, ratio: 3 },
    { name: "iPhone 11, XR", width: 414, height: 896, ratio: 2 },
    { name: "iPhone 8 Plus, 7 Plus", width: 414, height: 736, ratio: 3 },
    { name: "iPhone SE (2nd, 3rd gen), 8, 7", width: 375, height: 667, ratio: 2 },
];

/** The background the app opens on (the manifest's background_color and the dark theme's --background). */
export const SPLASH_BACKGROUND: readonly [number, number, number] = [0x0a, 0x0a, 0x0c];
/** The icon's share of the shorter side. */
const ICON_SHARE = 0.3;

export interface StartupImage {
    readonly file: string;
    readonly href: string;
    readonly pixelWidth: number;
    readonly pixelHeight: number;
    readonly orientation: "portrait" | "landscape";
    readonly media: string;
}

const DIRECTORY = "splash";

/** Every image for `base` ("/app/"), portrait first, then landscape. */
export function startupImages(base = "/app/", screens: readonly Screen[] = SCREENS): StartupImage[] {
    const images: StartupImage[] = [];
    for (const orientation of ["portrait", "landscape"] as const) {
        for (const s of screens) {
            const landscape = orientation === "landscape";
            const pixelWidth = (landscape ? s.height : s.width) * s.ratio;
            const pixelHeight = (landscape ? s.width : s.height) * s.ratio;
            const file = `${DIRECTORY}/apple-splash-${landscape ? "landscape" : "portrait"}-${s.ratio}x-${s.width}x${s.height}.png`;
            images.push({
                file,
                href: `${base}${file}`,
                pixelWidth,
                pixelHeight,
                orientation,
                media: `(device-width: ${s.width}px) and (device-height: ${s.height}px) and (-webkit-device-pixel-ratio: ${s.ratio}) and (orientation: ${orientation})`,
            });
        }
    }
    return images;
}

export function startupImageLinks(images: readonly StartupImage[]): string {
    return images.map((i) => `<link rel="apple-touch-startup-image" href="${i.href}" media="${i.media}" />`).join("\n        ");
}

/* ---- PNG ---- */

export interface Raster {
    readonly width: number;
    readonly height: number;
    /** RGBA, 8 bits a channel. */
    readonly data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decode a non-interlaced 8-bit grey, grey+alpha, RGB, RGBA or palette PNG. */
export function decodePng(png: Uint8Array): Raster {
    const buf = Buffer.from(png);
    if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
    let width = 0;
    let height = 0;
    let depth = 0;
    let colour = 0;
    let palette: Buffer | undefined;
    let transparency: Buffer | undefined;
    const idat: Buffer[] = [];
    for (let at = 8; at < buf.length; ) {
        const length = buf.readUInt32BE(at);
        const type = buf.toString("latin1", at + 4, at + 8);
        const body = buf.subarray(at + 8, at + 8 + length);
        if (type === "IHDR") {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            depth = body[8]!;
            colour = body[9]!;
            if (body[12] !== 0) throw new Error("interlaced PNGs are not supported");
        } else if (type === "PLTE") palette = body;
        else if (type === "tRNS") transparency = body;
        else if (type === "IDAT") idat.push(body);
        else if (type === "IEND") break;
        at += 12 + length;
    }
    if (depth !== 8) throw new Error(`${depth}-bit PNGs are not supported`);
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour];
    if (channels === undefined) throw new Error(`PNG colour type ${colour} is not supported`);
    if (colour === 3 && !palette) throw new Error("palette PNG without a palette");

    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const rows = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]!;
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const out = rows.subarray(y * stride, (y + 1) * stride);
        const above = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : undefined;
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? out[x - channels]! : 0;
            const b = above ? above[x]! : 0;
            const c = above && x >= channels ? above[x - channels]! : 0;
            let predictor = 0;
            if (filter === 1) predictor = a;
            else if (filter === 2) predictor = b;
            else if (filter === 3) predictor = (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            } else if (filter !== 0) throw new Error(`PNG filter ${filter} is not supported`);
            out[x] = (line[x]! + predictor) & 0xff;
        }
    }

    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const s = i * channels;
        const d = i * 4;
        if (colour === 6) data.set(rows.subarray(s, s + 4), d);
        else if (colour === 2) data.set([rows[s]!, rows[s + 1]!, rows[s + 2]!, 255], d);
        else if (colour === 0) data.set([rows[s]!, rows[s]!, rows[s]!, 255], d);
        else if (colour === 4) data.set([rows[s]!, rows[s]!, rows[s]!, rows[s + 1]!], d);
        else {
            const index = rows[s]!;
            data.set([palette![index * 3]!, palette![index * 3 + 1]!, palette![index * 3 + 2]!, transparency?.[index] ?? 255], d);
        }
    }
    return { width, height, data };
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes: Buffer): number {
    let c = 0xffffffff;
    for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
}

/** An opaque RGB PNG of `rgb`, 3 bytes a pixel, rows top to bottom. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
    const stride = width * 3;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * The splash: the icon, `ICON_SHARE` of the shorter side, centred on the background. Bilinear sampling of the icon,
 * composited over the background by its alpha (the icon's own corners are the background colour, so they vanish).
 */
export function renderSplash(icon: Raster, width: number, height: number, background = SPLASH_BACKGROUND): Buffer {
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) rgb.set(background, i * 3);
    const size = Math.round(Math.min(width, height) * ICON_SHARE);
    const left = Math.round((width - size) / 2);
    const top = Math.round((height - size) / 2);
    const k = icon.width / size;
    const texel = (x: number, y: number, channel: number): number =>
        icon.data[(Math.min(icon.height - 1, Math.max(0, y)) * icon.width + Math.min(icon.width - 1, Math.max(0, x))) * 4 + channel]!;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            // The centre of this output pixel, mapped into the icon; every source pixel under it counts (a box
            // filter of `k` icon pixels), which is what keeps a downscaled logo from aliasing.
            const x0 = Math.floor(x * k);
            const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * k));
            const y0 = Math.floor(y * k);
            const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * k));
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let n = 0;
            for (let sy = y0; sy < y1; sy++) {
                for (let sx = x0; sx < x1; sx++) {
                    const alpha = texel(sx, sy, 3);
                    r += texel(sx, sy, 0) * alpha;
                    g += texel(sx, sy, 1) * alpha;
                    b += texel(sx, sy, 2) * alpha;
                    a += alpha;
                    n++;
                }
            }
            const coverage = a / (255 * n);
            const at = ((top + y) * width + left + x) * 3;
            const mean = a === 0 ? [0, 0, 0] : [r / a, g / a, b / a];
            for (let c = 0; c < 3; c++) rgb[at + c] = Math.round(mean[c]! * coverage + background[c]! * (1 - coverage));
        }
    }
    return encodePng(width, height, rgb);
}

/** The vite plugin: writes the images into the build and the <link> tags into index.html. */
export function startupImagesPlugin(options: { icon?: string } = {}): Plugin {
    let base = "/app/";
    let root = process.cwd();
    return {
        name: "pikvm:startup-images",
        configResolved(config) {
            base = config.base;
            root = config.root;
        },
        transformIndexHtml: {
            order: "post",
            handler(html) {
                const links = startupImageLinks(startupImages(base));
                return html.replace("</head>", `        ${links}\n    </head>`);
            },
        },
        generateBundle() {
            const icon = decodePng(readFileSync(resolve(root, options.icon ?? "public/icon-512.png")));
            const cache = new Map<string, Buffer>();
            for (const image of startupImages(base)) {
                const key = `${image.pixelWidth}x${image.pixelHeight}`;
                let source = cache.get(key);
                if (!source) cache.set(key, (source = renderSplash(icon, image.pixelWidth, image.pixelHeight)));
                this.emitFile({ type: "asset", fileName: image.file, source });
            }
        },
    };
}
