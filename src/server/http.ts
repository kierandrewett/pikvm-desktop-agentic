/** Small helpers shared by the route table. */

import type { IncomingMessage, ServerResponse } from "node:http";

/** A JSON reply.
 *
 *  No `Access-Control-Allow-Origin`. This used to send `*`, and because loopback
 *  skips the access gate, any web page open in the user's browser could read
 *  the state and macros of a desktop app listening on 127.0.0.1. Our pages are
 *  same-origin and need no CORS at all. */
export function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

/** The request body as text. For the small form posts the sign-in uses. */
export async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf-8");
}
