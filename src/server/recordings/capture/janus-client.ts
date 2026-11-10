import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { RTCPeerConnection, RTCRtpCodecParameters, type RtcpPacket, type RtpPacket, type RTCRtpReceiver } from "werift";
import type { JanusTarget } from "./types";

/**
 * The host's own Janus client for the PiKVM's `janus.plugin.ustreamer`: watch video and audio, receive only.
 *
 * Generalises what src/server/agent/audio.ts does for audio-only clips. Facts it is built on (all measured in the native-record spike):
 *  - The Pi offers H.264 Constrained Baseline (PT 96, packetization-mode 1) and Opus 48k stereo (PT 111). It sends NO keyframe by itself:
 *    `requestKeyframe()` (RTCP PLI) is the only way to get one, and each PLI makes the one shared encoder burst an IDR to every viewer.
 *  - Janus ends a session 64 s after its last keepalive whatever the media does; one keepalive every 10 s is enough.
 *  - A dropped WebSocket ends the session at once and it cannot be resumed: a new session has a new SSRC and new RTP bases.
 *
 * `openJanusSession` is one WebSocket + one peer. `startJanusWatcher` keeps sessions coming (capped exponential backoff) until closed
 * or until the Pi has been unreachable for `giveUpAfterMs`. Neither reads the environment: the caller hands in the `JanusTarget`.
 */

export interface JanusSinks {
    onVideoRtp(packet: RtpPacket, at: number, session: number): void;
    onAudioRtp(packet: RtpPacket, at: number, session: number): void;
    onRtcp(kind: "video" | "audio", packet: RtcpPacket, at: number, session: number): void;
    /** The session's WebRTC connection is up and its tracks are known. */
    onSessionStart(session: number): void;
    /** The session ended (for any reason). `retryInMs` is null when the watcher will not retry. */
    onSessionEnd(session: number, reason: string, retryInMs: number | null): void;
}

export interface JanusSessionOptions {
    target: JanusTarget;
    video: boolean;
    audio: boolean;
    log: (line: string) => void;
    session: number;
    sinks: JanusSinks;
    keepaliveMs?: number;
    /** A session that has produced no RTP/RTCP at all for this long is declared dead. */
    stallMs?: number;
    /** A session must have media this long after its socket opened. */
    connectMs?: number;
}

export interface JanusSession {
    /** Resolves with the reason the session ended. */
    readonly ended: Promise<string>;
    /** Whether the session has reached the point of delivering media (its tracks exist). */
    readonly live: boolean;
    /** Sends a PLI for the video track. False when there is no video track yet. */
    requestKeyframe(): Promise<boolean>;
    close(reason: string): void;
    readonly audioAvailable: boolean;
}

const DEFAULT_KEEPALIVE_MS = 10_000;
const DEFAULT_STALL_MS = 10_000;
const DEFAULT_CONNECT_MS = 25_000;

interface JanusEvent {
    janus?: string;
    reason?: string;
    error?: { reason?: string };
    data?: { id?: number };
    plugindata?: { data?: { error?: string; error_code?: number; result?: { status?: string; features?: { audio?: boolean } } } };
    jsep?: { type: "offer" | "answer"; sdp: string };
    candidate?: { completed?: boolean } & Record<string, unknown>;
}

function wsUrl(target: JanusTarget): URL {
    const url = new URL("/janus/ws", target.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
}

export function openJanusSession(options: JanusSessionOptions): JanusSession {
    const { target, log, session, sinks } = options;
    const tag = `[recorder janus#${session}]`;
    const ended = Promise.withResolvers<string>();
    const socket = new WebSocket(wsUrl(target), "janus-protocol", { headers: { ...target.headers }, rejectUnauthorized: target.rejectUnauthorized });
    const codecs = {
        audio: options.audio
            ? [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111, parameters: "sprop-stereo=1" })]
            : [],
        video: options.video
            ? [
                  new RTCRtpCodecParameters({
                      mimeType: "video/H264",
                      clockRate: 90000,
                      payloadType: 96,
                      parameters: "profile-level-id=42E01F;packetization-mode=1",
                      rtcpFeedback: [{ type: "ccm", parameter: "fir" }, { type: "nack" }, { type: "nack", parameter: "pli" }],
                  }),
              ]
            : [],
    };
    const peer = new RTCPeerConnection({ codecs, iceServers: [] });
    const receivers: { video?: RTCRtpReceiver; audio?: RTCRtpReceiver } = {};
    const ssrcs: { video?: number | undefined; audio?: number | undefined } = {};
    let sessionId: number | undefined;
    let handleId: number | undefined;
    let keepalive: NodeJS.Timeout | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    let finished = false;
    let live = false;
    let audioAvailable = options.audio;
    let lastMediaAt = 0;
    const openedAt = Date.now();
    const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
    const connectMs = options.connectMs ?? DEFAULT_CONNECT_MS;

    const send = (janus: string, fields: Record<string, unknown> = {}): void => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ janus, transaction: randomUUID(), session_id: sessionId, ...fields }));
    };
    const message = (body: Record<string, unknown>, jsep?: unknown): void => {
        send("message", { handle_id: handleId, body, ...(jsep ? { jsep } : {}) });
    };
    const end = (reason: string): void => {
        if (finished) return;
        finished = true;
        live = false;
        clearInterval(keepalive);
        clearInterval(watchdog);
        if (sessionId !== undefined) send("destroy");
        // The destroy needs a moment to leave; the socket and the peer go after it.
        setTimeout(() => {
            try {
                socket.terminate();
            } catch {
                // Already gone.
            }
            void peer.close().catch(() => undefined);
        }, 100).unref();
        ended.resolve(reason);
    };

    const touch = (): void => {
        lastMediaAt = Date.now();
    };
    peer.onTrack.subscribe((track) => {
        if (track.kind === "video") {
            ssrcs.video = track.ssrc;
            track.onReceiveRtp.subscribe((packet) => {
                touch();
                sinks.onVideoRtp(packet, lastMediaAt, session);
            });
        } else {
            ssrcs.audio = track.ssrc;
            track.onReceiveRtp.subscribe((packet) => {
                touch();
                sinks.onAudioRtp(packet, lastMediaAt, session);
            });
        }
        const kind = track.kind === "video" ? "video" : "audio";
        // RTCP does not count as liveness: a sender keeps reporting on a stream that carries nothing.
        track.onReceiveRtcp.subscribe((packet) => {
            sinks.onRtcp(kind, packet, Date.now(), session);
        });
    });
    peer.onIceCandidate.subscribe((candidate) => send("trickle", { handle_id: handleId, candidate: candidate ? candidate.toJSON() : { completed: true } }));
    peer.connectionStateChange.subscribe((state) => {
        if (state === "connected" && !live) {
            live = true;
            touch();
            sinks.onSessionStart(session);
        }
        if (state === "failed" || state === "closed") end(`peer connection ${state}`);
    });

    const onMessage = async (raw: WebSocket.RawData): Promise<void> => {
        const event = JSON.parse(raw.toString()) as JanusEvent;
        if (event.janus === "error") return end(`janus error: ${event.error?.reason ?? "rejected"}`);
        if (event.janus === "success" && typeof event.data?.id === "number") {
            if (sessionId === undefined) {
                sessionId = event.data.id;
                send("attach", { plugin: "janus.plugin.ustreamer" });
                keepalive = setInterval(() => send("keepalive"), options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS);
            } else if (handleId === undefined) {
                handleId = event.data.id;
                message({ request: "features" });
            }
        }
        const data = event.plugindata?.data;
        if (data?.error || data?.error_code) return end(`the PiKVM refused: ${data.error ?? data.error_code}`);
        if (data?.result?.status === "features") {
            audioAvailable = options.audio && data.result.features?.audio !== false;
            message({ request: "watch", params: { orientation: 0, audio: audioAvailable, mic: false, cam: false } });
        }
        if (event.jsep) {
            await peer.setRemoteDescription(event.jsep);
            for (const transceiver of peer.getTransceivers()) {
                const kind = transceiver.kind;
                receivers[kind === "video" ? "video" : "audio"] = transceiver.receiver;
                const wanted = kind === "video" ? options.video : audioAvailable;
                transceiver.direction = wanted ? "recvonly" : "inactive";
            }
            await peer.setLocalDescription(await peer.createAnswer());
            message({ request: "start" }, peer.localDescription);
        }
        if (event.janus === "trickle") await peer.addIceCandidate(event.candidate?.completed ? undefined : (event.candidate as never));
        if (event.janus === "hangup" || event.janus === "detached" || event.janus === "timeout") {
            end(`janus ${event.janus}${event.reason ? `: ${event.reason}` : ""}`);
        }
    };
    socket.on("open", () => send("create"));
    socket.on("message", (raw) => {
        void onMessage(raw).catch((error: unknown) => end(`signalling failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    socket.on("error", (error) => end(`socket error: ${error.message}`));
    socket.on("close", () => end("socket closed"));

    watchdog = setInterval(() => {
        const now = Date.now();
        if (!live) {
            if (now - openedAt > connectMs) end(`no media within ${connectMs} ms of connecting`);
        } else if (now - lastMediaAt > stallMs) {
            end(`no packets for ${stallMs} ms`);
        }
    }, 1000);
    watchdog.unref();

    log(`${tag} opening ${target.origin.host}`);
    return {
        ended: ended.promise,
        get live() {
            return live;
        },
        get audioAvailable() {
            return audioAvailable;
        },
        async requestKeyframe() {
            const receiver = receivers.video;
            const ssrc = ssrcs.video;
            if (!live || !receiver || ssrc === undefined) return false;
            await receiver.sendRtcpPLI(ssrc);
            return true;
        },
        close: end,
    };
}

export interface JanusWatcherOptions {
    target: JanusTarget;
    video: boolean;
    audio: boolean;
    sinks: JanusSinks;
    log: (line: string) => void;
    /** Backoff between sessions: starts at `initialBackoffMs`, doubles, is capped at `maxBackoffMs`, resets once a session has run `healthyMs`. */
    initialBackoffMs?: number;
    maxBackoffMs?: number;
    healthyMs?: number;
    /** Stop trying when no session has been live for this long. */
    giveUpAfterMs: number;
    keepaliveMs?: number;
    stallMs?: number;
    connectMs?: number;
}

export interface JanusWatcher {
    requestKeyframe(): Promise<boolean>;
    /** Ends the current session and stops reconnecting. Resolves once the session is closed. */
    close(): Promise<void>;
    readonly session: number;
    readonly live: boolean;
    /** Resolves with the reason when the watcher gave up (never when closed by `close`). */
    readonly gaveUp: Promise<string>;
}

export function startJanusWatcher(options: JanusWatcherOptions): JanusWatcher {
    const initial = options.initialBackoffMs ?? 1000;
    const cap = options.maxBackoffMs ?? 15_000;
    const healthyMs = options.healthyMs ?? 10_000;
    const gaveUp = Promise.withResolvers<string>();
    let current: JanusSession | null = null;
    let sessionNo = 0;
    let backoff = initial;
    let closed = false;
    let retryTimer: NodeJS.Timeout | undefined;
    let lastLiveAt = Date.now();
    let wake: (() => void) | null = null;

    const run = async (): Promise<void> => {
        while (!closed) {
            sessionNo += 1;
            const no = sessionNo;
            const startedAt = Date.now();
            let wasLive = false;
            const sinks: JanusSinks = {
                ...options.sinks,
                onSessionStart: (n) => {
                    wasLive = true;
                    options.sinks.onSessionStart(n);
                },
            };
            let reason: string;
            try {
                current = openJanusSession({
                    target: options.target,
                    video: options.video,
                    audio: options.audio,
                    log: options.log,
                    session: no,
                    sinks,
                    ...(options.keepaliveMs !== undefined ? { keepaliveMs: options.keepaliveMs } : {}),
                    ...(options.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
                    ...(options.connectMs !== undefined ? { connectMs: options.connectMs } : {}),
                });
                reason = await current.ended;
            } catch (error) {
                reason = `could not open the session: ${error instanceof Error ? error.message : String(error)}`;
            }
            current = null;
            const lived = Date.now() - startedAt;
            if (wasLive) lastLiveAt = Date.now();
            if (closed) {
                options.sinks.onSessionEnd(no, reason, null);
                return;
            }
            if (wasLive && lived >= healthyMs) backoff = initial;
            if (Date.now() - lastLiveAt > options.giveUpAfterMs) {
                options.sinks.onSessionEnd(no, reason, null);
                gaveUp.resolve(`the PiKVM has been unreachable for ${Math.round(options.giveUpAfterMs / 1000)} s (${reason})`);
                return;
            }
            options.sinks.onSessionEnd(no, reason, backoff);
            const sleep = Promise.withResolvers<void>();
            wake = sleep.resolve;
            retryTimer = setTimeout(sleep.resolve, backoff);
            await sleep.promise;
            wake = null;
            backoff = Math.min(cap, backoff * 2);
        }
    };
    const loop = run();
    void loop.catch((error: unknown) => gaveUp.resolve(`the PiKVM watcher crashed: ${error instanceof Error ? error.message : String(error)}`));

    return {
        requestKeyframe: async () => (current ? await current.requestKeyframe() : false),
        async close() {
            closed = true;
            clearTimeout(retryTimer);
            wake?.();
            current?.close("capture stopped");
            await loop.catch(() => undefined);
        },
        get session() {
            return sessionNo;
        },
        get live() {
            return current?.live ?? false;
        },
        gaveUp: gaveUp.promise,
    };
}
