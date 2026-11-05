import { readFileSync } from "node:fs";

/**
 * PP-OCRv4 (PaddleOCR's mobile text detector and recogniser, exported to ONNX) run with onnxruntime-node, in plain code: sharp
 * for the pixels, no OpenCV. Detection finds the lines of text (DB: a probability map, thresholded, its connected regions boxed),
 * recognition reads each line (CTC, greedy). Horizontal text only, which is all a toast has.
 *
 * The models and the dictionary are files (`PaddleFiles`); `deploy/Dockerfile` fetches them at build time and pins their sha256.
 * Nothing here touches the network.
 */

export interface PaddleFiles {
    /** ch_PP-OCRv4_det_infer.onnx */
    det: string;
    /** ch_PP-OCRv4_rec_infer.onnx */
    rec: string;
    /** ppocr_keys_v1.txt: one character a line. */
    dict: string;
}

/** The two things this reads from onnxruntime-node and sharp, so a test or the worker can pass the real ones. */
export interface OrtLike {
    InferenceSession: { create(path: string, options?: Record<string, unknown>): Promise<SessionLike> };
    Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
}
export interface SessionLike {
    run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | Int32Array | BigInt64Array; dims: readonly number[] }>>;
    inputNames: readonly string[];
    outputNames: readonly string[];
}
export type SharpLike = (input: Buffer | { create: unknown } | Uint8Array, options?: Record<string, unknown>) => SharpInstance;
export interface SharpInstance {
    metadata(): Promise<{ width?: number; height?: number }>;
    resize(width: number, height: number, options?: Record<string, unknown>): SharpInstance;
    removeAlpha(): SharpInstance;
    extract(region: { left: number; top: number; width: number; height: number }): SharpInstance;
    raw(): SharpInstance;
    toBuffer(options?: { resolveWithObject: true }): Promise<Buffer> & Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }>;
}

export interface PaddleOptions {
    /** Upscale the image by this before detection (small text reads better larger). Default 1. */
    scale?: number;
    /** onnxruntime's intra-op threads per session. Default 2. */
    threads?: number;
    /** DB probability above which a pixel is text. */
    detThreshold?: number;
    /** Mean probability a region needs to count as a line. */
    boxThreshold?: number;
    /** How far a region grows (DB's unclip ratio). */
    unclipRatio?: number;
}

export interface PaddleRead {
    /** Lines in reading order. */
    lines: string[];
    /** Each line's box as fractions of the image, one per line. */
    boxes: { x0: number; y0: number; x1: number; y1: number }[];
}

export interface PaddleReader {
    read(image: Buffer): Promise<PaddleRead>;
}

interface Box {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

const DET_MEAN = [0.485, 0.456, 0.406] as const;
const DET_STD = [0.229, 0.224, 0.225] as const;
/** The detector's side is cut to a multiple of this, and its long side to at most `DET_MAX_SIDE`. */
const DET_STRIDE = 32;
const DET_MAX_SIDE = 1280;
const REC_HEIGHT = 48;
const REC_MAX_WIDTH = 960;
const MIN_REGION_PIXELS = 12;

export async function createPaddleReader(files: PaddleFiles, ort: OrtLike, sharp: SharpLike, options: PaddleOptions = {}): Promise<PaddleReader> {
    const scale = options.scale ?? 1;
    const detThreshold = options.detThreshold ?? 0.3;
    const boxThreshold = options.boxThreshold ?? 0.6;
    const unclip = options.unclipRatio ?? 1.5;
    const session = { intraOpNumThreads: options.threads ?? 2, interOpNumThreads: 1, graphOptimizationLevel: "all" };
    const [det, rec] = await Promise.all([ort.InferenceSession.create(files.det, session), ort.InferenceSession.create(files.rec, session)]);
    // CTC: class 0 is blank, then the dictionary's characters, then a space.
    const characters = ["", ...readFileSync(files.dict, "utf8").split("\n").map((line) => line.replace(/\r$/, "")).filter((line, i, all) => line !== "" || i < all.length - 1), " "];

    /** The image as RGB bytes at `scale`, rounded up to the detector's stride (the edge padded with white). */
    async function prepare(image: Buffer): Promise<{ rgb: Buffer; width: number; height: number; padded: { width: number; height: number } }> {
        const meta = await sharp(image).metadata();
        const sourceWidth = meta.width ?? 0;
        const sourceHeight = meta.height ?? 0;
        let ratio = scale;
        const longSide = Math.max(sourceWidth, sourceHeight) * ratio;
        if (longSide > DET_MAX_SIDE) ratio *= DET_MAX_SIDE / longSide;
        const width = Math.max(DET_STRIDE, Math.round(sourceWidth * ratio));
        const height = Math.max(DET_STRIDE, Math.round(sourceHeight * ratio));
        const rgb = await sharp(image).removeAlpha().resize(width, height, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer();
        return { rgb, width, height, padded: { width: Math.ceil(width / DET_STRIDE) * DET_STRIDE, height: Math.ceil(height / DET_STRIDE) * DET_STRIDE } };
    }

    /** The boxes of the text lines in the probability map, top to bottom and left to right. */
    function boxes(map: Float32Array, mapWidth: number, mapHeight: number, width: number, height: number): Box[] {
        const seen = new Uint8Array(mapWidth * mapHeight);
        const found: Box[] = [];
        const stack: number[] = [];
        for (let start = 0; start < map.length; start++) {
            if (seen[start] || map[start]! < detThreshold) continue;
            let x0 = mapWidth;
            let y0 = mapHeight;
            let x1 = -1;
            let y1 = -1;
            let sum = 0;
            let count = 0;
            stack.push(start);
            seen[start] = 1;
            while (stack.length > 0) {
                const at = stack.pop()!;
                const x = at % mapWidth;
                const y = (at - x) / mapWidth;
                sum += map[at]!;
                count++;
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
                for (const next of [at - 1, at + 1, at - mapWidth, at + mapWidth]) {
                    if (next < 0 || next >= map.length) continue;
                    // No wrap at the row ends.
                    if ((next === at - 1 && x === 0) || (next === at + 1 && x === mapWidth - 1)) continue;
                    if (!seen[next] && map[next]! >= detThreshold) {
                        seen[next] = 1;
                        stack.push(next);
                    }
                }
            }
            if (count < MIN_REGION_PIXELS || sum / count < boxThreshold) continue;
            // DB shrinks the text kernel; grow the box back by its unclip distance, and a little more in height for descenders.
            const w = x1 - x0 + 1;
            const h = y1 - y0 + 1;
            const distance = (w * h * unclip) / (2 * (w + h));
            found.push({
                x0: Math.max(0, Math.floor(((x0 - distance) * width) / mapWidth)),
                y0: Math.max(0, Math.floor(((y0 - distance) * height) / mapHeight)),
                x1: Math.min(width, Math.ceil(((x1 + 1 + distance) * width) / mapWidth)),
                y1: Math.min(height, Math.ceil(((y1 + 1 + distance) * height) / mapHeight)),
            });
        }
        found.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
        // Boxes that share a row (their vertical centres within half a box height) read left to right.
        const rows: Box[][] = [];
        for (const box of found) {
            const row = rows.find((candidate) => {
                const first = candidate[0]!;
                return Math.abs((first.y0 + first.y1) / 2 - (box.y0 + box.y1) / 2) < Math.min(first.y1 - first.y0, box.y1 - box.y0) / 2;
            });
            if (row) row.push(box);
            else rows.push([box]);
        }
        return rows.flatMap((row) => row.sort((a, b) => a.x0 - b.x0));
    }

    async function recognise(rgb: Buffer, width: number, height: number, box: Box): Promise<string> {
        const boxWidth = box.x1 - box.x0;
        const boxHeight = box.y1 - box.y0;
        if (boxWidth < 2 || boxHeight < 2) return "";
        const targetWidth = Math.min(REC_MAX_WIDTH, Math.max(16, Math.ceil((REC_HEIGHT * boxWidth) / boxHeight)));
        const pixels = await sharp(rgb, { raw: { width, height, channels: 3 } })
            .extract({ left: box.x0, top: box.y0, width: boxWidth, height: boxHeight })
            .resize(targetWidth, REC_HEIGHT, { fit: "fill", kernel: "lanczos3" })
            .raw()
            .toBuffer();
        const plane = REC_HEIGHT * targetWidth;
        const input = new Float32Array(3 * plane);
        for (let i = 0; i < plane; i++) {
            // The recogniser was trained on BGR.
            input[i] = (pixels[i * 3 + 2]! / 255 - 0.5) / 0.5;
            input[plane + i] = (pixels[i * 3 + 1]! / 255 - 0.5) / 0.5;
            input[2 * plane + i] = (pixels[i * 3]! / 255 - 0.5) / 0.5;
        }
        const out = await rec.run({ [rec.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, REC_HEIGHT, targetWidth]) });
        const result = out[rec.outputNames[0]!]!;
        const steps = result.dims[1]!;
        const classes = result.dims[2]!;
        const data = result.data as Float32Array;
        let text = "";
        let last = 0;
        for (let t = 0; t < steps; t++) {
            let best = 0;
            let bestValue = -Infinity;
            for (let c = 0; c < classes; c++) {
                const value = data[t * classes + c]!;
                if (value > bestValue) {
                    bestValue = value;
                    best = c;
                }
            }
            if (best !== 0 && best !== last) text += characters[best] ?? "";
            last = best;
        }
        return text.trim();
    }

    return {
        async read(image) {
            const { rgb, width, height, padded } = await prepare(image);
            const plane = padded.width * padded.height;
            const input = new Float32Array(3 * plane);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const at = (y * width + x) * 3;
                    const to = y * padded.width + x;
                    // The detector was trained on BGR as well, normalised with ImageNet's mean and deviation.
                    input[to] = (rgb[at + 2]! / 255 - DET_MEAN[0]) / DET_STD[0];
                    input[plane + to] = (rgb[at + 1]! / 255 - DET_MEAN[1]) / DET_STD[1];
                    input[2 * plane + to] = (rgb[at]! / 255 - DET_MEAN[2]) / DET_STD[2];
                }
            }
            const out = await det.run({ [det.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, padded.height, padded.width]) });
            const map = out[det.outputNames[0]!]!.data as Float32Array;
            const lines: string[] = [];
            const placed: PaddleRead["boxes"] = [];
            for (const box of boxes(map, padded.width, padded.height, padded.width, padded.height)) {
                const clipped = { x0: box.x0, y0: box.y0, x1: Math.min(box.x1, width), y1: Math.min(box.y1, height) };
                const text = await recognise(rgb, width, height, clipped);
                if (text === "") continue;
                lines.push(text);
                placed.push({ x0: clipped.x0 / width, y0: clipped.y0 / height, x1: clipped.x1 / width, y1: clipped.y1 / height });
            }
            return { lines, boxes: placed };
        },
    };
}
