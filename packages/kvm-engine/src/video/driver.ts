// The video machine plus a clock and the Janus port.
//
// The driver stamps events with the clock, fulfils the machine's timer requests
// (including repeating ones), starts the Janus session through an interface, and
// forwards every other effect to `render`, where the DOM adapter (or a test) acts on
// it and reports back with `send`.
//
// The Janus protocol client itself (src/views/janus.js + webrtc.js) stays a
// dependency behind `JanusPort`; nothing here knows its wire protocol.

import type { CancelTimer, Clock } from "../clock";
import { createVideoState, reduceVideo } from "./machine";
import type { VideoState } from "./machine";
import type { VideoEffect, VideoEvent, VideoEventInit, VideoRenderEffect } from "./types";

/** What the machine needs from a running Janus session. */
export interface JanusSession {
    /** Begin connecting. May throw; the machine then carries on with MJPEG alone. */
    start(): void;
    /** Whether a remote video track is currently present. */
    hasVideo(): boolean;
    stop(): void;
}

export interface JanusHandlers {
    /** "connecting" / "live" / "error": only the error matters before any video was seen. */
    onStatus(status: "connecting" | "live" | "error"): void;
    /** The session started or stopped delivering. */
    onActive(active: boolean): void;
}

/** The seam to the vendored Janus client. */
export interface JanusPort {
    /** The browser can do WebRTC and the client library is loaded. */
    available(): boolean;
    create(handlers: JanusHandlers): JanusSession;
}

export interface VideoDriverOptions {
    readonly clock: Clock;
    /** Acts on everything that is not a timer or the Janus start. */
    readonly render: (effect: VideoRenderEffect) => void;
    readonly janus?: JanusPort;
    /** Seed for MJPEG stream keys (random per page load). */
    readonly streamKey: string;
    readonly documentHidden?: boolean;
}

export interface VideoDriver {
    /** Begin detecting the screen mode. Call once. */
    start(): void;
    /** Feed an event from the world (a load, a fetch result, a visibility change). */
    send(event: VideoEventInit): void;
    readonly state: VideoState;
    /** Stop everything: timers and the Janus session. */
    dispose(): void;
}

export function createVideoDriver(opts: VideoDriverOptions): VideoDriver {
    const { clock } = opts;
    let state = createVideoState();
    let session: JanusSession | null = null;
    let disposed = false;
    const timers = new Map<string, CancelTimer>();

    const cancel = (id: string): void => {
        const c = timers.get(id);
        if (!c) return;
        timers.delete(id);
        c();
    };

    const arm = (id: string, ms: number, repeat: boolean): void => {
        cancel(id);
        timers.set(
            id,
            clock.setTimeout(() => {
                timers.delete(id);
                if (repeat) arm(id, ms, true); // re-arm first so a handler that cancels wins
                send({ type: "timer", id });
            }, ms),
        );
    };

    const run = (effect: VideoEffect): void => {
        switch (effect.type) {
            case "startTimer":
                arm(effect.id, effect.ms, effect.repeat === true);
                return;
            case "cancelTimer":
                cancel(effect.id);
                return;
            case "janusStart": {
                const janus = opts.janus;
                if (!janus) {
                    send({ type: "janusStartResult", ok: false });
                    return;
                }
                const created = janus.create({
                    onStatus: (status) => send({ type: "janusStatus", status }),
                    onActive: (active) => send({ type: "janusActive", active, hasVideo: session?.hasVideo() ?? false }),
                });
                session = created;
                try {
                    created.start();
                } catch {
                    session = null;
                    send({ type: "janusStartResult", ok: false });
                    return;
                }
                send({ type: "janusStartResult", ok: true });
                return;
            }
            default:
                opts.render(effect);
        }
    };

    function dispatch(event: VideoEvent): void {
        if (disposed) return;
        const step = reduceVideo(state, event);
        state = step.state;
        for (const e of step.effects) run(e);
    }

    function send(event: VideoEventInit): void {
        dispatch({ ...event, t: clock.now() } as VideoEvent);
    }

    return {
        start() {
            send({
                type: "start",
                janusAvailable: opts.janus?.available() ?? false,
                streamKey: opts.streamKey,
                ...(opts.documentHidden !== undefined ? { documentHidden: opts.documentHidden } : {}),
            });
        },
        send,
        get state() {
            return state;
        },
        dispose() {
            disposed = true;
            for (const c of timers.values()) c();
            timers.clear();
            try {
                session?.stop();
            } catch {
                // A session that will not stop is already gone as far as we are concerned.
            }
            session = null;
        },
    };
}
