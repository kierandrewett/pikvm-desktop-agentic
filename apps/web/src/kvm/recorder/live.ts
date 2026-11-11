/**
 * What the host is recording, as this page hears it: one server-sent stream with the capture in progress and the recordings still being
 * finished. The host makes the recording, so the state is the host's, whoever started it (this page, another client, a meeting detector);
 * the Record buttons and the Recordings page show the same thing from this one place.
 *
 * The stream is held while somebody uses it (`retain`) and the page is shown. A page in the background holds none, and takes a fresh one,
 * which begins with the current state, when it is shown again (the same rule the shared cursor follows).
 *
 * A broken stream is opened again here (growing pauses, never the browser's own retry: that stops for good after an HTTP error such as the
 * 502 of a server that is away). The capture runs on the host whether or not this page can hear it, so what was last heard is KEPT and
 * marked `stale` once the break has lasted a few seconds; the first state of the new stream clears it and says what the host did meanwhile.
 */

import { createStore, type ReadableStore } from "@pikvm/kvm-engine";
import { RECORDING_LIVE_PATH, type RecordingLive } from "@pikvm/contracts/recordings";

export interface LiveFeedState {
    /**
     * The newest state the host sent; null before the first one. While the stream is broken (`stale`) it is the LAST state heard, not the host's
     * state now: the capture is on the host, so a page that loses the host knows nothing about what the host does next.
     */
    readonly live: RecordingLive | null;
    /** This page's own clock when `live` arrived: `live.elapsedMs` was true on the host at `live.at`, and counts on from here. */
    readonly receivedAt: number;
    /** The stream has been broken for a few seconds (or went silent while something ran) and is being opened again: `live` may be out of date. */
    readonly stale: boolean;
}

const NOTHING: LiveFeedState = { live: null, receivedAt: 0, stale: false };

/** A stream that breaks and returns within this long is not worth a warning: proxies cut idle streams. */
const GRACE_MS = 3000;
/** While a recording or a re-encode runs the host sends a state every second; this long without one is a dead stream (a half-open socket sends no error). */
const SILENCE_MS = 8000;
/** The pauses before opening the stream again, growing; the last one repeats. */
const RETRY_MS = [1000, 2000, 4000, 8000, 15000] as const;

export interface LiveFeed {
    readonly store: ReadableStore<LiveFeedState>;
    /** Opens the stream until the returned function has been called as often as `retain` was. */
    retain(): () => void;
    /** Opens the stream again now when it is broken, instead of after the next pause. */
    refresh(): void;
}

/** What of EventSource this reads, so a test can bring its own. */
export interface LiveSource {
    onmessage: ((event: MessageEvent<string>) => void) | null;
    onerror: ((event: Event) => void) | null;
    close(): void;
}

function isLive(value: unknown): value is RecordingLive {
    return typeof value === "object" && value !== null && "at" in value && "finishing" in value && Array.isArray(value.finishing);
}

/** Whether the host is expected to send a state every second. */
const busy = (live: RecordingLive): boolean => live.recording !== null || live.finishing.length > 0;

export function createLiveFeed(open?: (url: string) => LiveSource): LiveFeed {
    const connect = open ?? (typeof EventSource === "undefined" ? undefined : (url: string): LiveSource => new EventSource(url));
    const store = createStore<LiveFeedState>(NOTHING);
    let holders = 0;
    let source: LiveSource | null = null;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;

    const clear = (timer: ReturnType<typeof setTimeout> | null): null => {
        if (timer) clearTimeout(timer);
        return null;
    };

    const close = (): void => {
        source?.close();
        source = null;
        silenceTimer = clear(silenceTimer);
    };

    const stopTimers = (): void => {
        close();
        retryTimer = clear(retryTimer);
        graceTimer = clear(graceTimer);
    };

    const attach = (): void => {
        if (holders === 0 || source || !connect || document.hidden) return;
        const stream = connect(RECORDING_LIVE_PATH);
        source = stream;
        stream.onmessage = (message) => {
            if (source !== stream) return;
            try {
                const parsed: unknown = JSON.parse(message.data);
                if (!isLive(parsed)) return;
                failures = 0;
                retryTimer = clear(retryTimer);
                graceTimer = clear(graceTimer);
                silenceTimer = clear(silenceTimer);
                if (busy(parsed)) {
                    silenceTimer = setTimeout(() => {
                        if (source === stream) lose();
                    }, SILENCE_MS);
                }
                store.setState({ live: parsed, receivedAt: Date.now(), stale: false });
            } catch {
                // Not a state: the next one is.
            }
        };
        // The browser would open the stream again by itself, but not after an HTTP error (a 502 from a server that is away ends it for good), so
        // this closes it and opens it again itself, with growing pauses. What was last heard stays, marked stale once the break has lasted.
        stream.onerror = () => {
            if (source === stream) lose();
        };
    };

    function lose(): void {
        close();
        const state = store.getState();
        if (!state.stale && !graceTimer) {
            graceTimer = setTimeout(() => {
                graceTimer = null;
                if (holders > 0 && !store.getState().stale) store.setState({ ...store.getState(), stale: true });
            }, GRACE_MS);
        }
        if (retryTimer) return;
        const pause = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)] ?? RETRY_MS[RETRY_MS.length - 1];
        failures += 1;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            attach();
        }, pause);
    }

    const onVisibility = (): void => {
        if (document.hidden) {
            stopTimers();
            // A page that has lost the host keeps saying so; otherwise a hidden page knows nothing until it is shown again.
            if (!store.getState().stale) store.setState(NOTHING);
        } else {
            failures = 0;
            attach();
        }
    };

    return {
        store,
        retain() {
            holders += 1;
            if (holders === 1) document.addEventListener("visibilitychange", onVisibility);
            attach();
            let released = false;
            return () => {
                if (released) return;
                released = true;
                holders -= 1;
                if (holders > 0) return;
                document.removeEventListener("visibilitychange", onVisibility);
                stopTimers();
                failures = 0;
                store.setState(NOTHING);
            };
        },
        refresh() {
            if (holders === 0 || source) return;
            retryTimer = clear(retryTimer);
            failures = 0;
            attach();
        },
    };
}

let shared: LiveFeed | null = null;

/** The page's one feed. */
export function liveFeed(): LiveFeed {
    shared ??= createLiveFeed();
    return shared;
}
