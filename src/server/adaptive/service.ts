/**
 * The adaptive picture: per-device re-encoded MJPEG that is never queued (FAILURE_MODES.md). One shared read of the Pi
 * (upstream.ts), one rung per device key (ladder.ts), one pump per connection that drops what the client cannot take.
 *
 *   GET /app/api/v1/adaptive/stream?key=<device key>&profile=auto|medium|low   multipart/x-mixed-replace JPEGs
 *   GET /app/api/v1/adaptive/status[?key=<device key>]                          JSON, the caller's own devices only
 *
 * The normal `/streamer/stream` proxy (proxy/kvmd.ts) is not touched by any of it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "../http";
import type { SignedIn } from "../web-auth";
import { readTcpQueues, LinkMeter } from "./backlog";
import { createEncoder, type Encoder } from "./encoder";
import { RUNGS, RungController, isProfile, type Profile } from "./ladder";
import { DEFAULT_LIMITS, type AdaptiveLimits } from "./limits";
import { SharedUpstream, type UpstreamTarget } from "./upstream";

export const ADAPTIVE_STREAM_PATH = "/app/api/v1/adaptive/stream";
export const ADAPTIVE_STATUS_PATH = "/app/api/v1/adaptive/status";
const BOUNDARY = "adaptiveframe";
/** I1 */
const DEVICE_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export interface AdaptiveDeps {
    /** Where the Pi is and how to sign in to it (the same thing the proxy uses). */
    target: () => Promise<UpstreamTarget>;
    limits?: AdaptiveLimits;
    now?: () => number;
    /** Test seams. */
    readQueues?: () => Promise<Map<string, number> | null>;
    encoder?: Encoder;
}

interface Device {
    owner: string;
    key: string;
    profile: Profile;
    controller: RungController;
    connection: Connection | null;
    lastSeen: number;
    since: number;
    bytesSent: number;
    framesSent: number;
    framesDropped: number;
    /** What the last (or current) connection's meter said; kept after it closed so the status still has it. */
    capacityBps: number;
    deliveredBps: number;
    queuedBytes: number;
    kernelQueue: boolean;
}

interface Connection {
    device: Device;
    res: ServerResponse;
    meter: LinkMeter;
    abort: AbortController;
    closed: boolean;
}

export interface AdaptiveService {
    handles(path: string): boolean;
    handle(req: IncomingMessage, res: ServerResponse, path: string, signedIn?: SignedIn): void;
    /** Ends every connection and the Pi read. */
    dispose(): void;
}

export function createAdaptive(deps: AdaptiveDeps): AdaptiveService {
    const limits = deps.limits ?? DEFAULT_LIMITS;
    const now = deps.now ?? Date.now;
    const readQueues = deps.readQueues ?? (() => readTcpQueues());
    const encoder = deps.encoder ?? createEncoder(limits.maxEncodes);
    const upstream = new SharedUpstream(deps.target, limits, now);
    const devices = new Map<string, Device>();
    const connections = new Set<Connection>();
    let ticker: NodeJS.Timeout | undefined;
    let ticking = false;

    function forgetIdle(): void {
        const t = now();
        for (const [id, device] of devices) if (!device.connection && t - device.lastSeen > limits.deviceIdleMs) devices.delete(id);
    }

    function device(owner: string, key: string, profile: Profile): Device | null {
        const id = `${owner}\n${key}`;
        const have = devices.get(id);
        if (have) {
            // The ceiling follows the profile the page asks for now; a worse rung than it is kept.
            have.controller.setProfile(profile);
            have.profile = profile;
            return have;
        }
        forgetIdle();
        if (devices.size >= limits.maxDevices) {
            // The longest idle goes first; a device with a connection never does.
            let oldest: [string, Device] | undefined;
            for (const entry of devices) if (!entry[1].connection && (!oldest || entry[1].lastSeen < oldest[1].lastSeen)) oldest = entry;
            if (!oldest) return null;
            devices.delete(oldest[0]);
        }
        const t = now();
        const created: Device = {
            owner,
            key,
            profile,
            controller: new RungController(limits, profile, t),
            connection: null,
            lastSeen: t,
            since: t,
            bytesSent: 0,
            framesSent: 0,
            framesDropped: 0,
            capacityBps: 0,
            deliveredBps: 0,
            queuedBytes: 0,
            kernelQueue: false,
        };
        devices.set(id, created);
        return created;
    }

    function close(conn: Connection, reason: "client" | "replaced" | "dead" | "upstream" | "dispose"): void {
        if (conn.closed) return;
        conn.closed = true;
        conn.abort.abort();
        connections.delete(conn);
        upstream.release();
        const dev = conn.device;
        if (dev.connection === conn) dev.connection = null;
        dev.lastSeen = now();
        dev.queuedBytes = 0;
        if (connections.size === 0 && ticker) {
            clearInterval(ticker);
            ticker = undefined;
        }
        if (reason === "client") return;
        // The Pi gone is the one end that is not an error for the page: the stream finishes and it asks again.
        if (reason === "upstream" && !conn.res.destroyed) conn.res.end();
        else conn.res.destroy();
    }

    /** One look at every client's queue (A1), and the end of any that has taken nothing for too long (A5). */
    async function tick(): Promise<void> {
        if (ticking) return;
        ticking = true;
        try {
            const queues = await readQueues();
            const t = now();
            for (const conn of [...connections]) {
                const socket = conn.res.socket;
                if (!socket || conn.closed) continue;
                const kernel = queues ? (queues.get(`${socket.localPort}:${socket.remotePort}`) ?? 0) : null;
                conn.meter.tick(t, conn.res.writableLength, kernel);
                const dev = conn.device;
                dev.capacityBps = conn.meter.capacityBps;
                dev.deliveredBps = conn.meter.deliveredBps;
                dev.queuedBytes = conn.meter.queued(conn.res.writableLength);
                dev.kernelQueue = conn.meter.kernel;
                if (conn.meter.dead(t, conn.res.writableLength)) close(conn, "dead");
            }
        } finally {
            ticking = false;
        }
    }

    function sleep(ms: number, signal: AbortSignal): Promise<void> {
        const { promise, resolve } = Promise.withResolvers<void>();
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
        return promise;
    }

    /** The loop of one client: the newest frame, when it is due and the client can take it, at the device's rung. */
    async function pump(conn: Connection): Promise<void> {
        const { res, device: dev, meter, abort } = conn;
        let lastSeq = 0;
        let lastSentAt = 0;
        const first = await upstream.wait(0, limits.firstFrameMs, abort.signal);
        if (conn.closed) return;
        if (!first) {
            // P3: nothing to show, said before any stream header so the page's <img> gets an error and can fall back.
            res.setHeader("retry-after", "5");
            json(res, 503, { error: "No picture from the PiKVM" });
            close(conn, "client");
            return;
        }
        res.writeHead(200, {
            "content-type": `multipart/x-mixed-replace;boundary=${BOUNDARY}`,
            "cache-control": "no-store, no-cache, must-revalidate",
            pragma: "no-cache",
            "x-accel-buffering": "no",
        });
        res.socket?.setNoDelay(true);
        res.socket?.setKeepAlive(true, 15_000);
        while (!conn.closed) {
            let frame = await upstream.wait(lastSeq, limits.upstreamGoneMs, abort.signal);
            if (conn.closed) return;
            if (!frame) {
                // Nothing for upstreamGoneMs: the Pi is gone (P3). A Pi that is only still sends keyframes.
                close(conn, "upstream");
                return;
            }
            let t = now();
            const due = lastSentAt + 1000 / RUNGS[dev.controller.rung]!.maxFps - t;
            if (due > 0) {
                // The frame cap: wait, then take whatever is newest by then. What came in between is gone (A2).
                await sleep(due, abort.signal);
                if (conn.closed) return;
                const newest = upstream.latest();
                if (!newest) continue;
                frame = newest;
                t = now();
            }
            const rungIndex = dev.controller.rung;
            const rung = RUNGS[rungIndex]!;
            const queued = meter.queued(res.writableLength);
            if (queued > meter.limit()) {
                // A1: the client has not taken what it was sent. Not queued behind it: dropped, and the rung falls.
                dev.framesDropped++;
                dev.controller.backlog(t);
                lastSeq = frame.seq;
                continue;
            }
            dev.controller.ok(t);
            const out = await encoder.encode(frame, rungIndex);
            lastSeq = frame.seq;
            if (conn.closed) return;
            if (!out) continue;
            const head = Buffer.from(
                `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${out.length}\r\nX-Timestamp: ${(frame.at / 1000).toFixed(6)}\r\nX-Adaptive-Rung: ${rung.name}\r\n\r\n`,
            );
            res.cork();
            res.write(head);
            res.write(out);
            res.write("\r\n");
            res.uncork();
            const bytes = head.length + out.length + 2;
            meter.sent += bytes;
            dev.bytesSent += bytes;
            dev.framesSent++;
            lastSentAt = t;
        }
    }

    function stream(req: IncomingMessage, res: ServerResponse, url: URL, signedIn?: SignedIn): void {
        const key = url.searchParams.get("key") ?? "";
        if (!DEVICE_KEY.test(key)) return json(res, 400, { error: "key must be 8 to 64 characters of A-Z a-z 0-9 _ -" });
        const profile = url.searchParams.get("profile") ?? "auto";
        if (!isProfile(profile)) return json(res, 400, { error: "profile must be auto, medium or low" });
        const owner = signedIn ? `${signedIn.method}:${signedIn.subject}` : "local";
        const id = `${owner}\n${key}`;
        // A device's own new connection replaces its old one (I3), so the old one does not count.
        const replacing = devices.get(id)?.connection ? 1 : 0;
        if (connections.size - replacing >= limits.maxClients) {
            res.setHeader("retry-after", "5");
            return json(res, 503, { error: "Too many adaptive pictures open on this host" });
        }
        try {
            encoder.ready();
        } catch {
            return json(res, 503, { error: "The image library is not available on this host" });
        }
        const dev = device(owner, key, profile);
        if (!dev) return json(res, 503, { error: "Too many devices" });
        const conn: Connection = {
            device: dev,
            res,
            meter: new LinkMeter(limits, now()),
            abort: new AbortController(),
            closed: false,
        };
        // The new connection takes its Pi subscription before the old gives its up, so a reconnect never closes the Pi read.
        upstream.acquire();
        const old = dev.connection;
        dev.connection = conn;
        connections.add(conn);
        if (old) close(old, "replaced");
        // `close` released one subscription for the old; the count is right again: one for each live connection.
        res.on("close", () => close(conn, "client"));
        req.on("error", () => close(conn, "client"));
        ticker ??= setInterval(() => void tick().catch(() => undefined), limits.tickMs);
        ticker.unref();
        pump(conn).catch((error: unknown) => {
            // T3: a failure of one client's loop is that client's alone.
            console.error("[adaptive] a picture stream failed:", error);
            close(conn, "dispose");
        });
    }

    function status(res: ServerResponse, url: URL, signedIn?: SignedIn): void {
        forgetIdle();
        const owner = signedIn ? `${signedIn.method}:${signedIn.subject}` : "local";
        const only = url.searchParams.get("key");
        const rows = [...devices.values()]
            .filter((d) => d.owner === owner && (only === null || d.key === only))
            .map((d) => {
                const r = RUNGS[d.controller.rung]!;
                return {
                    key: d.key,
                    profile: d.profile,
                    connected: d.connection !== null,
                    rung: d.controller.rung,
                    rungName: r.name,
                    scale: r.scale,
                    quality: r.quality === 0 ? "as the Pi sends it" : r.quality,
                    maxFps: r.maxFps,
                    best: d.controller.ceiling,
                    steps: d.controller.steps,
                    bytesSent: d.bytesSent,
                    framesSent: d.framesSent,
                    framesDropped: d.framesDropped,
                    deliveredBytesPerSecond: Math.round(d.deliveredBps),
                    linkBytesPerSecond: Math.round(d.capacityBps),
                    queuedBytes: d.queuedBytes,
                    kernelQueue: d.kernelQueue,
                    sinceMs: now() - d.since,
                };
            });
        json(res, 200, {
            ok: true,
            result: {
                devices: rows,
                rungs: RUNGS,
                limits: { maxClients: limits.maxClients, maxDevices: limits.maxDevices },
                // Not about any one device: the Pi read and what the host holds open, for debugging and the leak check.
                host: { clients: connections.size, upstream: upstream.status(), open: { ...upstream.handles(), ticker: ticker !== undefined }, encoder: encoder.load() },
            },
        });
    }

    return {
        handles: (path) => path === ADAPTIVE_STREAM_PATH || path === ADAPTIVE_STATUS_PATH,
        handle(req, res, path, signedIn) {
            if (req.method !== "GET") {
                res.setHeader("allow", "GET");
                return json(res, 405, { error: "GET only" });
            }
            const url = new URL(req.url ?? "/", "http://localhost");
            if (path === ADAPTIVE_STREAM_PATH) return stream(req, res, url, signedIn);
            status(res, url, signedIn);
        },
        dispose() {
            for (const conn of [...connections]) close(conn, "dispose");
        },
    };
}
