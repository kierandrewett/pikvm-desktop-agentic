/**
 * Reading the Pi's MJPEG (`multipart/x-mixed-replace`) and a JPEG's size, with nothing unbounded (FAILURE_MODES.md P4, P8).
 *
 * ustreamer writes `--<boundary>\r\n`, headers (`Content-Type`, `Content-Length`, `X-Timestamp` ...), a blank line, the
 * JPEG, `\r\n`. Only `Content-Length` is trusted: it is how a part is cut, and a part without one cannot be told from
 * the next. This is the only reader of that format on the host.
 */

export class MjpegProtocolError extends Error {}

export interface MjpegParserOptions {
    maxFrameBytes: number;
    maxHeaderBytes: number;
    /** A whole part's JPEG. `valid` is false when it is not a JPEG (no SOI or no EOI); the part is still consumed. */
    onFrame(jpeg: Buffer, valid: boolean): void;
}

/**
 * Feed it the response body in any chunking. It throws MjpegProtocolError when the stream cannot be followed (the caller
 * drops the connection and reconnects); a part that is merely not a JPEG is reported through `onFrame` and skipped.
 */
export class MjpegParser {
    private chunks: Buffer[] = [];
    private length = 0;
    /** The JPEG length of the part whose header was read, or -1 while waiting for a header. */
    private need = -1;

    constructor(private readonly options: MjpegParserOptions) {}

    push(chunk: Buffer): void {
        this.chunks.push(chunk);
        this.length += chunk.length;
        for (;;) {
            if (this.need < 0) {
                if (!this.readHeader()) return;
            }
            if (this.length < this.need) {
                // A frame can be long; nothing to scan until it has all arrived.
                return;
            }
            const body = this.take(this.need);
            this.need = -1;
            this.options.onFrame(body, isJpeg(body));
        }
    }

    /** Bytes held back, for the tests and the status. */
    get buffered(): number {
        return this.length;
    }

    private readHeader(): boolean {
        const { maxHeaderBytes, maxFrameBytes } = this.options;
        // Everything up to the blank line. The head of the buffer is enough: a header block is small.
        const head = this.peek(Math.min(this.length, maxHeaderBytes + 4));
        let start = 0;
        // Tolerate the CRLF that ends the previous part's body.
        while (start < head.length && (head[start] === 0x0d || head[start] === 0x0a)) start++;
        const end = head.indexOf("\r\n\r\n", start, "latin1");
        if (end < 0) {
            if (head.length >= maxHeaderBytes + 4) throw new MjpegProtocolError("part header too long");
            return false;
        }
        const text = head.toString("latin1", start, end);
        const lines = text.split("\r\n");
        if (!lines[0]!.startsWith("--")) throw new MjpegProtocolError("part does not start with a boundary");
        let size = -1;
        for (const line of lines.slice(1)) {
            const colon = line.indexOf(":");
            if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === "content-length") {
                const value = line.slice(colon + 1).trim();
                size = /^[0-9]{1,10}$/.test(value) ? Number(value) : -1;
            }
        }
        if (size < 0) throw new MjpegProtocolError("part has no usable Content-Length");
        if (size > maxFrameBytes) throw new MjpegProtocolError(`part of ${size} bytes is over the limit`);
        this.take(end + 4);
        this.need = size;
        return true;
    }

    /** The first n bytes, without consuming them. */
    private peek(n: number): Buffer {
        if (this.chunks.length === 0) return Buffer.alloc(0);
        const first = this.chunks[0]!;
        if (first.length >= n) return first.subarray(0, n);
        return Buffer.concat(this.chunks, this.length).subarray(0, n);
    }

    /** Consume n bytes (n <= length) and return them as one buffer. */
    private take(n: number): Buffer {
        this.length -= n;
        const first = this.chunks[0];
        if (first && first.length >= n) {
            const out = first.subarray(0, n);
            if (first.length === n) this.chunks.shift();
            else this.chunks[0] = first.subarray(n);
            // A subarray of the network chunk keeps all of it alive; a frame is kept past this call, so it is copied.
            return Buffer.from(out);
        }
        const all = Buffer.concat(this.chunks, this.length + n);
        this.chunks = this.length > 0 ? [all.subarray(n)] : [];
        return all.subarray(0, n);
    }
}

function isJpeg(buf: Buffer): boolean {
    return buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
}

/** The pixel size of a JPEG from its first start-of-frame marker, or null when it has none in the first 64 KiB. */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    const limit = Math.min(buf.length - 9, 65536);
    let i = 2;
    while (i < limit) {
        if (buf[i] !== 0xff) {
            i++;
            continue;
        }
        let marker = buf[i + 1]!;
        // Fill bytes: any run of 0xff before the marker byte.
        while (marker === 0xff && i + 2 < limit) {
            i++;
            marker = buf[i + 1]!;
        }
        // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            const height = buf.readUInt16BE(i + 5);
            const width = buf.readUInt16BE(i + 7);
            return width > 0 && height > 0 ? { width, height } : null;
        }
        // Standalone markers have no length: SOI, EOI, RSTn, TEM.
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            i += 2;
            continue;
        }
        i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
}
