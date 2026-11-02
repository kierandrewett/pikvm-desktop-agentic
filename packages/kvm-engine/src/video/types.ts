// The video source machine's vocabulary: events in, effects out, plus the timing
// constants, all carried over from the old console unchanged.

/** What the status chip and the overlay show. */
export type SignalState = "connecting" | "live" | "nosignal" | "offline" | "reconnecting" | "disconnected";

/** How the picture reaches us: not decided yet, ustreamer's MJPEG (+ WebRTC), or polled snapshots for VNC-lab targets. */
export type ScreenMode = "detecting" | "native" | "snapshot";

/* ---- timing, from console.js ---- */

/** First MJPEG frame must arrive within this or the stream is reconnected. */
export const STREAM_WATCHDOG_MS = 7000;
/** Reconnect backoff: 800 ms, x1.7 each time, capped at 8 s; reset by a real frame. */
export const RECONNECT_INITIAL_MS = 800;
export const RECONNECT_FACTOR = 1.7;
export const RECONNECT_MAX_MS = 8000;
/** The health poll cadence and its abort. */
export const HEALTH_POLL_MS = 2500;
export const HEALTH_ABORT_MS = 4000;
/** Mode detection (GET /api/info) gives up after this and falls back to native. */
export const INFO_ABORT_MS = 2500;
/** Snapshot transport: cadence after a good frame, abort per fetch, failure backoff and when to call it down. */
export const SNAPSHOT_INTERVAL_MS = 200;
export const SNAPSHOT_ABORT_MS = 5000;
export const SNAPSHOT_HIDDEN_RETRY_MS = 500;
export const SNAPSHOT_BACKOFF_BASE_MS = 400;
export const SNAPSHOT_BACKOFF_FACTOR = 1.8;
export const SNAPSHOT_BACKOFF_MAX_MS = 5000;
export const SNAPSHOT_DISCONNECTED_AFTER = 3;
/** WebRTC: <video> must be playing this soon after the track arrives, or fall back to MJPEG. */
export const PLAY_WATCHDOG_MS = 6000;
/** WebRTC: no video at all within this of starting the Janus session = fall back (harmless; MJPEG already runs). */
export const START_GUARD_MS = 8000;
/** Back from the background for longer than this: replace the sockets instead of trusting them. */
export const AWAY_RECONNECT_MS = 3000;
/** Blank-frame sampling cadence, grid size and rule (see blank.ts). */
export const BLANK_SAMPLE_MS = 1500;

/* ---- events ---- */

interface Stamped {
    /** Milliseconds on the engine clock. */
    readonly t: number;
}

/** Boot: begin detecting the screen mode. */
export interface StartEvent extends Stamped {
    readonly type: "start";
    /** Whether the Janus client exists and the browser can do WebRTC. */
    readonly janusAvailable: boolean;
    /** Seed for MJPEG stream keys (random per page load). */
    readonly streamKey: string;
    readonly documentHidden?: boolean;
}

export interface InfoResultEvent extends Stamped {
    readonly type: "infoResult";
    readonly mode: "native" | "snapshot";
}
export interface InfoFailedEvent extends Stamped {
    readonly type: "infoFailed";
}

export interface TimerEvent extends Stamped {
    readonly type: "timer";
    readonly id: string;
}

/** The MJPEG <img> fired load (first frame) / error. */
export interface MjpegLoadedEvent extends Stamped {
    readonly type: "mjpegLoaded";
}
export interface MjpegErrorEvent extends Stamped {
    readonly type: "mjpegError";
}

/** GET /streamer/state answered; `online` is result.source.online. */
export interface HealthResultEvent extends Stamped {
    readonly type: "healthResult";
    readonly online: boolean;
}
/** The health poll failed or timed out: the server is down. */
export interface HealthFailedEvent extends Stamped {
    readonly type: "healthFailed";
}

/** A snapshot was fetched AND decoded as an image. */
export interface SnapshotDecodedEvent extends Stamped {
    readonly type: "snapshotDecoded";
}
/** A snapshot fetch failed, was not an image, or did not decode. */
export interface SnapshotFailedEvent extends Stamped {
    readonly type: "snapshotFailed";
}

/** The Janus client's start() returned (ok) or threw. */
export interface JanusStartResultEvent extends Stamped {
    readonly type: "janusStartResult";
    readonly ok: boolean;
}
export interface JanusStatusEvent extends Stamped {
    readonly type: "janusStatus";
    readonly status: "connecting" | "live" | "error";
}
export interface JanusActiveEvent extends Stamped {
    readonly type: "janusActive";
    readonly active: boolean;
    /** The session currently has a remote video track. */
    readonly hasVideo: boolean;
}

/** The <video> fired `playing`: frames are genuinely decoding. */
export interface VideoPlayingEvent extends Stamped {
    readonly type: "videoPlaying";
}

/** A blank-frame sample was taken (only requested while sampling is worthwhile). */
export interface BlankSampleEvent extends Stamped {
    readonly type: "blankSample";
    readonly uniform: boolean;
}

export interface VisibilityEvent extends Stamped {
    readonly type: "visibility";
    readonly hidden: boolean;
}
export interface OnlineEvent extends Stamped {
    readonly type: "online";
}
export interface OfflineEvent extends Stamped {
    readonly type: "offline";
}

/** The Pi's own UI was framed over the picture (or removed). */
export interface FullUiEvent extends Stamped {
    readonly type: "fullUi";
    readonly on: boolean;
}

/** Whether anyone needs the MJPEG stream: preview collapsed, and whether background screen alerts watch it. */
export interface NeedEvent extends Stamped {
    readonly type: "need";
    readonly collapsed: boolean;
    readonly watching: boolean;
}

export type VideoEvent =
    | StartEvent
    | InfoResultEvent
    | InfoFailedEvent
    | TimerEvent
    | MjpegLoadedEvent
    | MjpegErrorEvent
    | HealthResultEvent
    | HealthFailedEvent
    | SnapshotDecodedEvent
    | SnapshotFailedEvent
    | JanusStartResultEvent
    | JanusStatusEvent
    | JanusActiveEvent
    | VideoPlayingEvent
    | BlankSampleEvent
    | VisibilityEvent
    | OnlineEvent
    | OfflineEvent
    | FullUiEvent
    | NeedEvent;

type Unstamped<T> = T extends unknown ? Omit<T, "t"> : never;
/** An event before the driver stamps it with the clock. */
export type VideoEventInit = Unstamped<VideoEvent>;

/* ---- effects ---- */

/** Scheduling requests: the driver fulfils them against the injected clock and never forwards them. */
export interface StartTimerEffect {
    readonly type: "startTimer";
    readonly id: string;
    readonly ms: number;
    /** Fire every `ms` until cancelled (the health poll and the blank sampler). */
    readonly repeat?: boolean;
}
export interface CancelTimerEffect {
    readonly type: "cancelTimer";
    readonly id: string;
}
export type VideoSchedulingEffect = StartTimerEffect | CancelTimerEffect;

/** The Janus session should be created and started (the driver owns the Janus client port). */
export interface JanusStartEffect {
    readonly type: "janusStart";
}

export type VideoRenderEffect =
    /** The signal state changed: repaint the chip and overlay. */
    | { readonly type: "signal"; readonly state: SignalState }
    /** Hold the last good frame on the freeze canvas (only requested when a frame exists). */
    | { readonly type: "freeze" }
    | { readonly type: "thaw" }
    /** Point the <img> at the MJPEG stream for `key` (the adapter adds the per-browser quirk and a cache-buster). */
    | { readonly type: "loadMjpeg"; readonly key: string }
    /** Remove the <img> src so the Pi's MJPEG connection is released. */
    | { readonly type: "dropMjpeg" }
    | { readonly type: "fetchInfo"; readonly timeoutMs: number }
    | { readonly type: "pollHealth"; readonly timeoutMs: number }
    | { readonly type: "fetchSnapshot"; readonly timeoutMs: number }
    /** The decoded snapshot becomes the picture (the previous object URL is released). */
    | { readonly type: "presentSnapshot" }
    /** The decoded snapshot arrived after the mode changed: throw it away. */
    | { readonly type: "discardSnapshot" }
    /** The screen mode was decided; the adapter sets titles and hides what the mode cannot do. */
    | { readonly type: "screenMode"; readonly mode: "native" | "snapshot" }
    /** A remote video track arrived: show the <video> muted but transparent ("warming"), start meters, reveal audio toggles. */
    | { readonly type: "webrtcActivated" }
    /** The <video> is really playing: reveal it, hide and release the <img>. `first` is true only for the swap itself. */
    | { readonly type: "videoSwapped"; readonly first: boolean }
    /** WebRTC is gone: show the <img>, hide the <video>, stop its tracks, hide audio toggles. */
    | { readonly type: "webrtcFallback"; readonly wasActive: boolean }
    /** Sample the picture for blankness: from the <video> when WebRTC is showing, else the <img>. */
    | { readonly type: "sampleBlank"; readonly source: "video" | "image" }
    /** The input socket should be replaced (`kick`: it may be dead) or ensured (`connect`). */
    | { readonly type: "hid"; readonly action: "kick" | "connect" };

export type VideoEffect = VideoSchedulingEffect | JanusStartEffect | VideoRenderEffect;

/* ---- status chip ---- */

export type StatusTone = "" | "ok" | "warn" | "bad";

export const STATUS: Readonly<Record<SignalState, { readonly tone: StatusTone; readonly label: string }>> = {
    connecting: { tone: "", label: "Connecting" },
    live: { tone: "ok", label: "Live" },
    nosignal: { tone: "warn", label: "No signal" },
    offline: { tone: "bad", label: "Reconnecting" },
    reconnecting: { tone: "", label: "Reconnecting" },
    disconnected: { tone: "bad", label: "Screen unavailable" },
};

/**
 * The chip's text: the stream state, plus whether input can reach the target. "input
 * offline" used to live only in a tooltip, so a console whose HID socket had dropped
 * showed a plain "Live" and every keystroke went nowhere.
 */
export function statusLabel(state: SignalState, inputOpen: boolean): string {
    return STATUS[state].label + (inputOpen ? "" : " · input offline");
}
