/**
 * Image operations the control core needs to turn a raw target frame into the
 * picture the agent sees: crop a region (zoom) and downscale (token saving).
 *
 * Abstracted behind this interface so `pikvm-control.ts` no longer imports
 * Electron's `nativeImage` directly. The desktop app wires a `nativeImage`-backed
 * implementation; the headless server wires a `sharp`-backed one. BOTH MUST be
 * behaviourally identical to the agent's eyes (same crop bounds, same long-edge
 * cap, JPEG out), so a screenshot looks the same whichever host produced it.
 *
 * All ops take and return JPEG `Buffer`s. They are async so a headless host can
 * back them with an async codec (`sharp`); the desktop's `nativeImage` impl is
 * synchronous under the hood and just resolves immediately. If an op cannot be
 * performed the impl returns `null` and the caller falls back to the un-processed
 * buffer (never throws).
 */

export interface ImageRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ImageOps {
    /**
     * Resize a JPEG to exactly `width`×`height` and re-encode at `quality` (0..100).
     * Returns `null` if the op fails (caller keeps the original buffer).
     */
    resize(jpeg: Buffer, width: number, height: number, quality: number): Promise<Buffer | null>;
    /**
     * Crop a JPEG to `region` (already clamped to the frame by the caller) and
     * re-encode at `quality` (0..100). Returns `null` if the op fails.
     */
    crop(jpeg: Buffer, region: ImageRegion, quality: number): Promise<Buffer | null>;
    /**
     * The frame as `width` x `height` grey bytes, row by row, for telling whether the screen is
     * still changing. Optional: without it the agent's "wait until stable" compares the JPEG bytes,
     * which a noisy capture can make differ for a screen that has not moved.
     */
    gray?(jpeg: Buffer, width: number, height: number): Promise<Uint8Array | null>;
}
