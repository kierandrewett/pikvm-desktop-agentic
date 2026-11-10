/**
 * One recording: the player, and beside it (below it on a narrow page) the transcript.
 *
 * The transcript is a list of lines, each with its second and who said it, coloured by speaker. A line seeks the player when it is
 * pressed, and the line being played is marked and kept in view until the person scrolls it themselves (Follow playback puts it
 * back). The box above it finds words in this transcript: the matches are marked, and Enter, Shift+Enter and the arrows move from
 * one to the next, seeking the player there. `?t=<seconds>` opens the recording at that second (paused, with its line marked) and
 * `?q=` puts the query in the box, so a link from a search result, or a reload, comes back to the same place.
 */

import type { RecordingView, Transcript, TranscriptionStatus } from "@pikvm/contracts/recordings";
import { ArrowClockwise, CaretDown, CaretLeft, CaretUp, Copy, DownloadSimple, PencilSimple, Trash, Warning } from "@pikvm/icons";
import { Link } from "@tanstack/react-router";
import { memo, type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "../kvm/dialogs/shell";
import { getTranscript, mediaUrl } from "../kvm/recorder/api";
import { findIn } from "./find";
import { displayTitle, formatBytes, formatDuration, formatStarted } from "./format";
import { RenameField } from "./library-view";
import { MenuButton, type MenuItem } from "./menu";
import { Expiry, Highlighted, Provenance, StatusPill } from "./parts";
import { SearchBox, type SearchBoxHandle } from "./search-box";
import { downloadTranscript, copyTranscript } from "./transcript-actions";
import { TRANSCRIPT_FORMATS } from "./transcript-export";
import { errorText, type Library } from "./use-library";

type TranscriptState =
    | { readonly phase: "none" }
    | { readonly phase: "loading" }
    | { readonly phase: "error"; readonly message: string }
    | { readonly phase: "ready"; readonly transcript: Transcript };

/** The transcript, fetched once the recording is done (and again if it is made again). */
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
 * A recording an older version took from a browser's own recorder is a file with no length, and a player will not seek in what has none (a recording the host made has its length). Asking for a time far past
 * the end makes it read to the end and learn the length; the position is then put where it was wanted. Resolves once it is there.
 */
function prepare(video: HTMLVideoElement, startAt: number): Promise<void> {
    return new Promise((resolve) => {
        if (video.duration !== Infinity) {
            if (startAt > 0) video.currentTime = startAt;
            return resolve();
        }
        const settle = (): void => {
            video.removeEventListener("timeupdate", settle);
            video.currentTime = startAt;
            resolve();
        };
        video.addEventListener("timeupdate", settle);
        video.currentTime = 1e101;
    });
}

/** The same empty list for every line with no match, so a line that did not change is not drawn again. */
const NO_RANGES: ReadonlyArray<readonly [number, number]> = [];

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface LineProps {
    readonly index: number;
    readonly start: number;
    readonly speaker: string;
    readonly channel: "mic" | "target";
    readonly text: string;
    readonly tone: number;
    readonly current: boolean;
    readonly linked: boolean;
    readonly ranges: ReadonlyArray<readonly [number, number]>;
    readonly active: boolean;
    readonly onSeek: (start: number) => void;
}

const Line = memo(function Line({ index, start, speaker, channel, text, tone, current, linked, ranges, active, onSeek }: LineProps) {
    return (
        <li>
            <button
                type="button"
                className="rw-line"
                data-testid="transcript-line"
                data-index={index}
                data-start={start}
                data-current={current || undefined}
                data-linked={linked || undefined}
                data-match={ranges.length > 0 || undefined}
                data-active-match={active || undefined}
                aria-current={current ? "true" : active ? "location" : undefined}
                style={{ "--spk": channel === "mic" ? "var(--rl-spk-you)" : `var(--rl-spk-${tone % 5})` } as CSSProperties}
                onClick={() => onSeek(start)}
            >
                <span className="rw-line-time">{formatDuration(start * 1000)}</span>
                <span className="rw-line-who">{speaker}</span>
                <span className="rw-line-text">
                    <Highlighted text={text} ranges={ranges} />
                </span>
            </button>
        </li>
    );
});

interface WatchViewProps {
    readonly id: string;
    readonly library: Library;
    /** Words to find in this transcript (the address's `q`). */
    readonly q: string;
    /** The second to open at (the address's `t`). */
    readonly t: number | null;
    /** The page is in front: out of it, the player is paused. */
    readonly active: boolean;
    readonly onQuery: (q: string) => void;
    readonly onLeave: () => void;
    readonly onNotice: (notice: { readonly tone: "ok" | "bad"; readonly text: string } | null) => void;
}

export function WatchView({ id, library, q, t, active, onQuery, onLeave, onNotice }: WatchViewProps) {
    const state = library.state;
    const recording = state.phase === "ready" ? (state.recordings.find((r) => r.id === id) ?? null) : null;
    const transcription: TranscriptionStatus | null = state.phase === "ready" ? state.transcription : null;
    const transcript = useTranscript(recording);
    const confirm = useConfirm();

    const player = useRef<HTMLVideoElement>(null);
    const lines = useRef<HTMLOListElement>(null);
    const finder = useRef<SearchBoxHandle>(null);
    const [now, setNow] = useState(0);
    const [ready, setReady] = useState(false);
    const [playerError, setPlayerError] = useState(false);
    const [follow, setFollow] = useState(true);
    const [playing, setPlaying] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [activeMatch, setActiveMatch] = useState(0);
    // What is in the find box right now. The address only follows after a pause, but the matches must not lag behind the keys.
    const [typed, setTyped] = useState(q);
    const [copied, setCopied] = useState(false);
    const appliedT = useRef<number | null>(null);

    // Another recording: everything about the last one is forgotten.
    useEffect(() => {
        setReady(false);
        setPlayerError(false);
        setNow(0);
        setFollow(true);
        setPlaying(false);
        setRenaming(false);
        setCopied(false);
        appliedT.current = null;
    }, [id]);

    useEffect(() => {
        if (!active) player.current?.pause();
    }, [active]);

    const segments = transcript.phase === "ready" ? transcript.transcript.segments : null;
    const found = useMemo(() => (segments ? findIn(segments, typed) : null), [segments, typed]);
    const speakerTone = useMemo(() => {
        const tones = new Map<string, number>();
        for (const speaker of transcript.phase === "ready" ? transcript.transcript.speakers : []) tones.set(speaker, tones.size);
        return tones;
    }, [transcript]);

    // The match to show first: the one at the second the link names, else the first.
    useEffect(() => {
        if (!found || !segments) return;
        const at = t === null ? -1 : found.lines.findIndex((i) => Math.floor(segments[i]?.start ?? -1) === t);
        setActiveMatch(at >= 0 ? at : 0);
        // Only when the matches themselves change: pressing a line must not move the active match.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [found]);

    const seek = useCallback((seconds: number, play: boolean): void => {
        const video = player.current;
        if (!video) return;
        video.currentTime = seconds;
        if (play) void video.play().catch(() => undefined);
    }, []);

    const onLineSeek = useCallback(
        (start: number) => {
            setFollow(true);
            seek(start, true);
        },
        [seek],
    );

    // The address names a second: at once when the player is ready, and again if the link changes while it is open.
    useEffect(() => {
        if (!ready || t === null || appliedT.current === t) return;
        appliedT.current = t;
        seek(t, false);
    }, [ready, t, seek]);

    const current = useMemo(() => {
        const set = new Set<number>();
        segments?.forEach((s, i) => {
            if (now >= s.start && now < s.end) set.add(i);
        });
        return set;
    }, [segments, now]);

    const linkedLine = useMemo(() => {
        if (t === null || !segments) return -1;
        return segments.findIndex((s) => Math.floor(s.start) === t);
    }, [segments, t]);

    // Brings a line to the middle of the transcript's own box. Not scrollIntoView: that would scroll the page as well, and on a phone
    // take the title and the player out of sight.
    const reveal = (index: number): void => {
        const box = lines.current;
        const line = box?.querySelector<HTMLElement>(`[data-index="${index}"]`);
        if (!box || !line) return;
        const at = line.getBoundingClientRect();
        const top = box.scrollTop + (at.top - box.getBoundingClientRect().top) - (box.clientHeight - at.height) / 2;
        box.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? "auto" : "smooth" });
    };

    // Following playback: while it plays, the first line being said stays in view (and comes into view when play starts).
    const firstCurrent = current.size > 0 ? Math.min(...current) : -1;
    useEffect(() => {
        if (follow && playing && firstCurrent >= 0) reveal(firstCurrent);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [firstCurrent, follow, playing]);

    // The line a link names is brought into view once the transcript is there.
    useEffect(() => {
        if (linkedLine >= 0) reveal(linkedLine);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [linkedLine, transcript.phase]);

    const step = (direction: 1 | -1): void => {
        if (!found || !segments || found.lines.length === 0) return;
        const next = (activeMatch + direction + found.lines.length) % found.lines.length;
        const index = found.lines[next];
        if (index === undefined) return;
        setActiveMatch(next);
        setFollow(false);
        reveal(index);
        const segment = segments[index];
        if (segment) seek(segment.start, false);
    };

    const activeLine = found?.lines[activeMatch] ?? -1;
    // The match in force is shown as soon as it is known, and whenever the matches change.
    useEffect(() => {
        if (activeLine >= 0 && typed !== "") reveal(activeLine);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [found, activeLine]);

    const name = recording ? displayTitle(recording) : "Recording";

    const transcribe = async (again: boolean): Promise<void> => {
        if (!recording) return;
        if (again) {
            const sure = await confirm.ask({
                title: "Transcribe again?",
                body: "The transcript is replaced by a new one. Search finds the new words once it is done.",
                confirm: "Transcribe again",
            });
            if (!sure) return;
        }
        setBusy(true);
        try {
            await library.transcribe(recording.id);
        } catch (error) {
            onNotice({ tone: "bad", text: `Could not start the transcription: ${errorText(error)}` });
        } finally {
            setBusy(false);
        }
    };

    const remove = async (): Promise<void> => {
        if (!recording) return;
        const sure = await confirm.ask({
            title: "Delete this recording?",
            body: `${recording.status === "recording" ? "The recording in progress is stopped first. " : ""}"${name}", its sound and its transcript are removed from the host. This cannot be undone.`,
            confirm: "Delete",
            danger: true,
        });
        if (!sure) return;
        setBusy(true);
        const refused = await library.remove([recording.id]);
        setBusy(false);
        if (refused.length > 0) return onNotice({ tone: "bad", text: `Could not delete: ${refused[0]?.message ?? ""}` });
        onNotice({ tone: "ok", text: "Recording deleted." });
        onLeave();
    };

    if (state.phase === "loading") return <div className="rl-skeleton" role="status" aria-label="Loading the recording" />;
    if (state.phase === "error" || recording === null) {
        return (
            <div className="rl-empty" role="alert" data-testid="watch-missing">
                <h2>{state.phase === "error" ? "The recording could not be loaded" : "There is no such recording"}</h2>
                <p>{state.phase === "error" ? state.message : "It may have been deleted, or it passed the time the host keeps recordings for."}</p>
                <button type="button" className="rl-btn" onClick={onLeave}>
                    <CaretLeft aria-hidden="true" /> Back to recordings
                </button>
            </div>
        );
    }

    const playable = recording.status !== "recording" && recording.status !== "finishing" && recording.bytes > 0;
    const doneTranscript = transcript.phase === "ready" ? transcript.transcript : null;
    const canTranscribe = transcription?.available === true && (recording.status === "ready" || recording.status === "failed" || recording.status === "done");
    const downloads: MenuItem[] = [
        ...TRANSCRIPT_FORMATS.map((f) => ({
            id: `download-${f.id}`,
            label: f.label,
            disabled: doneTranscript === null,
            why: "There is no transcript yet.",
            run: () => doneTranscript && downloadTranscript(doneTranscript, recording, f.id),
        })),
        { type: "separator" },
        {
            id: "download-video",
            label: `Video file (${formatBytes(recording.bytes)})`,
            disabled: !playable,
            run: () => document.getElementById("rw-video-download")?.click(),
        },
    ];

    return (
        <div className="rw" data-testid="watch-view" data-id={recording.id}>
            <header className="rw-head">
                <Link to="/recordings" search={q === "" ? {} : { q }} className="rl-btn rw-back" data-testid="back-to-list">
                    <CaretLeft aria-hidden="true" /> Recordings
                </Link>
                <div className="rw-titleblock">
                    {renaming ? (
                        <RenameField
                            className="rl-rename-field rw-rename"
                            initial={recording.title ?? name}
                            placeholder={name}
                            onDone={() => setRenaming(false)}
                            onSave={async (title) => {
                                try {
                                    await library.rename(recording.id, title);
                                } catch (error) {
                                    onNotice({ tone: "bad", text: `Could not rename: ${errorText(error)}` });
                                }
                            }}
                        />
                    ) : (
                        <h1 className="rw-title" data-testid="watch-title">
                            {name}
                            <button type="button" className="rl-icon-btn rl-rename" aria-label={`Rename ${name}`} title="Rename" data-testid="rename-button" onClick={() => setRenaming(true)}>
                                <PencilSimple aria-hidden="true" />
                            </button>
                        </h1>
                    )}
                    <p className="rw-meta">
                        <time dateTime={recording.startedAt}>{formatStarted(recording.startedAt)}</time>
                        <span>{formatDuration(recording.durationMs)}</span>
                        <span>{formatBytes(recording.bytes)}</span>
                        {recording.target ? <span>{recording.target}</span> : null}
                        <StatusPill recording={recording} />
                        <Expiry recording={recording} />
                    </p>
                    <p className="rw-meta">
                        <Provenance recording={recording} />
                    </p>
                </div>
                <div className="rw-actions">
                    <button
                        type="button"
                        className="rl-btn"
                        disabled={doneTranscript === null}
                        data-testid="copy-transcript"
                        onClick={() =>
                            void copyTranscript(recording.id, doneTranscript ?? undefined).then((ok) => {
                                setCopied(ok);
                                if (!ok) onNotice({ tone: "bad", text: "The transcript could not be copied." });
                                else setTimeout(() => setCopied(false), 2000);
                            })
                        }
                    >
                        <Copy aria-hidden="true" /> {copied ? "Copied" : "Copy"}
                    </button>
                    <MenuButton label="Download" items={downloads} align="end" className="rl-btn" testId="download-menu">
                        <DownloadSimple aria-hidden="true" /> Download <CaretDown aria-hidden="true" />
                    </MenuButton>
                    {playable ? <a id="rw-video-download" href={mediaUrl(recording.id)} download={`${name}.${recording.mime === "video/mp4" ? "mp4" : "webm"}`} className="rl-hidden-link" tabIndex={-1} aria-hidden="true" /> : null}
                    {canTranscribe ? (
                        <button type="button" className="rl-btn" disabled={busy} data-testid="retranscribe" onClick={() => void transcribe(recording.status === "done")}>
                            <ArrowClockwise aria-hidden="true" /> {recording.status === "done" ? "Transcribe again" : recording.status === "failed" ? "Try again" : "Transcribe"}
                        </button>
                    ) : null}
                    <button type="button" className="rl-btn is-danger" disabled={busy} data-testid="watch-delete" onClick={() => void remove()}>
                        <Trash aria-hidden="true" /> Delete
                    </button>
                </div>
            </header>

            <div className="rw-body">
                <section className="rw-player" aria-label="Player">
                    {playable ? (
                        <video
                            ref={player}
                            key={recording.id}
                            className="rw-video"
                            data-testid="recording-player"
                            src={mediaUrl(recording.id)}
                            controls
                            playsInline
                            preload="metadata"
                            onLoadedMetadata={(event) => void prepare(event.currentTarget, t ?? 0).then(() => {
                                appliedT.current = t;
                                setReady(true);
                            })}
                            onTimeUpdate={(event) => setNow(event.currentTarget.currentTime)}
                            onPlay={() => setPlaying(true)}
                            onPause={() => setPlaying(false)}
                            onEnded={() => setPlaying(false)}
                            onError={() => setPlayerError(true)}
                        />
                    ) : (
                        <div className="rw-noplayer">
                            {recording.status === "recording"
                                ? "The host is recording this now. It can be played when it is stopped and finished."
                                : recording.status === "finishing"
                                  ? `The host is shrinking what it captured into the file it keeps${recording.progress === null ? "" : ` (${Math.round(recording.progress * 100)}%)`}. It can be played when that is done.`
                                  : "Nothing was kept of this recording."}
                        </div>
                    )}
                    {playerError ? (
                        <p className="rl-note is-bad" role="alert">
                            <Warning aria-hidden="true" /> This browser cannot play this recording. Download the file to play it elsewhere.
                        </p>
                    ) : null}
                    {recording.status === "failed" && recording.error ? (
                        <p className="rl-note is-bad" role="alert">
                            <Warning aria-hidden="true" /> {recording.error}
                        </p>
                    ) : null}
                </section>

                <section className="rw-transcript" aria-label="Transcript">
                    <div className="rw-find">
                        <SearchBox
                            ref={finder}
                            value={q}
                            label="Find in this transcript"
                            placeholder="Find in transcript"
                            shortcut={active}
                            onInput={setTyped}
                            onSettle={onQuery}
                            onSubmit={(backwards) => step(backwards ? -1 : 1)}
                        />
                        {typed !== "" && found ? (
                            <span className="rw-count" role="status" aria-live="polite" data-testid="find-count">
                                {found.lines.length === 0 ? "No matches" : `${activeMatch + 1} of ${found.lines.length}`}
                            </span>
                        ) : null}
                        <div className="rw-steps">
                            <button type="button" className="rl-icon-btn" aria-label="Previous match" disabled={!found || found.lines.length === 0} data-testid="find-prev" onClick={() => step(-1)}>
                                <CaretUp aria-hidden="true" />
                            </button>
                            <button type="button" className="rl-icon-btn" aria-label="Next match" disabled={!found || found.lines.length === 0} data-testid="find-next" onClick={() => step(1)}>
                                <CaretDown aria-hidden="true" />
                            </button>
                        </div>
                        <button type="button" className="rl-chip rw-follow" aria-pressed={follow} data-testid="follow" onClick={() => setFollow(!follow)}>
                            Follow playback
                        </button>
                    </div>

                    {transcript.phase === "loading" ? <div className="rl-skeleton" role="status" aria-label="Loading the transcript" /> : null}
                    {transcript.phase === "error" ? (
                        <p className="rl-note is-bad" role="alert">
                            {transcript.message}
                        </p>
                    ) : null}
                    {recording.status === "recording" || recording.status === "finishing" ? (
                        <p className="rl-note" role="status">
                            {recording.status === "recording" ? "Recording on the host." : "Finishing the file on the host."} The transcript is made once the file exists{recording.status === "recording" ? " and the recording is stopped" : ""}.
                        </p>
                    ) : null}
                    {recording.status === "transcribing" ? (
                        <p className="rl-note" role="status">
                            Transcribing: {Math.round((recording.progress ?? 0) * 100)}% done. The words appear here when it finishes.
                        </p>
                    ) : null}
                    {recording.status === "ready" || (recording.status === "failed" && transcript.phase === "none") ? (
                        <p className="rl-note" role="status">
                            {transcription?.available === false
                                ? `There is no transcript, and this host cannot make one${transcription.reason ? `: ${transcription.reason}` : "."}`
                                : "There is no transcript yet. Transcribe this recording to read and search what was said."}
                        </p>
                    ) : null}
                    {doneTranscript && doneTranscript.segments.length === 0 ? <p className="rl-note">No speech was found in this recording.</p> : null}
                    {doneTranscript && doneTranscript.segments.length > 0 ? (
                        <ol
                            ref={lines}
                            className="rw-lines"
                            aria-label="Transcript lines"
                            data-testid="transcript"
                            onWheel={() => setFollow(false)}
                            onTouchMove={() => setFollow(false)}
                        >
                            {doneTranscript.segments.map((segment, i) => (
                                <Line
                                    key={`${segment.start}-${i}`}
                                    index={i}
                                    start={segment.start}
                                    speaker={segment.speaker}
                                    channel={segment.channel}
                                    text={segment.text}
                                    tone={speakerTone.get(segment.speaker) ?? 0}
                                    current={current.has(i)}
                                    linked={i === linkedLine}
                                    ranges={found?.ranges[i] ?? NO_RANGES}
                                    active={i === activeLine && typed !== ""}
                                    onSeek={onLineSeek}
                                />
                            ))}
                        </ol>
                    ) : null}
                </section>
            </div>
            {confirm.element}
        </div>
    );
}
