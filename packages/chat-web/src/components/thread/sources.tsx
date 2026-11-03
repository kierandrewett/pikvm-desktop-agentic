/**
 * Web sources found in a conversation's tool calls and outputs (web search, fetch, browser tools), the
 * favicon used for them, the per-conversation source lookup that citation chips read, and the
 * "Sources" button under an answer.
 *
 * Structured sources (`function_call_output.sources`, filled by the server from web tool results) carry
 * titles and snippets. Older items without them fall back to URLs found in the tool text.
 */
import type { OutputItem, SourceRef } from "@pikvm/chat-protocol";
import { ArrowUpRightIcon, GlobeIcon, MagnifyingGlassIcon, XIcon } from "@pikvm/icons";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Sheet } from "../ui/sheet";
import { EmptyState } from "../ui/state";
import { useT } from "../../l10n/provider";
import { cn } from "../../lib/cn";

const URL_RE = /\bhttps?:\/\/[^\s"'<>()\[\]{}`\\]+/g;

export interface Source {
    url: string;
    host: string;
    title?: string;
    snippet?: string;
    published?: string;
}

export function hostOf(url: string): string | undefined {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
        return parsed.hostname.replace(/^www\./, "") || undefined;
    } catch {
        return undefined;
    }
}

/** Canonical form for matching a cited URL to a source: no fragment, no trailing slash. */
export const sourceKey = (url: string) => url.replace(/#.*$/, "").replace(/\/+$/, "");

/** Unique http(s) URLs in a string, trailing punctuation trimmed, in order of appearance. */
export function urlsIn(text: string): Source[] {
    const seen = new Set<string>();
    const out: Source[] = [];
    for (const m of text.matchAll(URL_RE)) {
        const url = m[0].replace(/[.,;:!?'"]+$/, "");
        const host = hostOf(url);
        if (!host || seen.has(url)) continue;
        seen.add(url);
        out.push({ url, host });
    }
    return out;
}

const WEB_TOOL = /web|search|fetch|http|browse|browser|url|page/i;

/** Is this tool call one whose URLs count as sources? */
export const isWebTool = (name: string) => WEB_TOOL.test(name);

function fromRef(s: SourceRef): Source | undefined {
    const host = hostOf(s.url);
    if (!host) return undefined;
    return { url: s.url, host, title: s.title, snippet: s.snippet, published: s.published };
}

/**
 * Sources of a set of items, unique by URL: structured sources from tool outputs first-class, then URLs
 * in web tool arguments and outputs. A later structured entry fills in the title of an earlier bare URL.
 */
export function sourcesOf(items: readonly OutputItem[]): Source[] {
    const webCalls = new Set<string>();
    const byKey = new Map<string, Source>();
    const add = (list: (Source | undefined)[]) => {
        for (const s of list) {
            if (!s) continue;
            const k = sourceKey(s.url);
            const prev = byKey.get(k);
            if (!prev) byKey.set(k, s);
            else byKey.set(k, mergeSource(prev, s));
        }
    };
    for (const it of items) {
        if (it.type === "function_call" && isWebTool(it.name)) {
            webCalls.add(it.call_id);
            add(urlsIn(it.arguments));
        } else if (it.type === "function_call_output") {
            if (it.sources?.length) add(it.sources.map(fromRef));
            else if (webCalls.has(it.call_id)) add(urlsIn(it.output));
        } else if (it.type === "message" && it.role === "assistant") {
            for (const part of it.content) {
                if (part.type !== "output_text") continue;
                for (const annotation of part.annotations) {
                    if (annotation.type !== "url_citation" || typeof annotation.url !== "string") continue;
                    add([
                        fromRef({
                            url: annotation.url,
                            title: typeof annotation.title === "string" ? annotation.title : undefined,
                        }),
                    ]);
                }
            }
        }
    }
    return [...byKey.values()];
}

const MARKDOWN_LINK = /\[((?:[^\][]|\[[^\]]*\])*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g;

/** Annotations are authoritative. Older answers match links to known tool sources. */
export function citedSourceKeys(items: readonly OutputItem[], sources: readonly Source[]): ReadonlySet<string> {
    const known = new Set(sources.map((s) => sourceKey(s.url)));
    const cited = new Set<string>();
    for (const item of items) {
        if (item.type !== "message" || item.role !== "assistant") continue;
        for (const part of item.content) {
            if (part.type !== "output_text") continue;
            for (const annotation of part.annotations) {
                if (annotation.type === "url_citation" && typeof annotation.url === "string") {
                    cited.add(sourceKey(annotation.url));
                }
            }
            for (const link of part.text.matchAll(MARKDOWN_LINK)) {
                const key = sourceKey(link[2]!);
                if (known.has(key)) cited.add(key);
            }
        }
    }
    return cited;
}

/** Unique hosts, first seen first. */
export function hostsOf(sources: readonly Source[]): string[] {
    return [...new Set(sources.map((s) => s.host))];
}

/** Shared source panel. The thread supplies all items so older answers can identify cited links. */
export function SourcesView({
    sources,
    items = [],
    focus,
}: {
    sources: readonly Source[];
    items?: readonly OutputItem[];
    focus?: string;
}) {
    const t = useT();
    const [query, setQuery] = useState("");
    const root = useRef<HTMLDivElement>(null);
    const focusedKey = focus ? sourceKey(focus) : undefined;
    const cited = useMemo(() => citedSourceKeys(items, sources), [items, sources]);
    const unique = useMemo(() => [...sourceMap(sources).values()], [sources]);
    const filtered = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase();
        return unique.filter(
            (source) =>
                !needle ||
                `${sourceTitle(source)} ${source.host} ${source.snippet ?? ""}`.toLocaleLowerCase().includes(needle),
        );
    }, [unique, query]);
    useEffect(() => {
        if (!focusedKey) return;
        setQuery("");
        const frame = requestAnimationFrame(() => {
            const match = [...(root.current?.querySelectorAll<HTMLAnchorElement>("a[data-source-key]") ?? [])].find(
                (anchor) => anchor.dataset.sourceKey === focusedKey,
            );
            match?.scrollIntoView({ block: "nearest" });
            match?.focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(frame);
    }, [focusedKey, unique]);

    const groups = cited.size
        ? [
              {
                  label: t("thread-sources-cited"),
                  sources: filtered.filter((source) => cited.has(sourceKey(source.url))),
              },
              {
                  label: t("thread-sources-other"),
                  sources: filtered.filter((source) => !cited.has(sourceKey(source.url))),
              },
          ]
        : [{ label: t("thread-panel-sources"), sources: filtered }];

    return (
        <div ref={root} className="source-panel">
            {unique.length > 0 && (
                <div className="source-filter">
                    <MagnifyingGlassIcon aria-hidden size={18} />
                    <input
                        type="search"
                        name="source-filter"
                        autoComplete="off"
                        aria-label={t("thread-sources-filter")}
                        placeholder={t("thread-sources-filter")}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                    {query && (
                        <Button
                            size="sm"
                            uniform
                            aria-label={t("thread-sources-clear-filter")}
                            onClick={() => setQuery("")}
                        >
                            <XIcon />
                        </Button>
                    )}
                </div>
            )}
            {!filtered.length ? (
                <EmptyState
                    size="panel"
                    role="status"
                    icon={GlobeIcon}
                    title={unique.length ? t("thread-sources-no-match") : t("thread-sources-none")}
                    description={unique.length ? t("thread-sources-no-match-hint") : t("thread-sources-none-hint")}
                    action={
                        unique.length ? { label: t("thread-sources-clear"), onClick: () => setQuery("") } : undefined
                    }
                />
            ) : (
                groups
                    .filter((group) => group.sources.length)
                    .map((group) => (
                        <section key={group.label} className="source-group" aria-label={group.label}>
                            {cited.size > 0 && <h3>{group.label}</h3>}
                            <ul>
                                {group.sources.map((source) => (
                                    <li key={sourceKey(source.url)}>
                                        <a
                                            href={source.url}
                                            target="_blank"
                                            rel="noopener noreferrer nofollow"
                                            data-source-key={sourceKey(source.url)}
                                            data-focused={sourceKey(source.url) === focusedKey || undefined}
                                            className="source-card"
                                        >
                                            <span className="source-site">
                                                <Favicon host={source.host} size={16} className="rounded-full" />
                                                <span>{source.host}</span>
                                                <ArrowUpRightIcon aria-hidden size={16} />
                                            </span>
                                            <span className="source-title">{sourceTitle(source)}</span>
                                            {source.snippet && <span className="source-snippet">{source.snippet}</span>}
                                            {source.published && (
                                                <span className="source-date">{source.published}</span>
                                            )}
                                            <span className="sr-only"> {t("thread-sources-new-tab")}</span>
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))
            )}
        </div>
    );
}

// Source lookup for citation chips

const SourcesContext = createContext<ReadonlyMap<string, Source>>(new Map());

/** Make a conversation's sources available to citation chips in its messages. */
export function SourcesProvider({ sources, children }: { sources: readonly Source[]; children: ReactNode }) {
    const map = useMemo(() => sourceMap(sources), [sources]);
    return <SourcesContext.Provider value={map}>{children}</SourcesContext.Provider>;
}

/** Look up a cited URL; unknown URLs get a source built from the URL itself (no title). */
export function useSourceLookup(): { lookup: (url: string) => Source; count: number } {
    const map = useContext(SourcesContext);
    return {
        lookup: (url) => map.get(sourceKey(url)) ?? { url, host: hostOf(url) ?? url },
        count: map.size,
    };
}

const WORDS_OF_ID = /^(?:[0-9a-f-]{8,}|\d+|index|default|home|en|en-us|en-gb|docs?|wiki|html?)$/i;

/** One URL path segment as words: "Global_Objects" -> "Global Objects", "map.html" -> "map". */
function words(segment: string): string {
    let w = segment;
    try {
        w = decodeURIComponent(segment);
    } catch {}
    return w
        .replace(/\.(?:html?|php|aspx?|md)$/i, "")
        .replace(/[-_+]+/g, " ")
        .trim();
}

/**
 * A title for a source: the page title, else a readable title from the URL path (the last meaningful
 * segments, prettified: ".../Global_Objects/Array/map" -> "Array map"), else the domain. Never a citation
 * label or index.
 */
function usefulTitle(title: string | undefined, url: string): string | undefined {
    const value = title?.trim();
    if (!value || /^\[?\d+\]?$/.test(value) || /^source\s*\d*$/i.test(value)) return undefined;
    if (/^https?:\/\//i.test(value) || value === url || value.startsWith("/")) return undefined;
    return value;
}

function sourceMap(sources: readonly Source[]): ReadonlyMap<string, Source> {
    const map = new Map<string, Source>();
    for (const source of sources) {
        if (!hostOf(source.url)) continue;
        const key = sourceKey(source.url);
        const previous = map.get(key);
        map.set(key, previous ? mergeSource(previous, source) : source);
    }
    return map;
}

function mergeSource(previous: Source, source: Source): Source {
    return {
        ...previous,
        title: usefulTitle(previous.title, previous.url) ?? usefulTitle(source.title, source.url),
        snippet: previous.snippet || source.snippet,
        published: previous.published || source.published,
    };
}

export function sourceTitle(s: Source): string {
    const title = usefulTitle(s.title, s.url);
    if (title) return title;
    let path = "";
    try {
        path = new URL(s.url).pathname;
    } catch {}
    const segs = path.split("/").filter((x) => x && !WORDS_OF_ID.test(x));
    if (segs.length) {
        const last = words(segs.at(-1)!);
        // A short or generic last segment reads better with its parent ("Array map", not "map").
        const parent = segs.length > 1 && last.length <= 4 ? words(segs.at(-2)!) : "";
        const title = parent && !/\s/.test(last) ? `${parent} ${last}` : last;
        if (title && /[a-z]/i.test(title)) return title.charAt(0).toUpperCase() + title.slice(1);
    }
    return s.host;
}

/** Site favicon from `https://<host>/favicon.ico`, falling back to a globe if it does not load. */
export const Favicon = memo(function Favicon({
    host,
    size = 16,
    className,
}: {
    host: string;
    size?: number;
    className?: string;
}) {
    // "loading": the globe shows until the image has pixels; "failed": an error, or a 200 with an empty image
    // (some sites answer /favicon.ico with a blank), so a circle is never left empty.
    const [state, setState] = useState<"loading" | "ok" | "failed">("loading");
    const globe = <GlobeIcon size={Math.max(size, 14)} className={cn("shrink-0", className)} />;
    if (state === "failed") return globe;
    return (
        <>
            {state === "loading" && globe}
            <img
                src={`https://${host}/favicon.ico`}
                alt=""
                width={size}
                height={size}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                onLoad={(e) => setState(e.currentTarget.naturalWidth > 1 ? "ok" : "failed")}
                onError={() => setState("failed")}
                className={cn("shrink-0 object-contain", state !== "ok" && "hidden", className)}
                style={{ width: size, height: size }}
            />
        </>
    );
});

/**
 * "Sources" pill for an answer's action row: up to three stacked favicons and a label. Opens the right
 * panel's sources view. Renders nothing when the items found no sources.
 */
export const SourcesButton = memo(function SourcesButton({ items }: { items: readonly OutputItem[] }) {
    const t = useT();
    const [sheet, setSheet] = useState(false);
    const sources = useMemo(() => sourcesOf(items), [items, items.length]);
    const hosts = useMemo(() => hostsOf(sources), [sources]);
    if (!hosts.length) return null;
    return (
        <>
            <button
                type="button"
                className="md-sources-button"
                aria-label={t("thread-sources-button-label", { count: hosts.length })}
                aria-haspopup="dialog"
                onClick={() => setSheet(true)}
            >
                <span className="flex items-center" aria-hidden>
                    {hosts.slice(0, 3).map((h, i) => (
                        <Favicon key={h} host={h} size={16} className={cn("md-sources-favicon", i > 0 && "-ms-1")} />
                    ))}
                </span>
                {t("thread-panel-sources")}
            </button>
            <Sheet open={sheet} onOpenChange={setSheet} title={t("thread-panel-sources")}>
                <SourcesView sources={sources} items={items} />
            </Sheet>
        </>
    );
});
