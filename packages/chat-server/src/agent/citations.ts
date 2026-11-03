/**
 * Web sources and citations.
 *
 * Contract: docs/spec/agent-activity-server.md, "Sources and citations".
 * - Sources come only from structured tool results: `web_search` (`details.response.sources`) and `read`
 *   on a URL (`details.kind === "url"`). They are attached to the tool's `function_call_output` item as
 *   `sources`, so clients never parse tool text for them.
 * - The model cites with ordinary markdown links to a source URL, as `([domain](url))` after the claim.
 *   The instruction below asks for that form. Clients render such links as citation chips.
 * - For API clients, each markdown link in the final text whose URL matches a source of the same
 *   response gets a Responses `url_citation` annotation covering the link's markdown span.
 */
import type { SourceRef, UrlCitation } from "@pikvm/chat-protocol";

/** Appended to the agent system prompt so citations use one fixed, parseable form. */
export const CITATION_INSTRUCTIONS = [
    "When an answer uses information from web search results or fetched pages, cite each claim inline with a",
    "markdown link to the exact source URL, wrapped in parentheses after the sentence, with the site's domain",
    "as the link text: `The release shipped in May ([nodejs.org](https://nodejs.org/en/blog/release/v24.0.0)).`",
    "Cite several sources for one claim as `([a.com](https://a.com/x), [b.org](https://b.org/y))`.",
    "Use plain ASCII parentheses and brackets for citations, never full-width or other look-alike characters,",
    "and never a placeholder symbol in place of a citation.",
    "Only cite URLs that appeared in tool results. Do not add a separate list of sources at the end.",
].join(" ");

interface ToolResult {
    content?: { type: string; text?: string }[];
    details?: unknown;
}

const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);

/** Canonical form for matching: no fragment, no trailing slash. */
export function sourceKey(url: string): string {
    return url.replace(/#.*$/, "").replace(/\/+$/, "");
}

function textOf(r: ToolResult): string {
    return (r.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
}

/** Sources in one tool result, or undefined when the tool is not a web tool or found none. */
export function sourcesFromResult(toolName: string | undefined, result: unknown): SourceRef[] | undefined {
    const r = (result ?? {}) as ToolResult;
    const d = r.details as Record<string, unknown> | undefined;
    if (!d || typeof d !== "object") return undefined;
    const out: SourceRef[] = [];
    if (toolName === "web_search") {
        const list = (d.response as { sources?: unknown } | undefined)?.sources;
        if (!Array.isArray(list)) return undefined;
        for (const s of list as Record<string, unknown>[]) {
            if (!isHttp(s.url)) continue;
            const title = typeof s.title === "string" && s.title !== s.url ? s.title.trim() : undefined;
            out.push({
                url: s.url,
                title: title || undefined,
                snippet: typeof s.snippet === "string" ? s.snippet.trim().slice(0, 400) || undefined : undefined,
                published: typeof s.publishedDate === "string" ? s.publishedDate : undefined,
            });
        }
    } else if (d.kind === "url") {
        const url = isHttp(d.finalUrl) ? d.finalUrl : isHttp(d.url) ? d.url : undefined;
        if (!url) return undefined;
        const title = /^#\s+(.+)$/m.exec(textOf(r))?.[1]?.trim();
        out.push({ url, title: title?.slice(0, 200) });
    }
    return out.length ? out : undefined;
}

const LINK = /\[((?:[^\][]|\[[^\]]*\])*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g;

/** `url_citation` annotations for markdown links in `text` that point at a known source. */
export function citationsFor(text: string, sources: ReadonlyMap<string, SourceRef>): UrlCitation[] {
    if (!sources.size || !text.includes("](http")) return [];
    const out: UrlCitation[] = [];
    for (const m of text.matchAll(LINK)) {
        const src = sources.get(sourceKey(m[2]!));
        if (!src) continue;
        let host = src.url;
        try {
            host = new URL(src.url).hostname.replace(/^www\./, "");
        } catch {}
        out.push({
            type: "url_citation",
            start_index: m.index!,
            end_index: m.index! + m[0].length,
            url: m[2]!,
            title: src.title ?? host,
        });
    }
    return out;
}

/** Preserve the first metadata value, but fill gaps when a later fetch resolves the same URL. */
export function rememberSources(map: Map<string, SourceRef>, list: SourceRef[] | undefined): void {
    for (const source of list ?? []) {
        const key = sourceKey(source.url);
        const previous = map.get(key);
        map.set(
            key,
            previous
                ? {
                      ...previous,
                      title: previous.title || source.title,
                      snippet: previous.snippet || source.snippet,
                      published: previous.published || source.published,
                  }
                : source,
        );
    }
}
