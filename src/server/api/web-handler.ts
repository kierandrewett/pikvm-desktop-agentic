/**
 * Adapter between Node's http server and a web-standard `(Request) => Response`
 * handler, which is what Effect's `HttpApiBuilder.toWebHandler` produces.
 *
 * It exists so the HttpApi runs inside the server we already have (one port,
 * one gate, one upgrade path) instead of beside it on a second listener.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** A save of every macro is at most 60 x 40 steps of 4000 characters; nothing
 *  this API takes is larger, and an unbounded read is a free way to exhaust
 *  memory for anyone who can reach the port. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export type WebHandler = (request: Request) => Promise<Response>;

/** Read the request body, or null when it is over the cap. */
async function readCapped(req: IncomingMessage): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > MAX_BODY_BYTES) return null;
        chunks.push(buf);
    }
    return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

/** Every error body from this API reads `{ error: string }`.
 *
 *  Handlers' own failures already do. The framework's failures do not: a body
 *  that fails schema decoding is `{ _tag: "HttpApiDecodeError", message, issues }`
 *  and an unmatched route is empty. A client should read one field whichever
 *  layer refused it, so those are rewritten here. */
function normaliseError(status: number, text: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = undefined;
    }
    const body = parsed as { error?: unknown; message?: unknown } | undefined;
    if (typeof body?.error === "string") return text;
    const message = typeof body?.message === "string" ? body.message : status === 404 ? "Not found" : `Error ${status}`;
    return JSON.stringify({ error: message });
}

/** Run one Node request through a web handler and write its response. */
export async function serveWith(handler: WebHandler, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await readCapped(req) : null;
    if (hasBody && body === null) return sendJson(res, 413, { error: "Request body too large" });

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) for (const v of value) headers.append(name, v);
        else if (value !== undefined) headers.set(name, value);
    }
    // Only the path and query matter to the router; the host is not trusted input.
    const request = new Request(new URL(req.url ?? "/", "http://localhost"), {
        method,
        headers,
        ...(body && body.length ? { body: new Uint8Array(body) } : {}),
    });

    let response: Response;
    try {
        response = await handler(request);
    } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : "Internal error" });
    }

    const out: Record<string, string> = {};
    response.headers.forEach((value, name) => {
        out[name] = value;
    });
    if (response.status < 400) {
        res.writeHead(response.status, out);
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
    }
    const text = normaliseError(response.status, await response.text());
    delete out["content-length"];
    res.writeHead(response.status, { ...out, "content-type": "application/json" });
    res.end(text);
}
