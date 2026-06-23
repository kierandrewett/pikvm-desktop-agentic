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
 * EXACT late-join sync: SSE has no history, so a client that connects mid-run would
 * miss everything before it joined. To make spectating lag-free and complete, we
 * BUFFER the in-flight exchange's chunks (the starting `user` message, `begin`, and
 * every content chunk) and replay them to any client the moment it connects. The
 * client's reducer rebuilds the precise current state, then continues live — no gap,
 * no delay, no missing history. The buffer is bounded by pruning old screenshots'
 * image data (keeping the most recent few, exactly as the client itself prunes), so
 * replay stays faithful to what the actor actually shows without unbounded memory.
 *
 * The actor's own `useChat` POST stream is left exactly as-is; this is additive,
 * so a bug here can't break the working send/stream path. Each run is tagged with
 * the initiating client's id so that client ignores the echo of its own run, and
 * with a stable `messageId` so replays/reconnects reconcile to one message (no dup).
 */

import type { ServerResponse } from "node:http";

/** A run/message framing or content chunk sent to spectators. */
export type ChatBroadcastChunk =
    | { type: "begin"; clientId?: string; messageId?: string } // an assistant run started
    | { type: "end" } // …and finished
    | { type: "user"; id: string; clientId?: string; text: string; images?: { url: string }[] }
    | { type: string; [k: string]: unknown }; // the AI SDK UI chunks (text-delta, tool-*, data-*)

// Keep this many recent screenshots with full image data in the replay buffer; older
// ones are stripped to a placeholder (the client prunes its own screenshot history the
// same way, so this loses nothing the actor still shows). Bounds buffer memory.
const KEEP_SHOTS = 6;

export class ChatBroadcast {
    private clients = new Set<ServerResponse>();
    // The run currently in flight, if any (null between runs).
    private liveRun: { clientId?: string; messageId?: string } | null = null;
    // Every chunk of the in-flight exchange, in order, for exact late-join replay.
    private buffer: ChatBroadcastChunk[] = [];
    // The most recent `user` chunk not yet folded into a run — so the prompt that
    // STARTS a run (sent just before `begin`) is included at the head of the buffer.
    private pendingUser: ChatBroadcastChunk | null = null;

    /** Register an SSE response; auto-removed when it closes. Replays the in-flight
     *  exchange in full so a mid-run joiner reconstructs the exact current state. */
    add(res: ServerResponse): void {
        this.clients.add(res);
        const drop = () => this.clients.delete(res);
        res.on("close", drop);
        res.on("error", drop);
        if (this.liveRun) {
            for (const chunk of this.buffer) this.writeTo(res, chunk);
        }
    }

    /** Send one chunk to every connected client (and record it for replay). */
    send(chunk: ChatBroadcastChunk): void {
        this.track(chunk);
        const line = `data: ${JSON.stringify(chunk)}\n\n`;
        for (const res of this.clients) {
            if (this.overBuffered(res)) continue;
            try {
                res.write(line);
            } catch {
                /* a dead socket is cleaned up by its close handler */
            }
        }
    }

    /** Update the replay buffer + live-run state from run framing. */
    private track(chunk: ChatBroadcastChunk): void {
        if (chunk.type === "user") {
            // A new prompt — remember it so the next `begin` carries it into the buffer.
            this.pendingUser = chunk;
            return;
        }
        if (chunk.type === "begin") {
            const cid = (chunk as { clientId?: string }).clientId;
            const mid = (chunk as { messageId?: string }).messageId;
            this.liveRun = { ...(cid ? { clientId: cid } : {}), ...(mid ? { messageId: mid } : {}) };
            // Start the exchange buffer with the prompt that triggered it (if any).
            this.buffer = this.pendingUser ? [this.pendingUser, chunk] : [chunk];
            this.pendingUser = null;
            return;
        }
        if (chunk.type === "end") {
            this.liveRun = null; // run done — late joiners now use the persisted reload
            this.buffer = []; // free it: add() only replays while liveRun is set
            this.pendingUser = null;
            return;
        }
        if (this.liveRun) {
            this.buffer.push(chunk);
            this.pruneShots();
            this.capBuffer();
        }
    }

    /** Keep the replay buffer bounded for a long run: screenshots are pruned separately;
     *  here we cap the TOTAL chunk count, dropping the oldest CONTENT chunks (never the
     *  framing user/begin) so a late joiner still gets the prompt + a long recent tail. */
    private capBuffer(): void {
        const MAX = 4000;
        if (this.buffer.length <= MAX) return;
        const head = this.buffer.filter((c) => c.type === "user" || c.type === "begin");
        const rest = this.buffer.filter((c) => c.type !== "user" && c.type !== "begin");
        this.buffer = [...head, ...rest.slice(rest.length - (MAX - head.length))];
    }

    /** Strip image data from all but the most recent few screenshots in the buffer. */
    private pruneShots(): void {
        const shots = this.buffer.filter((c) => c.type === "data-screenshot");
        if (shots.length <= KEEP_SHOTS) return;
        for (const s of shots.slice(0, shots.length - KEEP_SHOTS)) {
            const data = (s as { data?: { src?: string } }).data;
            if (data && data.src) data.src = ""; // ShotImage handles empty src
        }
    }

    private overBuffered(res: ServerResponse): boolean {
        // A slow / half-dead client (sleeping browser, dropped network) that isn't
        // draining must NOT back up an unbounded socket buffer — these carry base64
        // screenshots, so it balloons fast. Cut it loose once its unsent buffer crosses
        // ~16MB; it reconnects cleanly (and re-syncs via replay) when it's back.
        if (res.writableLength > 16 * 1024 * 1024) {
            this.clients.delete(res);
            try {
                res.destroy();
            } catch {
                /* ignore */
            }
            return true;
        }
        return false;
    }

    private writeTo(res: ServerResponse, chunk: ChatBroadcastChunk): void {
        if (this.overBuffered(res)) return;
        try {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        } catch {
            /* dead socket cleaned up by its close handler */
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
