import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RECORDING_LIVE_PATH, RECORDINGS_PATH } from "@pikvm/contracts/recordings";
import { json, readBody } from "../http";
import type { RecordingService } from "./service";
import { isRecordingId, RecordingRefusal } from "./store";

/**
 * `/app/api/v1/recordings/*`: session recordings, as the contract (packages/contracts/src/recordings.ts) defines them.
 *
 *   GET    /                    the list (`?status=` a comma list, `?sort=`) and whether this host can transcribe
 *   POST   /start               { target?, mic, title?, transcribe? }: the host starts recording the PiKVM's stream
 *   GET    /live                the capture in progress and the recordings being finished; `Accept: text/event-stream` for a stream
 *   GET    /search              `?q=&limit=&offset=&speaker=&from=&to=`: full text over transcripts and titles
 *   GET    /:id                 one recording
 *   PATCH  /:id                 { title }: rename
 *   DELETE /:id                 the recording, its transcript and its work files; a recording in progress is stopped first
 *   POST   /:id/stop            end the capture
 *   WS     /:id/mic             Opus frames from the page's microphone (an upgrade: `handleUpgrade`)
 *   GET    /:id/media           the file, with Range
 *   GET    /:id/transcript      the transcript JSON (404 until done)
 *   POST   /:id/transcribe      start or restart the transcription
 *   GET    /youtube             the YouTube upload settings; the client secret and the refresh token are never returned
 *   PATCH  /youtube             { autoUpload?, privacy?, clientId?, clientSecret? }: change them (null or "" clears an id or secret)
 *   POST   /youtube/connect     start the YouTube sign-in: the code to type at Google is in the reply
 *   POST   /youtube/disconnect  revoke the sign-in here and at Google, and turn auto-upload off
 *   POST   /youtube/backfill    queue the existing finished recordings that were never uploaded, oldest first
 *   POST   /:id/youtube         queue the recording for YouTube now (a first upload or a retry)
 *
 * The route table (routes.ts) has judged the sign-in and required the `x-pikvm-recording: 1` header on every write. Here: a JSON
 * body on every write. The microphone socket cannot carry that header; the router checks the sign-in and that the page is of this
 * host (the chat socket's rule). An id that is not 32 hex digits is a 404 before any file is touched.
 */

export interface RecordingRoutes {
    handles(path: string): boolean;
    handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>;
    /** Whether an upgrade at this path is the microphone socket of a recording. */
    handlesUpgrade(path: string): boolean;
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, path: string): void;
}

const MIC_PATH = /^\/app\/api\/v1\/recordings\/([0-9a-f]{32})\/mic$/;

/** A line of keep-alive this often on the live stream while nothing runs, so a proxy does not close it. */
const LIVE_KEEPALIVE_TICKS = 15;

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

function requireJson(req: IncomingMessage): void {
    if (contentType(req) !== "application/json") throw new RecordingRefusal("Expected application/json", 415);
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
    function liveStream(res: ServerResponse): void {
        res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            connection: "keep-alive",
            // A proxy in front must not buffer a stream the page waits on.
            "x-accel-buffering": "no",
        });
        const send = (): void => {
            if (!res.writableNeedDrain) res.write(`data: ${JSON.stringify(service.live())}\n\n`);
        };
        res.write(": live\n\n");
        send();
        const off = service.onLive(send);
        let idle = 0;
        // While something runs the elapsed time moves, so the page hears every second; otherwise only when something changes.
        const timer = setInterval(() => {
            const live = service.live();
            if (live.recording !== null || live.finishing.length > 0) return send();
            idle += 1;
            if (idle % LIVE_KEEPALIVE_TICKS === 0 && !res.writableNeedDrain) res.write(": keep-alive\n\n");
        }, 1000);
        timer.unref();
        res.on("close", () => {
            off();
            clearInterval(timer);
        });
    }

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
            if (method !== "GET") return methodNot(res, "GET");
            return json(res, 200, await service.list({ status: query.get("status"), sort: query.get("sort") }));
        }

        if (rest === "/start") {
            if (method !== "POST") return methodNot(res, "POST");
            requireJson(req);
            return json(res, 201, await service.startRecording(await readJson(req)));
        }

        if (path === RECORDING_LIVE_PATH) {
            if (method !== "GET") return methodNot(res, "GET");
            if (String(req.headers.accept ?? "").includes("text/event-stream")) return liveStream(res);
            return json(res, 200, service.live());
        }

        if (rest === "/search") {
            if (method !== "GET") return methodNot(res, "GET");
            return json(res, 200, service.search(query));
        }

        if (rest === "/youtube") {
            if (method === "GET") return json(res, 200, service.youtubeSettings());
            if (method === "PATCH") {
                requireJson(req);
                return json(res, 200, await service.updateYouTube(await readJson(req)));
            }
            return methodNot(res, "GET", "PATCH");
        }

        if (rest === "/youtube/backfill") {
            if (method !== "POST") return methodNot(res, "POST");
            requireJson(req);
            return json(res, 200, await service.backfillYouTube());
        }

        if (rest === "/youtube/connect") {
            if (method !== "POST") return methodNot(res, "POST");
            requireJson(req);
            return json(res, 200, await service.connectYouTube());
        }

        if (rest === "/youtube/disconnect") {
            if (method !== "POST") return methodNot(res, "POST");
            requireJson(req);
            return json(res, 200, await service.disconnectYouTube());
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
                requireJson(req);
                return json(res, 200, await service.rename(id, await readJson(req)));
            }
            if (method === "DELETE") {
                requireJson(req);
                await service.remove(id);
                return json(res, 200, { deleted: true });
            }
            return methodNot(res, "GET", "PATCH", "DELETE");
        }

        const what = parts[1];
        if (parts.length !== 2) return json(res, 404, { error: "Not found" });

        if (what === "stop") {
            if (method !== "POST") return methodNot(res, "POST");
            requireJson(req);
            return json(res, 200, await service.stopRecording(id));
        }
        if (what === "media") {
            if (method !== "GET" && method !== "HEAD") return methodNot(res, "GET", "HEAD");
            return serveMedia(req, res, await service.media(id));
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
            requireJson(req);
            return json(res, 200, await service.transcribe(id));
        }
        if (what === "youtube") {
            if (method !== "POST") return methodNot(res, "POST");
            requireJson(req);
            return json(res, 200, await service.uploadYouTube(id));
        }
        return json(res, 404, { error: "Not found" });
    }

    return {
        handles: (path) => path === RECORDINGS_PATH || path.startsWith(`${RECORDINGS_PATH}/`),
        handlesUpgrade: (path) => MIC_PATH.test(path),
        handleUpgrade(req, socket, head, path) {
            const id = MIC_PATH.exec(path)?.[1];
            if (id === undefined) return void socket.destroy();
            service.attachMic(req, socket, head, id);
        },
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
