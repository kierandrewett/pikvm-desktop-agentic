/**
 * WebRTC (Janus) H.264 video, audio and microphone, the same path PiKVM's own UI uses.
 * Ported from the console's webrtc.js (itself from PiKVM's stream_janus.js) over the vendored
 * janus.js in public/janus/, which is loaded on demand so a page that never gets WebRTC never
 * pays for it.
 *
 * Flow: Janus.init, new Janus(ws), attach `janus.plugin.ustreamer`, {request:"features"},
 * {request:"watch"}, createAnswer(tracks), {request:"start"}, onremotetrack feeds the <video>.
 * The microphone is `capture` on the audio track.
 *
 * This is the one place that knows the Janus protocol. The video machine reaches it through the
 * engine's JanusPort, and the controller reaches the audio controls through `JanusStream`.
 */

import { WEBRTC_DISCONNECTED_MS } from "@pikvm/kvm-engine";
import type { JanusFailure, JanusHandlers, JanusPort, JanusSession } from "@pikvm/kvm-engine";
import { cameraConstraints, cameraKey, sentFrom, type CameraChoice, type CameraSent } from "./camera";
import { createRtcMonitor, type RtcMonitor, type RtcStats } from "./rtc-health";

/** The slice of janus.js this file touches. Its own typings do not exist. */
interface JanusPluginHandle {
    webrtcStuff?: { pc?: RTCPeerConnection };
    send(args: { message: Record<string, unknown>; jsep?: unknown }): void;
    createAnswer(args: {
        jsep: unknown;
        tracks: ReadonlyArray<Record<string, unknown>>;
        customizeSdp(jsep: { sdp: string }): void;
        success(jsep: unknown): void;
        error(error: unknown): void;
    }): void;
    hangup(): void;
    detach(): void;
}

interface JanusInstance {
    attach(args: Record<string, unknown>): void;
    destroy(): void;
}

interface JanusStatic {
    new (args: Record<string, unknown>): JanusInstance;
    init(args: { debug: boolean; callback(): void }): void;
    randomString(length: number): string;
}

let loaded: JanusStatic | null = null;
/** How many times loading janus.js failed: a browser remembers a failed dynamic import of the same address, so each retry asks under a new query string (W19). */
let loadFailures = 0;

function ensureJanus(): Promise<JanusStatic | null> {
    if (loaded) return Promise.resolve(loaded);
    const url = `${import.meta.env.BASE_URL}janus/janus.js${loadFailures > 0 ? `?retry=${loadFailures}` : ""}`;
    return import(/* @vite-ignore */ url)
        .then(
            (module: { Janus: JanusStatic }) =>
                new Promise<JanusStatic>((resolve) => {
                    module.Janus.init({
                        debug: false,
                        callback: () => {
                            loaded = module.Janus;
                            resolve(module.Janus);
                        },
                    });
                }),
        )
        .catch((error: unknown) => {
            loadFailures += 1;
            console.error("Janus import failed", error);
            return null;
        });
}

/**
 * The video track the session offers. It always receives the target's picture; with the camera on it also sends
 * this browser's camera, at the chosen quality (camera.ts). A pinned camera uses `exact`, so one that has been
 * unplugged fails and is named, and the browser does not quietly hand back another. The Pi's USB camera carries
 * 1280x720 at most, which no preset exceeds.
 */
export function videoTrackFor(allowCam: boolean, choice: CameraChoice): Record<string, unknown> {
    return { type: "video", capture: allowCam ? cameraConstraints(choice) : false, recv: true, add: true };
}

export interface JanusStreamOptions {
    readonly wsUrl: string;
    readonly video: HTMLVideoElement;
    readonly wantAudio: boolean;
    readonly wantMic: boolean;
    /** Which microphone, not just whether. Empty means any; read again on every (re)start. */
    readonly micDeviceId: () => string;
    /** Which camera and at what quality, not just whether. Read again on every (re)start. */
    readonly cam: () => CameraChoice;
    /** The camera is on: a session made after a drop (the page came back, the network returned) carries it again. */
    readonly wantCam: boolean;
    /** The Pi said whether it can take a camera (the `cam` feature: PiKVM V3/V4 with `ucamera`), on every session. */
    readonly onCameraSupport?: (supported: boolean) => void;
    /** What the camera really sends (the browser's own settings for the track), or null when nothing is sent. */
    readonly onCameraSent?: (sent: CameraSent | null) => void;
    /** The camera track ended by itself: unplugged, or its permission was withdrawn. */
    readonly onCameraEnded?: () => void;
    /** The session ended by itself, once (K109). The video machine owns the retry; this wrapper has none. */
    readonly onFailed: (reason: JanusFailure) => void;
    readonly onActive: (active: boolean) => void;
    /** A sample of the received stream every 2 s while the session plays, and null when it stops (K112). */
    readonly onStats?: (stats: RtcStats | null) => void;
    /** The session restarts on purpose; called just before `onActive(false)` (K127). */
    readonly onRestart?: () => void;
}

export interface AudioLevels {
    readonly speaker: number | null;
    readonly mic: number | null;
}

export interface JanusStream {
    start(): void;
    stop(): void;
    setAudio(on: boolean): void;
    setMic(on: boolean): void;
    /** Restart the session if the pinned microphone changed while the mic is live. */
    micDeviceChanged(): void;
    /** Restart the session if the camera or its quality changed while the camera is live. */
    camChanged(): void;
    /** Send the browser's camera to the target as its USB camera, or stop. Restarts the session. */
    setCam(on: boolean): void;
    hasVideo(): boolean;
    getAudioLevels(): Promise<AudioLevels>;
}

const RESTART_MS = 200;

export function createJanusStream(opts: JanusStreamOptions): JanusStream {
    const { video } = opts;
    let Janus: JanusStatic | null = null;
    let janus: JanusInstance | null = null;
    let handle: JanusPluginHandle | null = null;
    let iceUrl: string | null = null;
    /** `stop()` was called: the machine is done with this session. */
    let stopped = false;
    /** The session reported its failure; it has nothing more to say (K109). */
    let failed = false;
    /** Bumped whenever the session is closed, so a callback from an earlier one is deaf. */
    let generation = 0;
    let allowAudio = opts.wantAudio;
    let allowMic = opts.wantMic;
    let allowCam = opts.wantCam;
    let usedMicId = opts.micDeviceId();
    let usedCam = cameraKey(opts.cam());
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let monitor: RtcMonitor | null = null;

    const stream = (): MediaStream | null => (video.srcObject instanceof MediaStream ? video.srcObject : null);

    const removeTrack = (track: MediaStreamTrack): void => {
        const current = stream();
        if (!current) return;
        try {
            track.stop();
        } catch {
            // already ended
        }
        try {
            current.removeTrack(track);
        } catch {
            // not part of it
        }
        if (current.getTracks().length === 0) video.srcObject = null;
    };

    const addTrack = (track: MediaStreamTrack): void => {
        const current = stream();
        if (current) {
            for (const other of current.getTracks()) if (other.kind === track.kind && other.id !== track.id) removeTrack(other);
        }
        if (!stream()) video.srcObject = new MediaStream();
        stream()?.addTrack(track);
    };

    const sendWatch = (): void => {
        handle?.send({
            message: { request: "watch", params: { orientation: 0, audio: allowAudio, mic: allowMic, cam: allowCam } },
        });
    };
    const sendStop = (): void => {
        if (!handle) return;
        try {
            handle.send({ message: { request: "stop" } });
            handle.hangup();
        } catch {
            // already closed
        }
    };

    const stopTracks = (): void => {
        const current = stream();
        if (!current) return;
        for (const t of current.getTracks()) {
            try {
                t.stop();
            } catch {
                // already ended
            }
        }
        video.srcObject = null;
    };

    /** The sender of the camera, once the answer is made: it has the captured track, which says what is really sent. */
    const watchCamera = (): void => {
        if (!allowCam) return;
        const sender = handle?.webrtcStuff?.pc?.getSenders().find((candidate) => candidate.track?.kind === "video");
        const track = sender?.track;
        if (!track) return;
        opts.onCameraSent?.(sentFrom(track.getSettings()));
        // The browser ends a camera track when the device is pulled or its permission is withdrawn. The session is
        // not told otherwise, and would go on "sending" a dead track.
        track.addEventListener(
            "ended",
            () => {
                opts.onCameraSent?.(null);
                opts.onCameraEnded?.();
            },
            { once: true },
        );
    };

    /**
     * Everything this session holds, let go: the monitor, the timers, the Janus session and its handle, the tracks. Safe to
     * call again. It is the only teardown, for a failure, for `stop()` and for a restart.
     */
    const closeSession = (): void => {
        generation += 1;
        monitor?.stop();
        monitor = null;
        clearTimeout(disconnectTimer ?? undefined);
        disconnectTimer = null;
        const closing = janus;
        janus = null;
        if (closing) {
            try {
                closing.destroy();
            } catch {
                // already gone
            }
        }
        if (handle) {
            try {
                handle.detach();
            } catch {
                // already gone
            }
            handle = null;
        }
        stopTracks();
        opts.onCameraSent?.(null);
    };

    /**
     * The session cannot go on. The machine hears first, while the <video> still has a picture to hold (W13), and owns
     * what comes next: this wrapper never retries (K109). Once only.
     */
    const fail = (reason: JanusFailure): void => {
        if (failed || stopped) return;
        failed = true;
        try {
            opts.onFailed(reason);
        } finally {
            closeSession();
        }
    };

    /**
     * ICE and the connection both say "disconnected" when the browser has heard nothing from the peer. A hiccup clears
     * itself inside 3 s; one that lasts is a drop (W10). `failed` and `closed` are drops at once.
     */
    const peerState = (live: () => boolean, state: string): void => {
        if (!live()) return;
        if (state === "failed") fail("ice-failed");
        else if (state === "closed") fail("closed");
        else if (state === "disconnected") {
            disconnectTimer ??= setTimeout(() => {
                disconnectTimer = null;
                if (live()) fail("ice-disconnected");
            }, WEBRTC_DISCONNECTED_MS);
        } else {
            clearTimeout(disconnectTimer ?? undefined);
            disconnectTimer = null;
        }
    };

    /** The silent-drop check and the stats sampler, once the Pi says the stream started (K110, K112). */
    const startMonitor = (live: () => boolean): void => {
        monitor?.stop();
        monitor = createRtcMonitor({
            peer: () => handle?.webrtcStuff?.pc ?? null,
            visible: () => !document.hidden,
            onDead: () => {
                if (live()) fail("stalled");
            },
            onStats: (stats) => opts.onStats?.(stats),
        });
        monitor.start();
    };

    const attach = (live: () => boolean): void => {
        if (!janus || !Janus || !live()) return;
        const J = Janus;
        janus.attach({
            plugin: "janus.plugin.ustreamer",
            opaqueId: `oid-${J.randomString(12)}`,
            success: (h: JanusPluginHandle) => {
                if (!live()) return;
                handle = h;
                h.send({ message: { request: "features" } });
            },
            error: () => {
                if (live()) fail("plugin");
            },
            connectionState: (state: string) => peerState(live, state),
            iceState: (state: string) => peerState(live, state),
            // The Pi hung up the peer connection, or detached the handle: nothing is coming.
            webrtcState: (up: boolean) => {
                if (!up && live()) fail("hangup");
            },
            ondetached: () => {
                if (live()) fail("hangup");
            },
            onmessage: (msg: Record<string, unknown>, jsep: unknown) => {
                if (!live()) return;
                const result = msg["result"] as Record<string, unknown> | undefined;
                if (result) {
                    if (result["status"] === "started") {
                        opts.onActive(true);
                        startMonitor(live);
                    } else if (result["status"] === "stopped") {
                        fail("hangup");
                        return;
                    } else if (result["status"] === "features") {
                        const features = result["features"] as { ice?: { url?: string }; audio?: boolean; mic?: boolean; cam?: boolean };
                        iceUrl = features.ice?.url ?? null;
                        // Honour what the Pi actually supports.
                        if (!features.audio) allowAudio = false;
                        if (!features.mic) allowMic = false;
                        if (!features.cam) allowCam = false;
                        opts.onCameraSupport?.(!!features.cam);
                        sendWatch();
                    }
                } else if (msg["error_code"] || msg["error"]) {
                    fail("plugin");
                    return;
                }
                if (jsep && handle) {
                    // ONE audio track whose direction is set per flag, exactly as upstream: capture
                    // (mic to the target) gated on mic, recv (target to speaker) on audio, and added
                    // when EITHER is on, so the mic works with the speaker off and both together.
                    // The camera is `capture` on the video track; the Pi asks for it only when the target opens it.
                    const choice = opts.cam();
                    usedCam = cameraKey(choice);
                    const tracks: Array<Record<string, unknown>> = [videoTrackFor(allowCam, choice)];
                    if (allowAudio || allowMic) {
                        usedMicId = opts.micDeviceId();
                        tracks.push({
                            type: "audio",
                            // `exact` on purpose: a pinned device that has been unplugged must fail
                            // rather than quietly hand back whatever the OS calls default now.
                            capture: allowMic ? (usedMicId ? { deviceId: { exact: usedMicId } } : true) : false,
                            recv: allowAudio,
                            add: true,
                        });
                    }
                    handle.createAnswer({
                        jsep,
                        tracks,
                        // Chrome plays Opus as mono without this (PiKVM's own workaround).
                        customizeSdp: (j) => {
                            j.sdp = j.sdp.replace("useinbandfec=1", "useinbandfec=1;stereo=1");
                        },
                        success: (answer) => {
                            if (!live()) return;
                            handle?.send({ message: { request: "start" }, jsep: answer });
                            watchCamera();
                        },
                        error: () => {
                            if (live()) fail("answer");
                        },
                    });
                }
            },
            onremotetrack: (track: MediaStreamTrack, _id: string, added: boolean, meta?: { reason?: string }) => {
                if (!live()) return;
                const reason = meta?.reason;
                if (added && reason === "created") addTrack(track);
                else if (!added && reason === "ended") removeTrack(track);
            },
        });
    };

    function ensure(): void {
        if (janus || stopped || failed || !Janus) return;
        generation += 1;
        const mine = generation;
        const live = (): boolean => mine === generation && !stopped && !failed;
        const J = Janus;
        const created = new J({
            server: opts.wsUrl,
            ipv6: true,
            destroyOnUnload: false,
            iceServers: () => (iceUrl ? [{ urls: iceUrl }] : []),
            // Closed while the session was still being created: janus.js ignores a destroy until it has an id, so it is
            // destroyed here, once it has one (K111). Its socket stays open otherwise and keeps the session alive.
            success: () => {
                if (!live()) {
                    created.destroy();
                    return;
                }
                attach(live);
            },
            // Refused, unreachable, or lost after it was up: one failure, the machine's to retry (K109).
            error: () => {
                if (live()) fail("signalling");
            },
        });
        // An error raised inside the constructor has already failed and closed this session.
        if (live()) janus = created;
    }

    /**
     * PiKVM's fix for flaky audio and mic toggles: do not re-watch in-session (that races the
     * PeerConnection teardown against the new offer, the hit-or-miss where a second toggle was
     * needed). Bring the whole session down and up again with the new flags. Rapid toggles
     * coalesce so only the final state is brought up. This is a deliberate restart, not a retry:
     * if the new one fails it is reported like any other failure.
     */
    const restart = (): void => {
        opts.onRestart?.(); // before the loss is reported, so the controller can tell this restart from a dropped link (K127)
        opts.onActive(false); // the picture falls back to MJPEG for the reconnect: no black frame
        closeSession();
        clearTimeout(restartTimer ?? undefined);
        restartTimer = setTimeout(() => {
            restartTimer = null;
            ensure();
        }, RESTART_MS);
    };

    return {
        start() {
            stopped = false;
            failed = false;
            void ensureJanus().then((J) => {
                if (stopped || failed) return;
                if (!J) {
                    fail("load");
                    return;
                }
                Janus = J;
                ensure();
            });
        },
        stop() {
            stopped = true;
            clearTimeout(restartTimer ?? undefined);
            restartTimer = null;
            sendStop();
            closeSession();
        },
        setAudio(on) {
            allowAudio = on;
            if (janus || handle) restart();
        },
        setMic(on) {
            allowMic = on;
            if (janus || handle) restart();
        },
        setCam(on) {
            allowCam = on;
            if (janus || handle) restart();
        },
        micDeviceChanged() {
            if (allowMic && (janus || handle) && opts.micDeviceId() !== usedMicId) restart();
        },
        camChanged() {
            if (allowCam && (janus || handle) && cameraKey(opts.cam()) !== usedCam) restart();
        },
        hasVideo: () => !!stream()?.getVideoTracks().length,
        // The live audio energy (0..1) for the received and sent tracks, straight from WebRTC
        // stats: no AudioContext and no output device, so it needs no gesture and cannot touch
        // the OS default device.
        async getAudioLevels() {
            const pc = handle?.webrtcStuff?.pc;
            if (!pc?.getStats) return { speaker: null, mic: null };
            try {
                const report = await pc.getStats();
                let speaker: number | null = null;
                let mic: number | null = null;
                report.forEach((s: Record<string, unknown>) => {
                    if (s["kind"] !== "audio" && s["mediaType"] !== "audio") return;
                    if (s["type"] === "inbound-rtp" && typeof s["audioLevel"] === "number") speaker = s["audioLevel"];
                    else if ((s["type"] === "media-source" || s["type"] === "outbound-rtp") && typeof s["audioLevel"] === "number") {
                        mic = s["audioLevel"];
                    }
                });
                return { speaker, mic };
            } catch {
                return { speaker: null, mic: null };
            }
        },
    };
}

export function janusWsUrl(loc: Pick<Location, "protocol" | "host"> = location): string {
    return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/janus/ws`;
}

export interface JanusBridge {
    readonly port: JanusPort;
    /** The session the video machine started, or null. The audio controls act on it. */
    current(): JanusStream | null;
}

export interface JanusBridgeOptions {
    readonly micDeviceId: () => string;
    readonly cam: () => CameraChoice;
    readonly wantAudio: () => boolean;
    readonly wantCam: () => boolean;
    readonly onCameraSupport?: (supported: boolean) => void;
    readonly onCameraSent?: (sent: CameraSent | null) => void;
    readonly onCameraEnded?: () => void;
    /** A sample of the received stream every 2 s while a session plays, and null when there is none (K112). */
    readonly onStats?: (stats: RtcStats | null) => void;
    /** The session is about to restart on purpose (speaker, microphone, camera or device changed): its loss is not a dropped link (K127). */
    readonly onRestart?: () => void;
}

/** The engine's JanusPort over this client, remembering the running stream for the audio controls. */
export function createJanusBridge(video: HTMLVideoElement, bridge: JanusBridgeOptions): JanusBridge {
    const { micDeviceId, cam, wantAudio, wantCam, onCameraSupport, onCameraSent, onCameraEnded, onStats, onRestart } = bridge;
    let running: JanusStream | null = null;
    const port: JanusPort = {
        available: () => typeof RTCPeerConnection !== "undefined",
        create(handlers: JanusHandlers): JanusSession {
            const stream = createJanusStream({
                wsUrl: janusWsUrl(),
                video,
                // Audio output is on by default; the microphone stays off for privacy.
                wantAudio: wantAudio(),
                wantMic: false,
                micDeviceId,
                cam,
                wantCam: wantCam(),
                ...(onCameraSupport ? { onCameraSupport } : {}),
                ...(onCameraSent ? { onCameraSent } : {}),
                ...(onCameraEnded ? { onCameraEnded } : {}),
                ...(onStats ? { onStats } : {}),
                onFailed: handlers.onFailed,
                onActive: handlers.onActive,
                ...(onRestart ? { onRestart } : {}),
            });
            running = stream;
            return {
                start: () => stream.start(),
                hasVideo: () => stream.hasVideo(),
                stop: () => {
                    stream.stop();
                    if (running === stream) running = null;
                },
            };
        },
    };
    return { port, current: () => running };
}
