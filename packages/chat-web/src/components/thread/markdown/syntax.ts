/**
 * Markdown syntax extensions as small, linear tree passes. Each pass walks the tree once and only looks
 * at a node and its direct children, so a streaming block costs the same per character as plain GFM.
 *
 * - `prepareText`        text-level normalisation before parsing (math delimiters, currency dollars)
 * - `remarkChat`         one mdast pass for alerts, details, inline HTML whitelist, ==mark==, ^sup^,
 *                        ~sub~, citation groups and image groups
 * - `rehypeHeadingIds`   stable, prefixed heading ids for anchors
 *
 * Nothing here enables raw HTML. Inline and block HTML outside the whitelist is dropped by the renderer,
 * as before; whitelisted tags become real mdast nodes with a fixed element name and no attributes.
 */

/** The subset of mdast and hast this module reads and writes. */
export interface MdNode {
    type: string;
    value?: string;
    url?: string;
    alt?: string | null;
    title?: string | null;
    lang?: string | null;
    meta?: string | null;
    depth?: number;
    children?: MdNode[];
    data?: { hName?: string; hProperties?: Record<string, unknown> };
}

export interface HastNode {
    type: string;
    tagName?: string;
    value?: string;
    properties?: Record<string, unknown>;
    children?: HastNode[];
    data?: { meta?: string };
}

export function hastText(n: HastNode | undefined): string {
    if (!n) return "";
    if (n.type === "text") return n.value ?? "";
    return (n.children ?? []).map(hastText).join("");
}

function mdText(n: MdNode): string {
    if (n.type === "text" || n.type === "inlineCode") return n.value ?? "";
    if (n.type === "image") return n.alt ?? "";
    return (n.children ?? []).map(mdText).join("");
}

// Text normalisation

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** `$` that starts a currency amount ("$5", "$1,200.50", "$3bn"), not an inline formula. */
const CURRENCY = /(^|[\s(])\$(?=\d[\d,.]*(?:[kKmMbB]n?)?(?:[\s.,;:!?)]|$))/g;
const INLINE_PAREN = /\\\((.+?)\\\)/g;
const INLINE_BRACKET = /\\\[(.+?)\\\]/g;
const DISPLAY_ONE_LINE = /^(\s*)(?:\$\$(.+?)\$\$|\\\[(.+?)\\\])\s*$/;

/** Apply `fn` to the parts of a line outside inline code spans. */
function outsideCode(line: string, fn: (s: string) => string): string {
    if (!line.includes("`")) return fn(line);
    return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 ? part : fn(part)))
        .join("");
}

/**
 * Normalise math delimiters before parsing: `\( x \)` -> `$x$`, `\[ x \]` -> display math, a line that is
 * only `$$ x $$` -> a display block, and currency dollars are escaped so "$5 and $10" stays text. Code
 * fences and inline code are left alone. Pure and line-local, so streaming blocks and whole documents
 * normalise the same way.
 */
export function prepareText(text: string): string {
    if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) return text;
    const out: string[] = [];
    let fence: string | null = null;
    for (const line of text.split("\n")) {
        const m = FENCE.exec(line);
        if (fence) {
            out.push(line);
            if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && line.trim() === m[1]) fence = null;
            continue;
        }
        if (m) {
            fence = m[1]!;
            out.push(line);
            continue;
        }
        const t = line.trim();
        if (t === "\\[" || t === "\\]") {
            out.push(line.replace(t, "$$$$"));
            continue;
        }
        const display = DISPLAY_ONE_LINE.exec(line);
        if (display) {
            const pad = display[1]!;
            out.push(`${pad}$$`, `${pad}${(display[2] ?? display[3]!).trim()}`, `${pad}$$`);
            continue;
        }
        out.push(
            outsideCode(line, (s) =>
                s
                    .replace(INLINE_PAREN, (_, tex: string) => `$${tex.trim()}$`)
                    .replace(INLINE_BRACKET, (all, tex: string) => (/[\\^_=]/.test(tex) ? `$$${tex.trim()}$$` : all))
                    .replace(CURRENCY, "$1\\$"),
            ),
        );
    }
    return out.join("\n");
}

// Helpers

const el = (type: string, hName: string, children: MdNode[], hProperties?: Record<string, unknown>): MdNode => ({
    type,
    children,
    data: { hName, hProperties },
});

const isText = (n: MdNode | undefined): n is MdNode & { value: string } => n?.type === "text";
const isHttp = (url: string | undefined) => !!url && /^https?:\/\//i.test(url);

export function hostOf(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}

// Alerts: > [!NOTE] ... (GFM alert syntax)

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;

function alert(node: MdNode): void {
    if (node.type !== "blockquote") return;
    const first = node.children?.[0];
    const lead = first?.type === "paragraph" ? first.children?.[0] : undefined;
    if (!isText(lead)) return;
    const m = ALERT.exec(lead.value);
    if (!m) return;
    lead.value = lead.value.slice(m[0].length);
    if (!lead.value) first!.children!.shift();
    // A soft break right after the marker would leave an empty first line.
    if (first!.children![0]?.type === "break") first!.children!.shift();
    if (!first!.children!.length) node.children!.shift();
    node.data = { hName: "div", hProperties: { dataAlert: m[1]!.toLowerCase() } };
}

// <details><summary>..</summary> ... </details> from block HTML, without raw HTML.

const DETAILS_OPEN = /^<details(\s+open)?\s*>/i;
const SUMMARY = /<summary>([\s\S]*?)<\/summary>/i;
const DETAILS_CLOSE = /<\/details>\s*$/i;
const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").trim();

function details(parent: MdNode): void {
    const ch = parent.children;
    if (!ch?.some((n) => n.type === "html")) return;
    for (let i = 0; i < ch.length; i++) {
        const open = ch[i]!;
        if (open.type !== "html" || !DETAILS_OPEN.test(open.value ?? "")) continue;
        let summary = SUMMARY.exec(open.value!)?.[1];
        let depth = 1;
        let j = i + 1;
        // The opening block may also hold the close (`<details><summary>x</summary>y</details>`).
        if (DETAILS_CLOSE.test(open.value!)) depth = 0;
        for (; depth > 0 && j < ch.length; j++) {
            const n = ch[j]!;
            if (n.type !== "html") continue;
            if (summary === undefined) summary = SUMMARY.exec(n.value ?? "")?.[1];
            if (DETAILS_OPEN.test(n.value ?? "")) depth++;
            if (DETAILS_CLOSE.test(n.value ?? "")) depth--;
        }
        const inner = ch
            .slice(i + 1, depth === 0 && j > i + 1 ? j - 1 : j)
            .filter((n) => !(n.type === "html" && SUMMARY.test(n.value ?? "") && !DETAILS_OPEN.test(n.value ?? "")));
        details({ type: "root", children: inner });
        const label = stripTags(summary ?? "") || "Details";
        const node = el(
            "mdDetails",
            "details",
            [el("mdSummary", "summary", [{ type: "text", value: label }]), ...inner],
            DETAILS_OPEN.exec(open.value!)?.[1] ? { open: true } : undefined,
        );
        ch.splice(i, j - i, node);
    }
}

// Inline HTML whitelist: <kbd>, <sub>, <sup>, <mark>, <ins>, <u>, <small>, <br>.

const INLINE_TAGS = new Set(["kbd", "sub", "sup", "mark", "ins", "u", "small"]);
const OPEN_TAG = /^<([a-z]+)\s*>$/i;
const CLOSE_TAG = /^<\/([a-z]+)\s*>$/i;
const BR = /^<br\s*\/?>$/i;

function inlineHtml(parent: MdNode): void {
    const ch = parent.children;
    if (!ch?.some((n) => n.type === "html")) return;
    for (let i = 0; i < ch.length; i++) {
        const n = ch[i]!;
        if (n.type !== "html") continue;
        const v = (n.value ?? "").trim();
        if (BR.test(v)) {
            ch[i] = { type: "break" };
            continue;
        }
        const tag = OPEN_TAG.exec(v)?.[1]?.toLowerCase();
        if (!tag || !INLINE_TAGS.has(tag)) continue;
        const end = ch.findIndex(
            (c, k) => k > i && c.type === "html" && CLOSE_TAG.exec((c.value ?? "").trim())?.[1]?.toLowerCase() === tag,
        );
        if (end < 0) continue;
        ch.splice(i, end - i + 1, el("mdInline", tag, ch.slice(i + 1, end)));
    }
}

// ==mark==, ^sup^, ~sub~ inside text nodes. Single-tilde strikethrough is off (remark-gfm singleTilde),
// so `~x~` reaches us as text.

const SPANS = /==([^=\s](?:[^=]*?[^=\s])?)==|\^([^\s^]+)\^|~([^\s~]+)~/g;

function inlineSpans(parent: MdNode): void {
    const ch = parent.children;
    if (!ch || parent.type === "link" || parent.type === "linkReference") return;
    for (let i = 0; i < ch.length; i++) {
        const n = ch[i]!;
        if (!isText(n) || !/==|\^|~/.test(n.value)) continue;
        const parts: MdNode[] = [];
        let last = 0;
        for (const m of n.value.matchAll(SPANS)) {
            if (m.index! > last) parts.push({ type: "text", value: n.value.slice(last, m.index) });
            const [tag, inner] =
                m[1] !== undefined ? ["mark", m[1]] : m[2] !== undefined ? ["sup", m[2]] : ["sub", m[3]!];
            parts.push(el("mdInline", tag, [{ type: "text", value: inner }]));
            last = m.index! + m[0].length;
        }
        if (!parts.length) continue;
        if (last < n.value.length) parts.push({ type: "text", value: n.value.slice(last) });
        ch.splice(i, 1, ...parts);
        i += parts.length - 1;
    }
}

// Citations: `([nodejs.org](https://...))`, `[github.com](https://...)`, `[1](https://...)` and groups
// of these separated by commas become one inline citation with every URL.

export interface CiteRef {
    url: string;
    label: string;
}

const CITE_SEP = /^[\s,;]*$/;
const PAREN_BEFORE = /\(\s*$/;
const PAREN_AFTER = /^\s*\)/;

function citeLabel(link: MdNode): boolean {
    const host = hostOf(link.url ?? "");
    if (!host) return false;
    const label = mdText(link)
        .toLowerCase()
        .replace(/^[[(\s]+|[\])\s]+$/g, "")
        .replace(/^www\./, "");
    if (!label) return false;
    if (/^\d{1,3}$/.test(label) || /^source\s*\d*$/.test(label)) return true;
    return label === host || host.endsWith(`.${label}`) || label.endsWith(`.${host}`);
}

function citations(parent: MdNode): void {
    const ch = parent.children;
    if (!ch || parent.type === "link" || !ch.some((n) => n.type === "link")) return;
    for (let i = 0; i < ch.length; i++) {
        const first = ch[i]!;
        if (first.type !== "link" || !isHttp(first.url)) continue;
        const run = [i];
        let j = i;
        while (true) {
            const a = ch[j + 1];
            if (a?.type === "link" && isHttp(a.url)) {
                run.push(++j);
                continue;
            }
            const b = ch[j + 2];
            if (isText(a) && CITE_SEP.test(a.value) && b?.type === "link" && isHttp(b.url)) {
                j += 2;
                run.push(j);
                continue;
            }
            break;
        }
        const before = ch[i - 1];
        const after = ch[j + 1];
        const paren =
            isText(before) && PAREN_BEFORE.test(before.value) && isText(after) && PAREN_AFTER.test(after.value);
        if (!paren && !run.every((k) => citeLabel(ch[k]!))) {
            i = j;
            continue;
        }
        const refs: CiteRef[] = run.map((k) => ({ url: ch[k]!.url!, label: mdText(ch[k]!).trim() }));
        if (paren) {
            before.value = before.value.replace(PAREN_BEFORE, "");
            after.value = after.value.replace(PAREN_AFTER, "");
            if (before.value && !/\s$/.test(before.value)) before.value += " ";
        }
        const node = el("mdCite", "span", [{ type: "text", value: refs.map((r) => r.label).join(", ") }], {
            dataCite: JSON.stringify(refs),
        });
        ch.splice(i, j - i + 1, node);
    }
}

// Image groups: a paragraph that holds only images (optionally linked) becomes a figure or a gallery.

function imageGroup(node: MdNode): void {
    if (node.type !== "paragraph" || !node.children?.length) return;
    let count = 0;
    for (const c of node.children) {
        if (c.type === "image" || (c.type === "link" && c.children?.length === 1 && c.children[0]!.type === "image"))
            count++;
        else if (!(c.type === "break" || (isText(c) && !c.value.trim()))) return;
    }
    if (!count) return;
    node.children = node.children.filter((c) => c.type === "image" || c.type === "link");
    node.data = { hName: "div", hProperties: { dataImages: count } };
}

/** One pass over the tree for every Chat syntax extension. */
export function remarkChat() {
    const walk = (node: MdNode) => {
        if (node.type === "code" || node.type === "inlineCode" || node.type === "math" || node.type === "inlineMath")
            return;
        if (node.children) {
            details(node);
            inlineHtml(node);
            citations(node);
            inlineSpans(node);
            for (const c of node.children) walk(c);
        }
        alert(node);
        imageGroup(node);
    };
    return (tree: MdNode) => walk(tree);
}

// Heading ids

export function slug(text: string): string {
    return (
        text
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 64) || "section"
    );
}

/** Give h1-h6 a stable id `<prefix>h-<slug>` (deduplicated), so anchors survive re-renders. */
export function rehypeHeadingIds(options: { prefix: string }) {
    return (tree: HastNode) => {
        const seen = new Map<string, number>();
        const walk = (n: HastNode) => {
            if (n.type === "element" && /^h[1-6]$/.test(n.tagName ?? "") && !n.properties?.id) {
                const base = slug(hastText(n));
                const k = seen.get(base) ?? 0;
                seen.set(base, k + 1);
                n.properties = { ...n.properties, id: `${options.prefix}h-${base}${k ? `-${k}` : ""}` };
                return;
            }
            for (const c of n.children ?? []) walk(c);
        };
        walk(tree);
    };
}

/** Short stable hash (FNV-1a) used to prefix ids per message. */
export function hash(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

/** Does the text use link reference definitions or footnotes (which need whole-document parsing)? */
export const needsWholeParse = (text: string) => /^ {0,3}\[[^\]\n]+\]:/m.test(text);
