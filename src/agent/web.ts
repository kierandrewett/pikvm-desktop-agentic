/**
 * Keyless web access for the agent: DuckDuckGo search + readable page fetch.
 * No API key required (best-effort HTML scrape); falls back gracefully.
 */

import axios from "axios";

const UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}

function decode(s: string): string {
    return s
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .trim();
}

function unwrap(href: string): string {
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    return uddg ? decodeURIComponent(uddg[1]!) : href.startsWith("//") ? "https:" + href : href;
}

async function ddgPost(url: string, query: string): Promise<string> {
    const res = await axios.post(url, new URLSearchParams({ q: query }).toString(), {
        headers: {
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "text/html,application/xhtml+xml",
            Referer: "https://duckduckgo.com/",
            "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: 12_000,
    });
    return String(res.data);
}

/** DuckDuckGo Instant Answer API — keyless JSON, reliable fallback. */
async function ddgInstantAnswer(query: string, limit: number): Promise<SearchResult[]> {
    const { data } = await axios.get("https://api.duckduckgo.com/", {
        params: { q: query, format: "json", no_html: 1, no_redirect: 1, t: "pikvm-agent" },
        headers: { "User-Agent": UA },
        timeout: 12_000,
    });
    const out: SearchResult[] = [];
    if (data.AbstractText && data.AbstractURL)
        out.push({ title: data.Heading || query, url: data.AbstractURL, snippet: data.AbstractText });
    const visit = (topics: any[]) => {
        for (const t of topics ?? []) {
            if (out.length >= limit) return;
            if (t.Text && t.FirstURL) out.push({ title: t.Text.split(" - ")[0]!.slice(0, 80), url: t.FirstURL, snippet: t.Text });
            else if (t.Topics) visit(t.Topics);
        }
    };
    visit(data.RelatedTopics);
    return out;
}

export async function webSearch(query: string, limit = 6): Promise<SearchResult[]> {
    // 1. Try the scrape endpoints (full web results) — best on residential IPs.
    let html = "";
    try {
        try {
            html = await ddgPost("https://lite.duckduckgo.com/lite/", query);
        } catch {
            html = await ddgPost("https://html.duckduckgo.com/html/", query);
        }
    } catch {
        // 2. Scrape blocked → keyless Instant Answer API.
        try {
            const ia = await ddgInstantAnswer(query, limit);
            if (ia.length) return ia;
        } catch {
            /* give up */
        }
        return [];
    }
    const out: SearchResult[] = [];

    // Lite layout: result-link anchors, then result-snippet cells (document order).
    const links: { url: string; title: string }[] = [];
    const linkRe = /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(html))) links.push({ url: unwrap(lm[1]!), title: decode(lm[2]!) });

    const snippets: string[] = [];
    const snipRe = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
    let sm: RegExpExecArray | null;
    while ((sm = snipRe.exec(html))) snippets.push(decode(sm[1]!));

    for (let i = 0; i < links.length && out.length < limit; i++) {
        out.push({ title: links[i]!.title, url: links[i]!.url, snippet: snippets[i] ?? "" });
    }

    // Fallback: classic html layout (result__a / result__snippet).
    if (out.length === 0) {
        const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) && out.length < limit) {
            out.push({ title: decode(m[2]!), url: unwrap(m[1]!), snippet: decode(m[3]!) });
        }
    }
    // Still nothing parseable → Instant Answer API.
    if (out.length === 0) {
        try {
            return await ddgInstantAnswer(query, limit);
        } catch {
            /* give up */
        }
    }
    return out;
}

/** Fetch a URL and return readable plain text (scripts/styles stripped, truncated). */
export async function fetchUrl(url: string, maxChars = 6000): Promise<string> {
    const res = await axios.get(url, {
        headers: { "User-Agent": UA },
        timeout: 15_000,
        maxContentLength: 5_000_000,
        responseType: "text",
    });
    let html = String(res.data);
    html = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ");
    const text = decode(html).replace(/\s+/g, " ").trim();
    return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}
