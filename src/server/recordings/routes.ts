import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { RECORDINGS_PATH } from "@pikvm/contracts/recordings";
import { json, readBody } from "../http";
import type { RecordingService } from "./service";
import { isRecordingId, RecordingRefusal } from "./store";

/**
 * `/app/api/v1/recordings/*`: session recordings, as the contract (packages/contracts/src/recordings.ts) defines them.
 *
 *   GET    /                    the list (`?status=` a comma list, `?sort=`) and whether this host can transcribe
 *   POST   /                    { mime, startedAt, target? }: a new recording
 *   GET    /search              `?q=&limit=&offset=&speaker=&from=&to=`: full text over transcripts and titles
 *   GET    /:id                 one recording
 *   PATCH  /:id                 { title }: rename
 *   DELETE /:id                 the recording, its transcript and its work files
 *   PUT    /:id/chunks/:n       the next chunk, as application/octet-stream, streamed to disk
 *   POST   /:id/finish          { durationMs, transcribe }
 *   GET    /:id/media           the file, with Range
 *   GET    /:id/transcript      the transcript JSON (404 until done)
 *   POST   /:id/transcribe      start or restart the transcription
 *
 * The route table (routes.ts) has judged the sign-in and required the `x-pikvm-recording: 1` header on every write. Here: a JSON
 * body on every write but a chunk, and an octet-stream body on a chunk. An id that is not 32 hex digits is a 404 before any file is
 * touched.
 */

export interface RecordingRoutes {
    handles(path: string): boolean;
    handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>;
}

const MAX_JSON_BYTES = 16 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
    let text: string;
    try {
        text = await readBody(req, MAX_JSON_BYTES);
    } catch {
        throw new RecordingRefusal("The request body is too large.", 413);
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new RecordingRefusal("The request body is not JSON.", 400);
    }
}

const contentType = (req: IncomingMessage): string => String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();

function requireType(req: IncomingMessage, expected: "application/json" | "application/octet-stream"): void {
    if (contentType(req) !== expected) throw new RecordingRefusal(`Expected ${expected}`, 415);
}

function methodNot(res: ServerResponse, ...allowed: string[]): void {
    res.setHeader("allow", allowed.join(", "));
    json(res, 405, { error: `${allowed.join(" or ")} only` });
}

/** One `Range` header against a file of `size` bytes: the bytes to send, "all" to send everything, or null when it cannot be satisfied. */
function byteRange(header: string | undefined, size: number): { start: number; end: number } | "all" | null {
    if (header === undefined) return "all";
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    // Not a single byte range (a unit this host does not know, or several ranges): the whole file is a valid answer.
    if (!match) return "all";
    const [, from = "", to = ""] = match;
    if (from === "" && to === "") return "all";
    if (from === "") {
        const suffix = Number(to);
        if (suffix === 0 || size === 0) return null;
        return { start: Math.max(0, size - suffix), end: size - 1 };
    }
    const start = Number(from);
    const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
    if (start >= size || start > end) return null;
    return { start, end };
}

async function serveMedia(req: IncomingMessage, res: ServerResponse, media: { path: string; size: number; mime: string }): Promise<void> {
    const headers = {
        "content-type": media.mime,
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
    };
    const range = byteRange(req.headers.range, media.size);
    if (range === null) {
        res.writeHead(416, { ...headers, "content-range": `bytes */${media.size}`, "content-type": "application/json" });
        res.end(JSON.stringify({ error: "That byte range is outside the recording." }));
        return;
    }
    const part = range === "all" ? null : range;
    const length = part ? part.end - part.start + 1 : media.size;
    res.writeHead(part ? 206 : 200, {
        ...headers,
        "content-length": String(length),
        ...(part ? { "content-range": `bytes ${part.start}-${part.end}/${media.size}` } : {}),
    });
    if (req.method === "HEAD" || length === 0) {
        res.end();
        return;
    }
    await pipeline(createReadStream(media.path, part ? { start: part.start, end: part.end } : {}), res);
}

export function createRecordingRoutes(service: RecordingService): RecordingRoutes {
    async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
        const method = req.method ?? "GET";
        try {
            await service.ready;
        } catch {
            throw new RecordingRefusal("Recordings could not be loaded on this host; see its log.", 503);
        }
        const rest = path.slice(RECORDINGS_PATH.length);

        const query = new URL(req.url ?? "/", "http://localhost").searchParams;

        if (rest === "") {
            if (method === "GET") return json(res, 200, await service.list({ status: query.get("status"), sort: query.get("sort") }));
            if (method === "POST") {
                requireType(req, "application/json");
                return json(res, 201, await service.create(await readJson(req)));
            }
            return methodNot(res, "GET", "POST");
        }

        if (rest === "/search") {
            if (method !== "GET") return methodNot(res, "GET");
            return json(res, 200, service.search(query));
        }

        const parts = rest.slice(1).split("/");
        let id: string;
        try {
            id = decodeURIComponent(parts[0] ?? "");
        } catch {
            return json(res, 404, { error: "There is no such recording." });
        }
        if (!isRecordingId(id)) return json(res, 404, { error: "There is no such recording." });

        if (parts.length === 1) {
            if (method === "GET") return json(res, 200, service.view(id));
            if (method === "PATCH") {
                requireType(req, "application/json");
                return json(res, 200, await service.rename(id, await readJson(req)));
            }
            if (method === "DELETE") {
                requireType(req, "application/json");
                await service.remove(id);
                return json(res, 200, { deleted: true });
            }
            return methodNot(res, "GET", "PATCH", "DELETE");
        }

        const what = parts[1];
        if (what === "chunks" && parts.length === 3) {
            if (method !== "PUT") return methodNot(res, "PUT");
            requireType(req, "application/octet-stream");
            const n = /^\d{1,9}$/.test(parts[2] ?? "") ? Number(parts[2]) : NaN;
            if (!Number.isInteger(n)) throw new RecordingRefusal("The chunk number must be a whole number from 0.", 400);
            const declared = Number(req.headers["content-length"]);
            try {
                return json(res, 200, await service.chunk(id, n, req, Number.isInteger(declared) && declared >= 0 ? declared : null));
            } catch (error) {
                // The rest of an oversized or refused body is not worth reading.
                if (error instanceof RecordingRefusal && (error.status === 413 || error.status === 507)) res.setHeader("connection", "close");
                throw error;
            }
        }
        if (parts.length !== 2) return json(res, 404, { error: "Not found" });

        if (what === "finish") {
            if (method !== "POST") return methodNot(res, "POST");
            requireType(req, "application/json");
            return json(res, 200, await service.finish(id, await readJson(req)));
        }
        if (what === "media") {
            if (method !== "GET" && method !== "HEAD") return methodNot(res, "GET", "HEAD");
            return serveMedia(req, res, service.media(id));
        }
        if (what === "transcript") {
            if (method !== "GET") return methodNot(res, "GET");
            const text = await service.transcript(id);
            res.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
            res.end(text);
            return;
        }
        if (what === "transcribe") {
            if (method !== "POST") return methodNot(res, "POST");
            requireType(req, "application/json");
            return json(res, 200, await service.transcribe(id));
        }
        return json(res, 404, { error: "Not found" });
    }

    return {
        handles: (path) => path === RECORDINGS_PATH || path.startsWith(`${RECORDINGS_PATH}/`),
        async handle(req, res, path) {
            try {
                await route(req, res, path);
            } catch (error) {
                if (error instanceof RecordingRefusal) return json(res, error.status, { ...error.extra, error: error.message });
                // The browser went away in the middle of a body or a download: there is nobody to answer.
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ERR_STREAM_PREMATURE_CLOSE" || code === "ECONNRESET" || code === "ABORT_ERR") return void res.destroy();
                console.error("[recordings] route failed:", error);
                if (res.headersSent) return void res.destroy();
                json(res, 500, { error: "Internal error" });
            }
        },
    };
}
