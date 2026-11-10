/**
 * What a search found, grouped by recording: the recording's name once, then each place the words were said, with the second, who
 * said it and the words with the match marked. A line opens the recording at that second (`/recordings/<id>?t=<s>&q=<query>`), so
 * the link can be copied and a reload lands in the same place. A title that matched is a line of its own, with no second.
 */

import type { RecordingSearchHit, RecordingView } from "@pikvm/contracts/recordings";
import { MagnifyingGlass } from "@pikvm/icons";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { displayTitle, formatDuration, formatStarted } from "./format";
import { Highlighted, Poster } from "./parts";
import type { SearchState } from "./use-search";

interface Group {
    readonly recording: RecordingView;
    readonly hits: RecordingSearchHit[];
}

/** Hits collected under their recording; a recording sits where its best-ranked hit does. */
export function groupHits(hits: ReadonlyArray<RecordingSearchHit>): Group[] {
    const groups = new Map<string, Group>();
    for (const hit of hits) {
        const group = groups.get(hit.recording.id);
        if (group) group.hits.push(hit);
        else groups.set(hit.recording.id, { recording: hit.recording, hits: [hit] });
    }
    // Inside a recording the lines read in the order they were said, the title (no second) first; the ranking decided only where the
    // recording sits among the others.
    for (const group of groups.values()) group.hits.sort((a, b) => (a.startMs ?? -1) - (b.startMs ?? -1));
    return [...groups.values()];
}

export function SearchResults({ query, state, more }: { readonly query: string; readonly state: SearchState; readonly more: () => void }) {
    const groups = useMemo(() => (state.phase === "ready" ? groupHits(state.hits) : []), [state]);

    if (state.phase === "error") {
        return (
            <div className="rl-empty" role="alert" data-testid="search-error">
                <h2>The search could not be made</h2>
                <p>{state.message}</p>
            </div>
        );
    }
    if (state.phase === "loading" || state.phase === "idle") {
        return <div className="rl-skeleton" role="status" aria-label="Searching" data-testid="search-loading" />;
    }
    if (state.hits.length === 0) {
        return (
            <div className="rl-empty" data-testid="search-empty">
                <MagnifyingGlass aria-hidden="true" />
                <h2>Nothing matches "{state.query}"</h2>
                <p>Only transcribed recordings have words to find. Try fewer words, or put words in quotes to find them together: "upgrade the server".</p>
            </div>
        );
    }
    return (
        <div className="rl-results" data-testid="search-results" aria-busy={state.query !== query}>
            <p className="rl-count" role="status" data-testid="search-count">
                {state.total} {state.total === 1 ? "match" : "matches"} in {state.recordings} {state.recordings === 1 ? "recording" : "recordings"}
            </p>
            {groups.map((group) => (
                <section key={group.recording.id} className="rl-group" aria-label={displayTitle(group.recording)} data-testid="result-group">
                    <Link to="/recordings/$id" params={{ id: group.recording.id }} search={{ q: state.query }} className="rl-group-head">
                        <Poster recording={group.recording} className="rl-thumb-img rl-thumb-small" />
                        <span className="rl-group-text">
                            <span className="rl-group-title">{displayTitle(group.recording)}</span>
                            <span className="rl-sub">
                                {[formatStarted(group.recording.startedAt), formatDuration(group.recording.durationMs), group.recording.target].filter(Boolean).join(" \u00b7 ")}
                            </span>
                        </span>
                    </Link>
                    <ul className="rl-hits">
                        {group.hits.map((hit, i) => (
                            <li key={`${hit.startMs ?? "title"}-${i}`}>
                                <Link
                                    to="/recordings/$id"
                                    params={{ id: group.recording.id }}
                                    search={hit.startMs === null ? { q: state.query } : { q: state.query, t: Math.floor(hit.startMs / 1000) }}
                                    className="rl-hit"
                                    data-testid="search-hit"
                                    data-kind={hit.kind}
                                    data-start-ms={hit.startMs ?? undefined}
                                >
                                    <span className="rl-hit-time">{hit.startMs === null ? "Title" : formatDuration(hit.startMs)}</span>
                                    {hit.speaker !== null ? <span className="rl-hit-who">{hit.speaker}</span> : null}
                                    <span className="rl-hit-text">
                                        <Highlighted text={hit.text} ranges={hit.ranges} />
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
            {state.hits.length < state.total ? (
                <div className="rl-more">
                    {typeof state.more === "object" ? (
                        <p className="rl-note is-bad" role="alert">
                            {state.more.error}
                        </p>
                    ) : null}
                    <button type="button" className="rl-btn" disabled={state.more === "loading"} data-testid="more-results" onClick={more}>
                        {state.more === "loading" ? "Loading..." : `Show more (${state.total - state.hits.length} left)`}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
