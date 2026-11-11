/**
 * How the screen's controls reach the Record control: one per screen, made once and handed down through a context, the way the
 * session is. It needs no picture: the host records the PiKVM's own stream, so it works from any tab (MJPEG included) and shows a
 * recording another client started.
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { createStore, type Notify } from "@pikvm/kvm-engine";
import { MIC_DEVICE_KEY, readDeviceChoice } from "../../settings/local-prefs";
import { useStore } from "../use-store";
import { liveFeed, type LiveFeedState } from "./live";
import { createRecordControl, type RecordControl, type RecordControlState } from "./recorder";

const RecorderContext = createContext<RecordControl | null>(null);
const FALLBACK_CONTROL = createStore<RecordControlState>({ phase: "idle", error: null, micNote: null, feeding: false });
const FALLBACK_FEED = createStore<LiveFeedState>({ live: null, receivedAt: 0, stale: false });

export const RecorderProvider = RecorderContext.Provider;

/** The screen's Record control, or null outside the screen. */
export function useRecorder(): RecordControl | null {
    return useContext(RecorderContext);
}

/** Makes the screen's Record control, follows the host's live state while the screen is mounted and lets go when it is not. */
export function useKvmRecorder(notify: Notify | undefined): RecordControl {
    const control = useMemo(() => createRecordControl({ feed: liveFeed(), micDeviceId: () => readDeviceChoice(MIC_DEVICE_KEY).id, ...(notify ? { notify } : {}) }), [notify]);
    useEffect(() => control.attach(), [control]);
    return control;
}

export interface RecordUiState {
    readonly control: RecordControlState;
    readonly feed: LiveFeedState;
    /** This page's clock, which moves while a recording runs. */
    readonly now: number;
}

/** The control's state, the host's live state, and a clock that ticks twice a second only while a recording runs. */
export function useRecordUi(control: RecordControl | null): RecordUiState {
    const own = useStore(control?.store ?? FALLBACK_CONTROL);
    const feed = useStore(control?.feed.store ?? FALLBACK_FEED);
    const [now, setNow] = useState(() => Date.now());
    // A recording whose host cannot be heard has a frozen clock: nothing to tick for.
    const running = feed.live?.recording != null && !feed.stale;
    useEffect(() => {
        if (!running) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(timer);
    }, [running]);
    return { control: own, feed, now };
}


/** What a Record button shows. One place, so the toolbar, dock and sheet agree. */
export interface RecordButtonView {
    readonly disabled: boolean;
    readonly recording: boolean;
    readonly busy: boolean;
    readonly warn: boolean;
    /** The host cannot be reached: `recording` is what was last heard, and the capture may well be going on there. */
    readonly stale: boolean;
    /** Elapsed time while recording ("04:12"), else empty. */
    readonly clock: string;
    readonly label: string;
    readonly title: string;
    /** What the sheet's row shows where the other rows show their state. */
    readonly pip: string;
}

export function formatClock(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const two = (n: number): string => String(n).padStart(2, "0");
    return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

export function recordButtonView(ui: RecordUiState): RecordButtonView {
    const { control, feed, now } = ui;
    const live = feed.live;
    const recording = live?.recording != null;
    const busy = control.phase !== "idle";
    if (live && live.recording && feed.stale) {
        // The capture is on the host: a page that has lost it knows the recording was running, not that it still is. The time stops at the last
        // word from the host and is shown as unknown, never counted on; a click still means Stop, and says plainly when it cannot get through.
        const lastSeen = formatClock(live.elapsedMs);
        return {
            disabled: control.phase === "stopping",
            recording,
            busy: control.phase === "stopping",
            warn: true,
            stale: true,
            clock: "--:--",
            label: `Lost contact with the host: stop recording (last seen at ${lastSeen})`,
            title: `Cannot reach the host. The recording may still be running there; it will be shown again when the connection is back. Last heard at ${lastSeen}. Click to try to stop it.`,
            pip: "Lost contact",
        };
    }
    if (live && live.recording) {
        const clock = formatClock(live.elapsedMs + Math.max(0, now - feed.receivedAt));
        const reconnecting = live.connection === "reconnecting";
        const notes = [
            reconnecting ? `The host lost the PiKVM's stream${live.connectionNote ? ` (${live.connectionNote})` : ""} and is reconnecting; the recording has a gap until it returns.` : "",
            live.holes.length > 0 ? `${live.holes.length} gap${live.holes.length === 1 ? "" : "s"} so far.` : "",
            live.mic === "waiting" && !control.feeding ? "No microphone is being recorded." : "",
        ].filter(Boolean);
        return {
            disabled: control.phase === "stopping",
            recording,
            busy: control.phase === "stopping",
            warn: reconnecting,
            stale: false,
            clock,
            label: `Stop recording (${clock})`,
            title: `Stop recording. ${clock} so far, recorded on the host.${notes.length > 0 ? ` ${notes.join(" ")}` : ""}`,
            pip: clock,
        };
    }
    if (busy) {
        const word = control.phase === "starting" ? "Starting the recording" : "Stopping the recording";
        return { disabled: true, recording: false, busy, warn: false, stale: false, clock: "", label: word, title: `${word}...`, pip: "..." };
    }
    const idle = "Record the session on the host: the picture and the target's sound";
    if (control.error) return { disabled: false, recording: false, busy: false, warn: true, stale: false, clock: "", label: "Record the session", title: `${control.error} Click to record again.`, pip: "Off" };
    return {
        disabled: false,
        recording: false,
        busy: false,
        warn: false,
        stale: false,
        clock: "",
        label: "Record the session",
        title: control.micNote ? `${idle}. ${control.micNote}` : `${idle}, and your microphone`,
        pip: "Off",
    };
}
