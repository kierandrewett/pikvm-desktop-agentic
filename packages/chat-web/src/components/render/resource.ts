/**
 * One loaded-or-loadable file. Renderers ask for exactly what they need (the whole file as a blob or
 * text, the first bytes, the last bytes, or a URL for a native element) and the resource does the
 * fetching with limits, abort signals and object URL bookkeeping. This is the only fetch path in the
 * renderer, so every renderer gets the same size rules and the same error messages.
 *
 * URL sources are same-origin API paths: fetched with the session cookie, never navigated to.
 */
import { isSessionEpochCurrent } from "../../lib/queries";
import { registerSessionReset } from "../../lib/session-reset";
import { translate } from "../../l10n/runtime";
import { formatBytes } from "./detect";
import type { FileSource } from "./types";

export type RenderErrorCode = "not-found" | "forbidden" | "http" | "network" | "too-large" | "parse" | "unsupported";

export class RenderError extends Error {
    constructor(
        message: string,
        readonly code: RenderErrorCode,
        /** Size in bytes, when the error is about size. */
        readonly size?: number,
    ) {
        super(message);
        this.name = "RenderError";
    }
}

export const tooLarge = (size?: number) =>
    new RenderError(
        size ? translate("render-error-size", { size: formatBytes(size) }) : translate("render-error-too-large"),
        "too-large",
        size,
    );

export interface Resource {
    readonly ownerEpoch: number;
    isCurrent(): boolean;
    readonly name: string;
    readonly mimeType: string | undefined;
    /**
     * Size in bytes: from the host, the blob or text itself, or learned from the first response
     * (Content-Length or a Content-Range total) when the host did not know it.
     */
    readonly size: number | undefined;
    /** The same-origin URL for remote sources; undefined for blob and text sources. */
    readonly remoteUrl: string | undefined;
    /** A URL for native elements (img, audio, video): the remote URL or a managed object URL. */
    url(type?: string): string;
    /** Where download buttons point. */
    downloadUrl(): string;
    /** The whole file, rejecting with a too-large error past `limit` bytes. Cached per limit. */
    blob(limit: number): Promise<Blob>;
    /** The whole file as text (UTF-8, or UTF-16 with a byte order mark). */
    text(limit: number): Promise<string>;
    /** Up to `n` bytes from the start, with a Range request when the server supports it. */
    head(n: number): Promise<Uint8Array>;
    /**
     * The last `n` bytes and the total size, or null when the server cannot serve a suffix range and
     * the file is larger than `fallbackLimit` (then reading the whole file would be wasteful).
     */
    tail(n: number, fallbackLimit: number): Promise<{ bytes: Uint8Array; total: number } | null>;
    /** Abort every download in flight and revoke every object URL this resource created. */
    dispose(): void;
}

function httpError(status: number): RenderError {
    if (status === 404) return new RenderError(translate("render-error-gone"), "not-found");
    if (status === 401 || status === 403) return new RenderError(translate("render-error-forbidden"), "forbidden");
    return new RenderError(translate("render-error-http", { status }), "http");
}

async function request(url: string, signal?: AbortSignal, headers?: HeadersInit): Promise<Response> {
    let res: Response;
    try {
        res = await fetch(url, { credentials: "same-origin", signal, headers });
    } catch (err) {
        if (signal?.aborted) throw err;
        throw new RenderError(translate("render-error-network"), "network");
    }
    if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        throw httpError(res.status);
    }
    return res;
}

/** Read a response body into a blob, stopping (and cancelling the download) past `limit` bytes. */
async function readLimited(
    res: Response,
    limit: number,
    check: () => void,
    readers: Set<ReadableStreamDefaultReader<Uint8Array>>,
): Promise<Blob> {
    check();
    const declared = Number(res.headers.get("content-length") ?? Number.NaN);
    // Content-Length is the encoded size when the server compresses; it is still a fair early answer.
    if (Number.isFinite(declared) && declared > limit) {
        void res.body?.cancel().catch(() => undefined);
        throw tooLarge(declared);
    }
    if (!res.body) return res.blob();
    const reader = res.body.getReader();
    readers.add(reader);
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            check();
            if (done) break;
            total += value.byteLength;
            if (total > limit) {
                void reader.cancel().catch(() => undefined);
                throw tooLarge(Number.isFinite(declared) ? declared : undefined);
            }
            chunks.push(value as Uint8Array<ArrayBuffer>);
        }
        check();
        return new Blob(chunks);
    } finally {
        readers.delete(reader);
        reader.releaseLock();
    }
}

export function decodeText(buf: ArrayBuffer): string {
    const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf);
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(buf);
    // The default decoder drops a UTF-8 byte order mark and replaces invalid bytes.
    return new TextDecoder("utf-8").decode(buf);
}

const activeResources = new Set<Resource>();
const resetSubscribers = new Set<() => void>();

export function subscribeRendererReset(listener: () => void): () => void {
    resetSubscribers.add(listener);
    return () => resetSubscribers.delete(listener);
}

registerSessionReset("file-renderer-resources", () => {
    const oldResources = [...activeResources];
    const oldSubscribers = [...resetSubscribers];
    for (const resource of oldResources) activeResources.delete(resource);
    const failures: unknown[] = [];
    for (const resource of oldResources) {
        try {
            resource.dispose();
        } catch (error) {
            failures.push(error);
        }
    }
    for (const listener of oldSubscribers) {
        if (!resetSubscribers.has(listener)) continue;
        try {
            listener();
        } catch (error) {
            failures.push(error);
        }
    }
    if (failures.length) throw new AggregateError(failures, "File resources could not be fully reset");
});

/** Source ownership survives lazy loading. Disposal cancels exposed reads, not native conversion work. */
export function createResource(input: FileSource, ownerEpoch: number): Resource {
    let source: FileSource | undefined = input;
    let local: Blob | undefined =
        "blob" in input
            ? input.blob
            : "text" in input
              ? new Blob([input.text], { type: "text/plain;charset=utf-8" })
              : undefined;
    const remoteUrl = "url" in input ? input.url : undefined;
    let size = local ? local.size : "size" in input ? input.size : undefined;
    let disposed = false;
    const controller = new AbortController();
    const { signal } = controller;
    const objectUrls = new Set<string>();
    const blobs = new Map<number, Promise<Blob>>();
    const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
    const cancellations = new Set<() => void>();
    const isCurrent = () => !disposed && isSessionEpochCurrent(ownerEpoch);
    const cancelled = () => new DOMException("The file owner is no longer current.", "AbortError");
    const check = () => {
        if (!isCurrent()) throw cancelled();
    };
    const operation = <T>(work: () => Promise<T> | T): Promise<T> => {
        if (!isCurrent()) return Promise.reject(cancelled());
        return new Promise<T>((resolve, reject) => {
            const cancel = () => reject(cancelled());
            cancellations.add(cancel);
            void Promise.resolve()
                .then(() => {
                    check();
                    return work();
                })
                .then((value) => {
                    check();
                    resolve(value);
                })
                .catch((error: unknown) => reject(isCurrent() ? error : cancelled()))
                .finally(() => cancellations.delete(cancel));
        });
    };
    const learn = (res: Response) => {
        check();
        if (size !== undefined) return;
        const total = Number(/\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1] ?? Number.NaN);
        const length = res.status === 200 ? Number(res.headers.get("content-length") ?? Number.NaN) : Number.NaN;
        if (Number.isFinite(total)) size = total;
        else if (Number.isFinite(length) && !res.headers.get("content-encoding")) size = length;
    };
    const fetchRemote = async (headers?: HeadersInit): Promise<Response> => {
        check();
        const res = await request(remoteUrl!, signal, headers);
        if (!isCurrent()) {
            void res.body?.cancel().catch(() => undefined);
            throw cancelled();
        }
        learn(res);
        return res;
    };
    const makeObjectUrl = (blob: Blob) => {
        check();
        const url = URL.createObjectURL(blob);
        objectUrls.add(url);
        return url;
    };
    let plainUrl: string | undefined;
    const typedUrls = new Map<string, string>();

    const resource: Resource = {
        ownerEpoch,
        isCurrent,
        name: input.name,
        mimeType: input.mimeType,
        get size() {
            return size;
        },
        remoteUrl,
        url(type) {
            check();
            if (remoteUrl) return remoteUrl;
            if (!type) return (plainUrl ??= makeObjectUrl(local!));
            let url = typedUrls.get(type);
            if (!url) {
                url = makeObjectUrl(new Blob([local!], { type }));
                typedUrls.set(type, url);
            }
            return url;
        },
        downloadUrl() {
            check();
            return source!.downloadUrl ?? resource.url();
        },
        blob(limit) {
            if (!isCurrent()) return Promise.reject(cancelled());
            if (local) {
                return operation(() => {
                    check();
                    if (local!.size > limit) throw tooLarge(local!.size);
                    return local!;
                });
            }
            if (size !== undefined && size > limit) return Promise.reject(tooLarge(size));
            let promise = blobs.get(limit);
            if (!promise) {
                promise = operation(async () => {
                    const res = await fetchRemote();
                    check();
                    const blob = await readLimited(res, limit, check, readers);
                    check();
                    return blob;
                });
                const cached = promise;
                void cached.catch(() => {
                    if (blobs.get(limit) === cached) blobs.delete(limit);
                });
                blobs.set(limit, cached);
            }
            return promise;
        },
        text(limit) {
            return operation(async () => {
                if (source && "text" in source) {
                    if (local!.size > limit) throw tooLarge(local!.size);
                    check();
                    return source.text;
                }
                const blob = await resource.blob(limit);
                check();
                const bytes = await blob.arrayBuffer();
                check();
                return decodeText(bytes);
            });
        },
        head(n) {
            return operation(async () => {
                if (local) {
                    const bytes = await local.slice(0, n).arrayBuffer();
                    check();
                    return new Uint8Array(bytes);
                }
                const res = await fetchRemote({ Range: `bytes=0-${n - 1}` });
                check();
                if (!res.body) {
                    const bytes = await res.arrayBuffer();
                    check();
                    return new Uint8Array(bytes).subarray(0, n);
                }
                const reader = res.body.getReader();
                readers.add(reader);
                try {
                    const out = new Uint8Array(n);
                    let got = 0;
                    while (got < n) {
                        const { done, value } = await reader.read();
                        check();
                        if (done) break;
                        const take = Math.min(value.byteLength, n - got);
                        out.set(value.subarray(0, take), got);
                        got += take;
                    }
                    void reader.cancel().catch(() => undefined);
                    check();
                    return out.subarray(0, got);
                } finally {
                    readers.delete(reader);
                    reader.releaseLock();
                }
            });
        },
        tail(n, fallbackLimit) {
            return operation(async () => {
                if (local) {
                    const total = local.size;
                    const bytes = await local.slice(Math.max(0, total - n)).arrayBuffer();
                    check();
                    return { bytes: new Uint8Array(bytes), total };
                }
                const res = await fetchRemote({ Range: `bytes=-${n}` });
                check();
                if (res.status === 206) {
                    const total = Number(/\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1] ?? Number.NaN);
                    const buffer = await res.arrayBuffer();
                    check();
                    const bytes = new Uint8Array(buffer);
                    return { bytes, total: Number.isFinite(total) ? total : bytes.byteLength };
                }
                const declared = Number(res.headers.get("content-length") ?? Number.NaN);
                if (!Number.isFinite(declared) || declared > fallbackLimit) {
                    void res.body?.cancel().catch(() => undefined);
                    return null;
                }
                const blob = await readLimited(res, fallbackLimit, check, readers);
                check();
                const buffer = await blob.arrayBuffer();
                check();
                const all = new Uint8Array(buffer);
                return { bytes: all.subarray(Math.max(0, all.byteLength - n)), total: all.byteLength };
            });
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            activeResources.delete(resource);
            const pending = [...cancellations];
            cancellations.clear();
            source = undefined;
            local = undefined;
            blobs.clear();
            const urls = [...objectUrls];
            objectUrls.clear();
            typedUrls.clear();
            plainUrl = undefined;
            const failures: unknown[] = [];
            const clean = (work: () => void) => {
                try {
                    work();
                } catch (error) {
                    failures.push(error);
                }
            };
            for (const cancel of pending) clean(cancel);
            clean(() => controller.abort());
            for (const reader of readers) clean(() => void reader.cancel().catch(() => undefined));
            readers.clear();
            for (const url of urls) clean(() => URL.revokeObjectURL(url));
            if (failures.length) throw new AggregateError(failures, "File resource cleanup failed");
        },
    };
    if (isCurrent()) activeResources.add(resource);
    else resource.dispose();
    return resource;
}
