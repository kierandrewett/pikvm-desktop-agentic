/**
 * The Record control. The HOST records: it joins the PiKVM's stream itself, so there is nothing here to capture, encode or upload but
 * the person's microphone. This starts and stops the host's recording, sends the microphone while one runs (mic.ts), and tells the
 * person when the host ended a recording this page did not stop (a limit, the PiKVM gone for good, a host restart).
 *
 * What a recording IS, as far as this page shows it, comes from the host's live stream (live.ts), not from what this page did: a
 * recording another client or a meeting detector started shows here the same way, with the same clock, and either page can stop it.
 */

import { createStore, type Notify, type ReadableStore } from "@pikvm/kvm-engine";
import type { RecordingView } from "@pikvm/contracts/recordings";
import { getRecording, RecordingsError, startRecording, stopRecording } from "./api";
import type { LiveFeed, LiveFeedState } from "./live";
import { micFailureText, micSupport, newMicContext, openMicStream, startMicFeed, type MicEnd, type MicFeed } from "./mic";

export type RecordPhase = "idle" | "starting" | "stopping";

export interface RecordControlState {
    readonly phase: RecordPhase;
    /** Why the last start or stop failed, until the next one. */
    readonly error: string | null;
    /** Why this page sends no microphone (this browser cannot, or it was refused); null when it can. */
    readonly micNote: string | null;
    /** This page is sending its microphone to the host now. */
    readonly feeding: boolean;
}

export interface RecordControlOptions {
    readonly feed: LiveFeed;
    /** The pinned microphone ("" follows the system default); read when a recording starts. */
    readonly micDeviceId: () => string;
    readonly notify?: Notify;
}

export interface RecordControl {
    readonly store: ReadableStore<RecordControlState>;
    readonly feed: LiveFeed;
    /** Follows the host's live state and keeps this page's microphone going through a reload. Returns how to stop. */
    attach(): () => void;
    start(): Promise<void>;
    stop(): Promise<void>;
}

/** The recording this tab started with a microphone, so a reload of the page can take the microphone up again. */
const MIC_MARKER_KEY = "pikvm-recording-mic";

function readMarker(): string | null {
    try {
        return sessionStorage.getItem(MIC_MARKER_KEY);
    } catch {
        return null;
    }
}

function writeMarker(id: string | null): void {
    try {
        if (id === null) sessionStorage.removeItem(MIC_MARKER_KEY);
        else sessionStorage.setItem(MIC_MARKER_KEY, id);
    } catch {
        // Storage is off: a reload then does not resume the microphone.
    }
}

const errorText = (error: unknown, fallback: string): string => (error instanceof RecordingsError ? error.message : fallback);

/** What to tell the person about a recording the host ended, or null when there is nothing to say. `quiet` is a stop this page asked for. */
export function endNotice(view: RecordingView, quiet: boolean): { text: string; error: boolean } | null {
    const kept = "What was captured is kept.";
    switch (view.reason) {
        case "quota":
            return { text: `The recording was closed: the recordings on the host reached their disk limit. ${kept}`, error: true };
        case "recording_cap":
            return { text: `The recording was closed: it reached the size limit for one recording. ${kept}`, error: true };
        case "backlog_cap":
            return { text: `The recording was closed: the host could not shrink it as fast as it recorded. ${kept}`, error: true };
        case "error":
            return { text: `${view.error ?? "The recording stopped because of an error."} ${kept}`, error: true };
        case "interrupted":
            return { text: "The host restarted, so the recording ended there. What was captured is kept.", error: true };
        case "duration":
            return { text: `The recording reached its time limit. ${kept}`, error: true };
        case "stopped":
            return quiet ? null : { text: "The recording was stopped.", error: false };
        case null:
            return null;
    }
}

export function createRecordControl(options: RecordControlOptions): RecordControl {
    const store = createStore<RecordControlState>({ phase: "idle", error: null, micNote: null, feeding: false });
    const patch = (next: Partial<RecordControlState>): void => store.setState({ ...store.getState(), ...next });
    const notify = (text: string, error = false): void => options.notify?.({ text, error });

    let mic: MicFeed | null = null;
    /** Counts the feeds made, so one that was replaced or stopped cannot clear the state of the one that took its place. */
    let feedSeq = 0;
    /** A feed is being set up (its worklet loading): nothing else may start one. */
    let micBusy = false;
    /** The recording the live stream last showed in progress. */
    let following: string | null = null;
    /** Recordings whose microphone this page already tried to take up again: once each. */
    const resumed = new Set<string>();
    /** Recordings this page asked to stop: the end is announced by the stop itself, not again when the live state says so. */
    const stoppedHere = new Set<string>();
    let detached = true;
    /** What micSupport said, once it has: the click that starts a recording must not wait for it. */
    let supportReason: string | null | undefined;

    const stopMic = (): void => {
        feedSeq += 1;
        mic?.stop();
        mic = null;
        patch({ feeding: false });
    };

    /** Sends the microphone for a recording that runs. Takes the stream and the context: lets go of them when it cannot. */
    const feedMic = async (id: string, stream: MediaStream, context: AudioContext): Promise<void> => {
        stopMic();
        micBusy = true;
        const seq = feedSeq;
        try {
            const feed = await startMicFeed({
                stream,
                context,
                recordingId: id,
                onEnd: (why: MicEnd, detail: string) => {
                    if (seq !== feedSeq) return;
                    mic = null;
                    patch({ feeding: false });
                    if (why === "replaced") notify("Another page is sending the microphone to this recording now.");
                    else if (why === "refused" || why === "failed") notify(`The microphone is no longer recorded: ${detail || "the host refused it."}`, true);
                },
            });
            if (seq !== feedSeq) return feed.stop();
            mic = feed;
            patch({ feeding: true });
        } catch (error) {
            notify(`Recording without your microphone: ${error instanceof Error ? error.message : "it could not be sent to the host"}.`, true);
        } finally {
            micBusy = false;
        }
    };

    /** A page that reloaded in the middle of a recording it started takes its microphone up again, if the browser lets it without asking. */
    const resumeMic = async (id: string): Promise<void> => {
        resumed.add(id);
        if ((await micSupport()) !== null) return;
        let context: AudioContext | null = null;
        try {
            context = newMicContext();
            const stream = await openMicStream(options.micDeviceId());
            // A page that was just loaded has had no click, so its audio is held until the first touch or key.
            if (context.state !== "running") {
                const wake = (): void => void context?.resume().catch(() => undefined);
                window.addEventListener("pointerdown", wake, { once: true });
                window.addEventListener("keydown", wake, { once: true });
            }
            await feedMic(id, stream, context);
        } catch (error) {
            void context?.close().catch(() => undefined);
            notify(`The microphone of this recording stopped when the page reloaded and could not be taken up again: ${micFailureText(error)}.`, true);
        }
    };

    const explainEnd = async (id: string): Promise<void> => {
        stopMic();
        if (readMarker() === id) writeMarker(null);
        // A stop this page asked for says its own words.
        const quiet = stoppedHere.delete(id) || store.getState().phase === "stopping";
        try {
            const notice = endNotice(await getRecording(id), quiet);
            if (notice) notify(notice.text, notice.error);
        } catch {
            // Deleted meanwhile, or the host is away: nothing true to say.
        }
    };

    const onLive = (state: LiveFeedState): void => {
        const live = state.live;
        // No state at all (the stream is down) says nothing about the recording: it is not "ended".
        if (!live) return;
        const recording = live.recording;
        if (recording) {
            following = recording.id;
            if (live.mic === "waiting" && !mic && !micBusy && readMarker() === recording.id && !resumed.has(recording.id) && store.getState().phase === "idle") void resumeMic(recording.id);
            return;
        }
        if (following !== null) {
            const id = following;
            following = null;
            void explainEnd(id);
        }
    };

    const start = async (): Promise<void> => {
        const { phase } = store.getState();
        const running = options.feed.store.getState().live?.recording ?? null;
        if (phase !== "idle" || running) return;
        patch({ phase: "starting", error: null });
        const fail = (message: string): void => {
            patch({ phase: "idle", error: message });
            notify(message, true);
        };

        // Made now, inside the click that started this: a context made after an await may be refused sound.
        if (supportReason === undefined) supportReason = await micSupport();
        const context = supportReason === null ? newMicContext() : null;
        let stream: MediaStream | null = null;
        if (context) {
            try {
                stream = await openMicStream(options.micDeviceId());
                patch({ micNote: null });
            } catch (error) {
                const why = micFailureText(error);
                patch({ micNote: `Your microphone is not recorded: ${why}.` });
                notify(`Recording without your microphone: ${why}. Your side stays out of the recording.`, true);
                void context.close().catch(() => undefined);
            }
        } else patch({ micNote: supportReason ?? null });

        let view: RecordingView;
        try {
            view = await startRecording({ mic: stream !== null });
        } catch (error) {
            for (const track of stream?.getTracks() ?? []) track.stop();
            void context?.close().catch(() => undefined);
            // Another client got there first: the live stream shows it, and this page does not make a second one.
            if (error instanceof RecordingsError && error.status === 409 && error.recording?.status === "recording") {
                patch({ phase: "idle" });
                notify("A recording is already in progress; this page now follows it.");
                return;
            }
            return fail(errorText(error, "The recording could not be started."));
        }
        following = view.id;
        // This page is feeding this recording itself: it has nothing to take up again.
        resumed.add(view.id);
        patch({ phase: "idle" });
        if (stream && context) {
            writeMarker(view.id);
            await feedMic(view.id, stream, context);
        }
    };

    const stop = async (): Promise<void> => {
        const id = options.feed.store.getState().live?.recording?.id ?? following;
        if (store.getState().phase !== "idle" || id === null) return;
        patch({ phase: "stopping", error: null });
        stoppedHere.add(id);
        stopMic();
        writeMarker(null);
        try {
            await stopRecording(id);
            notify("Recording stopped. The host is finishing the file; it appears in Recordings.");
        } catch (error) {
            // Already stopped by someone else is what was wanted.
            if (!(error instanceof RecordingsError && error.status === 409)) {
                patch({ error: errorText(error, "The recording could not be stopped.") });
                notify(errorText(error, "The recording could not be stopped."), true);
            }
        }
        patch({ phase: "idle" });
    };

    void micSupport().then((reason) => {
        supportReason = reason;
        patch({ micNote: reason });
    });

    return {
        store,
        feed: options.feed,
        attach() {
            if (!detached) return () => undefined;
            detached = false;
            const release = options.feed.retain();
            const off = options.feed.store.subscribe(() => onLive(options.feed.store.getState()));
            onLive(options.feed.store.getState());
            return () => {
                detached = true;
                off();
                release();
                stopMic();
            };
        },
        start,
        stop,
    };
}
