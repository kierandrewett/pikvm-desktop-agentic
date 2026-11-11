/**
 * The Recordings destination: the header (title and search), and under it the library, the search results or one recording,
 * as the address says. The address is the state: reloading, going back and copying the link all keep what was open.
 *
 * Like Chat and Settings it stays mounted while another tab is in front (panes.tsx), so it remembers what it was showing while
 * hidden, pauses its player, reads the list again when it returns, and takes no keys while it is away.
 */

import { X } from "@pikvm/icons";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { type RecordingFilter } from "./format";
import { LibraryView, Skeleton } from "./library-view";
import { recordingIdOf, readSearch } from "./route-state";
import { SearchBox } from "./search-box";
import { SearchResults } from "./search-results";
import { useLibrary } from "./use-library";
import { useSearch } from "./use-search";
import { WatchView } from "./watch-view";
import type { RecordingSort } from "@pikvm/contracts/recordings";
import "./recordings.css";

interface Notice {
    readonly tone: "ok" | "bad";
    readonly text: string;
}

const NOTICE_MS = 6000;

export function RecordingsRoute({ active }: { active: boolean }) {
    const navigate = useNavigate();
    const location = useRouterState({ select: (state) => state.location });
    const library = useLibrary(active);
    const [notice, setNotice] = useState<Notice | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const here = useMemo(() => ({ id: recordingIdOf(location.pathname), search: readSearch(location.search as Record<string, unknown>) }), [location.pathname, location.search]);
    // Hidden, the page keeps showing what it showed (the address is another tab's meanwhile).
    const [kept, setKept] = useState(here);
    if (active && JSON.stringify(kept) !== JSON.stringify(here)) setKept(here);
    const shown = active ? here : kept;
    const { id, search } = shown;
    const q = search.q ?? "";
    const filter: RecordingFilter = search.filter ?? "all";
    const sort: RecordingSort = search.sort ?? "newest";

    const say = (next: Notice | null): void => {
        clearTimeout(timer.current);
        setNotice(next);
        if (next?.tone === "ok") timer.current = setTimeout(() => setNotice(null), NOTICE_MS);
    };
    useEffect(() => () => clearTimeout(timer.current), []);
    // A notice about one view is not carried to the next.
    useEffect(() => setNotice(null), [id]);

    const ready = library.state.phase === "ready" ? library.state : null;
    const listKey = ready ? ready.recordings.map((r) => `${r.id}:${r.status}:${r.title ?? ""}`).join("|") : "";
    const searching = id === null && q !== "";
    const results = useSearch(searching ? q : "", active, listKey);

    const setQuery = (next: string): void => {
        // The same page with the other query: the library stays the library and a recording stays open.
        void navigate({ to: ".", search: (prev) => ({ ...prev, q: next.trim() === "" ? undefined : next }), replace: true });
    };

    if (id !== null) {
        return (
            <div className="rl-page" data-testid="recordings-page" data-view="watch">
                <Notices notice={notice} onDismiss={() => say(null)} />
                <WatchView
                    id={id}
                    library={library}
                    q={q}
                    t={search.t ?? null}
                    active={active}
                    onQuery={setQuery}
                    onLeave={() => void navigate({ to: "/recordings" })}
                    onNotice={say}
                />
            </div>
        );
    }

    return (
        <div className="rl-page" data-testid="recordings-page" data-view={searching ? "search" : "library"}>
            <header className="rl-head">
                <h1 className="rl-h1">Recordings</h1>
                <SearchBox value={q} label="Search recordings" placeholder="Search what was said, or titles" shortcut={active} onSettle={setQuery} />
            </header>
            <Notices notice={notice} onDismiss={() => say(null)} />
            {ready?.stale ? (
                <p className="rl-note is-bad" role="alert" data-testid="stale-note">
                    Could not refresh the list: {ready.stale}
                </p>
            ) : null}
            {ready && !ready.transcription.available ? (
                <p className="rl-note" data-testid="no-transcription">
                    Transcription is not available on this host{ready.transcription.reason ? `: ${ready.transcription.reason}` : "."} Recordings can still be played and deleted.
                </p>
            ) : null}
            {ready?.archive.enabled && ready.archive.failed > 0 ? (
                <p className="rl-note is-bad" role="alert" data-testid="archive-note">
                    {ready.archive.failed} {ready.archive.failed === 1 ? "recording is" : "recordings are"} not copied to the archive folder yet, so the host keeps their files. The copy is retried.
                </p>
            ) : null}
            <div className="rl-content">
                {searching ? (
                    <SearchResults query={q} state={results.state} more={results.more} />
                ) : library.state.phase === "loading" ? (
                    <Skeleton />
                ) : (
                    <LibraryView
                        library={library}
                        filter={filter}
                        sort={sort}
                        onFilter={(next) =>
                            void navigate({ to: "/recordings", search: (prev) => ({ ...prev, filter: next === "all" ? undefined : next }), replace: true })
                        }
                        onSort={(next) => void navigate({ to: "/recordings", search: (prev) => ({ ...prev, sort: next === "newest" ? undefined : next }), replace: true })}
                        onNotice={say}
                        onOpenKvm={() => void navigate({ to: "/kvm" })}
                    />
                )}
            </div>
        </div>
    );
}

function Notices({ notice, onDismiss }: { readonly notice: Notice | null; readonly onDismiss: () => void }) {
    if (notice === null) return null;
    return (
        <p className={`rl-note${notice.tone === "bad" ? " is-bad" : " is-ok"}`} role={notice.tone === "bad" ? "alert" : "status"} data-testid="notice">
            <span>{notice.text}</span>
            <button type="button" className="rl-note-dismiss" aria-label="Dismiss" onClick={onDismiss}>
                <X aria-hidden="true" />
            </button>
        </p>
    );
}
