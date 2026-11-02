// Test support for the video machine: a manual clock, a recording render sink and a
// scriptable Janus port.

import { createManualClock } from "../clock";
import type { ManualClock } from "../clock";
import { createVideoDriver } from "./driver";
import type { JanusHandlers, JanusPort, VideoDriver } from "./driver";
import type { SignalState, VideoEventInit, VideoRenderEffect } from "./types";

export type JanusBehaviour = "ok" | "unavailable" | "throws";

export interface VideoRig {
    readonly clock: ManualClock;
    readonly driver: VideoDriver;
    /** Render effects since the last `clear`. */
    readonly fx: VideoRenderEffect[];
    readonly janus: { handlers: JanusHandlers | null; hasVideo: boolean; started: number; stopped: number };
    send(event: VideoEventInit): void;
    advance(ms: number): void;
    clear(): void;
    /** Signal states painted since the last clear. */
    signals(): SignalState[];
    count(type: VideoRenderEffect["type"]): number;
    of<T extends VideoRenderEffect["type"]>(type: T): Extract<VideoRenderEffect, { type: T }>[];
    /** Boot into native mode with an answered /api/info; MJPEG is loading. */
    bootNative(): void;
    /** Boot into snapshot mode. */
    bootSnapshot(): void;
    /** A first MJPEG frame arrived and the source is online: live. */
    goLive(): void;
    /** A Janus video track arrives and plays: the picture swaps to WebRTC. */
    webrtcUp(): void;
}

export function createVideoRig(init: { janus?: JanusBehaviour; documentHidden?: boolean } = {}): VideoRig {
    const clock = createManualClock(1000);
    const fx: VideoRenderEffect[] = [];
    const janus: VideoRig["janus"] = { handlers: null, hasVideo: false, started: 0, stopped: 0 };
    const behaviour = init.janus ?? "unavailable";
    const port: JanusPort = {
        available: () => behaviour !== "unavailable",
        create: (handlers) => {
            janus.handlers = handlers;
            return {
                start: () => {
                    janus.started++;
                    if (behaviour === "throws") throw new Error("no webrtc");
                },
                hasVideo: () => janus.hasVideo,
                stop: () => {
                    janus.stopped++;
                },
            };
        },
    };
    const driver = createVideoDriver({
        clock,
        render: (e) => fx.push(e),
        janus: port,
        streamKey: "k",
        ...(init.documentHidden !== undefined ? { documentHidden: init.documentHidden } : {}),
    });
    const rig: VideoRig = {
        clock,
        driver,
        fx,
        janus,
        send: (e) => driver.send(e),
        advance: (ms) => clock.advance(ms),
        clear: () => {
            fx.length = 0;
        },
        signals: () => fx.flatMap((e) => (e.type === "signal" ? [e.state] : [])),
        count: (type) => fx.filter((e) => e.type === type).length,
        of: <T extends VideoRenderEffect["type"]>(type: T) => fx.filter((e): e is Extract<VideoRenderEffect, { type: T }> => e.type === type),
        bootNative: () => {
            driver.start();
            driver.send({ type: "infoResult", mode: "native" });
        },
        bootSnapshot: () => {
            driver.start();
            driver.send({ type: "infoResult", mode: "snapshot" });
        },
        goLive: () => {
            driver.send({ type: "mjpegLoaded" });
            driver.send({ type: "healthResult", online: true });
        },
        webrtcUp: () => {
            janus.hasVideo = true;
            janus.handlers?.onActive(true);
            driver.send({ type: "videoPlaying" });
        },
    };
    return rig;
}
