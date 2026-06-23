/**
 * Live chat broadcast — fans the agent's UI message chunks out to EVERY connected
 * client (web + desktop), so all of them see the same conversation in real time,
 * not just the one that started the run.
 *
 * The server already turns agent events into Vercel-AI-SDK UI message chunks (via
 * `bridgeAgentEvents`). This hub sends those same chunks — plus run framing
 * (`begin`/`end`) and `user` messages — to all `/_agent/api/events` subscribers as
 * Server-Sent Events. A client-side reducer rebuilds the messages from them.
 *
 * The actor's own `useChat` POST stream is left exactly as-is; this is additive,
 * so a bug here can't break the working send/stream path. Each run is tagged with
 * the initiating client's id so that client ignores the echo of its own run.
 */

import type { ServerResponse } from "node:http";

/** A run/message framing or content chunk sent to spectators. */
export type ChatBroadcastChunk =
    | { type: "begin"; clientId?: string } // an assistant run started
    | { type: "end" } // …and finished
    | { type: "user"; id: string; clientId?: string; text: string; images?: { url: string }[] }
    | { type: string; [k: string]: unknown }; // the AI SDK UI chunks (text-delta, tool-*, data-*)

export class ChatBroadcast {
    private clients = new Set<ServerResponse>();

    /** Register an SSE response; auto-removed when it closes. */
    add(res: ServerResponse): void {
        this.clients.add(res);
        const drop = () => this.clients.delete(res);
        res.on("close", drop);
        res.on("error", drop);
    }

    /** Send one chunk to every connected client. */
    send(chunk: ChatBroadcastChunk): void {
        const line = `data: ${JSON.stringify(chunk)}\n\n`;
        for (const res of this.clients) {
            try {
                // A slow / half-dead client (sleeping browser, dropped network) that
                // isn't draining must NOT back up an unbounded socket buffer — these
                // carry base64 screenshots, so it balloons fast. Cut it loose once its
                // unsent buffer crosses ~16MB; it reconnects cleanly when it's back.
                if (res.writableLength > 16 * 1024 * 1024) {
                    this.clients.delete(res);
                    try {
                        res.destroy();
                    } catch {
                        /* ignore */
                    }
                    continue;
                }
                res.write(line);
            } catch {
                /* a dead socket is cleaned up by its close handler */
            }
        }
    }

    /** A minimal `UIMessageStreamWriter`-shaped adapter for `bridgeAgentEvents`. */
    writer(): { write: (chunk: unknown) => void } {
        return { write: (chunk: unknown) => this.send(chunk as ChatBroadcastChunk) };
    }

    count(): number {
        return this.clients.size;
    }
}
