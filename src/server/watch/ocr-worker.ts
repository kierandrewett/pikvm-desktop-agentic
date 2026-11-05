/**
 * The OCR's own process (built to dist/ocr-worker.js, forked by ocr-engine.ts). It loads the PP-OCR models once, then reads one
 * image per message. A process of its own so that a read that hangs can be killed and the host's event loop never waits on it, and
 * so the models' memory is not the web host's.
 *
 * Messages (Node's advanced serialization, so a Buffer crosses as is):
 *   parent -> worker  { id, image: Uint8Array }
 *   worker -> parent  { ready: true }                          once the models are loaded
 *                     { id, lines, boxes, ms }                 a read: the lines and where each was (fractions of the image)
 *                     { id, error: string }                    a read that failed
 *                     { fatal: string }                        the models cannot be loaded; the process then exits
 * It opens no socket and makes no request.
 */
// ONNX Runtime's Linux builds carry Microsoft's 1DS telemetry client, which posts to mobile.events.data.microsoft.com.
// Nothing from a screen may leave the host, so it is switched off before the library loads. This is a second line of defence:
// ocr-engine.ts and the image set the same variable.
process.env["ORT_DISABLE_TELEMETRY"] = "1";

import { join } from "node:path";
import { createPaddleReader, type OrtLike, type SharpLike } from "./ocr-paddle";

interface Request {
    id: number;
    image: Uint8Array;
}

const send = (message: object): void => void process.send?.(message);

async function main(): Promise<void> {
    const models = process.env["PIKVM_OCR_MODELS"] ?? "/opt/ocr/models";
    const threads = Number(process.env["PIKVM_OCR_THREADS"] ?? "2");
    const reader = await createPaddleReader(
        { det: join(models, "ch_PP-OCRv4_det_infer.onnx"), rec: join(models, "ch_PP-OCRv4_rec_infer.onnx"), dict: join(models, "ppocr_keys_v1.txt") },
        require("onnxruntime-node") as OrtLike,
        require("sharp") as SharpLike,
        { threads: Number.isFinite(threads) && threads > 0 ? threads : 2 },
    );
    let queue: Promise<void> = Promise.resolve();
    process.on("message", (message: Request) => {
        // One read at a time, in the order they came.
        queue = queue.then(async () => {
            const started = performance.now();
            try {
                const { lines, boxes } = await reader.read(Buffer.from(message.image));
                send({ id: message.id, lines, boxes, ms: Math.round(performance.now() - started) });
            } catch (error) {
                send({ id: message.id, error: error instanceof Error ? error.message : String(error) });
            }
        });
    });
    send({ ready: true });
}

main().catch((error: unknown) => {
    send({ fatal: error instanceof Error ? error.message : String(error) });
    process.exit(1);
});
