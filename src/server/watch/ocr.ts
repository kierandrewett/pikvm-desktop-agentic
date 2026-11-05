/**
 * The OCR the fast alerts read a pop-up with. It runs on this host, in a process of its own, with no network: what is on the
 * screen is read here and does not leave it. This file is only the contract; `ocr-engine.ts` is the real engine and tests pass
 * a fake.
 */

/** A line's place in the image, as fractions of its width and height (0 to 1, from the top left). */
export interface OcrBox {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

export interface OcrResult {
    /** The lines of text, in reading order, as the engine returned them. */
    lines: string[];
    /** Where each line was, one per line, when the engine says. */
    boxes?: OcrBox[];
    /** Wall time of the read, ms: from the image handed over to the text back, the engine's own queueing excluded. */
    ms: number;
}

export interface Ocr {
    /**
     * Read the text in an image (a JPEG or PNG). One job runs at a time: a second call waits for the first. Rejects with
     * `OcrTimeoutError` when the read has not finished after `timeoutMs` (the job is abandoned and the engine restarted), and
     * with `OcrUnavailableError` when the engine cannot run here at all.
     */
    read(image: Buffer, timeoutMs: number): Promise<OcrResult>;
    /** Start the engine now so the first read does not wait for the models to load. Never throws; a read says why it cannot run. */
    warm?(): void;
    /** Why the engine cannot run on this host (models or worker missing, or it failed to start), or undefined when it can. */
    unavailable?(): string | undefined;
    /** Stop the engine. */
    close(): void;
}

export class OcrTimeoutError extends Error {
    constructor(readonly timeoutMs: number) {
        super(`ocr timed out after ${timeoutMs} ms`);
        this.name = "OcrTimeoutError";
    }
}

export class OcrUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OcrUnavailableError";
    }
}
