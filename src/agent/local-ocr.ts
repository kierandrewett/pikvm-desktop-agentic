/**
 * Local OCR for watched typing — reads text out of a cropped field IN-PROCESS via
 * tesseract.js (WASM). Unlike PiKVM's server-side Tesseract this puts zero load on
 * the Pi and never stalls the live stream, and unlike the vision model it's ~300ms,
 * free, and offline. It's the fast common-path read-back; the vision model is kept
 * as a confirm-on-mismatch safety net by the orchestrator.
 *
 * Everything degrades gracefully: if tesseract.js can't load (or its language data
 * isn't fetched yet), `read()` returns null and the caller falls back to vision.
 */

// One shared worker, created lazily and reused (warm). `read` returns:
//   string  → tesseract ran (may be "" for an empty field)
//   null    → engine unavailable / failed (caller should fall back to vision)
export class LocalOcr {
    private worker: any = null;
    private ready: Promise<any> | null = null;
    private failed = false;

    constructor(private readonly lang = "eng") {}

    /** Kick off worker init in the background so the first real read is warm. */
    warm(): void {
        void this.ensure();
    }

    private ensure(): Promise<any> {
        if (this.worker) return Promise.resolve(this.worker);
        if (this.failed) return Promise.resolve(null);
        if (!this.ready) {
            this.ready = (async () => {
                try {
                    const mod: any = await import("tesseract.js");
                    const createWorker = mod.createWorker ?? mod.default?.createWorker;
                    if (!createWorker) throw new Error("tesseract.js has no createWorker");
                    const w = await createWorker(this.lang);
                    this.worker = w;
                    return w;
                } catch {
                    this.failed = true;
                    return null;
                }
            })();
        }
        return this.ready;
    }

    /** OCR a base64 JPEG/PNG field crop. Returns recognised text, "" or null. */
    async read(image: { data: string; mimeType: string }): Promise<string | null> {
        const w = await this.ensure();
        if (!w) return null;
        try {
            const buf = Buffer.from(image.data, "base64");
            const res = await w.recognize(buf);
            return String(res?.data?.text ?? "").trim();
        } catch {
            return null;
        }
    }

    async dispose(): Promise<void> {
        try {
            await this.worker?.terminate?.();
        } catch {
            /* best-effort */
        }
        this.worker = null;
        this.ready = null;
    }
}
