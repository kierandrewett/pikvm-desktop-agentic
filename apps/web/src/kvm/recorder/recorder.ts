/**
 * Records the KVM session in the browser and streams it to the host (uploader.ts).
 *
 * One small file: the target's picture from the `<video>` the picture machine plays, and ONE stereo audio track made with
 * WebAudio, LEFT = what the target played (the tracks of the same MediaStream), RIGHT = this person's microphone. The
 * split is the first step of "who said what" in the transcript: the right channel is always one voice. Video is about
 * 300 kbit/s and audio 48 kbit/s (32 lost words of the microphone under loud target speech), so an hour is roughly 155 MB.
 *
 * The audio graph never reaches `ctx.destination`, or the target would be heard twice (the `<video>` already plays it).
 * Only a WebRTC picture has a MediaStream; with MJPEG there is nothing to record, and the button says so (`recordSupport`).
 */

import { createStore, type Notify, type ReadableStore } from "@pikvm/kvm-engine";
import type { RecordingMime, RecordingView } from "@pikvm/contracts/recordings";
import { RecordingsError } from "./api";
import { createUploader, type Uploader, type UploaderOptions } from "./uploader";

export type RecorderPhase = "idle" | "starting" | "recording" | "stopping" | "failed";

export interface RecorderState {
    readonly phase: RecorderPhase;
    readonly elapsedMs: number;
    /** Bytes the host has acknowledged. */
    readonly bytesSent: number;
    /** Bytes waiting in memory (more than a slice or two means the host is slow or away). */
    readonly bytesQueued: number;
    readonly retrying: boolean;
    readonly error: string | null;
    /** The recording being made, or the one that just ended. */
    readonly recordingId: string | null;
    /** The microphone could not be used: the right channel is silent. */
    readonly micMissing: boolean;
}

export interface RecorderOptions {
    readonly video: HTMLVideoElement;
    /** The pinned microphone ("" follows the system default); read when a recording starts. */
    readonly micDeviceId: () => string;
    /** What the person was looking at, for the list. */
    readonly target?: () => string | null;
    readonly notify?: Notify;
    /** How often the browser hands over a piece. */
    readonly sliceMs?: number;
    /** Tuning of the upload (the pauses between tries, the memory cap). */
    readonly upload?: Partial<Pick<UploaderOptions, "backoffMs" | "maxQueueBytes" | "finishPatienceMs">>;
}

export interface Recorder {
    readonly store: ReadableStore<RecorderState>;
    start(): Promise<void>;
    /** Stop, upload the end, close the recording. Resolves once the host has it (or it failed). */
    stop(): Promise<void>;
    dispose(): void;
}

export const VIDEO_BITS_PER_SECOND = 300_000;
export const AUDIO_BITS_PER_SECOND = 48_000;
export const SLICE_MS = 10_000;
/** In the order of preference: smallest first, then what Safari can do. */
export const MIME_CANDIDATES: ReadonlyArray<string> = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/mp4"];

const initial: RecorderState = {
    phase: "idle",
    elapsedMs: 0,
    bytesSent: 0,
    bytesQueued: 0,
    retrying: false,
    error: null,
    recordingId: null,
    micMissing: false,
};

export interface PickedMime {
    /** What MediaRecorder is asked for, codecs included. */
    readonly recorderMime: string;
    /** What the host calls the container. */
    readonly mime: RecordingMime;
}

/** A browser's answer does not change while the page lives, and the button asks on every render. */
let cachedMime: PickedMime | null | undefined;

/** The first container this browser records, and how the host names it; null when it records none. */
export function pickMime(): PickedMime | null {
    if (cachedMime !== undefined) return cachedMime;
    cachedMime = null;
    if (typeof MediaRecorder === "undefined") return cachedMime;
    for (const candidate of MIME_CANDIDATES) {
        if (MediaRecorder.isTypeSupported(candidate)) {
            cachedMime = { recorderMime: candidate, mime: candidate.startsWith("video/webm") ? "video/webm" : "video/mp4" };
            break;
        }
    }
    return cachedMime;
}

/** Why recording is not possible here, in a sentence, or null when it is. `webrtc` is whether a WebRTC picture is playing. */
export function recordSupport(webrtc: boolean): string | null {
    if (!webrtc) return "Recording needs the WebRTC picture. This one is MJPEG, or WebRTC has not started yet.";
    if (typeof MediaRecorder === "undefined" || typeof AudioContext === "undefined") return "This browser cannot record.";
    if (pickMime() === null) return "This browser has no video format it can record.";
    return null;
}

function micFailureText(error: unknown): string {
    const name = error instanceof Error ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") return "the browser did not allow the microphone";
    if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "no microphone was found";
    return "the microphone could not be opened";
}

function liveStream(video: HTMLVideoElement): MediaStream | null {
    if (video.srcObject instanceof MediaStream) return video.srcObject;
    const capturable = video as HTMLVideoElement & { captureStream?: () => MediaStream };
    return typeof capturable.captureStream === "function" ? capturable.captureStream() : null;
}

const live = (tracks: MediaStreamTrack[]): MediaStreamTrack[] => tracks.filter((track) => track.readyState === "live");

export function createRecorder(options: RecorderOptions): Recorder {
    const { video } = options;
    const sliceMs = options.sliceMs ?? SLICE_MS;
    const store = createStore<RecorderState>(initial);
    const patch = (next: Partial<RecorderState>): void => store.setState({ ...store.getState(), ...next });

    /** Everything one recording owns, so one function ends it. */
    interface Session {
        readonly ctx: AudioContext;
        readonly uploader: Uploader;
        readonly recorder: MediaRecorder;
        readonly mic: MediaStream | null;
        readonly source: MediaStream;
        readonly cleanup: Array<() => void>;
        /** Stops mirroring the upload's progress into the store. */
        readonly offUpload: () => void;
        t0: number;
        finished: boolean;
    }
    let session: Session | null = null;
    let ticker: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const stopTicker = (): void => {
        clearInterval(ticker ?? undefined);
        ticker = null;
    };

    const teardown = (s: Session): void => {
        stopTicker();
        for (const undo of s.cleanup.splice(0)) {
            try {
                undo();
            } catch {
                // already gone
            }
        }
        for (const track of s.mic?.getTracks() ?? []) track.stop();
        void s.ctx.close().catch(() => {});
    };

    const elapsed = (s: Session): number => Math.max(0, performance.now() - s.t0);

    /** A recording that cannot go on: the upload gave up, or the browser's recorder broke before anything was kept. */
    const failHard = (s: Session, message: string): void => {
        if (session !== s || s.finished) return;
        s.finished = true;
        session = null;
        if (s.recorder.state !== "inactive") {
            s.recorder.ondataavailable = null;
            s.recorder.onstop = null;
            try {
                s.recorder.stop();
            } catch {
                // already stopped
            }
        }
        teardown(s);
        s.offUpload();
        patch({ phase: "failed", error: message, retrying: false });
        options.notify?.({ text: message, error: true });
        void s.uploader.abandon();
    };

    /** The recorder has stopped and its last piece is queued: send the rest and close the recording. */
    const finalize = async (s: Session, note: string | null): Promise<void> => {
        const durationMs = elapsed(s);
        patch({ phase: "stopping", elapsedMs: durationMs });
        teardown(s);
        try {
            const view: RecordingView = await s.uploader.finish(durationMs);
            if (session === s) session = null;
            s.finished = true;
            s.offUpload();
            patch({ phase: "idle", recordingId: view.id, error: null, retrying: false });
            const transcribing = view.status === "transcribing";
            options.notify?.({ text: `${note ? `${note} ` : ""}Recording saved${transcribing ? ". It is being transcribed" : ""}.` });
        } catch (error) {
            // The upload gave up on its own and already said so (failHard).
            if (s.finished) return;
            if (session === s) session = null;
            s.finished = true;
            s.offUpload();
            const message =
                error instanceof RecordingsError
                    ? `The recording could not be saved: ${error.message}`
                    : "The recording could not be saved.";
            patch({ phase: "failed", error: message, retrying: false });
            options.notify?.({ text: message, error: true });
            void s.uploader.abandon();
        }
    };

    const onPageHide = (): void => {
        const s = session;
        if (!s || s.finished || store.getState().phase !== "recording") return;
        s.finished = true;
        session = null;
        const durationMs = elapsed(s);
        s.uploader.pageHide(durationMs);
        // The browser's recorder hands over its last piece as an event a moment after this; the uploader takes it.
        s.recorder.onstop = () => {
            teardown(s);
            s.offUpload();
        };
        try {
            s.recorder.stop();
        } catch {
            teardown(s);
        }
        patch({ phase: "idle", elapsedMs: durationMs });
    };
    window.addEventListener("pagehide", onPageHide);

    const start = async (): Promise<void> => {
        const { phase } = store.getState();
        if (disposed || (phase !== "idle" && phase !== "failed")) return;
        patch({ ...initial, phase: "starting" });

        const fail = (message: string): void => {
            patch({ phase: "failed", error: message });
            options.notify?.({ text: message, error: true });
        };

        const picked = pickMime();
        if (!picked || typeof AudioContext === "undefined") return fail("This browser cannot record the session.");
        const source = liveStream(video);
        const videoTrack = source ? live(source.getVideoTracks())[0] : undefined;
        if (!source || !videoTrack) return fail("There is no picture to record yet.");

        // Made now, inside the click that started this: a context made after an await may be refused sound.
        const ctx = new AudioContext({ latencyHint: "playback" });
        void ctx.resume().catch(() => {});
        const cleanup: Array<() => void> = [];
        let mic: MediaStream | null = null;
        let micMissing = false;
        let offUpload: () => void = () => {};
        /** Undo everything built so far, for a start that does not get as far as recording. */
        const release = (): void => {
            for (const undo of cleanup.splice(0)) undo();
            offUpload();
            for (const track of mic?.getTracks() ?? []) track.stop();
            void ctx.close().catch(() => {});
        };

        const pinned = options.micDeviceId();
        try {
            if (!navigator.mediaDevices?.getUserMedia) throw new Error("no getUserMedia");
            mic = await navigator.mediaDevices.getUserMedia({
                audio: { ...(pinned ? { deviceId: { exact: pinned } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true },
            });
        } catch (error) {
            micMissing = true;
            options.notify?.({ text: `Recording without your microphone: ${micFailureText(error)}. Your side stays silent in the recording.`, error: true });
        }
        if (disposed) return release();

        // Input 0 = the target, input 1 = the microphone, each folded to one channel first. Nothing here reaches
        // ctx.destination: the <video> already plays the target, and a second path would double it.
        const merger = ctx.createChannelMerger(2);
        const destination = ctx.createMediaStreamDestination();
        destination.channelCount = 2;
        destination.channelCountMode = "explicit";
        destination.channelInterpretation = "discrete";
        merger.connect(destination);
        cleanup.push(() => merger.disconnect());
        const mono = (): GainNode => {
            const gain = ctx.createGain();
            gain.channelCount = 1;
            gain.channelCountMode = "explicit";
            gain.channelInterpretation = "speakers";
            return gain;
        };
        const targetBus = mono();
        targetBus.connect(merger, 0, 0);
        cleanup.push(() => targetBus.disconnect());
        if (mic) {
            const micBus = mono();
            micBus.connect(merger, 0, 1);
            const micSource = ctx.createMediaStreamSource(mic);
            micSource.connect(micBus);
            cleanup.push(
                () => micSource.disconnect(),
                () => micBus.disconnect(),
            );
        }

        // The target's audio tracks come and go with the picture's session; follow them.
        const wired = new Map<string, MediaStreamAudioSourceNode>();
        const syncTargetAudio = (): void => {
            const now = live(source.getAudioTracks());
            for (const [trackId, node] of wired) {
                if (!now.some((track) => track.id === trackId)) {
                    node.disconnect();
                    wired.delete(trackId);
                }
            }
            for (const track of now) {
                if (wired.has(track.id)) continue;
                const node = ctx.createMediaStreamSource(new MediaStream([track]));
                node.connect(targetBus);
                wired.set(track.id, node);
            }
        };
        syncTargetAudio();
        source.addEventListener("addtrack", syncTargetAudio);
        source.addEventListener("removetrack", syncTargetAudio);
        cleanup.push(() => {
            source.removeEventListener("addtrack", syncTargetAudio);
            source.removeEventListener("removetrack", syncTargetAudio);
            for (const node of wired.values()) node.disconnect();
            wired.clear();
        });

        const outAudio = destination.stream.getAudioTracks()[0];
        if (!outAudio) {
            release();
            return fail("The browser could not make the audio track.");
        }

        const uploader = createUploader({
            mime: picked.mime,
            startedAt: new Date(),
            target: options.target?.() ?? null,
            onFail: (message) => {
                if (session) failHard(session, message);
            },
            ...options.upload,
        });
        offUpload = uploader.store.subscribe(() => {
            const up = uploader.store.getState();
            patch({ bytesSent: up.bytesAcked, bytesQueued: up.queuedBytes, retrying: up.retrying });
        });

        let created: RecordingView;
        try {
            created = await uploader.open();
        } catch (error) {
            release();
            return fail(error instanceof RecordingsError ? error.message : "The recording could not be started.");
        }

        let recorder: MediaRecorder;
        try {
            recorder = new MediaRecorder(new MediaStream([videoTrack, outAudio]), {
                mimeType: picked.recorderMime,
                videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
                audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
            });
        } catch {
            release();
            void uploader.abandon();
            return fail("The browser could not start its recorder.");
        }

        const s: Session = { ctx, uploader, recorder, mic, source, cleanup, offUpload, t0: performance.now(), finished: false };
        session = s;
        let stopNote: string | null = null;

        recorder.ondataavailable = (event: BlobEvent) => {
            if (event.data.size > 0) uploader.push(event.data, elapsed(s));
        };
        recorder.onerror = () => {
            // The browser's recorder broke: keep what was cut so far, as a normal stop would.
            stopNote = "The browser's recorder stopped.";
            try {
                if (recorder.state !== "inactive") recorder.stop();
            } catch {
                void finalize(s, stopNote);
            }
        };
        recorder.onstop = () => void finalize(s, stopNote);

        // The picture dropped (the session restarted): its track ends and the recorder would carry on with no video.
        const onVideoEnded = (): void => {
            if (recorder.state === "inactive") return;
            stopNote = "The picture dropped, so the recording ended there.";
            recorder.stop();
        };
        videoTrack.addEventListener("ended", onVideoEnded);
        cleanup.push(() => videoTrack.removeEventListener("ended", onVideoEnded));

        recorder.start(sliceMs);
        s.t0 = performance.now();
        const ended = (): boolean => videoTrack.readyState === "ended" || !source.getVideoTracks().includes(videoTrack);
        // The picture machine adds and removes tracks from a script, and that fires no event: look every half second.
        ticker = setInterval(() => {
            patch({ elapsedMs: elapsed(s) });
            syncTargetAudio();
            if (ended()) onVideoEnded();
        }, 500);
        patch({ phase: "recording", recordingId: created.id, micMissing, elapsedMs: 0 });
    };

    const stop = async (): Promise<void> => {
        const s = session;
        if (!s || store.getState().phase !== "recording" || s.recorder.state === "inactive") return;
        patch({ phase: "stopping" });
        const done = new Promise<void>((resolve) => {
            const unsubscribe = store.subscribe(() => {
                const { phase } = store.getState();
                if (phase === "idle" || phase === "failed") {
                    unsubscribe();
                    resolve();
                }
            });
        });
        s.recorder.stop();
        await done;
    };

    return {
        store,
        start,
        stop,
        dispose() {
            if (disposed) return;
            disposed = true;
            window.removeEventListener("pagehide", onPageHide);
            const s = session;
            if (s && s.recorder.state !== "inactive") s.recorder.stop();
            else if (s) teardown(s);
            else stopTicker();
        },
    };
}
