/**
 * Recordings: what the host holds, newest first, with a player, the transcript under it and the few things to do to a
 * recording (transcribe, copy the text, delete). A transcript segment seeks the player when it is clicked, and the one
 * being played is marked.
 *
 * The host may not be able to transcribe (no models, no ffmpeg): the dialog says why and still plays and deletes. The
 * list is read when the dialog opens and again every few seconds, but only while something is being transcribed.
 */

import type { RecordingView, Transcript, TranscriptionStatus } from "@pikvm/contracts/recordings";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DialogProps } from "../dialog-seam";
import { copyText } from "../dialogs/kvmd";
import { Btn, DialogShell, Note, useConfirm, type Confirmer } from "../dialogs/shell";
import { deleteRecording, getTranscript, listRecordings, mediaUrl, RecordingsError, transcribeRecording } from "./api";
import { formatClock } from "./use-recorder";
import "./recorder.css";

export const POLL_MS = 3000;

const errorText = (error: unknown): string => (error instanceof RecordingsError ? error.message : "Something went wrong.");

function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function statusLabel(r: RecordingView): string {
    switch (r.status) {
        case "recording":
            return "Recording";
        case "ready":
            return "Recorded";
        case "transcribing":
            return r.progress === null ? "Transcribing" : `Transcribing ${Math.round(r.progress * 100)}%`;
        case "done":
            return r.speakers === null ? "Transcribed" : `Transcribed, ${r.speakers} ${r.speakers === 1 ? "speaker" : "speakers"}`;
        case "failed":
            return "Failed";
    }
}

function expiryText(r: RecordingView): string | null {
    if (r.status === "recording") return null;
    return r.expiresAt ? `Deleted on ${dateOnly.format(new Date(r.expiresAt))}` : "Kept until you delete it";
}

type ListState =
    | { readonly phase: "loading" }
    | { readonly phase: "error"; readonly message: string }
    | { readonly phase: "ready"; readonly recordings: ReadonlyArray<RecordingView>; readonly transcription: TranscriptionStatus; readonly stale: string | null };

/** The list, read on mount and polled while anything is being transcribed. */
function useRecordings() {
    const [state, setState] = useState<ListState>({ phase: "loading" });
    const alive = useRef(true);

    const load = useCallback(async (): Promise<void> => {
        try {
            const list = await listRecordings();
            if (!alive.current) return;
            const recordings = [...list.recordings].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
            setState({ phase: "ready", recordings, transcription: list.transcription, stale: null });
        } catch (error) {
            if (!alive.current) return;
            // A poll that fails keeps what is on screen and says it is old; a first load that fails has nothing to show.
            setState((now) => (now.phase === "ready" ? { ...now, stale: errorText(error) } : { phase: "error", message: errorText(error) }));
        }
    }, []);

    useEffect(() => {
        alive.current = true;
        void load();
        return () => {
            alive.current = false;
        };
    }, [load]);

    const transcribing = state.phase === "ready" && state.recordings.some((r) => r.status === "transcribing");
    useEffect(() => {
        if (!transcribing) return;
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    }, [transcribing, load]);

    const replace = useCallback((view: RecordingView): void => {
        setState((now) => (now.phase === "ready" ? { ...now, recordings: now.recordings.map((r) => (r.id === view.id ? view : r)) } : now));
    }, []);
    const remove = useCallback((id: string): void => {
        setState((now) => (now.phase === "ready" ? { ...now, recordings: now.recordings.filter((r) => r.id !== id) } : now));
    }, []);

    return { state, reload: load, replace, remove };
}

type TranscriptState =
    | { readonly phase: "none" }
    | { readonly phase: "loading" }
    | { readonly phase: "error"; readonly message: string }
    | { readonly phase: "ready"; readonly transcript: Transcript };

/** The transcript of the selected recording, fetched when it is done. */
function useTranscript(recording: RecordingView | null): TranscriptState {
    const [state, setState] = useState<TranscriptState>({ phase: "none" });
    const id = recording?.id ?? null;
    const done = recording?.status === "done";
    useEffect(() => {
        if (!id || !done) {
            setState({ phase: "none" });
            return;
        }
        const abort = new AbortController();
        setState({ phase: "loading" });
        getTranscript(id, abort.signal).then(
            (transcript) => setState({ phase: "ready", transcript }),
            (error: unknown) => {
                if (!abort.signal.aborted) setState({ phase: "error", message: errorText(error) });
            },
        );
        return () => abort.abort();
    }, [id, done]);
    return state;
}

/**
 * A browser's own recorder writes a file with no length, and a player will not seek in what has none. Asking for a time
 * far past the end makes it read to the end and learn the length; the position is put back to the start.
 */
function learnDuration(video: HTMLVideoElement): void {
    if (video.duration !== Infinity) return;
    const restore = (): void => {
        video.removeEventListener("timeupdate", restore);
        video.currentTime = 0;
    };
    video.addEventListener("timeupdate", restore);
    video.currentTime = 1e101;
}

function Detail({ recording, transcription, onChanged, onRemoved, confirm }: {
    readonly recording: RecordingView;
    readonly transcription: TranscriptionStatus;
    readonly onChanged: (view: RecordingView) => void;
    readonly onRemoved: (id: string) => void;
    readonly confirm: Confirmer;
}) {
    const player = useRef<HTMLVideoElement>(null);
    const [now, setNow] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const transcript = useTranscript(recording);
    const playable = recording.status !== "recording" && recording.bytes > 0;

    useEffect(() => {
        setError(null);
        setCopied(false);
        setNow(0);
    }, [recording.id]);

    const seek = (seconds: number): void => {
        const video = player.current;
        if (!video) return;
        video.currentTime = seconds;
        void video.play().catch(() => {});
    };

    const transcribe = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            onChanged(await transcribeRecording(recording.id));
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    const remove = async (): Promise<void> => {
        const sure = await confirm.ask({
            title: "Delete this recording?",
            body: "The video, its sound and any transcript are removed from the host. This cannot be undone.",
            confirm: "Delete",
            danger: true,
        });
        if (!sure) return;
        setBusy(true);
        setError(null);
        try {
            await deleteRecording(recording.id);
            onRemoved(recording.id);
        } catch (e) {
            setError(errorText(e));
            setBusy(false);
        }
    };

    const copy = async (text: string): Promise<void> => {
        setCopied(await copyText(text));
    };

    const expiry = expiryText(recording);
    const canTranscribe = transcription.available && (recording.status === "ready" || recording.status === "failed");

    return (
        <div className="rec-detail" data-testid="recording-detail">
            {playable ? (
                <video
                    ref={player}
                    className="rec-player"
                    data-testid="recording-player"
                    key={recording.id}
                    src={mediaUrl(recording.id)}
                    controls
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={(e) => learnDuration(e.currentTarget)}
                    onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
                />
            ) : (
                <Note>{recording.status === "recording" ? "This recording is still being made." : "Nothing was kept of this recording."}</Note>
            )}
            {expiry ? <p className="rec-expiry">{expiry}</p> : null}
            {recording.status === "failed" && recording.error ? (
                <p className="dlg-note is-warn" role="alert">
                    {recording.error}
                </p>
            ) : null}
            {recording.status === "transcribing" ? (
                <Note live>{recording.progress === null ? "Transcribing..." : `Transcribing: ${Math.round(recording.progress * 100)}% done.`}</Note>
            ) : null}

            {transcript.phase === "loading" ? <Note live>Loading the transcript...</Note> : null}
            {transcript.phase === "error" ? (
                <p className="dlg-note is-warn" role="alert">
                    {transcript.message}
                </p>
            ) : null}
            {transcript.phase === "ready" ? (
                <>
                    <div className="rec-transcript" role="list" aria-label="Transcript" data-testid="transcript">
                        {transcript.transcript.segments.length === 0 ? <Note>No speech was found in this recording.</Note> : null}
                        {transcript.transcript.segments.map((seg, i) => (
                            <button
                                key={`${seg.start}-${i}`}
                                type="button"
                                role="listitem"
                                className="rec-seg"
                                data-testid="transcript-segment"
                                aria-current={now >= seg.start && now < seg.end ? "true" : undefined}
                                onClick={() => seek(seg.start)}
                            >
                                <span className="rec-seg-time">{formatClock(seg.start * 1000)}</span>
                                <span className="rec-seg-who" data-channel={seg.channel}>
                                    {seg.speaker}
                                </span>
                                <span>{seg.text}</span>
                            </button>
                        ))}
                    </div>
                    <Note>
                        {transcript.transcript.speakers.length} {transcript.transcript.speakers.length === 1 ? "speaker" : "speakers"}, with {transcript.transcript.models.recognizer} and{" "}
                        {transcript.transcript.models.diarizer}. Took {Math.round(transcript.transcript.tookSeconds)} s.
                    </Note>
                </>
            ) : null}

            {error ? (
                <p className="dlg-note is-warn" role="alert">
                    {error}
                </p>
            ) : null}
            <div className="dlg-inline-actions">
                {canTranscribe ? (
                    <Btn variant="primary" disabled={busy} onClick={() => void transcribe()}>
                        {recording.status === "failed" ? "Retry transcription" : "Transcribe"}
                    </Btn>
                ) : null}
                {transcript.phase === "ready" ? (
                    <Btn onClick={() => void copy(transcript.transcript.text)}>{copied ? "Copied" : "Copy text"}</Btn>
                ) : null}
                <Btn variant="danger" disabled={busy || recording.status === "recording"} onClick={() => void remove()}>
                    Delete
                </Btn>
            </div>
        </div>
    );
}

export function RecordingsDialog({ onClose }: DialogProps) {
    const { state, reload, replace, remove } = useRecordings();
    const [selected, setSelected] = useState<string | null>(null);
    const confirm = useConfirm();
    const chosen = useRef(false);

    // The newest recording is open at once; after that the person's own choice stands.
    useEffect(() => {
        if (state.phase !== "ready") return;
        if (!chosen.current && state.recordings[0]) {
            chosen.current = true;
            setSelected(state.recordings[0].id);
        }
    }, [state]);

    const recordings = state.phase === "ready" ? state.recordings : [];
    const current = recordings.find((r) => r.id === selected) ?? null;

    return (
        <DialogShell
            title="Recordings"
            size="wide"
            onClose={onClose}
            testId="recordings-dialog"
            actions={
                <>
                    <Btn onClick={() => void reload()}>Refresh</Btn>
                    <Btn variant="primary" onClick={onClose}>
                        Done
                    </Btn>
                </>
            }
        >
            {state.phase === "loading" ? <Note live>Loading recordings...</Note> : null}
            {state.phase === "error" ? (
                <p className="dlg-note is-warn" role="alert">
                    {state.message}
                </p>
            ) : null}
            {state.phase === "ready" ? (
                <>
                    {!state.transcription.available ? (
                        <Note>
                            Transcription is not available on this host{state.transcription.reason ? `: ${state.transcription.reason}` : "."} Recordings can still be played and deleted.
                        </Note>
                    ) : null}
                    {state.stale ? (
                        <p className="dlg-note is-warn" role="alert">
                            Could not refresh the list: {state.stale}
                        </p>
                    ) : null}
                    {recordings.length === 0 ? (
                        <Note>No recordings yet. Press the record button on the KVM screen to make one; it saves on the host as you go.</Note>
                    ) : (
                        <ul className="rec-list" data-testid="recording-list">
                            {recordings.map((r) => (
                                <li key={r.id}>
                                    <button
                                        type="button"
                                        className="rec-row"
                                        data-testid="recording-row"
                                        data-status={r.status}
                                        aria-current={r.id === selected ? "true" : undefined}
                                        onClick={() => setSelected(r.id)}
                                    >
                                        <span className="rec-when">{dateTime.format(new Date(r.startedAt))}</span>
                                        <span className="rec-status" data-status={r.status}>
                                            {statusLabel(r)}
                                        </span>
                                        <span className="rec-meta">
                                            {[r.target, r.durationMs === null ? null : formatClock(r.durationMs), formatBytes(r.bytes)].filter(Boolean).join(" · ")}
                                        </span>
                                        {r.status === "transcribing" && r.progress !== null ? (
                                            <span className="rec-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r.progress * 100)}>
                                                <span style={{ width: `${Math.round(r.progress * 100)}%` }} />
                                            </span>
                                        ) : null}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {current ? (
                        <Detail
                            recording={current}
                            transcription={state.transcription}
                            onChanged={replace}
                            onRemoved={(id) => {
                                remove(id);
                                setSelected(null);
                            }}
                            confirm={confirm}
                        />
                    ) : null}
                </>
            ) : null}
            {confirm.element}
        </DialogShell>
    );
}
