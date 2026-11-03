/**
 * Web search and page reads in the activity timeline.
 *
 * - `WebSearchStep`: one step row for a run of consecutive searches ("Searched the web  rust E0597
 *   · 6 sources"), opening to the results grouped by query (favicon, title, domain, snippet).
 * - `WebFetchStep`: a page the agent read, as a row with the page title as a link.
 * - `ResultsList`: the results panel, also used by the subagent transcript.
 *
 * Inputs are plain protocol items: `webSearchEntries` pairs `function_call` items with their
 * `function_call_output` (whose `sources` the server fills from the search's structured result).
 */
import type { FunctionCallItem, FunctionCallOutputItem, OutputItem, SourceRef } from "@pikvm/chat-protocol";
import { MagnifyingGlass } from "@pikvm/icons";
import { memo, useMemo, useState } from "react";
import { useT } from "../../l10n/provider";
import { FaviconStack, StepRow, type StepState } from "./activity/shared";
import { Favicon, hostOf } from "./sources";
import { parseArgs } from "./turns";

export interface WebSearchEntry {
    callId: string;
    query: string;
    /** Why the agent searched, in its own words. */
    intent?: string;
    /** "stopped": cut off by Stop (set by the activity group, which knows how the turn ended). */
    status: "running" | "completed" | "failed" | "stopped";
    sources: SourceRef[];
    error?: string;
}

/** Is this call a web search (and not a file search)? */
export const isWebSearchCall = (name: string) => /^web_search$|web.?search/i.test(name);

/** Is this call a page read: a fetch-like tool, or `read` on an http(s) URL? */
export function isWebFetchCall(name: string, args: string): boolean {
    if (/fetch|browse_?url|open_?url/i.test(name)) return true;
    if (name !== "read") return false;
    const p = parseArgs(args)?.path;
    return typeof p === "string" && /^https?:\/\//i.test(p);
}

/** Search entries for the web search calls among `items`, in order, with their results. */
export function webSearchEntries(items: readonly OutputItem[]): WebSearchEntry[] {
    const outputs = new Map<string, FunctionCallOutputItem>();
    for (const it of items) if (it.type === "function_call_output") outputs.set(it.call_id, it);
    const out: WebSearchEntry[] = [];
    for (const it of items) {
        if (it.type !== "function_call" || !isWebSearchCall(it.name)) continue;
        out.push(entryOf(it, outputs.get(it.call_id)));
    }
    return out;
}

export function entryOf(call: FunctionCallItem, output: FunctionCallOutputItem | undefined): WebSearchEntry {
    const a = parseArgs(call.arguments);
    const failed = !!output?.is_error;
    return {
        callId: call.call_id,
        query: typeof a?.query === "string" ? a.query : "",
        intent: typeof a?.i === "string" ? a.i : undefined,
        status: !output || output.status === "in_progress" ? "running" : failed ? "failed" : "completed",
        sources: output?.sources ?? [],
        error: failed ? output!.output.replace(/^Error:\s*/, "").split("\n")[0] : undefined,
    };
}

/** Unique sources across entries, first seen first. */
function uniqueSources(entries: readonly WebSearchEntry[]): SourceRef[] {
    const seen = new Set<string>();
    const out: SourceRef[] = [];
    for (const e of entries) {
        for (const s of e.sources) {
            if (seen.has(s.url)) continue;
            seen.add(s.url);
            out.push(s);
        }
    }
    return out;
}

const RESULTS_PER_QUERY = 5;

/** One search result row. Opens the page in a new tab, or hands it to `onOpen` (the sources panel). */
/** The address as a search engine shows it: host, then path segments ("doc.traefik.io › https › acme"). */
function breadcrumb(url: string, host: string): string {
    try {
        const parts = new URL(url).pathname
            .split("/")
            .filter(Boolean)
            .map((part) => decodeURIComponent(part).replace(/\.[a-z0-9]{2,5}$/i, ""));
        return [host, ...parts.slice(0, 3)].join(" › ");
    } catch {
        return host;
    }
}

/** One result, laid out like a search engine's: site and address, then the title as a link, then the snippet. */
const ResultRow = memo(function ResultRow({ source, onOpen }: { source: SourceRef; onOpen?: (url: string) => void }) {
    const host = hostOf(source.url) ?? source.url;
    const title = source.title || host;
    return (
        <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="aa-result"
            onClick={(e) => {
                if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onOpen(source.url);
            }}
        >
            <span className="aa-result-site">
                <span className="aa-result-icon">
                    <Favicon host={host} size={16} />
                </span>
                <span className="aa-result-address">
                    <span className="aa-result-host">{host}</span>
                    <span className="aa-result-path" translate="no">
                        {breadcrumb(source.url, host)}
                    </span>
                </span>
            </span>
            <span className="aa-result-title">{title}</span>
            {source.snippet && <span className="aa-result-snippet">{source.snippet}</span>}
        </a>
    );
});

/** Results of one or more searches, grouped by query when there are several. */
export function ResultsList({
    entries,
    onOpen,
}: {
    entries: readonly WebSearchEntry[];
    onOpen?: (url: string) => void;
}) {
    const t = useT();
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    return (
        <div className="aa-results" role="list" aria-label={t("thread-web-results")}>
            {entries.map((e) => {
                const all = expanded.has(e.callId);
                const shown = all ? e.sources : e.sources.slice(0, RESULTS_PER_QUERY);
                const rest = e.sources.length - shown.length;
                return (
                    <div key={e.callId} role="listitem">
                        {/* Each query as a search box with its term, as a search engine heads its results. */}
                        <div className="aa-searchbox" role="presentation">
                            <MagnifyingGlass aria-hidden />
                            <span className="min-w-0 truncate">{e.query || t("thread-web-search")}</span>
                        </div>
                        {e.status === "failed" && (
                            <div className="aa-error-line">{e.error || t("thread-web-failed")}</div>
                        )}
                        {!e.sources.length && e.status !== "failed" && (
                            <div className="aa-quiet-line">
                                {e.status === "running"
                                    ? t("thread-web-searching")
                                    : e.status === "stopped"
                                      ? t("thread-web-stopped")
                                      : t("thread-web-no-results")}
                            </div>
                        )}
                        {shown.map((s) => (
                            <ResultRow key={s.url} source={s} onOpen={onOpen} />
                        ))}
                        {rest > 0 && (
                            <button
                                type="button"
                                className="act-more mx-2 mb-1"
                                onClick={() => setExpanded(new Set([...expanded, e.callId]))}
                            >
                                {t("thread-web-show-more", { count: rest })}
                            </button>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/**
 * A run of web searches as one step row: "Searched the web" with the query (or "3 queries"), a favicon
 * stack and the source count. Opens to the results, grouped by query. Closed by default, also while it
 * runs: the row's live verb and the group header say that it is searching.
 */
export const WebSearchStep = memo(function WebSearchStep({
    entries,
    live,
    onOpenSource,
}: {
    entries: readonly WebSearchEntry[];
    live: boolean;
    onOpenSource?: (url: string) => void;
}) {
    const t = useT();
    const running = live && entries.some((e) => e.status === "running");
    const sources = useMemo(() => uniqueSources(entries), [entries]);
    const failed = entries.filter((e) => e.status === "failed").length;
    const stopped = entries.some((e) => e.status === "stopped");
    const allFailed = failed === entries.length && entries.length > 0;
    const single = entries.length === 1 ? entries[0]!.query : undefined;
    const state: StepState = running
        ? "running"
        : allFailed
          ? "failed"
          : stopped && !sources.length
            ? "stopped"
            : "done";
    return (
        <StepRow
            kind="web-search"
            state={state}
            verb={running ? t("thread-act-searching-web") : t("thread-act-searched-web")}
            subject={single ?? t("thread-web-queries", { count: entries.length })}
            title={entries.map((e) => e.query).join("\n")}
            meta={
                sources.length ? (
                    <>
                        <FaviconStack urls={sources.map((s) => s.url)} max={3} size={14} />
                        {t("thread-sub-sources", { count: sources.length })}
                    </>
                ) : undefined
            }
            note={
                state === "failed"
                    ? t("thread-act-failed")
                    : state === "stopped"
                      ? t("thread-act-stopped")
                      : failed && !running
                        ? t("thread-sub-n-failed", { count: failed })
                        : undefined
            }
            detail={() => <ResultsList entries={entries} onOpen={onOpenSource} />}
        />
    );
});

/** A page the agent read: "Read" and the page title, linking to the page; no detail. */
export const WebFetchStep = memo(function WebFetchStep({
    url,
    title,
    state,
    onOpenSource,
}: {
    url: string;
    title?: string;
    state: StepState;
    onOpenSource?: (url: string) => void;
}) {
    const t = useT();
    const host = hostOf(url) ?? url;
    return (
        <StepRow
            kind="fetch"
            state={state}
            verb={state === "running" ? t("thread-act-verb-reading") : t("thread-act-verb-read")}
            subject={
                <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="act-link"
                    onClick={(e) => {
                        if (!onOpenSource || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        onOpenSource(url);
                    }}
                >
                    <Favicon host={host} size={14} />
                    <span className="truncate">{title || host}</span>
                </a>
            }
            title={url}
            meta={title ? host : undefined}
            note={
                state === "failed" ? t("thread-act-failed") : state === "stopped" ? t("thread-act-stopped") : undefined
            }
        />
    );
});

/** Props for `WebFetchStep` from a call and its output. */
export function fetchOf(call: FunctionCallItem, output: FunctionCallOutputItem | undefined) {
    const p = parseArgs(call.arguments);
    const url =
        output?.sources?.[0]?.url ?? (typeof p?.path === "string" ? p.path : typeof p?.url === "string" ? p.url : "");
    return {
        url,
        title: output?.sources?.[0]?.title,
        status: (!output || output.status === "in_progress" ? "running" : output.is_error ? "failed" : "completed") as
            "running" | "completed" | "failed",
    };
}
