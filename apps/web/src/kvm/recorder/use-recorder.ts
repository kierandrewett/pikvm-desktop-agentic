/**
 * How the screen's controls reach the recorder: one recorder per picture, made once the picture exists and handed down
 * through a context, the way the session is. The recorder reads the `<video>` the picture machine plays, so it is made
 * from the stage's own element rather than asking the picture controller (which owns playback, not recording).
 */

import { createStore, type ReadableStore } from "@pikvm/kvm-engine";
import { createContext, useContext, useEffect, useRef, useState, type RefObject } from "react";
import { useAppState } from "../../api/queries";
import { MIC_DEVICE_KEY, readDeviceChoice } from "../../settings/local-prefs";
import type { PictureController, PictureState } from "../picture-controller";
import type { KvmSession } from "../session";
import { useStore } from "../use-store";
import { createRecorder, recordSupport, type Recorder, type RecorderState } from "./recorder";

const RecorderContext = createContext<Recorder | null>(null);

export const RecorderProvider = RecorderContext.Provider;

/** The screen's recorder, or null before the picture exists (and outside the screen). */
export function useRecorder(): Recorder | null {
    return useContext(RecorderContext);
}

const BLANK: RecorderState = {
    phase: "idle",
    elapsedMs: 0,
    bytesSent: 0,
    bytesQueued: 0,
    retrying: false,
    error: null,
    recordingId: null,
    micMissing: false,
};
const BLANK_STORE: ReadableStore<RecorderState> = createStore(BLANK);

export function useRecorderState(recorder: Recorder | null): RecorderState {
    return useStore(recorder?.store ?? BLANK_STORE);
}

/** The host name of the PiKVM, for the list ("pikvm.lan"); null when it is not known yet. */
function targetName(origin: string | undefined): string | null {
    if (!origin) return null;
    try {
        return new URL(origin).host || null;
    } catch {
        return origin;
    }
}

/** Makes the recorder for this picture and ends it with the picture. `stage` holds the `<video>`. */
export function useKvmRecorder(controller: PictureController | null, stage: RefObject<HTMLElement | null>, session: KvmSession): Recorder | null {
    const [recorder, setRecorder] = useState<Recorder | null>(null);
    const state = useAppState();
    const target = useRef<string | null>(null);
    target.current = targetName(state.data?.pikvm.origin);
    const notify = session.notices.notify;

    useEffect(() => {
        const video = controller ? stage.current?.querySelector<HTMLVideoElement>("video.kvm-video") : null;
        if (!controller || !video) return;
        const made = createRecorder({
            video,
            micDeviceId: () => readDeviceChoice(MIC_DEVICE_KEY).id,
            target: () => target.current,
            notify,
        });
        setRecorder(made);
        return () => {
            setRecorder(null);
            made.dispose();
        };
    }, [controller, stage, notify]);

    return recorder;
}

/** What a Record button shows, from the picture and the recorder. One place, so the toolbar, dock and sheet agree. */
export interface RecordButtonView {
    readonly disabled: boolean;
    readonly recording: boolean;
    readonly busy: boolean;
    readonly warn: boolean;
    /** Elapsed time while recording ("04:12"), else empty. */
    readonly clock: string;
    readonly label: string;
    readonly title: string;
}

export function formatClock(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const two = (n: number): string => String(n).padStart(2, "0");
    return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

export function recordButtonView(picture: Pick<PictureState, "webrtc">, recorder: Recorder | null, state: RecorderState): RecordButtonView {
    const recording = state.phase === "recording";
    const busy = state.phase === "starting" || state.phase === "stopping";
    const unavailable = recorder === null ? recordSupport(picture.webrtc) ?? "Recording starts when the picture is ready." : recordSupport(picture.webrtc);
    const clock = recording ? formatClock(state.elapsedMs) : "";
    if (recording) {
        const held = state.retrying ? " The host is out of reach; the recording is kept here and sent when it returns." : "";
        return { disabled: false, recording, busy, warn: state.retrying, clock, label: `Stop recording (${clock})`, title: `Stop recording. ${clock} so far.${held}` };
    }
    if (busy) {
        const word = state.phase === "starting" ? "Starting the recording" : "Saving the recording";
        return { disabled: true, recording, busy, warn: false, clock, label: word, title: `${word}...` };
    }
    if (unavailable) return { disabled: true, recording, busy, warn: false, clock, label: "Record the session", title: unavailable };
    if (state.phase === "failed" && state.error) {
        return { disabled: false, recording, busy, warn: true, clock, label: "Record the session", title: `${state.error} Click to record again.` };
    }
    return {
        disabled: false,
        recording,
        busy,
        warn: false,
        clock,
        label: "Record the session",
        title: "Record the picture, the target's sound and your microphone",
    };
}
