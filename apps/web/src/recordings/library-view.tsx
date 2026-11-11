/**
 * The library: every recording the host holds, as a table that becomes a stack of cards when the page is narrow.
 *
 * A row is the thumbnail, the title (opens the recording; the pencil renames it in place), where it was recorded, its state, when,
 * how long, how big, when it goes, and a menu. Rows are picked with their boxes (Shift extends from the last one) and the bar
 * above the table then offers one delete for all of them. The arrow keys move between the titles. Filters and the sort are
 * applied here, on the list the host sent, so they answer at once and their counts are always true.
 */

import type { RecordingSort, RecordingView, TranscriptionStatus, YouTubeSettings } from "@pikvm/contracts/recordings";
import { ArrowClockwise, ArrowsDownUp, Copy, DotsThreeVertical, DownloadSimple, FilmStrip, PencilSimple, Trash, VideoCamera, X } from "@pikvm/icons";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { mediaUrl } from "../kvm/recorder/api";
import { useConfirm } from "../kvm/dialogs/shell";
import { displayTitle, FILTERS, formatDuration, formatStarted, matchesFilter, type RecordingFilter, SORTS, sizeText, sortRecordings } from "./format";
import { MenuButton, type MenuItem } from "./menu";
import { Expiry, Poster, Provenance, StatusPill } from "./parts";
import { copyTranscript } from "./transcript-actions";
import { errorText, type Library } from "./use-library";
import { readYouTubeSettings, uploadRecordingToYouTube, youtubeKey } from "./youtube-api";

interface LibraryViewProps {
    readonly library: Library;
    readonly filter: RecordingFilter;
    readonly sort: RecordingSort;
    readonly onFilter: (filter: RecordingFilter) => void;
    readonly onSort: (sort: RecordingSort) => void;
    /** Tell the page something happened that the person should read (it shows in the banner above). */
    readonly onNotice: (notice: { readonly tone: "ok" | "bad"; readonly text: string } | null) => void;
    readonly onOpenKvm: () => void;
}

export function Skeleton() {
    return (
        <div className="rl-skeleton" role="status" aria-label="Loading recordings">
            {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="rl-skeleton-row" aria-hidden="true">
                    <span className="rl-skel rl-skel-thumb" />
                    <span className="rl-skel-lines">
                        <span className="rl-skel" style={{ width: `${48 + ((i * 17) % 30)}%` }} />
                        <span className="rl-skel" style={{ width: "28%" }} />
                    </span>
                </div>
            ))}
        </div>
    );
}

function Title({ recording, editing, onStart, onDone, onSave }: {
    readonly recording: RecordingView;
    readonly editing: boolean;
    readonly onStart: () => void;
    readonly onDone: () => void;
    readonly onSave: (title: string | null) => Promise<void>;
}) {
    const name = displayTitle(recording);
    if (editing) return <RenameField initial={recording.title ?? name} placeholder={name} onDone={onDone} onSave={onSave} />;
    return (
        <span className="rl-title-line">
            <Link to="/recordings/$id" params={{ id: recording.id }} className="rl-title" data-testid="recording-title">
                {name}
            </Link>
            <button type="button" className="rl-icon-btn rl-rename" aria-label={`Rename ${name}`} title="Rename" data-testid="rename-button" onClick={onStart}>
                <PencilSimple aria-hidden="true" />
            </button>
        </span>
    );
}

/** An input that takes the place of a title: Enter or leaving it saves, Escape puts the old one back. An empty name is the default one. */
export function RenameField({ initial, placeholder, onDone, onSave, className = "rl-rename-field" }: {
    readonly initial: string;
    readonly placeholder: string;
    readonly onDone: () => void;
    readonly onSave: (title: string | null) => Promise<void>;
    readonly className?: string;
}) {
    const input = useRef<HTMLInputElement>(null);
    const [text, setText] = useState(initial);
    const [saving, setSaving] = useState(false);
    const finished = useRef(false);

    useEffect(() => {
        input.current?.focus();
        input.current?.select();
    }, []);

    const save = async (): Promise<void> => {
        if (finished.current) return;
        finished.current = true;
        const next = text.replace(/\s+/g, " ").trim();
        if (next === initial.trim()) return onDone();
        setSaving(true);
        try {
            await onSave(next === "" ? null : next);
        } finally {
            onDone();
        }
    };

    return (
        <input
            ref={input}
            className={className}
            value={text}
            placeholder={placeholder}
            maxLength={200}
            aria-label="Recording title"
            aria-busy={saving}
            disabled={saving}
            data-testid="rename-input"
            onChange={(event) => setText(event.target.value)}
            onBlur={() => void save()}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    void save();
                } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    finished.current = true;
                    onDone();
                }
            }}
        />
    );
}

function RowMenu({ recording, transcription, youtubeConnected, onRename, onDelete, onTranscribe, onYouTube, onNotice }: {
    readonly recording: RecordingView;
    readonly transcription: TranscriptionStatus;
    readonly onRename: () => void;
    readonly onDelete: () => void;
    readonly onTranscribe: () => void;
    readonly youtubeConnected: boolean;
    readonly onYouTube: () => void;
    readonly onNotice: LibraryViewProps["onNotice"];
}) {
    const name = displayTitle(recording);
    const hasMedia = recording.status !== "recording" && recording.status !== "finishing" && recording.bytes > 0;
    const canTranscribe = transcription.available && (recording.status === "ready" || recording.status === "failed");
    const youtubeState = recording.youtube?.state;
    const canYouTube = youtubeConnected && (recording.status === "ready" || recording.status === "done") && youtubeState !== "uploaded" && youtubeState !== "uploading" && youtubeState !== "verifying";
    const items: MenuItem[] = [
        { id: "open", label: "Open", icon: <VideoCamera aria-hidden="true" />, run: () => document.getElementById(`rl-open-${recording.id}`)?.click() },
        { id: "rename", label: "Rename", icon: <PencilSimple aria-hidden="true" />, run: onRename },
        {
            id: "copy",
            label: "Copy transcript",
            icon: <Copy aria-hidden="true" />,
            disabled: recording.status !== "done",
            why: "There is no transcript yet.",
            run: () => void copyTranscript(recording.id).then((ok) => onNotice(ok ? { tone: "ok", text: "Transcript copied." } : { tone: "bad", text: "The transcript could not be copied." })),
        },
        ...(canTranscribe ? [{ id: "transcribe", label: recording.status === "failed" ? "Try transcribing again" : "Transcribe", icon: <ArrowClockwise aria-hidden="true" />, run: onTranscribe }] : []),
        ...(canYouTube ? [{ id: "youtube", label: youtubeState === "failed" ? "Try YouTube upload again" : "Upload to YouTube", icon: <FilmStrip aria-hidden="true" />, run: onYouTube }] : []),
        {
            id: "download",
            label: "Download",
            icon: <DownloadSimple aria-hidden="true" />,
            disabled: !hasMedia,
            why: "There is nothing to download.",
            run: () => document.getElementById(`rl-download-${recording.id}`)?.click(),
        },
        { type: "separator" },
        { id: "delete", label: recording.status === "recording" ? "Stop and delete" : "Delete", icon: <Trash aria-hidden="true" />, danger: true, run: onDelete },
    ];
    return (
        <>
            <MenuButton label={`More actions for ${name}`} items={items} align="end" className="rl-icon-btn" testId="row-menu">
                <DotsThreeVertical weight="bold" aria-hidden="true" />
            </MenuButton>
            {/* The menu's Open and Download act through these, so they are real links: a new tab and a saved file work as anywhere. */}
            <Link id={`rl-open-${recording.id}`} to="/recordings/$id" params={{ id: recording.id }} className="rl-hidden-link" tabIndex={-1} aria-hidden="true" />
            {hasMedia ? <a id={`rl-download-${recording.id}`} href={mediaUrl(recording.id)} download={`${name}.${recording.mime === "video/mp4" ? "mp4" : "webm"}`} className="rl-hidden-link" tabIndex={-1} aria-hidden="true" /> : null}
        </>
    );
}

export function LibraryView({ library, filter, sort, onFilter, onSort, onNotice, onOpenKvm }: LibraryViewProps) {
    const confirm = useConfirm();
    const youtube = useQuery<YouTubeSettings, Error>({ queryKey: youtubeKey, queryFn: readYouTubeSettings, staleTime: 30_000 });
    const youtubeConnected = youtube.data?.connected === true;
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [editing, setEditing] = useState<string | null>(null);
    const anchor = useRef<string | null>(null);
    const all = useRef<HTMLInputElement>(null);
    const state = library.state;

    const recordings = state.phase === "ready" ? state.recordings : [];
    const counts = useMemo(() => {
        const now = Date.now();
        return Object.fromEntries(FILTERS.map((f) => [f.id, recordings.filter((r) => matchesFilter(r, f.id, now)).length])) as Record<RecordingFilter, number>;
    }, [recordings]);
    const shown = useMemo(() => sortRecordings(recordings.filter((r) => matchesFilter(r, filter)), sort), [recordings, filter, sort]);

    // A recording that left (deleted here or by the sweep) leaves the selection too.
    useEffect(() => {
        setSelected((now) => {
            const kept = new Set([...now].filter((id) => recordings.some((r) => r.id === id)));
            return kept.size === now.size ? now : kept;
        });
    }, [recordings]);

    const picked = shown.filter((r) => selected.has(r.id));
    useEffect(() => {
        if (all.current) all.current.indeterminate = picked.length > 0 && picked.length < shown.length;
    }, [picked.length, shown.length]);

    const toggle = (id: string, extend: boolean): void => {
        setSelected((now) => {
            const next = new Set(now);
            const from = anchor.current === null ? -1 : shown.findIndex((r) => r.id === anchor.current);
            const to = shown.findIndex((r) => r.id === id);
            if (extend && from >= 0 && to >= 0) {
                const wanted = !now.has(id);
                for (const r of shown.slice(Math.min(from, to), Math.max(from, to) + 1)) {
                    if (wanted) next.add(r.id);
                    else next.delete(r.id);
                }
            } else if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
        anchor.current = id;
    };

    const deleteMany = async (ids: ReadonlyArray<string>): Promise<void> => {
        const first = recordings.find((r) => r.id === ids[0]);
        const warning = ids.map((id) => recordings.find((r) => r.id === id)?.youtubeWarning).find((w) => w !== undefined);
        const sure = await confirm.ask({
            title: ids.length === 1 ? "Delete this recording?" : `Delete ${ids.length} recordings?`,
            body:
                (ids.length === 1 && first
                    ? `${first.status === "recording" ? "The recording in progress is stopped first. " : ""}"${displayTitle(first)}", its sound and its transcript are removed from the host. This cannot be undone.`
                    : "The videos, their sound and their transcripts are removed from the host. This cannot be undone.") + (warning ? ` ${warning}` : ""),
            confirm: ids.length === 1 ? "Delete" : `Delete ${ids.length}`,
            danger: true,
        });
        if (!sure) return;
        const refused = await library.remove(ids);
        if (refused.length === 0) onNotice({ tone: "ok", text: ids.length === 1 ? "Recording deleted." : `${ids.length} recordings deleted.` });
        else onNotice({ tone: "bad", text: `${refused.length} of ${ids.length} could not be deleted: ${refused[0]?.message ?? ""}` });
    };

    const uploadToYouTube = async (recording: RecordingView): Promise<void> => {
        try {
            await uploadRecordingToYouTube(recording.id);
            onNotice({ tone: "ok", text: "Queued for YouTube. It appears here when the upload is done." });
            void library.reload();
        } catch (error) {
            onNotice({ tone: "bad", text: `Could not upload to YouTube: ${error instanceof Error ? error.message : "Something went wrong."}` });
        }
    };

    const save = (id: string) => async (title: string | null): Promise<void> => {
        try {
            await library.rename(id, title);
        } catch (error) {
            onNotice({ tone: "bad", text: `Could not rename: ${errorText(error)}` });
        }
    };

    const onListKey = (event: KeyboardEvent<HTMLDivElement>): void => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || !target.classList.contains("rl-title")) return;
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const titles = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(".rl-title"));
        const next = titles[titles.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
        if (!next) return;
        event.preventDefault();
        next.focus();
        next.scrollIntoView({ block: "nearest" });
    };

    if (state.phase === "loading") return <Skeleton />;
    if (state.phase === "error") {
        return (
            <div className="rl-empty" role="alert" data-testid="library-error">
                <h2>The recordings could not be loaded</h2>
                <p>{state.message}</p>
                <button type="button" className="rl-btn" onClick={() => void library.reload()}>
                    <ArrowClockwise aria-hidden="true" /> Try again
                </button>
            </div>
        );
    }
    if (recordings.length === 0) {
        return (
            <div className="rl-empty" data-testid="library-empty">
                <FilmStrip aria-hidden="true" />
                <h2>No recordings yet</h2>
                <p>Press the record button on the KVM screen to record a session. It saves on this host as you go, and can be turned into a searchable transcript.</p>
                <button type="button" className="rl-btn is-primary" onClick={onOpenKvm}>
                    Go to the KVM
                </button>
            </div>
        );
    }

    const selecting = picked.length > 0;
    return (
        <>
            <div className="rl-toolbar">
                {selecting ? (
                    <div className="rl-selbar" role="group" aria-label="Selected recordings" data-testid="selection-bar">
                        <span className="rl-selcount" role="status">
                            {picked.length} selected
                        </span>
                        <button type="button" className="rl-btn is-danger" data-testid="bulk-delete" onClick={() => void deleteMany(picked.map((r) => r.id))}>
                            <Trash aria-hidden="true" /> Delete
                        </button>
                        <button type="button" className="rl-btn" onClick={() => setSelected(new Set())}>
                            <X aria-hidden="true" /> Clear selection
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="rl-chips" role="group" aria-label="Filter recordings">
                            {FILTERS.map((f) => (
                                <button key={f.id} type="button" className="rl-chip" aria-pressed={filter === f.id} data-testid={`filter-${f.id}`} onClick={() => onFilter(f.id)}>
                                    {f.label}
                                    <span className="rl-chip-count">{counts[f.id]}</span>
                                </button>
                            ))}
                        </div>
                        <MenuButton
                            label={`Sort: ${SORTS.find((s) => s.id === sort)?.label ?? ""}`}
                            className="rl-btn rl-sort"
                            align="end"
                            testId="sort-menu"
                            items={SORTS.map((s) => ({ id: `sort-${s.id}`, label: s.label, checked: s.id === sort, run: () => onSort(s.id) }))}
                        >
                            <ArrowsDownUp aria-hidden="true" />
                            <span className="rl-sort-label">{SORTS.find((s) => s.id === sort)?.label}</span>
                        </MenuButton>
                    </>
                )}
            </div>

            {shown.length === 0 ? (
                <div className="rl-empty" data-testid="filter-empty">
                    <h2>No recordings match this filter</h2>
                    <p>{recordings.length} {recordings.length === 1 ? "recording is" : "recordings are"} hidden by "{FILTERS.find((f) => f.id === filter)?.label}".</p>
                    <button type="button" className="rl-btn" onClick={() => onFilter("all")}>
                        Show all recordings
                    </button>
                </div>
            ) : (
                <div className="rl-table" role="table" aria-label="Recordings" aria-rowcount={shown.length + 1} data-testid="recording-table" onKeyDown={onListKey}>
                    <div className="rl-row rl-head-row" role="row">
                        <div className="rl-c-check" role="columnheader">
                            <input
                                ref={all}
                                type="checkbox"
                                className="rl-check"
                                aria-label="Select all recordings shown"
                                checked={picked.length === shown.length && shown.length > 0}
                                onChange={() => setSelected(picked.length === shown.length ? new Set() : new Set(shown.map((r) => r.id)))}
                            />
                        </div>
                        <div className="rl-c-main" role="columnheader">
                            Recording
                        </div>
                        <div className="rl-c-target" role="columnheader">
                            Target
                        </div>
                        <div className="rl-c-status" role="columnheader">
                            State
                        </div>
                        <div className="rl-c-date" role="columnheader">
                            Date
                        </div>
                        <div className="rl-c-len" role="columnheader">
                            Length
                        </div>
                        <div className="rl-c-size" role="columnheader">
                            Size
                        </div>
                        <div className="rl-c-exp" role="columnheader">
                            Deleted
                        </div>
                        <div className="rl-c-menu" role="columnheader">
                            <span className="rl-sr">Actions</span>
                        </div>
                    </div>
                    {shown.map((r) => {
                        const name = displayTitle(r);
                        return (
                            <div
                                key={r.id}
                                className="rl-row"
                                role="row"
                                data-testid="recording-row"
                                data-id={r.id}
                                data-status={r.status}
                                data-selected={selected.has(r.id) || undefined}
                            >
                                <div className="rl-c-check" role="cell">
                                    <input
                                        type="checkbox"
                                        className="rl-check"
                                        aria-label={`Select ${name}`}
                                        checked={selected.has(r.id)}
                                        data-testid="row-check"
                                        onChange={() => undefined}
                                        onClick={(event) => toggle(r.id, event.shiftKey)}
                                    />
                                </div>
                                <div className="rl-c-main" role="cell">
                                    <Link to="/recordings/$id" params={{ id: r.id }} className="rl-thumb" tabIndex={-1} aria-hidden="true">
                                        <Poster recording={r} />
                                    </Link>
                                    <div className="rl-titleblock">
                                        <Title recording={r} editing={editing === r.id} onStart={() => setEditing(r.id)} onDone={() => setEditing(null)} onSave={save(r.id)} />
                                        <span className="rl-sub">{[r.target, sizeText(r)].filter(Boolean).join(" \u00b7 ")}</span>
                                        <Provenance recording={r} />
                                        <span className="rl-sub-card">{[formatStarted(r.startedAt), r.target, sizeText(r)].filter(Boolean).join(" \u00b7 ")}</span>
                                    </div>
                                </div>
                                <div className="rl-c-target" role="cell">
                                    {r.target ?? <span className="rl-muted">-</span>}
                                </div>
                                <div className="rl-c-status" role="cell">
                                    <StatusPill recording={r} />
                                </div>
                                <div className="rl-c-date" role="cell">
                                    <time dateTime={r.startedAt}>{formatStarted(r.startedAt)}</time>
                                </div>
                                <div className="rl-c-len" role="cell">
                                    {formatDuration(r.durationMs)}
                                </div>
                                <div className="rl-c-size" role="cell">
                                    {sizeText(r)}
                                </div>
                                <div className="rl-c-exp" role="cell">
                                    <Expiry recording={r} />
                                </div>
                                <div className="rl-c-menu" role="cell">
                                    <RowMenu
                                        recording={r}
                                        transcription={state.transcription}
                                        youtubeConnected={youtubeConnected}
                                        onYouTube={() => void uploadToYouTube(r)}
                                        onRename={() => setEditing(r.id)}
                                        onDelete={() => void deleteMany([r.id])}
                                        onTranscribe={() =>
                                            void library.transcribe(r.id).catch((error: unknown) => onNotice({ tone: "bad", text: `Could not start the transcription: ${errorText(error)}` }))
                                        }
                                        onNotice={onNotice}
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
            {confirm.element}
        </>
    );
}
