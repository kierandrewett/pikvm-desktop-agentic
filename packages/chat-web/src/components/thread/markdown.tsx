/**
 * Assistant markdown: react-markdown with GFM, math (remark-math, typeset lazily with KaTeX) and the Chat
 * syntax pass (`markdown/syntax.ts`: alerts, details, citations, image groups, kbd/sub/sup/mark).
 * Typography lives in markdown.css. The design and the citation contract are in docs/spec/markdown-notes.md.
 *
 * Speed:
 * - `Markdown` from react-markdown v10 is a pure, hook-free function, so we call it directly and cache the
 *   resulting element tree by source text. Anything that varies per message (streaming, known sources)
 *   reaches components through context, so cached trees stay valid.
 * - While a message streams, the text is split into top-level blocks and each block is a memoised
 *   component, so a delta re-parses only the last block instead of the whole document.
 * - A finished message is parsed once as a whole (reference links and footnotes need the whole document).
 *   A long finished message without those is rendered block by block instead: the first screenful at once,
 *   the rest in a transition, so React can yield between blocks and reopening never blocks the main thread.
 * - KaTeX, the lightbox and shiki grammars are separate chunks, loaded on first use.
 */
import { ArrowBendLeftUpIcon, CaretRightIcon } from "@pikvm/icons";
import { memo, startTransition, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import renderMarkdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { captureSessionEpoch, isSessionEpochCurrent } from "../../lib/queries";
import { registerSessionReset } from "../../lib/session-reset";
import { Alert, Heading, Table, scrollToAnchor } from "./markdown/blocks";
import { Citation } from "./markdown/citation";
import { CodeBlock, parseFence } from "./markdown/code-block";
import { MdEnv, useCopy } from "./markdown/env";
import { MdImage, safeImageUrl } from "./markdown/image";
import { ExternalLink } from "./markdown/link-card";
import { MathBlock, MathInline } from "./markdown/math";
import {
    hash,
    hastText,
    needsWholeParse,
    prepareText,
    rehypeHeadingIds,
    remarkChat,
    type HastNode,
} from "./markdown/syntax";
import "./markdown.css";

export { CodeBlock } from "./markdown/code-block";
export { useCopy };

const classesOf = (n: HastNode | undefined): string[] => {
    const c = n?.properties?.className;
    return Array.isArray(c) ? c.map(String) : typeof c === "string" ? c.split(" ") : [];
};

const isExternal = (href: string | undefined) => {
    if (!href || !/^https?:\/\//i.test(href)) return false;
    try {
        return new URL(href).origin !== location.origin;
    } catch {
        return true;
    }
};

const heading =
    (as: "h1" | "h2" | "h3" | "h4" | "h5" | "h6"): Components["h1"] =>
    ({ id, children, className }) => {
        // The footnotes label ("References") keeps its own id and styling and gets no anchor.
        if (className?.includes("md-fn-label")) {
            const Tag = as;
            return (
                <Tag id={id} className={className}>
                    {children}
                </Tag>
            );
        }
        return (
            <Heading as={as} id={id}>
                {children}
            </Heading>
        );
    };

const components: Components = {
    pre({ node }) {
        const code = (node as HastNode | undefined)?.children?.find((c) => c.tagName === "code");
        const cls = classesOf(code);
        const text = hastText(code).replace(/\n$/, "");
        if (cls.includes("math-display")) return <MathBlock tex={text} />;
        const raw = cls.find((c) => c.startsWith("language-"))?.slice(9) ?? "";
        const { lang, file } = parseFence(raw, code?.data?.meta);
        return <CodeBlock lang={lang} code={text} file={file} />;
    },
    code({ node, children, className }) {
        if (classesOf(node as HastNode).includes("math-inline")) return <MathInline tex={hastText(node as HastNode)} />;
        return <code className={className}>{children}</code>;
    },
    a({ node, children, href, ...rest }) {
        const n = node as HastNode | undefined;
        const kids = (n?.children ?? []).filter((c) => !(c.type === "text" && !c.value?.trim()));
        if (kids.length === 1 && kids[0]!.tagName === "img") {
            const p = kids[0]!.properties ?? {};
            return <MdImage src={p.src as string} alt={p.alt as string} title={p.title as string} href={href} />;
        }
        if ("data-footnote-backref" in rest) {
            return (
                <a
                    href={href}
                    className="md-fn-back"
                    aria-label={rest["aria-label"] as string}
                    onClick={(e) => href && scrollToAnchor(e, href)}
                >
                    <ArrowBendLeftUpIcon aria-hidden size={14} />
                </a>
            );
        }
        if (href?.startsWith("#")) {
            return (
                <a {...rest} href={href} onClick={(e) => scrollToAnchor(e, href)}>
                    {children}
                </a>
            );
        }
        if (href && isExternal(href)) {
            return (
                <ExternalLink {...rest} href={href}>
                    {children}
                </ExternalLink>
            );
        }
        return (
            <a {...rest} href={href} target="_blank" rel="noopener noreferrer nofollow">
                {children}
            </a>
        );
    },
    img({ src, alt, title }) {
        return <MdImage src={typeof src === "string" ? src : undefined} alt={alt} title={title} />;
    },
    table({ node, children }) {
        return <Table node={node as HastNode}>{children}</Table>;
    },
    span({ node: _node, children, ...rest }) {
        if ("data-cite" in rest) return <Citation data={rest["data-cite"]} />;
        return <span {...rest}>{children}</span>;
    },
    div({ node: _node, children, ...rest }) {
        const alert = rest["data-alert" as keyof typeof rest];
        if (typeof alert === "string") return <Alert kind={alert}>{children}</Alert>;
        const images = rest["data-images" as keyof typeof rest];
        if (images !== undefined) {
            return (
                <div
                    className={Number(images) > 1 ? "md-gallery" : "md-figure"}
                    data-count={Math.min(Number(images), 4)}
                >
                    {children}
                </div>
            );
        }
        return <div {...rest}>{children}</div>;
    },
    input({ node: _node, checked, type }) {
        if (type !== "checkbox") return null;
        return (
            <span
                className="md-task"
                data-checked={checked || undefined}
                role="img"
                aria-label={checked ? "Done" : "Not done"}
            />
        );
    },
    summary({ node: _node, children }) {
        return (
            <summary>
                <CaretRightIcon aria-hidden size={16} className="shrink-0" />
                <span className="min-w-0">{children}</span>
            </summary>
        );
    },
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    h5: heading("h5"),
    h6: heading("h6"),
};

const urlTransform: Options["urlTransform"] = (url, key) =>
    key === "src" ? safeImageUrl(url) : defaultUrlTransform(url);

// remark-gfm with single-tilde strikethrough off, so `~x~` stays available for subscript.
const remarkPlugins: Options["remarkPlugins"] = [
    [remarkGfm, { singleTilde: false }],
    [remarkMath, { singleDollarTextMath: true }],
    remarkChat,
];

function options(text: string, prefix: string, streaming: boolean): Options {
    return {
        children: prepareText(text),
        remarkPlugins,
        rehypePlugins: streaming ? [rehypeStreamWords] : [[rehypeHeadingIds, { prefix }]],
        remarkRehypeOptions: {
            clobberPrefix: `${prefix}fn-`,
            footnoteLabel: "References",
            footnoteLabelTagName: "h2",
            footnoteLabelProperties: { className: ["md-fn-label"] },
            footnoteBackLabel: (i: number) => `Back to reference ${i + 1}`,
        },
        urlTransform,
        components,
    };
}

const MAX_CACHED = 1500;
const rendered = new Map<string, ReactElement>();
registerSessionReset("markdown-parser-cache", () => rendered.clear());

/** Parse finished markdown, cached by text within the current account. */
function parse(text: string, ownerEpoch: number): ReactElement | null {
    if (!isSessionEpochCurrent(ownerEpoch)) return null;
    const hit = rendered.get(text);
    if (hit) {
        // Refresh the LRU position so a long open conversation keeps its own blocks.
        rendered.delete(text);
        rendered.set(text, hit);
        return hit;
    }
    const el = renderMarkdown(options(text, `m${hash(text)}-`, false)) as ReactElement;
    if (!isSessionEpochCurrent(ownerEpoch)) return null;
    rendered.set(text, el);
    if (rendered.size > MAX_CACHED) rendered.delete(rendered.keys().next().value!);
    return el;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST = /^ {0,3}([-*+]|\d{1,9}[.)])\s/;
const MATH_FENCE = /^\s*\$\$\s*$/;

/**
 * Split markdown into top-level blocks at blank lines outside code fences and `$$` math blocks.
 * Conservative: a blank line followed by indented text (list continuation) or by a list item after a list
 * does not split, so each block parses the same way it would inside the whole document.
 */
export function splitBlocks(text: string): string[] {
    const blocks: string[] = [];
    let cur: string[] = [];
    let fence: string | null = null;
    let math = false;
    let detailsDepth = 0;
    let blank = false;
    let firstLine = "";
    for (const line of text.split("\n")) {
        const m = FENCE.exec(line);
        if (fence) {
            cur.push(line);
            if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && line.trim() === m[1]) fence = null;
            continue;
        }
        if (math) {
            cur.push(line);
            if (MATH_FENCE.test(line)) math = false;
            continue;
        }
        if (!line.trim()) {
            if (cur.length) blank = true;
            cur.push(line);
            continue;
        }
        if (blank && detailsDepth === 0 && !/^\s/.test(line) && !(LIST.test(line) && LIST.test(firstLine))) {
            blocks.push(cur.join("\n"));
            cur = [];
        }
        blank = false;
        if (!cur.length) firstLine = line;
        cur.push(line);
        if (m) fence = m[1]!;
        else if (MATH_FENCE.test(line)) math = true;
        else {
            const opens = line.match(/<details(?:\s+open)?\s*>/gi)?.length ?? 0;
            const closes = line.match(/<\/details\s*>/gi)?.length ?? 0;
            detailsDepth = Math.max(0, detailsDepth + opens - closes);
        }
    }
    if (cur.length) blocks.push(cur.join("\n"));
    return blocks;
}

/**
 * Rehype step for streaming blocks: wrap each word in `span.sw` so new words fade in (A.7.5). Spans keep
 * their position as text is appended, so React reuses them and only new words animate.
 */
function rehypeStreamWords() {
    const wrap = (node: HastNode) => {
        if (!node.children || node.tagName === "code" || node.tagName === "pre" || node.properties?.dataCite) return;
        const out: HastNode[] = [];
        for (const c of node.children) {
            if (c.type !== "text") {
                wrap(c);
                out.push(c);
                continue;
            }
            for (const part of (c.value ?? "").split(/(\s+)/)) {
                if (!part) continue;
                if (/^\s+$/.test(part)) out.push({ type: "text", value: part });
                else
                    out.push({
                        type: "element",
                        tagName: "span",
                        properties: { className: ["sw"] },
                        children: [{ type: "text", value: part }],
                    });
            }
        }
        node.children = out;
    };
    return (tree: HastNode) => wrap(tree);
}

const StreamingBlock = memo(function StreamingBlock({
    text,
    index,
    ownerEpoch,
}: {
    text: string;
    index: number;
    ownerEpoch: number;
}) {
    if (!isSessionEpochCurrent(ownerEpoch)) return null;
    // Not cached: the last block changes every frame and would evict finished messages.
    const el = renderMarkdown(options(text, `s${index}-`, true)) as ReactElement;
    return isSessionEpochCurrent(ownerEpoch) ? el : null;
});

const FinishedBlock = memo(function FinishedBlock({ text, ownerEpoch }: { text: string; ownerEpoch: number }) {
    return parse(text, ownerEpoch);
});

/** Characters rendered in the first, synchronous pass of a long finished message. */
const FIRST_PASS_CHARS = 12_000;
/** Messages shorter than this parse as one document. */
const PROGRESSIVE_AT = 24_000;

function Progressive({ text, ownerEpoch }: { text: string; ownerEpoch: number }) {
    const blocks = useMemo(() => splitBlocks(text), [text]);
    const first = useMemo(() => {
        let chars = 0;
        let n = 0;
        while (n < blocks.length && chars < FIRST_PASS_CHARS) chars += blocks[n++]!.length;
        return n;
    }, [blocks]);
    const [limit, setLimit] = useState(first);
    useEffect(() => {
        if (!isSessionEpochCurrent(ownerEpoch) || limit >= blocks.length) return;
        startTransition(() => {
            if (isSessionEpochCurrent(ownerEpoch)) setLimit(blocks.length);
        });
    }, [limit, blocks.length, ownerEpoch]);
    if (!isSessionEpochCurrent(ownerEpoch)) return null;
    return blocks
        .slice(0, Math.max(limit, first))
        .map((b, i) => <FinishedBlock key={i} text={b} ownerEpoch={ownerEpoch} />);
}

/** Markdown body. `streaming` switches to the per-block path. */
export const Markdown = memo(function Markdown({
    text,
    streaming = false,
    className = "md",
    originatingOwnerEpoch,
}: {
    text: string;
    streaming?: boolean;
    className?: string;
    originatingOwnerEpoch?: number;
}) {
    const [ownerEpoch] = useState(() => originatingOwnerEpoch ?? captureSessionEpoch());
    const env = useMemo(() => ({ streaming, ownerEpoch }), [streaming, ownerEpoch]);
    if (
        !isSessionEpochCurrent(ownerEpoch) ||
        (originatingOwnerEpoch !== undefined && originatingOwnerEpoch !== ownerEpoch)
    )
        return null;
    let body: ReactNode;
    if (streaming)
        body = splitBlocks(text).map((b, i) => <StreamingBlock key={i} text={b} index={i} ownerEpoch={ownerEpoch} />);
    else if (text.length >= PROGRESSIVE_AT && !needsWholeParse(text))
        body = <Progressive text={text} ownerEpoch={ownerEpoch} />;
    else body = parse(text, ownerEpoch);
    return (
        <MdEnv.Provider value={env}>
            <div className={streaming ? `${className} md-streaming` : className}>{body}</div>
        </MdEnv.Provider>
    );
});
