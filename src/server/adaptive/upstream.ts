/**
 * The one read of the Pi's MJPEG that every adaptive client shares (FAILURE_MODES.md P1 to P4).
 *
 * It opens with the first subscriber and is destroyed with the last. Only the newest frame is kept. While subscribers
 * remain it reconnects with a capped backoff, and it never writes anything to the Pi but this one GET: kvmd's
 * streamer parameters are not read or changed here (I7).
 */

import { request as httpRequest, type IncomingMessage, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AdaptiveLimits } from "./limits";
import { jpegSize, MjpegParser, MjpegProtocolError } from "./mjpeg";

export interface UpstreamTarget {
    origin: URL;
    headers: Record<string, string>;
    rejectUnauthorized: boolean;
}

export interface Frame {
    /** 1, 2, 3 ... for as long as any client was subscribed; a reconnect carries on counting. */
    seq: number;
    jpeg: Buffer;
    /** Milliseconds since the epoch when the host finished reading it. */
    at: number;
    width: number;
    height: number;
}

export interface UpstreamStatus {
    state: "idle" | "connecting" | "streaming" | "backoff";
    subscribers: number;
    framesIn: number;
    bytesIn: number;
    badFrames: number;
    reconnects: number;
    lastError: string | null;
    lastFrameAgoMs: number | null;
    width: number | null;
    height: number | null;
}

type Waiter = { after: number; done: (frame: Frame | null) => void };

export class SharedUpstream {
    private subscribers = 0;
    private generation = 0;
    private state: UpstreamStatus["state"] = "idle";
    private current: Frame | null = null;
    private seq = 0;
    private framesIn = 0;
    private bytesIn = 0;
    private badFrames = 0;
    private reconnects = 0;
    private lastError: string | null = null;
    private request: ClientRequest | undefined;
    private response: IncomingMessage | undefined;
    private backoff: number;
    private connectedAt = 0;
    private retry: NodeJS.Timeout | undefined;
    private stall: NodeJS.Timeout | undefined;
    private readonly waiters = new Set<Waiter>();

    constructor(
        private readonly target: () => Promise<UpstreamTarget>,
        private readonly limits: AdaptiveLimits,
        private readonly now: () => number = Date.now,
    ) {
        this.backoff = limits.backoffFirstMs;
    }

    /** One more client. Pair with `release`. */
    acquire(): void {
        this.subscribers++;
        if (this.subscribers === 1) this.connect(++this.generation);
    }

    release(): void {
        if (this.subscribers === 0) return;
        this.subscribers--;
        if (this.subscribers === 0) this.stop();
    }

    /** The newest frame, or null when there is none (no stream yet, or the Pi dropped and has not come back). */
    latest(): Frame | null {
        return this.current;
    }

    /** Resolves with the first frame newer than `after`, or null after `timeoutMs`, on `signal`, or when the last subscriber left. */
    wait(after: number, timeoutMs: number, signal: AbortSignal): Promise<Frame | null> {
        const have = this.current;
        if (have && have.seq > after) return Promise.resolve(have);
        if (signal.aborted) return Promise.resolve(null);
        const { promise, resolve } = Promise.withResolvers<Frame | null>();
        const waiter: Waiter = {
            after,
            done: (frame) => {
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                this.waiters.delete(waiter);
                resolve(frame);
            },
        };
        const onAbort = () => waiter.done(null);
        const timer = setTimeout(onAbort, timeoutMs);
        timer.unref();
        signal.addEventListener("abort", onAbort, { once: true });
        this.waiters.add(waiter);
        return promise;
    }

    status(): UpstreamStatus {
        return {
            state: this.state,
            subscribers: this.subscribers,
            framesIn: this.framesIn,
            bytesIn: this.bytesIn,
            badFrames: this.badFrames,
            reconnects: this.reconnects,
            lastError: this.lastError,
            lastFrameAgoMs: this.current ? this.now() - this.current.at : null,
            width: this.current?.width ?? null,
            height: this.current?.height ?? null,
        };
    }

    /** Pi-side sockets and timers that are open, for the leak check. */
    handles(): { request: boolean; retryTimer: boolean; stallTimer: boolean; waiters: number } {
        return { request: this.request !== undefined, retryTimer: this.retry !== undefined, stallTimer: this.stall !== undefined, waiters: this.waiters.size };
    }

    private stop(): void {
        this.generation++;
        this.teardown();
        this.state = "idle";
        this.current = null;
        this.backoff = this.limits.backoffFirstMs;
        for (const waiter of [...this.waiters]) waiter.done(null);
    }

    private teardown(): void {
        clearTimeout(this.retry);
        clearTimeout(this.stall);
        this.retry = undefined;
        this.stall = undefined;
        this.response?.destroy();
        this.request?.destroy();
        this.response = undefined;
        this.request = undefined;
    }

    /**
     * The connection failed or ended: try again after the backoff, while anyone is still watching. The generation is the
     * attempt's identity: a failure ends it, so the `end` and `close` of one dead response (and the stall timer) count once.
     */
    private failed(generation: number, reason: string): void {
        if (generation !== this.generation) return;
        const next = ++this.generation;
        this.teardown();
        this.lastError = reason;
        // The Pi's picture is not known any more; no client is given the old one as if it were live.
        this.current = null;
        if (this.subscribers === 0) {
            this.state = "idle";
            return;
        }
        this.state = "backoff";
        this.reconnects++;
        const wait = this.backoff;
        this.backoff = Math.min(this.backoff * 2, this.limits.backoffMaxMs);
        this.retry = setTimeout(() => {
            this.retry = undefined;
            if (next === this.generation) this.connect(next);
        }, wait);
    }

    private connect(generation: number): void {
        this.state = "connecting";
        void this.target().then(
            (target) => {
                if (generation !== this.generation) return;
                this.open(generation, target);
            },
            (error: unknown) => this.failed(generation, error instanceof Error ? error.message : String(error)),
        );
    }

    private open(generation: number, target: UpstreamTarget): void {
        const { origin } = target;
        const secure = origin.protocol === "https:";
        const parser = new MjpegParser({
            maxFrameBytes: this.limits.maxFrameBytes,
            maxHeaderBytes: this.limits.maxHeaderBytes,
            onFrame: (jpeg, valid) => this.frame(generation, jpeg, valid),
        });
        const request = (secure ? httpsRequest : httpRequest)({
            protocol: origin.protocol,
            hostname: origin.hostname,
            port: origin.port || (secure ? 443 : 80),
            method: "GET",
            path: "/streamer/stream",
            headers: { ...target.headers, host: origin.host, accept: "multipart/x-mixed-replace, */*" },
            rejectUnauthorized: target.rejectUnauthorized,
        });
        this.request = request;
        this.armStall(generation);
        request.on("error", (error) => this.failed(generation, error.message));
        request.on("response", (response) => {
            if (generation !== this.generation) {
                response.destroy();
                return;
            }
            this.response = response;
            const type = String(response.headers["content-type"] ?? "");
            if (response.statusCode !== 200 || !type.toLowerCase().startsWith("multipart/x-mixed-replace")) {
                response.resume();
                this.failed(generation, `the Pi answered ${response.statusCode ?? "nothing"} (${type || "no content type"})`);
                return;
            }
            this.connectedAt = this.now();
            response.on("data", (chunk: Buffer) => {
                this.armStall(generation);
                try {
                    parser.push(chunk);
                } catch (error) {
                    this.failed(generation, error instanceof MjpegProtocolError ? error.message : String(error));
                }
            });
            response.on("end", () => this.failed(generation, "the Pi ended the stream"));
            response.on("error", (error) => this.failed(generation, error.message));
            response.on("close", () => this.failed(generation, "the Pi closed the stream"));
        });
        request.end();
    }

    private armStall(generation: number): void {
        clearTimeout(this.stall);
        this.stall = setTimeout(() => this.failed(generation, "the Pi sent nothing"), this.limits.upstreamStallMs);
        this.stall.unref();
    }

    private frame(generation: number, jpeg: Buffer, valid: boolean): void {
        if (generation !== this.generation) return;
        const size = valid ? jpegSize(jpeg) : null;
        if (!size) {
            this.badFrames++;
            return;
        }
        const at = this.now();
        this.state = "streaming";
        this.framesIn++;
        this.bytesIn += jpeg.length;
        // The backoff is forgotten only once the connection has held for a while, so a Pi that accepts and then drops
        // does not turn the wait back into the shortest one every time.
        if (at - this.connectedAt >= this.limits.backoffResetMs) this.backoff = this.limits.backoffFirstMs;
        const frame: Frame = { seq: ++this.seq, jpeg, at, width: size.width, height: size.height };
        this.current = frame;
        for (const waiter of [...this.waiters]) if (frame.seq > waiter.after) waiter.done(frame);
    }
}
