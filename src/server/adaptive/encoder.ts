/**
 * Making a frame smaller for a rung (FAILURE_MODES.md P5 to P7).
 *
 * Rung 0 hands the Pi's JPEG back as it is. The others decode and re-encode with sharp (libvips; JPEG shrink-on-load
 * makes the downscale cheap). At most `maxEncodes` run at once in the whole process, the rest wait in turn; a pump has
 * one outstanding encode, so the queue is never longer than the number of clients. Clients on the same rung share the
 * encode of a frame: only the newest frame's results are kept.
 */

import type { Frame } from "./upstream";
import { RUNGS } from "./ladder";

interface SharpImage {
    resize(options: { width: number; height: number; fit: "fill" }): SharpImage;
    jpeg(options: { quality: number; chromaSubsampling: string }): SharpImage;
    toBuffer(): Promise<Buffer>;
}
type SharpFactory = (input: Buffer, options: { failOn: "none" }) => SharpImage;

export interface Encoder {
    /** The frame as the rung's JPEG, or null when it cannot be decoded (the caller skips it). */
    encode(frame: Frame, rung: number): Promise<Buffer | null>;
    /** Loads the image library now; throws where it cannot be (the route answers 503 instead of streaming nothing). */
    ready(): void;
    /** Encodes running and waiting, for the status and the leak check. */
    load(): { running: number; waiting: number; decodeErrors: number; encodes: number; encodeMsTotal: number };
}

export function createEncoder(maxEncodes: number, load: () => SharpFactory = () => require("sharp") as SharpFactory): Encoder {
    let sharp: SharpFactory | undefined;
    let running = 0;
    let decodeErrors = 0;
    let encodes = 0;
    let encodeMsTotal = 0;
    const waiting: Array<() => void> = [];
    let cachedSeq = -1;
    let cache = new Map<number, Promise<Buffer | null>>();

    // A finishing encode hands its slot straight to the next waiter, so `running` never passes `maxEncodes`.
    async function slot<T>(work: () => Promise<T>): Promise<T> {
        if (running >= maxEncodes) {
            const { promise, resolve } = Promise.withResolvers<void>();
            waiting.push(resolve);
            await promise;
        } else running++;
        try {
            return await work();
        } finally {
            const next = waiting.shift();
            if (next) next();
            else running--;
        }
    }

    async function make(frame: Frame, rung: number): Promise<Buffer | null> {
        const r = RUNGS[rung]!;
        if (r.quality === 0) return frame.jpeg;
        const lib = (sharp ??= load());
        const started = performance.now();
        try {
            const out = await slot(() =>
                lib(frame.jpeg, { failOn: "none" })
                    .resize({ width: Math.max(16, Math.round(frame.width * r.scale)), height: Math.max(16, Math.round(frame.height * r.scale)), fit: "fill" })
                    .jpeg({ quality: r.quality, chromaSubsampling: "4:2:0" })
                    .toBuffer(),
            );
            encodes++;
            encodeMsTotal += performance.now() - started;
            return out;
        } catch {
            decodeErrors++;
            return null;
        }
    }

    return {
        ready() {
            sharp ??= load();
        },
        encode(frame, rung) {
            // A pump holding an older frame than the newest cached is not worth a cache of its own.
            if (frame.seq < cachedSeq) return make(frame, rung);
            if (frame.seq !== cachedSeq) {
                cachedSeq = frame.seq;
                cache = new Map();
            }
            let result = cache.get(rung);
            if (!result) {
                result = make(frame, rung);
                cache.set(rung, result);
            }
            return result;
        },
        load: () => ({ running, waiting: waiting.length, decodeErrors, encodes, encodeMsTotal }),
    };
}
