import type { IncomingMessage, ServerResponse } from "node:http";
import { CURSOR_PATH } from "@pikvm/contracts/api";
import { json } from "../http";
import type { CursorHub } from "./hub";

/**
 * `GET /app/api/v1/cursor`: the shared cursor as server-sent events, one `CursorUpdate` per event, the current one
 * first when the position is known.
 *
 * It sits behind the gate like everything under /app and reads nothing from the client: which updates a page ignores
 * (its own) is its business. A client that reads slowly is not queued behind: while its socket is full the newest
 * position replaces the one waiting, and goes out as soon as the socket drains.
 */

/** A keep-alive comment this often, so a proxy that closes idle streams does not close this one. */
export const CURSOR_KEEPALIVE_MS = 15_000;

export interface CursorRoutes {
    handles(path: string): boolean;
    handle(req: IncomingMessage, res: ServerResponse): void;
}

export function createCursorRoutes(hub: CursorHub, keepAliveMs = CURSOR_KEEPALIVE_MS): CursorRoutes {
    function stream(req: IncomingMessage, res: ServerResponse): void {
        res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            connection: "keep-alive",
            // A proxy in front must not buffer a stream the page waits on.
            "x-accel-buffering": "no",
        });
        let waiting: string | null = null;
        const write = (data: string): void => {
            if (res.writableNeedDrain) {
                waiting = data;
                return;
            }
            // Whatever waited is older than this: it must not come out after it on the next drain.
            waiting = null;
            res.write(data);
        };
        res.on("drain", () => {
            if (waiting === null) return;
            const data = waiting;
            waiting = null;
            res.write(data);
        });
        // The first write also flushes the headers, so the page's `open` fires before any position is known.
        res.write(": cursor\n\n");
        const current = hub.current();
        if (current) write(`data: ${JSON.stringify(current)}\n\n`);
        const off = hub.subscribe((update) => write(`data: ${JSON.stringify(update)}\n\n`));
        const timer = setInterval(() => {
            if (!res.writableNeedDrain) res.write(": keep-alive\n\n");
        }, keepAliveMs);
        timer.unref();
        req.on("close", () => {
            off();
            clearInterval(timer);
        });
    }

    return {
        handles: (path) => path === CURSOR_PATH,
        handle(req, res) {
            if (req.method !== "GET") return json(res, 405, { error: "GET only" });
            stream(req, res);
        },
    };
}
