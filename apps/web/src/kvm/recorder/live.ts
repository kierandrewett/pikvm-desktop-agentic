/**
 * What the host is recording, as this page hears it: one server-sent stream with the capture in progress and the recordings still being
 * finished. The host makes the recording, so the state is the host's, whoever started it (this page, another client, a meeting detector);
 * the Record buttons and the Recordings page show the same thing from this one place.
 *
 * The stream is held while somebody uses it (`retain`) and the page is shown. A page in the background holds none, and takes a fresh one,
 * which begins with the current state, when it is shown again (the same rule the shared cursor follows).
 */

import { createStore, type ReadableStore } from "@pikvm/kvm-engine";
import { RECORDING_LIVE_PATH, type RecordingLive } from "@pikvm/contracts/recordings";

export interface LiveFeedState {
    /** The newest state the host sent; null before the first one and while the stream is down. */
    readonly live: RecordingLive | null;
    /** This page's own clock when `live` arrived: `live.elapsedMs` was true on the host at `live.at`, and counts on from here. */
    readonly receivedAt: number;
}

const NOTHING: LiveFeedState = { live: null, receivedAt: 0 };

export interface LiveFeed {
    readonly store: ReadableStore<LiveFeedState>;
    /** Opens the stream until the returned function has been called as often as `retain` was. */
    retain(): () => void;
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

export function createLiveFeed(open?: (url: string) => LiveSource): LiveFeed {
    const connect = open ?? (typeof EventSource === "undefined" ? undefined : (url: string): LiveSource => new EventSource(url));
    const store = createStore<LiveFeedState>(NOTHING);
    let holders = 0;
    let source: LiveSource | null = null;

    const close = (): void => {
        source?.close();
        source = null;
    };

    const attach = (): void => {
        if (holders === 0 || source || !connect || document.hidden) return;
        const stream = connect(RECORDING_LIVE_PATH);
        source = stream;
        stream.onmessage = (message) => {
            if (source !== stream) return;
            try {
                const parsed: unknown = JSON.parse(message.data);
                if (isLive(parsed)) store.setState({ live: parsed, receivedAt: Date.now() });
            } catch {
                // Not a state: the next one is.
            }
        };
        // The browser opens the stream again by itself and the host then begins with the current state; until it does, nothing is known.
        stream.onerror = () => {
            if (source === stream) store.setState(NOTHING);
        };
    };

    const onVisibility = (): void => {
        if (document.hidden) {
            close();
            store.setState(NOTHING);
        } else attach();
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
                close();
                store.setState(NOTHING);
            };
        },
    };
}

let shared: LiveFeed | null = null;

/** The page's one feed. */
export function liveFeed(): LiveFeed {
    shared ??= createLiveFeed();
    return shared;
}
