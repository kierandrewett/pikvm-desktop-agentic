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
/** WebRTC: <video> must be playing this soon after the track arrives, or the session has failed and is retried. */
export const PLAY_WATCHDOG_MS = 6000;
/** WebRTC: no video track within this of starting the session = it failed and is retried. A Janus handshake is about ten round trips plus the first picture. */
export const START_GUARD_MS = 12000;
/** Back from the background for longer than this: the WebRTC session is restarted instead of trusted (the stream and the socket go past `RESUME_STALE_MS`). */
export const AWAY_RECONNECT_MS = 3000;
/** WebRTC retry: 500 ms, doubling, capped at 15 s, each delay spread by +-20 %; no attempt limit (W7). */
export const WEBRTC_RETRY_INITIAL_MS = 500;
export const WEBRTC_RETRY_FACTOR = 2;
export const WEBRTC_RETRY_MAX_MS = 15000;
export const WEBRTC_RETRY_JITTER = 0.2;
/** A session that has played this long has earned a fast first retry again (W8). */
export const WEBRTC_STABLE_MS = 10000;
/** A hidden page that nobody watches retries this slowly (W15). */
export const WEBRTC_HIDDEN_RETRY_MS = 30000;
/** One burst of "the network is back" signals is one new session: a session this young with no video yet is not restarted again (W15). */
export const WEBRTC_DUPLICATE_MS = 500;
/** Three adaptive loads in a row that fail make the next load the direct stream, to tell missing routes from a dead network (V14). */
export const ADAPTIVE_FAILURES_BEFORE_TRIAL = 3;
/** After the direct stream worked where the adaptive one failed three times, the adaptive one is left alone this long while the cause is unknown (a refusal that will pass: the client limit, the Pi down) (V14). */
export const ADAPTIVE_RETRY_MS = 60 * 1000;
/** The same, once the host has answered 404 to the adaptive status address: the routes are not there (V14). */
export const ADAPTIVE_BLOCK_MS = 10 * 60 * 1000;
/** ICE or the connection disconnected for this long is a drop (W10). */
export const WEBRTC_DISCONNECTED_MS = 3000;
/** Nothing at all (media, transport heartbeat) for this long is a silent drop (W11). */
export const WEBRTC_STALL_MS = 4000;
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
/** Why a Janus session ended by itself. The wrapper reports it once and then has nothing more to say (W6, W9). */
export type JanusFailure =
    /** The Janus library could not be loaded. */
    | "load"
    /** The signalling socket could not be opened or was lost. */
    | "signalling"
    /** The Pi's plugin or the handle refused, or the Pi stopped the stream. */
    | "plugin"
    /** The answer to the Pi's offer could not be made (a camera or microphone that cannot be opened). */
    | "answer"
    /** The Pi hung up the peer connection or detached the handle. */
    | "hangup"
    /** ICE failed, or the connection failed. */
    | "ice-failed"
    /** ICE or the connection stayed disconnected past `WEBRTC_DISCONNECTED_MS`. */
    | "ice-disconnected"
    /** The connection closed under the session. */
    | "closed"
    /** Nothing arrived, not even the transport's own heartbeat, for `WEBRTC_STALL_MS`. */
    | "stalled";

/** `JanusFailure`, or one only the machine can see: its own time-outs. */
export type WebrtcFailure = JanusFailure | "no-video" | "not-playing";

/** The session ended by itself (it is stopped; the machine decides what comes next). */
export interface JanusFailedEvent extends Stamped {
    readonly type: "janusFailed";
    readonly reason: JanusFailure;
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
/**
 * The page is about to be frozen or put in the back/forward cache (`freeze`, `pagehide`): it may
 * never be told it is hidden, so this is where the time away starts if nothing has started it.
 */
export interface FreezeEvent extends Stamped {
    readonly type: "freeze";
}
/**
 * Something says the page is back: `pageshow` after a back/forward cache restore, the window gaining
 * focus, the Page Lifecycle `resume`. `hidden` is what `document.hidden` reads when it arrives.
 */
export interface ResumeEvent extends Stamped {
    readonly type: "resume";
    readonly reason: "pageshow" | "focus" | "resume";
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
    /** The page sends its microphone or camera over the WebRTC session: it must outlive the framed UI. */
    readonly keepSession?: boolean;
}

/** Whether anyone needs the MJPEG stream: preview collapsed, and whether background screen alerts watch it. */
export interface NeedEvent extends Stamped {
    readonly type: "need";
    readonly collapsed: boolean;
    readonly watching: boolean;
}

/** Which MJPEG source the page asks for: "auto" follows the link (V12); the others are a person's or the governor's choice. */
export type SourcePref = "auto" | "adaptive" | "direct";
export interface SourceEvent extends Stamped {
    readonly type: "source";
    readonly pref: SourcePref;
}
/** Keep WebRTC off for `ms` (the link is too weak for it): the picture is the reduced MJPEG meanwhile (W20). */
export interface HoldWebrtcEvent extends Stamped {
    readonly type: "holdWebrtc";
    readonly ms: number;
}
/** End a hold now: WebRTC starts again as a normal attempt (W21). */
export interface ReleaseWebrtcEvent extends Stamped {
    readonly type: "releaseWebrtc";
}
/** The host's answer to `probeAdaptive`: `missing` when it said 404 (V14). */
export interface AdaptiveProbeEvent extends Stamped {
    readonly type: "adaptiveProbe";
    readonly missing: boolean;
}

export type VideoEvent =
    | SourceEvent
    | HoldWebrtcEvent
    | ReleaseWebrtcEvent
    | AdaptiveProbeEvent
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
    | JanusFailedEvent
    | JanusActiveEvent
    | VideoPlayingEvent
    | BlankSampleEvent
    | VisibilityEvent
    | OnlineEvent
    | FreezeEvent
    | ResumeEvent
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
    /** Spread the delay by up to +-this fraction (0.2 = +-20 %), so retries from many clients do not land together. The driver fulfils it. */
    readonly jitter?: number;
}
export interface CancelTimerEffect {
    readonly type: "cancelTimer";
    readonly id: string;
}
export type VideoSchedulingEffect = StartTimerEffect | CancelTimerEffect;

/** The running Janus session should be stopped (the driver owns the Janus client port). */
export interface JanusStopEffect {
    readonly type: "janusStop";
}

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
    /** Point the <img> at the MJPEG stream for `key` (the adapter adds the per-browser quirk and a cache-buster). `source` "adaptive" is the per-device reduced stream (V12). */
    | { readonly type: "loadMjpeg"; readonly key: string; readonly source: "direct" | "adaptive" }
    /** What is on screen: the Pi's own MJPEG, the reduced per-device MJPEG, or WebRTC; and whether the reduced one is turned off for now (V14). */
    | { readonly type: "source"; readonly source: "direct" | "adaptive" | "webrtc"; readonly adaptiveBlocked: boolean }
    /** Ask the host whether it has the adaptive routes at all (a 404 on the status address says it has not); the answer comes back as `adaptiveProbe` (V14). */
    | { readonly type: "probeAdaptive" }
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
    /** A WebRTC session that had played is being brought back (`retrying`), or is back or no longer wanted: the chip says "reconnecting video" meanwhile. */
    | { readonly type: "webrtcRetry"; readonly retrying: boolean }
    /** Sample the picture for blankness: from the <video> when WebRTC is showing, else the <img>. */
    | { readonly type: "sampleBlank"; readonly source: "video" | "image" }
    /** The input socket should be replaced (`kick`: it may be dead) or ensured (`connect`). */
    | { readonly type: "hid"; readonly action: "kick" | "connect" };

export type VideoEffect = VideoSchedulingEffect | JanusStartEffect | JanusStopEffect | VideoRenderEffect;

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
export function statusLabel(state: SignalState, inputOpen: boolean, videoRetrying = false, reduced = false): string {
    const live = state === "live";
    return STATUS[state].label + (videoRetrying && live ? " · reconnecting video" : "") + (reduced && live ? " · reduced" : "") + (inputOpen ? "" : " · input offline");
}

/**
 * The chip's colour. A picture that is live over MJPEG while WebRTC is being brought back, or that is the reduced one, is
 * amber: nothing is lost but the sharper picture and the sound, and a green chip would say nothing is wrong.
 */
export function statusTone(state: SignalState, videoRetrying = false, reduced = false): StatusTone {
    return (videoRetrying || reduced) && state === "live" ? "warn" : STATUS[state].tone;
}
