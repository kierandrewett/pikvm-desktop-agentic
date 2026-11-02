// The stream source machine.
//
// WebRTC (Janus) is preferred; MJPEG runs underneath as the fallback and keeps the
// picture up while WebRTC starts; snapshot mode serves VNC-lab targets. A health
// poll tells "server unreachable" from "no signal" from a stream hiccup; a watchdog
// and a backoff reconnect restart a stalled MJPEG stream; the last good frame is
// held (frozen) across every restart so the picture never drops to black.
//
// Pure: `reduceVideo(state, event)` returns the next state and the effects to run.
// Time arrives stamped on events and timers are requested as effects, so a test can
// replay minutes of outage in microseconds on a manual clock.

import { INITIAL_BLANK, stepBlank } from "./blank";
import type { BlankTracker } from "./blank";
import {
    AWAY_RECONNECT_MS,
    BLANK_SAMPLE_MS,
    HEALTH_ABORT_MS,
    HEALTH_POLL_MS,
    INFO_ABORT_MS,
    PLAY_WATCHDOG_MS,
    RECONNECT_FACTOR,
    RECONNECT_INITIAL_MS,
    RECONNECT_MAX_MS,
    SNAPSHOT_ABORT_MS,
    SNAPSHOT_BACKOFF_BASE_MS,
    SNAPSHOT_BACKOFF_FACTOR,
    SNAPSHOT_BACKOFF_MAX_MS,
    SNAPSHOT_DISCONNECTED_AFTER,
    SNAPSHOT_HIDDEN_RETRY_MS,
    SNAPSHOT_INTERVAL_MS,
    START_GUARD_MS,
    STREAM_WATCHDOG_MS,
} from "./types";
import type { ScreenMode, SignalState, VideoEffect, VideoEvent } from "./types";

export interface VideoState {
    readonly mode: ScreenMode;
    readonly signal: SignalState;
    /** The MJPEG stream key; replaced when the server comes back so the Pi starts a clean stream. */
    readonly streamKey: string;
    readonly keyBase: string;
    readonly keySeq: number;
    /** A real picture has been shown at least once (the freeze canvas has something to hold). */
    readonly hasFrame: boolean;
    /** An MJPEG frame has arrived on the current connection. */
    readonly streamUp: boolean;
    /** The server is known down; its verdict is the only one shown. */
    readonly serverDown: boolean;
    /** WebRTC owns the picture (or snapshot mode does): the MJPEG pipeline is suspended. */
    readonly mjpegPaused: boolean;
    /** The <img> currently has a src (a connection to the Pi is open or opening). */
    readonly mjpegOpen: boolean;
    readonly retryMs: number;
    readonly reconnectPending: boolean;
    readonly janusAvailable: boolean;
    /** A Janus session was started and not abandoned. */
    readonly janusStarted: boolean;
    readonly sawVideo: boolean;
    /** A remote video track is present. */
    readonly webrtcActive: boolean;
    /** The <video> is really playing and the MJPEG <img> has been retired. */
    readonly webrtcSwapped: boolean;
    readonly blank: BlankTracker;
    readonly fullUiOn: boolean;
    readonly collapsed: boolean;
    readonly watching: boolean;
    readonly documentHidden: boolean;
    readonly hiddenAt: number | null;
    readonly snapshotInFlight: boolean;
    readonly snapshotFailures: number;
}

export function createVideoState(): VideoState {
    return {
        mode: "detecting",
        signal: "connecting",
        streamKey: "",
        keyBase: "",
        keySeq: 0,
        hasFrame: false,
        streamUp: false,
        serverDown: false,
        mjpegPaused: false,
        mjpegOpen: false,
        retryMs: RECONNECT_INITIAL_MS,
        reconnectPending: false,
        janusAvailable: false,
        janusStarted: false,
        sawVideo: false,
        webrtcActive: false,
        webrtcSwapped: false,
        blank: INITIAL_BLANK,
        fullUiOn: false,
        collapsed: false,
        watching: false,
        documentHidden: false,
        hiddenAt: null,
        snapshotInFlight: false,
        snapshotFailures: 0,
    };
}

export interface VideoStep {
    readonly state: VideoState;
    readonly effects: readonly VideoEffect[];
}

/** Timer ids the machine uses. */
export const TIMER = {
    streamWatchdog: "streamWatchdog",
    reconnect: "reconnect",
    health: "health",
    blank: "blank",
    snapshot: "snapshot",
    playWatchdog: "playWatchdog",
    startGuard: "startGuard",
} as const;

/** Whether a blank sample is worth taking now (the readback is expensive). */
export function shouldSampleBlank(s: VideoState): boolean {
    // Skipped while the window is hidden, unless screen-change alerts are watching: a
    // minimised window still gets sampled when alerts are armed, which is exactly the
    // case they exist for.
    if (s.documentHidden && !s.watching) return false;
    return s.streamUp || (s.webrtcActive && s.webrtcSwapped);
}

/** Whether anyone can see the picture: the Pi's UI is framed over it, or the preview is collapsed. */
export function pictureHidden(s: Pick<VideoState, "fullUiOn" | "collapsed">): boolean {
    return s.fullUiOn || s.collapsed;
}

/** One step of the machine. */
export function reduceVideo(prev: VideoState, ev: VideoEvent): VideoStep {
    const m = new Mutator(prev);
    m.handle(ev);
    return { state: m.s, effects: m.fx };
}

/** A scratch copy of the state with the original console's helper functions as methods. */
class Mutator {
    s: { -readonly [K in keyof VideoState]: VideoState[K] };
    readonly fx: VideoEffect[] = [];

    constructor(prev: VideoState) {
        this.s = { ...prev };
    }

    private emit(e: VideoEffect): void {
        this.fx.push(e);
    }

    private start(id: string, ms: number): void {
        this.emit({ type: "startTimer", id, ms });
    }

    private cancel(id: string): void {
        this.emit({ type: "cancelTimer", id });
    }

    /**
     * Leaving "live" is the moment to hold the picture, whatever is about to stop
     * updating it: an MJPEG restart, a stall, a WebRTC drop. Doing it here rather than
     * only in loadStream matters: loadStream returns early while WebRTC owns the
     * picture, so on a WebRTC target the freeze would never have fired at all.
     */
    private setSignal(next: SignalState): void {
        const s = this.s;
        if (next !== "live" && s.signal === "live") this.freeze();
        const changed = s.signal !== next;
        s.signal = next;
        if (changed) this.emit({ type: "signal", state: next });
        if (next === "live") this.emit({ type: "thaw" }); // the live source is painting again
    }

    private freeze(): void {
        if (this.s.hasFrame) this.emit({ type: "freeze" });
    }

    handle(ev: VideoEvent): void {
        const s = this.s;
        switch (ev.type) {
            case "start":
                s.streamKey = ev.streamKey;
                s.keyBase = ev.streamKey;
                s.janusAvailable = ev.janusAvailable;
                s.documentHidden = ev.documentHidden ?? false;
                this.setSignal("connecting");
                this.emit({ type: "signal", state: "connecting" }); // paint the chip once at boot, whatever it already said
                this.emit({ type: "fetchInfo", timeoutMs: INFO_ABORT_MS });
                this.emit({ type: "startTimer", id: TIMER.health, ms: HEALTH_POLL_MS, repeat: true });
                this.emit({ type: "startTimer", id: TIMER.blank, ms: BLANK_SAMPLE_MS, repeat: true });
                return;
            case "infoResult":
                if (ev.mode === "snapshot") this.startSnapshotScreen();
                else this.startNativeScreen();
                return;
            case "infoFailed":
                this.startNativeScreen();
                return;
            case "timer":
                this.onTimer(ev.id);
                return;
            case "mjpegLoaded":
                if (s.mode !== "native" || s.mjpegPaused) return;
                s.streamUp = true;
                s.hasFrame = true;
                this.emit({ type: "thaw" }); // a real frame is on screen again
                s.retryMs = RECONNECT_INITIAL_MS;
                this.cancel(TIMER.streamWatchdog);
                if (!s.serverDown && !s.blank.blank) this.setSignal("live");
                return;
            case "mjpegError":
                if (s.mode !== "native" || s.mjpegPaused) return;
                s.streamUp = false;
                this.scheduleReconnect();
                return;
            case "healthResult":
                this.onHealth(ev.online);
                return;
            case "healthFailed":
                s.serverDown = true;
                s.streamUp = false;
                if (!s.mjpegPaused) this.setSignal("disconnected");
                return;
            case "snapshotDecoded":
                this.onSnapshotDecoded();
                return;
            case "snapshotFailed":
                s.snapshotInFlight = false;
                this.snapshotFailed();
                return;
            case "janusStartResult":
                if (!ev.ok) {
                    s.janusStarted = false;
                    return;
                }
                // If WebRTC has not produced video within a few seconds (Janus down, no ICE,
                // SDP issue) the MJPEG underneath is already live, so this only makes sure the
                // audio toggles stay hidden.
                this.start(TIMER.startGuard, START_GUARD_MS);
                return;
            case "janusStatus":
                // Once live the wrapper retries by itself and the <video> stays up. Before any
                // video was ever seen, an error means drop to MJPEG.
                if (ev.status === "error" && !s.sawVideo) this.fallbackToMjpeg();
                return;
            case "janusActive":
                if (ev.active && s.janusStarted && ev.hasVideo) {
                    s.sawVideo = true;
                    this.cancel(TIMER.startGuard);
                    this.activateWebrtc();
                } else if (!ev.active && s.webrtcActive) {
                    // The session stopped while live: go back to MJPEG so the user is not left on a frozen frame.
                    this.fallbackToMjpeg();
                }
                return;
            case "videoPlaying":
                this.onVideoPlaying();
                return;
            case "blankSample":
                this.onBlankSample(ev.uniform, ev.t);
                return;
            case "visibility":
                this.onVisibility(ev.hidden, ev.t);
                return;
            case "online":
                s.serverDown = false;
                this.emit({ type: "hid", action: "kick" }); // the old socket rode the network that just went
                if (s.mode === "snapshot") this.scheduleSnapshot(0);
                else this.loadStream();
                return;
            case "offline":
                s.serverDown = true;
                this.setSignal("disconnected");
                return;
            case "fullUi":
                this.onFullUi(ev.on);
                return;
            case "need":
                s.collapsed = ev.collapsed;
                s.watching = ev.watching;
                this.applyStreamNeed();
                return;
        }
    }

    /* ---- timers ---- */

    private onTimer(id: string): void {
        const s = this.s;
        switch (id) {
            case TIMER.streamWatchdog:
                if (!s.streamUp) this.scheduleReconnect(); // first frame never arrived
                return;
            case TIMER.reconnect:
                s.reconnectPending = false;
                this.loadStream();
                return;
            case TIMER.health:
                if (s.mode === "native") this.emit({ type: "pollHealth", timeoutMs: HEALTH_ABORT_MS });
                return;
            case TIMER.blank:
                if (shouldSampleBlank(s)) this.emit({ type: "sampleBlank", source: s.webrtcActive && s.webrtcSwapped ? "video" : "image" });
                return;
            case TIMER.snapshot:
                this.loadSnapshotFrame();
                return;
            case TIMER.playWatchdog:
                if (s.webrtcActive && !s.webrtcSwapped) this.fallbackToMjpeg();
                return;
            case TIMER.startGuard:
                if (!s.sawVideo) this.fallbackToMjpeg(); // harmless: MJPEG is already live
                return;
        }
    }

    /* ---- screen modes ---- */

    private startNativeScreen(): void {
        const s = this.s;
        s.mode = "native";
        s.mjpegPaused = false;
        this.emit({ type: "screenMode", mode: "native" });
        this.setSignal("connecting");
        this.loadStream();
        this.startNativeWebrtc();
    }

    private startSnapshotScreen(): void {
        const s = this.s;
        s.mode = "snapshot";
        s.mjpegPaused = true;
        s.fullUiOn = false;
        this.emit({ type: "screenMode", mode: "snapshot" });
        this.setSignal("connecting");
        this.loadSnapshotFrame();
    }

    /* ---- MJPEG ---- */

    private loadStream(): void {
        const s = this.s;
        if (s.mode !== "native" || s.mjpegPaused) return; // WebRTC owns the picture; do not open an MJPEG connection
        // The full Pi UI is up and streaming the same camera over the same link, so a
        // second connection behind it pays for the picture twice to look at one of them.
        // Guarded HERE, the only place the connection is opened.
        if (s.fullUiOn) return;
        // Nor while the preview is collapsed and nothing is watching it.
        if (s.collapsed && !s.watching) return;
        /*
         * While the server is known down, its verdict is the only one shown. Three writers
         * described the same "no picture, retrying" situation with three names (the health
         * poll says "disconnected", this says "reconnecting", the reconnect says "offline"),
         * two of them in the same words but different colours, so one unchanging outage made
         * the overlay thrash: nineteen changes in twenty-four seconds, including one-frame
         * white flashes, on the one surface whose job is to explain why there is no picture.
         */
        if (s.signal !== "live" && !s.serverDown) this.setSignal(s.signal === "disconnected" ? "reconnecting" : s.signal);
        // Before the src is replaced, not after: setting it is what blanks the <img>.
        this.freeze();
        s.mjpegOpen = true;
        this.emit({ type: "loadMjpeg", key: s.streamKey });
        this.start(TIMER.streamWatchdog, STREAM_WATCHDOG_MS);
    }

    private scheduleReconnect(): void {
        const s = this.s;
        if (s.mode !== "native" || s.mjpegPaused || s.reconnectPending) return;
        // Same reason as loadStream: do not talk over the health poll.
        if (s.signal !== "disconnected" && !s.serverDown) this.setSignal("offline");
        s.reconnectPending = true;
        this.start(TIMER.reconnect, s.retryMs);
        s.retryMs = Math.min(Math.round(s.retryMs * RECONNECT_FACTOR), RECONNECT_MAX_MS);
    }

    private onHealth(online: boolean): void {
        const s = this.s;
        if (s.mode !== "native") return;
        const wasDown = s.serverDown;
        s.serverDown = false;
        if (s.mjpegPaused) return; // WebRTC owns the status while it is live
        if (wasDown) {
            s.keySeq += 1;
            s.streamKey = `${s.keyBase}-${s.keySeq}`;
            this.loadStream();
        } else if ((!online || s.blank.blank) && s.streamUp) {
            if (s.signal !== "nosignal") this.setSignal("nosignal");
        } else if (online && s.streamUp && s.signal !== "live") {
            this.setSignal("live");
        }
    }

    /** Bring the stream in line with whether anyone needs it. */
    private applyStreamNeed(): void {
        const s = this.s;
        if (s.mode !== "native") return;
        if (pictureHidden(s) && !s.watching) {
            if (s.mjpegOpen) {
                s.mjpegOpen = false;
                this.emit({ type: "dropMjpeg" });
            }
            return;
        }
        if (!s.mjpegOpen) this.loadStream();
    }

    private onFullUi(on: boolean): void {
        const s = this.s;
        // The Pi's UI cannot be framed over a snapshot screen: the mode forces it off.
        if (s.mode === "snapshot") return;
        s.fullUiOn = on;
        if (on) {
            // Stop our own picture before the Pi's starts. fullUiOn is already true, so
            // loadStream is closed for business and nothing reopens what this drops.
            s.mjpegOpen = false;
            this.emit({ type: "dropMjpeg" });
        } else {
            // loadStream guards itself on mode and mjpegPaused, so this resumes MJPEG only
            // if MJPEG is what was showing before.
            this.loadStream();
        }
    }

    private onVisibility(hidden: boolean, t: number): void {
        const s = this.s;
        s.documentHidden = hidden;
        if (hidden) {
            s.hiddenAt = t;
            return;
        }
        // After a real stay in the background what still reads as connected usually is
        // not: iOS freezes the page and its sockets go quiet without closing. So past a
        // few seconds the HID socket is replaced and the stream reloaded, not trusted.
        const away = s.hiddenAt === null ? 0 : t - s.hiddenAt;
        s.hiddenAt = null;
        this.emit({ type: "hid", action: away > AWAY_RECONNECT_MS ? "kick" : "connect" });
        if (s.mode === "snapshot") this.scheduleSnapshot(0);
        else {
            if (s.mode === "native") this.emit({ type: "pollHealth", timeoutMs: HEALTH_ABORT_MS });
            if (away > AWAY_RECONNECT_MS || s.signal !== "live") this.loadStream();
        }
    }

    /* ---- snapshot ---- */

    private scheduleSnapshot(delay: number): void {
        if (this.s.mode !== "snapshot") return;
        this.start(TIMER.snapshot, Math.max(0, delay));
    }

    private loadSnapshotFrame(): void {
        const s = this.s;
        if (s.mode !== "snapshot" || s.snapshotInFlight) return;
        if (s.documentHidden) {
            this.scheduleSnapshot(SNAPSHOT_HIDDEN_RETRY_MS);
            return;
        }
        s.snapshotInFlight = true;
        this.emit({ type: "fetchSnapshot", timeoutMs: SNAPSHOT_ABORT_MS });
    }

    private onSnapshotDecoded(): void {
        const s = this.s;
        s.snapshotInFlight = false;
        if (s.mode !== "snapshot") {
            this.emit({ type: "discardSnapshot" });
            return;
        }
        this.emit({ type: "presentSnapshot" });
        s.hasFrame = true;
        s.streamUp = true;
        s.serverDown = false;
        s.snapshotFailures = 0;
        this.setSignal(s.blank.blank ? "nosignal" : "live");
        this.scheduleSnapshot(SNAPSHOT_INTERVAL_MS);
    }

    private snapshotFailed(): void {
        const s = this.s;
        if (s.mode !== "snapshot") return;
        s.snapshotFailures += 1;
        s.serverDown = true;
        this.setSignal(s.snapshotFailures >= SNAPSHOT_DISCONNECTED_AFTER ? "disconnected" : "reconnecting");
        this.scheduleSnapshot(Math.min(SNAPSHOT_BACKOFF_BASE_MS * Math.pow(SNAPSHOT_BACKOFF_FACTOR, s.snapshotFailures - 1), SNAPSHOT_BACKOFF_MAX_MS));
    }

    /* ---- WebRTC ---- */

    private startNativeWebrtc(): void {
        const s = this.s;
        if (s.mode !== "native" || s.janusStarted || !s.janusAvailable) return;
        s.janusStarted = true;
        s.sawVideo = false;
        this.emit({ type: "janusStart" });
    }

    /**
     * A WebRTC track arrived. Show the <video> and start it MUTED: Safari/iOS refuse to
     * autoplay an unmuted MediaStream without a user gesture, so the picture must never
     * wait on audio permission. The MJPEG <img> is NOT hidden here: that swap waits for
     * the <video>'s "playing" event, so the fallback stays up until frames are genuinely
     * decoding and a silent WebRTC failure never leaves a blank screen.
     */
    private activateWebrtc(): void {
        const s = this.s;
        if (s.webrtcActive) return;
        s.webrtcActive = true;
        if (s.reconnectPending) {
            s.reconnectPending = false;
            this.cancel(TIMER.reconnect);
        }
        this.emit({ type: "webrtcActivated" });
        // The visible <video> must stay rendered to actually decode, so a stream that
        // connects but never produces frames would otherwise sit black over the MJPEG.
        this.start(TIMER.playWatchdog, PLAY_WATCHDOG_MS);
    }

    private onVideoPlaying(): void {
        const s = this.s;
        if (!s.webrtcActive) return;
        if (!s.webrtcSwapped) {
            s.webrtcSwapped = true;
            s.mjpegPaused = true;
            s.mjpegOpen = false;
            this.cancel(TIMER.playWatchdog);
            this.cancel(TIMER.streamWatchdog);
            if (s.reconnectPending) {
                s.reconnectPending = false;
                this.cancel(TIMER.reconnect);
            }
            this.emit({ type: "videoSwapped", first: true });
            this.setSignal("live");
            return;
        }
        this.emit({ type: "videoSwapped", first: false });
    }

    /**
     * Fall back to MJPEG: show the <img>, hide the <video>, resume the MJPEG pipeline.
     *
     * Nothing to fall back FROM means nothing to do. This is called on every WebRTC
     * "error" while no video has been seen and the wrapper keeps retrying, so on any Pi
     * without a working Janus it ran every few seconds forever; everything below is
     * teardown of a session that is not there, except the last lines, which throw away
     * a perfectly good MJPEG connection and reopen it: five reopens in 25 seconds, each
     * freezing the last frame, a visible stutter every five seconds. mjpegPaused tells
     * the two cases apart: WebRTC suspends the MJPEG pipeline when it takes over, so a
     * fallback that has to resume it still has work even though webrtcActive never
     * became true.
     */
    private fallbackToMjpeg(): void {
        const s = this.s;
        const was = s.webrtcActive;
        if (!was && !s.mjpegPaused) return;
        s.webrtcActive = false;
        s.webrtcSwapped = false;
        this.cancel(TIMER.playWatchdog);
        s.mjpegPaused = false;
        // Signal first: leaving "live" freezes the frame, and the <video> must still be showing
        // for there to be one to hold. (Hiding it first lost the last frame of every WebRTC drop.)
        if (was) this.setSignal("offline"); // brief "reconnecting" while the <img> reloads
        this.emit({ type: "webrtcFallback", wasActive: was });
        s.streamUp = false;
        this.loadStream();
    }

    /* ---- blank frames ---- */

    private onBlankSample(uniform: boolean, t: number): void {
        const s = this.s;
        const before = s.blank.blank;
        s.blank = stepBlank(s.blank, uniform, t);
        if (s.blank.blank !== before) this.reevalSignal();
    }

    private reevalSignal(): void {
        const s = this.s;
        if (s.mjpegPaused && !s.webrtcActive) return; // snapshot mode / WebRTC suspension owns the status
        if (s.blank.blank && s.streamUp) this.setSignal("nosignal");
        else if (s.streamUp && !s.serverDown) this.setSignal("live");
    }
}
