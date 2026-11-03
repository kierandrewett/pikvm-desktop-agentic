/**
 * Pure look-up from a file name (and optional MIME type or leading bytes) to an icon look.
 * Order: exact name, name pattern, longest extension (so "a.test.ts" and "a.tar.gz" beat "ts" and "gz"),
 * then MIME type, then sniffed bytes, then a plain fallback. Directory names use `resolveFolder`.
 * No DOM and no React here, so the coverage table script can import it with Bun.
 */
import {
    FALLBACK_LOOK,
    FALLBACK_LOOK_BINARY,
    FALLBACK_LOOK_CODE,
    FOLDERS,
    type FolderRow,
    TYPES,
    type Family,
    type TypeRow,
} from "./data";

export interface FileLook {
    /** Row id ("typescript"), "mime:<type>", "sniff:<kind>" or "fallback". */
    id: string;
    family: Family;
    /** Phosphor file glyph name without the "File" prefix ("Ts"), when the type has a drawn glyph. */
    glyph?: string;
    /** One or two characters drawn on the plain file shape. */
    label?: string;
    /** Which step of the look-up chose this look. */
    via: "name" | "pattern" | "extension" | "mime" | "sniff" | "fallback";
}

/** A folder row without its name list. `glyph` is empty for an ordinary folder. */
export type FolderLook = Omit<FolderRow, "names">;

const parseLook = (look: string): Pick<FileLook, "family" | "glyph" | "label"> => {
    const glyph = look.indexOf(":");
    if (glyph > 0) return { family: look.slice(0, glyph) as Family, glyph: look.slice(glyph + 1) };
    const label = look.indexOf("=");
    return { family: look.slice(0, label) as Family, label: look.slice(label + 1) };
};

const tokens = (s: string | undefined) => (s ? s.split(/\s+/).filter(Boolean) : []);

interface Index {
    byName: Map<string, TypeRow>;
    byExt: Map<string, TypeRow>;
    patterns: [RegExp, TypeRow][];
    maxDots: number;
}

let index: Index | undefined;
const build = (): Index => {
    const byName = new Map<string, TypeRow>();
    const byExt = new Map<string, TypeRow>();
    const patterns: [RegExp, TypeRow][] = [];
    let maxDots = 1;
    for (const row of TYPES) {
        for (const n of tokens(row.names)) if (!byName.has(n)) byName.set(n, row);
        for (const e of tokens(row.ext)) {
            if (!byExt.has(e)) byExt.set(e, row);
            maxDots = Math.max(maxDots, e.split(".").length);
        }
        for (const rx of row.rx ?? []) patterns.push([rx, row]);
    }
    return { byName, byExt, patterns, maxDots };
};

const look = (row: TypeRow, via: FileLook["via"]): FileLook => ({ id: row.id, via, ...parseLook(row.look) });
const plain = (lookStr: string, id: string, via: FileLook["via"]): FileLook => ({ id, via, ...parseLook(lookStr) });

/** MIME types for files with no useful extension (uploads keep a type, workspace entries do not). */
const MIME: [RegExp, string][] = [
    [/^application\/pdf$/i, "pdf"],
    [/^image\/svg\+xml$/i, "svg"],
    [/^image\/png$/i, "png"],
    [/^image\/jpeg$/i, "jpeg"],
    [/^image\//i, "image"],
    [/^audio\//i, "audio"],
    [/^video\//i, "video"],
    [/^font\//i, "font"],
    [/^text\/html$/i, "html"],
    [/^text\/css$/i, "css"],
    [/^text\/(csv|tab-separated-values)$/i, "csv"],
    [/^text\/(markdown|x-markdown)$/i, "markdown"],
    [/^application\/(json|ld\+json|x-ndjson)$/i, "json"],
    [/^application\/(x-)?ya?ml$|^text\/(x-)?yaml$/i, "yaml"],
    [/^application\/(xml|xhtml\+xml)$|^text\/xml$/i, "xml"],
    [/^application\/(javascript|x-javascript|ecmascript)$|^text\/javascript$/i, "javascript"],
    [/^application\/typescript$|^text\/typescript$/i, "typescript"],
    [/^application\/x-sh$|^text\/x-shellscript$/i, "shell"],
    [/^application\/sql$/i, "sql"],
    [/^application\/(zip|x-zip-compressed|java-archive)$/i, "zip"],
    [/^application\/(gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|vnd\.rar|x-bzip2|x-xz|zstd)$/i, "archive"],
    [/^application\/vnd\.openxmlformats-officedocument\.wordprocessingml/i, "word"],
    [/^application\/vnd\.openxmlformats-officedocument\.spreadsheetml/i, "sheet"],
    [/^application\/vnd\.openxmlformats-officedocument\.presentationml/i, "slides"],
    [/^application\/(msword)$/i, "word"],
    [/^application\/vnd\.ms-excel$/i, "sheet"],
    [/^application\/vnd\.ms-powerpoint$/i, "slides"],
    [/^application\/wasm$/i, "wasm"],
    [/^text\/plain$/i, "text"],
];
const GENERIC_MIME = /^(application\/(octet-stream|x-download|binary|unknown)|binary\/octet-stream)$/i;

const byId = (id: string): TypeRow | undefined => TYPES.find((r) => r.id === id);

/** Sniff the first bytes (or the first text) of a file. Returns a row id, or undefined. */
export function sniff(head: Uint8Array | string): string | undefined {
    const b = typeof head === "string" ? new TextEncoder().encode(head.slice(0, 64)) : head;
    const starts = (s: string) => s.split("").every((c, i) => b[i] === c.charCodeAt(0));
    if (starts("%PDF")) return "pdf";
    if (b[0] === 0x89 && starts("\x89PNG")) return "png";
    if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
    if (starts("GIF8") || (starts("RIFF") && b[8] === 0x57)) return "image";
    if (starts("PK\x03\x04")) return "zip";
    if (b[0] === 0x1f && b[1] === 0x8b) return "archive";
    if (starts("\x7fELF")) return "executable";
    if (starts("\0asm")) return "wasm";
    if (starts("SQLite format 3")) return "database";
    if (starts("<svg") || starts("<?xml")) return starts("<svg") ? "svg" : "xml";
    if (starts("<!DOCTYPE html") || starts("<html")) return "html";
    if (starts("#!")) {
        const line = new TextDecoder().decode(b.slice(0, 64)).split("\n")[0] ?? "";
        if (/python/.test(line)) return "python";
        if (/node|bun|deno/.test(line)) return "javascript";
        if (/ruby/.test(line)) return "ruby";
        if (/perl/.test(line)) return "perl";
        return "shell";
    }
    return undefined;
}

export interface ResolveInput {
    name: string;
    mime?: string;
    /** Leading bytes or text. Only read when the name and MIME type say nothing. */
    head?: Uint8Array | string;
}

export function resolveFile({ name, mime, head }: ResolveInput): FileLook {
    const ix = (index ??= build());
    const base = (name.split("/").pop() ?? name).toLowerCase();

    const exact = ix.byName.get(base);
    if (exact) return look(exact, "name");
    for (const [rx, row] of ix.patterns) if (rx.test(base)) return look(row, "pattern");

    // Longest suffix first: "a.test.ts" -> "test.ts", then "ts". A leading dot is part of the name, not a suffix.
    const parts = base.replace(/^\./, "").split(".");
    for (let take = Math.min(ix.maxDots, parts.length - 1); take >= 1; take--) {
        const row = ix.byExt.get(parts.slice(parts.length - take).join("."));
        if (row) return look(row, "extension");
    }

    if (mime && !GENERIC_MIME.test(mime)) {
        for (const [rx, id] of MIME) {
            const row = rx.test(mime) ? byId(id) : undefined;
            if (row) return { ...look(row, "mime"), id: row.id };
        }
    }
    if (head) {
        const id = sniff(head);
        const row = id ? byId(id) : undefined;
        if (row) return look(row, "sniff");
    }
    if (!base.includes(".")) return plain(FALLBACK_LOOK_CODE, "fallback", "fallback");
    return plain(mime && GENERIC_MIME.test(mime) ? FALLBACK_LOOK_BINARY : FALLBACK_LOOK, "fallback", "fallback");
}

let folderIndex: Map<string, (typeof FOLDERS)[number]> | undefined;

export function resolveFolder(name: string): FolderLook {
    folderIndex ??= new Map(FOLDERS.flatMap((f) => tokens(f.names).map((n) => [n, f] as const)));
    const base = (name.split("/").pop() ?? name).toLowerCase();
    const row = folderIndex.get(base);
    return row ? { id: row.id, family: row.family, glyph: row.glyph } : { id: "folder", family: "neutral", glyph: "" };
}
