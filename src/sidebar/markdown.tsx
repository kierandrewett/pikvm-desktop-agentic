/**
 * Tiny dependency-free markdown renderer for the chat. Builds React elements
 * (no dangerouslySetInnerHTML), covering the common chat cases: fenced code with
 * a copy button, headings, lists, blockquotes, inline code/bold/italic/links.
 */

import { Fragment, useState, type ReactNode } from "react";

function openExternal(url: string) {
    (window as any).ui?.send?.("open-external", url);
}

/** Inline spans: bold, italic, inline code, and links. */
function inline(text: string, keyBase: string): ReactNode[] {
    const out: ReactNode[] = [];
    const re = new RegExp(
        "(\\*\\*([^*]+)\\*\\*)|(`([^`]+)`)|(\\*([^*]+)\\*)|(_([^_]+)_)|(\\[([^\\]]+)\\]\\(([^)]+)\\))",
        "g",
    );
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(text))) {
        if (m.index > last) out.push(<Fragment key={`${keyBase}-t${i}`}>{text.slice(last, m.index)}</Fragment>);
        if (m[2]) out.push(<strong key={`${keyBase}-b${i}`}>{m[2]}</strong>);
        else if (m[4]) out.push(<code key={`${keyBase}-c${i}`} className="inline-code">{m[4]}</code>);
        else if (m[6]) out.push(<em key={`${keyBase}-i${i}`}>{m[6]}</em>);
        else if (m[8]) out.push(<em key={`${keyBase}-u${i}`}>{m[8]}</em>);
        else if (m[10])
            out.push(
                <a
                    key={`${keyBase}-l${i}`}
                    href={m[11]}
                    onClick={(e) => {
                        e.preventDefault();
                        openExternal(m![11]!);
                    }}
                >
                    {m[10]}
                </a>,
            );
        last = re.lastIndex;
        i++;
    }
    if (last < text.length) out.push(<Fragment key={`${keyBase}-end`}>{text.slice(last)}</Fragment>);
    return out;
}

const KEYWORDS =
    /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|new|this|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|void|null|undefined|true|false|def|elif|lambda|None|True|False|print|echo|sudo|cd|ls|rm|mkdir|grep|cat|git|npm|yarn|node)\b/g;

/** Very small, language-agnostic highlighter: comments, strings, numbers, keywords. */
function highlight(code: string): ReactNode[] {
    const out: ReactNode[] = [];
    // Split on the things we want to colour, keeping the delimiters.
    const re = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d._]*\b)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    const plain = (s: string) => {
        // Highlight keywords within plain segments.
        const parts: ReactNode[] = [];
        let kl = 0;
        let km: RegExpExecArray | null;
        KEYWORDS.lastIndex = 0;
        let j = 0;
        while ((km = KEYWORDS.exec(s))) {
            if (km.index > kl) parts.push(s.slice(kl, km.index));
            parts.push(
                <span key={`k${i}-${j}`} className="hl-kw">
                    {km[0]}
                </span>,
            );
            kl = KEYWORDS.lastIndex;
            j++;
        }
        if (kl < s.length) parts.push(s.slice(kl));
        return parts;
    };
    while ((m = re.exec(code))) {
        if (m.index > last) out.push(<Fragment key={`p${i}`}>{plain(code.slice(last, m.index))}</Fragment>);
        const cls = m[1] ? "hl-com" : m[2] ? "hl-str" : "hl-num";
        out.push(
            <span key={`s${i}`} className={cls}>
                {m[0]}
            </span>,
        );
        last = re.lastIndex;
        i++;
    }
    if (last < code.length) out.push(<Fragment key="pend">{plain(code.slice(last))}</Fragment>);
    return out;
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        });
    };
    return (
        <div className="codeblock">
            <div className="cb-head">
                <span className="cb-lang">{lang || "text"}</span>
                <button className="cb-copy" onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                </button>
            </div>
            <pre>
                <code>{highlight(code)}</code>
            </pre>
        </div>
    );
}

export function Markdown({ text }: { text: string }) {
    const lines = text.split("\n");
    const blocks: ReactNode[] = [];
    let i = 0;
    let key = 0;

    while (i < lines.length) {
        const line = lines[i]!;

        // Fenced code block
        const fence = line.match(/^```(\w*)/);
        if (fence) {
            const lang = fence[1];
            const buf: string[] = [];
            i++;
            while (i < lines.length && !lines[i]!.startsWith("```")) buf.push(lines[i++]!);
            i++; // closing fence
            blocks.push(<CodeBlock key={key++} code={buf.join("\n")} {...(lang ? { lang } : {})} />);
            continue;
        }

        // Heading
        const h = line.match(/^(#{1,4})\s+(.*)/);
        if (h) {
            const level = h[1]!.length;
            const content = inline(h[2]!, `h${key}`);
            blocks.push(
                level <= 1 ? (
                    <h3 key={key++}>{content}</h3>
                ) : level === 2 ? (
                    <h4 key={key++}>{content}</h4>
                ) : (
                    <h5 key={key++}>{content}</h5>
                ),
            );
            i++;
            continue;
        }

        // Table (| a | b | with a |---|---| separator row)
        if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
            const splitRow = (r: string) =>
                r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
            const header = splitRow(line);
            i += 2;
            const rows: string[][] = [];
            while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
                rows.push(splitRow(lines[i]!));
                i++;
            }
            blocks.push(
                <table key={key++} className="md-table">
                    <thead>
                        <tr>{header.map((c, ci) => <th key={ci}>{inline(c, `th${key}-${ci}`)}</th>)}</tr>
                    </thead>
                    <tbody>
                        {rows.map((r, ri) => (
                            <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c, `td${key}-${ri}-${ci}`)}</td>)}</tr>
                        ))}
                    </tbody>
                </table>,
            );
            continue;
        }

        // List (consecutive - / * / 1. lines)
        if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
            const items: ReactNode[] = [];
            const ordered = /^\s*\d+\.\s+/.test(line);
            while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) {
                const content = lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, "");
                items.push(<li key={items.length}>{inline(content, `li${key}-${items.length}`)}</li>);
                i++;
            }
            blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
            continue;
        }

        // Blockquote
        if (line.startsWith(">")) {
            const buf: string[] = [];
            while (i < lines.length && lines[i]!.startsWith(">")) buf.push(lines[i++]!.replace(/^>\s?/, ""));
            blocks.push(<blockquote key={key++}>{inline(buf.join(" "), `bq${key}`)}</blockquote>);
            continue;
        }

        // Blank line
        if (line.trim() === "") {
            i++;
            continue;
        }

        // Paragraph (gather until blank / block start)
        const buf: string[] = [];
        while (
            i < lines.length &&
            lines[i]!.trim() !== "" &&
            !lines[i]!.startsWith("```") &&
            !/^(#{1,4})\s/.test(lines[i]!) &&
            !/^\s*([-*]|\d+\.)\s+/.test(lines[i]!) &&
            !lines[i]!.startsWith(">")
        ) {
            buf.push(lines[i++]!);
        }
        blocks.push(<p key={key++}>{inline(buf.join(" "), `p${key}`)}</p>);
    }

    return <div className="md">{blocks}</div>;
}
