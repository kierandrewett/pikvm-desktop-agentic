/**
 * Lazy syntax highlighting. Shiki loads on the first code block that asks for it (dynamic import, so
 * it never touches the initial bundle), uses the JavaScript regex engine (no WASM download) and loads
 * each grammar on demand. Output carries both themes as CSS variables (`--shiki-light` /
 * `--shiki-dark`); markdown.css picks one from the active theme, so a theme switch needs no re-highlight.
 *
 * Results are cached by (language, code) so a re-mounted block (live -> history swap, reopening a
 * conversation) paints highlighted on its first frame.
 */
import type { HighlighterGeneric } from "shiki";
import { useEffect, useState } from "react";
import { isSessionEpochCurrent } from "../../lib/queries";
import { registerSessionReset } from "../../lib/session-reset";
import { languageAlias } from "../render/detect";
import { schedule } from "./markdown/env";

// Highlighter type parameters are the bundled language and theme unions; we only pass strings we
// have checked against `bundledLanguages`, so the loose type is safe here.
type Highlighter = HighlighterGeneric<string, string>;

const THEMES = { light: "github-light", dark: "github-dark" } as const;
const MAX_CACHED = 400;

let highlighter: Promise<Highlighter> | undefined;
let known: Record<string, unknown> | undefined;
const loadedLangs = new Set<string>();
const cache = new Map<string, string>();
registerSessionReset("markdown-highlight-cache", () => cache.clear());

function load(): Promise<Highlighter> {
    highlighter ??= import("shiki").then(async (s) => {
        known = s.bundledLanguages;
        const h = await s.createHighlighter({
            themes: [THEMES.light, THEMES.dark],
            langs: [],
            engine: s.createJavaScriptRegexEngine({ forgiving: true }),
        });
        return h as unknown as Highlighter;
    });
    return highlighter;
}

const key = (lang: string, code: string) => `${lang}\u0000${code}`;

/** Cached highlighted inner HTML of the `<code>` element, if this block was highlighted before. */
export function cachedHighlight(lang: string, code: string, ownerEpoch: number): string | undefined {
    if (!isSessionEpochCurrent(ownerEpoch)) return undefined;
    return cache.get(key(lang, code));
}

/**
 * Highlight `code` and resolve with the inner HTML of shiki's `<code>` element (one `span.line` per
 * line). Resolves undefined for unknown languages, which stay plain text.
 */
export async function highlight(lang: string, code: string, ownerEpoch: number): Promise<string | undefined> {
    if (!isSessionEpochCurrent(ownerEpoch)) return undefined;
    const k = key(lang, code);
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    const h = await load();
    if (!isSessionEpochCurrent(ownerEpoch)) return undefined;
    // A fence may name an extension or a file ("conf", "service") rather than a shiki id.
    const asked = lang.toLowerCase();
    const id = known && !(asked in known) ? languageAlias(asked) : asked;
    if (!id || !known || !(id in known)) return undefined;
    if (!loadedLangs.has(id)) {
        try {
            await h.loadLanguage(id);
            loadedLangs.add(id);
        } catch {
            return undefined;
        }
    }
    // Each block tokenises in its own task slot (markdown/env.ts schedule), so a message with many code
    // blocks does not highlight them all in one long task.
    if (!isSessionEpochCurrent(ownerEpoch)) return undefined;
    const outcome = await schedule(() => {
        const html = h.codeToHtml(code, { lang: id, themes: THEMES, defaultColor: false });
        return html.match(/<code[^>]*>([\s\S]*)<\/code>/)?.[1] ?? "";
    }, ownerEpoch);
    if (outcome.status === "cancelled" || !isSessionEpochCurrent(ownerEpoch)) return undefined;
    const inner = outcome.value;
    cache.set(k, inner);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
    return inner;
}

/**
 * React side of `highlight`: the highlighted inner HTML of `code`, or undefined while it is not ready, for an
 * unknown language and when `enabled` is false. A block highlighted before paints from the cache on its first
 * frame. `delayMs` debounces a block that still streams. Every step checks the owner's session epoch, so a
 * result never lands after the session changes. Chat code blocks, commands in the activity and approval
 * requests use it; the file renderer's CodeView keeps its own line-aligned variant (render/renderers/code-view.tsx).
 */
export function useHighlight(
    lang: string,
    code: string,
    { ownerEpoch, enabled = true, delayMs = 0 }: { ownerEpoch: number; enabled?: boolean; delayMs?: number },
): string | undefined {
    const [result, setResult] = useState(() => ({
        lang,
        code,
        html: enabled ? cachedHighlight(lang, code, ownerEpoch) : undefined,
    }));
    useEffect(() => {
        if (!enabled || !isSessionEpochCurrent(ownerEpoch)) return;
        const hit = cachedHighlight(lang, code, ownerEpoch);
        if (hit !== undefined) {
            setResult({ lang, code, html: hit });
            return;
        }
        if (!lang) {
            setResult({ lang, code, html: undefined });
            return;
        }
        let alive = true;
        const run = () => {
            if (!alive || !isSessionEpochCurrent(ownerEpoch)) return;
            void highlight(lang, code, ownerEpoch)
                .then((html) => {
                    if (alive && isSessionEpochCurrent(ownerEpoch)) setResult({ lang, code, html });
                })
                .catch(() => {
                    if (alive && isSessionEpochCurrent(ownerEpoch)) setResult({ lang, code, html: undefined });
                });
        };
        const timer = delayMs > 0 ? setTimeout(run, delayMs) : undefined;
        if (!timer) run();
        return () => {
            alive = false;
            clearTimeout(timer);
        };
    }, [lang, code, enabled, ownerEpoch, delayMs]);
    return enabled && isSessionEpochCurrent(ownerEpoch) && result.lang === lang && result.code === code
        ? result.html
        : undefined;
}
