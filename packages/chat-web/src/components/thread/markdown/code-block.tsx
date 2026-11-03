/**
 * Code block (web notes A.7.6): 24px card, sticky 48px header with the language or file name, word wrap
 * toggle and Copy. Plain text paints at once; shiki highlighting arrives when ready and is debounced
 * while the block still streams. `diff` and `patch` blocks colour added, removed and hunk lines from the
 * diff tokens instead of a grammar. Long finished blocks start collapsed with a "Show more" footer.
 */
import { CaretDownIcon, CodeIcon } from "@pikvm/icons";
import { memo, useContext, useState } from "react";
import { cn } from "../../../lib/cn";
import { captureSessionEpoch } from "../../../lib/queries";
import { FileTypeIcon } from "../../file-icons/file-type-icon";
import { TextTools } from "../../render/text-tools";
import { ToolScope } from "../../render/toolbar";
import { useHighlight } from "../highlight";
import { MdEnv } from "./env";

/** Lines above which a finished block starts collapsed, and the lines it shows when collapsed. */
const COLLAPSE_AT = 40;
const COLLAPSED_LINES = 24;

const LANG_NAMES: Record<string, string> = {
    bash: "Bash",
    sh: "Shell",
    shell: "Shell",
    zsh: "Zsh",
    console: "Console",
    powershell: "PowerShell",
    ps1: "PowerShell",
    js: "JavaScript",
    javascript: "JavaScript",
    jsx: "JSX",
    mjs: "JavaScript",
    ts: "TypeScript",
    typescript: "TypeScript",
    tsx: "TSX",
    py: "Python",
    python: "Python",
    rb: "Ruby",
    rs: "Rust",
    rust: "Rust",
    go: "Go",
    java: "Java",
    kt: "Kotlin",
    swift: "Swift",
    c: "C",
    cpp: "C++",
    "c++": "C++",
    cs: "C#",
    csharp: "C#",
    php: "PHP",
    sql: "SQL",
    html: "HTML",
    css: "CSS",
    scss: "SCSS",
    json: "JSON",
    jsonc: "JSONC",
    yaml: "YAML",
    yml: "YAML",
    toml: "TOML",
    xml: "XML",
    md: "Markdown",
    markdown: "Markdown",
    diff: "Diff",
    patch: "Diff",
    dockerfile: "Dockerfile",
    nix: "Nix",
    lua: "Lua",
    graphql: "GraphQL",
    text: "Plain text",
    txt: "Plain text",
    plaintext: "Plain text",
};

export function languageName(lang: string): string {
    return LANG_NAMES[lang.toLowerCase()] ?? lang;
}

/**
 * Language and file name from a fence info string. Accepts ```ts title="src/a.ts"```, ```ts filename=a.ts```,
 * ```ts:src/a.ts``` and ```ts src/a.ts``` (a bare path-like word after the language).
 */
export function parseFence(rawLang: string, meta: string | undefined): { lang: string; file?: string } {
    let lang = rawLang;
    let file: string | undefined;
    const colon = lang.indexOf(":");
    if (colon > 0) {
        file = lang.slice(colon + 1);
        lang = lang.slice(0, colon);
    }
    if (meta) {
        const named = /\b(?:title|file|filename|name)=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(meta);
        if (named) file = named[1] ?? named[2] ?? named[3];
        else if (/^[\w./-]+\.\w+$/.test(meta.trim())) file = meta.trim();
    }
    return { lang, file };
}

function DiffLines({ code }: { code: string }) {
    return code.split("\n").map((line, i) => {
        const kind = line.startsWith("@@")
            ? "hunk"
            : line.startsWith("+++") || line.startsWith("---")
              ? "file"
              : line.startsWith("+")
                ? "add"
                : line.startsWith("-")
                  ? "del"
                  : undefined;
        return (
            <span key={i} className="md-diff-line" data-diff={kind}>
                {line || " "}
            </span>
        );
    });
}

export const CodeBlock = memo(function CodeBlock({ lang, code, file }: { lang: string; code: string; file?: string }) {
    const env = useContext(MdEnv);
    const { streaming } = env;
    const [ownerEpoch] = useState(() => env.ownerEpoch ?? captureSessionEpoch());
    const isDiff = /^(diff|patch)$/i.test(lang);
    // The same highlighter as the file renderer's code view (thread/highlight.ts), debounced while streaming.
    const html = useHighlight(lang, code, { ownerEpoch, enabled: !isDiff, delayMs: 120 });
    const [wrap, setWrap] = useState(false);
    const lines = code.split("\n").length;
    // Decided once at mount: a block that arrives while streaming never collapses under the reader.
    const [collapsed, setCollapsed] = useState(() => !streaming && lines > COLLAPSE_AT);
    const label = languageName(lang) || "Plain text";

    let shown = code;
    let shownHtml = html;
    if (collapsed) {
        shown = code.split("\n").slice(0, COLLAPSED_LINES).join("\n");
        shownHtml = html?.split("\n").slice(0, COLLAPSED_LINES).join("\n");
    }

    return (
        <div className="md-code">
            <div className="md-code-card">
                <div className="md-code-header">
                    {file ? (
                        <FileTypeIcon name={file} size={20} className="shrink-0" />
                    ) : (
                        <CodeIcon aria-hidden size={20} className="shrink-0" />
                    )}
                    <div className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="truncate">{file ?? label}</span>
                        {file && lang && <span className="md-code-lang shrink-0">{label}</span>}
                    </div>
                    {/* The file renderer's Wrap and Copy controls (render/text-tools.tsx), in header size. */}
                    <div className="flex gap-px">
                        <ToolScope>
                            <TextTools text={code} wrap={wrap} onWrap={setWrap} className="text-text! [--icon:20px]" />
                        </ToolScope>
                    </div>
                </div>
                <div
                    className="md-code-scroll"
                    data-no-drawer-gesture=""
                    data-wrap={wrap}
                    data-collapsed={collapsed || undefined}
                >
                    <pre className={cn("md-pre", isDiff && "md-diff")}>
                        {isDiff ? (
                            <code>
                                <DiffLines code={shown} />
                            </code>
                        ) : shownHtml !== undefined ? (
                            <code dangerouslySetInnerHTML={{ __html: shownHtml }} />
                        ) : (
                            <code>{shown}</code>
                        )}
                    </pre>
                </div>
                {lines > COLLAPSE_AT && !streaming && (
                    <button
                        type="button"
                        className="md-code-more"
                        aria-expanded={!collapsed}
                        onClick={() => setCollapsed(!collapsed)}
                    >
                        <CaretDownIcon aria-hidden size={16} className={cn(!collapsed && "rotate-180")} />
                        {collapsed ? `Show ${lines - COLLAPSED_LINES} more lines` : "Show less"}
                    </button>
                )}
            </div>
        </div>
    );
});
