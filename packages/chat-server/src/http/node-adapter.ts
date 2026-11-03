/**
 * Bridges `node:http` and the fetch API, so Hono routes and the MCP handlers run on a plain Node server unchanged.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/** A fetch `Request` for an incoming message. Its signal aborts when the client goes away before the reply ends. */
export function toRequest(req: IncomingMessage, origin: string): Request {
    const controller = new AbortController();
    // `close` fires on the request stream when the connection drops; on a normal finish the response ends first.
    req.on("close", () => {
        if (!req.complete) controller.abort();
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const v of value) headers.append(name, v);
        else headers.set(name, value);
    }
    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    return new Request(new URL(req.url ?? "/", origin), {
        method,
        headers,
        signal: controller.signal,
        ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}),
    } as RequestInit);
}

/** Write a fetch `Response` to the socket, streaming its body. A write to a closed socket stops the stream. */
export async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((value, name) => {
        if (name === "set-cookie") return;
        headers[name] = value;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers["set-cookie"] = cookies;
    res.writeHead(response.status, response.statusText, headers);
    if (!response.body) return void res.end();
    const reader = response.body.getReader();
    res.on("close", () => void reader.cancel().catch(() => undefined));
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(value)) await new Promise<void>((resolve) => res.once("drain", resolve));
        }
    } catch {
        // The upstream body failed mid-stream: nothing sensible is left to send.
    } finally {
        res.end();
    }
}
