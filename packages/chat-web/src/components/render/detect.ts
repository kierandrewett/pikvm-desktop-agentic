/**
 * Kind detection: MIME type first, then the extension, then magic bytes when both say nothing useful.
 * Pure functions, no DOM, so hosts can call `detectKind` for icons and labels too.
 */
import { activeLocalization, msg, translate } from "../../l10n/runtime";
import type { RenderKind } from "./types";

const GENERIC_MIME = /^(application\/(octet-stream|x-download|binary|unknown)|binary\/octet-stream)$/i;

const MIME: [RegExp, RenderKind][] = [
    [/^application\/pdf$/i, "pdf"],
    [/^text\/(csv|tab-separated-values)$/i, "sheet"],
    [/^text\/(markdown|x-markdown)$/i, "markdown"],
    [/^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/i, "docx"],
    [/^application\/(json|ld\+json|x-ndjson|jsonl)$/i, "json"],
    [/^image\/svg\+xml$/i, "svg"],
    [/^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|apng)$/i, "image"],
    [/^audio\//i, "audio"],
    [/^video\//i, "video"],
    [/^text\/html$/i, "html"],
    [
        /^application\/(zip|x-zip-compressed|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|vnd\.rar|x-bzip2|x-xz|zstd)$/i,
        "archive",
    ],
    [/^(text\/|application\/(javascript|typescript|xml|x-sh|x-yaml|yaml|toml|sql))/i, "code"],
];

const EXT: Record<string, RenderKind> = {
    pdf: "pdf",
    csv: "sheet",
    tsv: "sheet",
    tab: "sheet",
    md: "markdown",
    markdown: "markdown",
    mdown: "markdown",
    mkd: "markdown",
    docx: "docx",
    json: "json",
    openui: "openui",
    jsonl: "json",
    ndjson: "json",
    geojson: "json",
    webmanifest: "json",
    svg: "svg",
    png: "image",
    jpg: "image",
    jpeg: "image",
    jfif: "image",
    gif: "image",
    webp: "image",
    avif: "image",
    bmp: "image",
    ico: "image",
    apng: "image",
    mp3: "audio",
    wav: "audio",
    ogg: "audio",
    oga: "audio",
    opus: "audio",
    flac: "audio",
    m4a: "audio",
    aac: "audio",
    weba: "audio",
    mp4: "video",
    m4v: "video",
    webm: "video",
    mov: "video",
    ogv: "video",
    mkv: "video",
    html: "html",
    htm: "html",
    xhtml: "html",
    zip: "archive",
    jar: "archive",
    gz: "archive",
    tgz: "archive",
    tar: "archive",
    "7z": "archive",
    rar: "archive",
    bz2: "archive",
    xz: "archive",
    zst: "archive",
    // Office formats we do not render: an info card with a download is the honest answer.
    doc: "binary",
    xls: "binary",
    xlsx: "binary",
    ppt: "binary",
    pptx: "binary",
    odt: "binary",
    ods: "binary",
    exe: "binary",
    dll: "binary",
    so: "binary",
    bin: "binary",
    wasm: "binary",
    sqlite: "binary",
    db: "binary",
    woff: "binary",
    woff2: "binary",
    ttf: "binary",
    otf: "binary",
    heic: "binary",
    psd: "binary",
};

/** Language id (shiki) and human label per extension. An empty id means plain text. */
const LANGS: Record<string, [id: string, label: string]> = {
    ts: ["ts", "TypeScript"],
    tsx: ["tsx", "TSX"],
    mts: ["ts", "TypeScript"],
    cts: ["ts", "TypeScript"],
    js: ["js", "JavaScript"],
    mjs: ["js", "JavaScript"],
    cjs: ["js", "JavaScript"],
    jsx: ["jsx", "JSX"],
    json: ["json", "JSON"],
    jsonl: ["json", "JSON Lines"],
    ndjson: ["json", "JSON Lines"],
    geojson: ["json", "GeoJSON"],
    webmanifest: ["json", "Web manifest"],
    md: ["markdown", "Markdown"],
    markdown: ["markdown", "Markdown"],
    mdx: ["mdx", "MDX"],
    rs: ["rust", "Rust"],
    py: ["python", "Python"],
    pyi: ["python", "Python"],
    rb: ["ruby", "Ruby"],
    go: ["go", "Go"],
    java: ["java", "Java"],
    kt: ["kotlin", "Kotlin"],
    kts: ["kotlin", "Kotlin"],
    scala: ["scala", "Scala"],
    swift: ["swift", "Swift"],
    c: ["c", "C"],
    h: ["c", "C header"],
    cc: ["cpp", "C++"],
    cpp: ["cpp", "C++"],
    hpp: ["cpp", "C++ header"],
    cs: ["csharp", "C#"],
    fs: ["fsharp", "F#"],
    php: ["php", "PHP"],
    sh: ["bash", "Shell"],
    bash: ["bash", "Bash"],
    zsh: ["bash", "Zsh"],
    fish: ["fish", "Fish"],
    ps1: ["powershell", "PowerShell"],
    sql: ["sql", "SQL"],
    lua: ["lua", "Lua"],
    nix: ["nix", "Nix"],
    zig: ["zig", "Zig"],
    dart: ["dart", "Dart"],
    ex: ["elixir", "Elixir"],
    exs: ["elixir", "Elixir"],
    erl: ["erlang", "Erlang"],
    hs: ["haskell", "Haskell"],
    ml: ["ocaml", "OCaml"],
    clj: ["clojure", "Clojure"],
    r: ["r", "R"],
    jl: ["julia", "Julia"],
    pl: ["perl", "Perl"],
    css: ["css", "CSS"],
    scss: ["scss", "SCSS"],
    less: ["less", "Less"],
    html: ["html", "HTML"],
    htm: ["html", "HTML"],
    xhtml: ["html", "XHTML"],
    xml: ["xml", "XML"],
    svg: ["xml", "SVG"],
    yaml: ["yaml", "YAML"],
    yml: ["yaml", "YAML"],
    toml: ["toml", "TOML"],
    ini: ["ini", "INI"],
    cfg: ["ini", "Config"],
    conf: ["ini", "Config"],
    env: ["dotenv", "Environment"],
    vue: ["vue", "Vue"],
    svelte: ["svelte", "Svelte"],
    astro: ["astro", "Astro"],
    graphql: ["graphql", "GraphQL"],
    gql: ["graphql", "GraphQL"],
    proto: ["proto", "Protocol Buffers"],
    tf: ["hcl", "Terraform"],
    hcl: ["hcl", "HCL"],
    diff: ["diff", "Diff"],
    patch: ["diff", "Diff"],
    csv: ["", "CSV"],
    tsv: ["", "TSV"],
    txt: ["", "Plain text"],
    text: ["", "Plain text"],
    log: ["log", "Log"],
    // systemd units (restic-backup.service, restic-backup.timer, ...).
    service: ["systemd", "systemd unit"],
    timer: ["systemd", "systemd timer"],
    socket: ["systemd", "systemd unit"],
    mount: ["systemd", "systemd unit"],
    automount: ["systemd", "systemd unit"],
    target: ["systemd", "systemd unit"],
    path: ["systemd", "systemd unit"],
    slice: ["systemd", "systemd unit"],
    network: ["systemd", "systemd network"],
    netdev: ["systemd", "systemd network"],
    container: ["systemd", "Quadlet container"],
    properties: ["properties", "Properties"],
    desktop: ["desktop", "Desktop entry"],
    nginx: ["nginx", "nginx config"],
    gitconfig: ["ini", "Git config"],
    editorconfig: ["ini", "EditorConfig"],
    npmrc: ["ini", "npm config"],
    groovy: ["groovy", "Groovy"],
    gradle: ["groovy", "Gradle"],
    cmake: ["cmake", "CMake"],
    mk: ["make", "Makefile"],
    bat: ["bat", "Batch"],
    cmd: ["bat", "Batch"],
    vim: ["viml", "Vim script"],
    j2: ["jinja", "Jinja"],
    jinja: ["jinja", "Jinja"],
};

/** Extension-less file names that are code. */
const NAMES: Record<string, [id: string, label: string]> = {
    dockerfile: ["dockerfile", "Dockerfile"],
    makefile: ["make", "Makefile"],
    justfile: ["just", "Justfile"],
    gemfile: ["ruby", "Gemfile"],
    rakefile: ["ruby", "Rakefile"],
    ".gitignore": ["", "Git ignore"],
    ".env": ["dotenv", "Environment"],
    license: ["", "Plain text"],
    readme: ["", "Plain text"],
    containerfile: ["dockerfile", "Containerfile"],
    vagrantfile: ["ruby", "Vagrantfile"],
    jenkinsfile: ["groovy", "Jenkinsfile"],
    "cmakelists.txt": ["cmake", "CMake"],
    ".bashrc": ["bash", "Shell"],
    ".bash_profile": ["bash", "Shell"],
    ".profile": ["bash", "Shell"],
    ".zshrc": ["bash", "Zsh"],
    ".gitconfig": ["ini", "Git config"],
    ".editorconfig": ["ini", "EditorConfig"],
    ".npmrc": ["ini", "npm config"],
    ssh_config: ["ssh-config", "SSH config"],
    sshd_config: ["ssh-config", "SSH config"],
};

/** Interpreter names on a "#!" line. */
const SHEBANG: Record<string, [id: string, label: string]> = {
    sh: ["bash", "Shell"],
    bash: ["bash", "Shell"],
    zsh: ["bash", "Zsh"],
    dash: ["bash", "Shell"],
    fish: ["fish", "Fish"],
    python: ["python", "Python"],
    python3: ["python", "Python"],
    node: ["js", "JavaScript"],
    deno: ["ts", "TypeScript"],
    bun: ["ts", "TypeScript"],
    ruby: ["ruby", "Ruby"],
    perl: ["perl", "Perl"],
    php: ["php", "PHP"],
    lua: ["lua", "Lua"],
};

/**
 * Language from the text, for files whose name says nothing (no extension, or one we do not know). Only
 * strong signals count: a "#!" line, an XML prolog, a Dockerfile FROM, a diff header, or a first section
 * header followed by key = value lines (INI, systemd, WireGuard). Anything else stays plain text.
 */
export function languageFromText(text: string): [id: string, label: string] | undefined {
    const head = text.slice(0, 2048);
    const shebang = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?)?(?:\S*\/)?([\w.-]+)/.exec(head);
    if (shebang) {
        const interpreter = shebang[1]!.replace(/[\d.]+$/, "") || shebang[1]!;
        return SHEBANG[shebang[1]!] ?? SHEBANG[interpreter];
    }
    const lines = head.split(/\r?\n/).filter((l) => l.trim() && !/^\s*[#;]/.test(l));
    const first = lines[0]?.trim() ?? "";
    if (first.startsWith("<?xml")) return ["xml", "XML"];
    if (/^diff --git |^--- \S/.test(first)) return ["diff", "Diff"];
    if (/^FROM\s+\S+/i.test(first) && lines.some((l) => /^(RUN|COPY|CMD|ENTRYPOINT|WORKDIR)\s/i.test(l)))
        return ["dockerfile", "Dockerfile"];
    if (/^\[[^\]]+\]$/.test(first) && lines.slice(1, 6).some((l) => /^\s*[\w.-]+\s*=/.test(l))) {
        const unit = /^\[(Unit|Service|Timer|Install|Socket|Mount|Container|Network)\]$/.test(first);
        return unit ? ["systemd", "systemd unit"] : ["ini", "Config"];
    }
    return undefined;
}

/**
 * Shiki id for a language hint that shiki does not know by itself: a file extension or name used as a
 * Markdown fence ("conf", "service", "Dockerfile"). Known ids and unknown hints come back unchanged.
 */
export function languageAlias(hint: string): string {
    const id = hint.toLowerCase();
    return LANGS[id]?.[0] || NAMES[id]?.[0] || id;
}

/** Suffixes that wrap a real file type: "wg0.conf.example" is a config file, "app.ts.bak" is TypeScript. */
const WRAPPER_EXT = new Set(["example", "sample", "template", "tmpl", "dist", "default", "orig", "bak", "old", "new"]);

export function extensionOf(name: string): string {
    const base = name.toLowerCase().split("/").at(-1) ?? "";
    const parts = base.split(".");
    // A leading dot is a hidden file name (".env"), not an extension.
    if (parts.length < 2 || (parts.length === 2 && !parts[0])) return "";
    let ext = parts.at(-1)!;
    if (WRAPPER_EXT.has(ext) && parts.length > 2 && parts.at(-2)) ext = parts.at(-2)!;
    return ext;
}

/** Shiki language id and label for a file name. Unknown names are plain text. */
export function languageOf(name: string): [id: string, label: string] {
    const base = name.toLowerCase().split("/").at(-1) ?? "";
    const named = NAMES[base];
    if (named) return named;
    // Variants such as "Dockerfile.dev" and "Containerfile.prod".
    const stem = NAMES[base.slice(0, base.indexOf(".") > 0 ? base.indexOf(".") : undefined)];
    if (stem?.[0] === "dockerfile") return stem;
    const ext = extensionOf(name);
    return LANGS[ext] ?? ["", ext ? `${ext.toUpperCase()} file` : "Plain text"];
}

/**
 * Kind from the name and MIME type alone. Undefined means "sniff the first bytes": no useful MIME
 * type and an extension we do not know (or no extension at all).
 */
export function detectKind(name: string, mimeType?: string): RenderKind | undefined {
    const mime = mimeType?.split(";")[0]?.trim() ?? "";
    const ext = extensionOf(name);
    // A specific extension beats a vague MIME type (servers often send text/plain for .md or .csv).
    const byExt = EXT[ext];
    if (byExt) return byExt;
    const base = name.toLowerCase().split("/").at(-1) ?? "";
    if (NAMES[base] || LANGS[ext]) return "code";
    if (mime && !GENERIC_MIME.test(mime)) {
        for (const [re, kind] of MIME) if (re.test(mime)) return kind;
    }
    return undefined;
}

const ascii = (bytes: Uint8Array, at: number, text: string) =>
    text.split("").every((ch, i) => bytes[at + i] === ch.charCodeAt(0));

/** Kind from magic bytes, for files without a useful name or MIME type. */
export function sniffKind(bytes: Uint8Array): RenderKind {
    if (bytes.length === 0) return "code";
    if (ascii(bytes, 0, "%PDF-")) return "pdf";
    if (bytes[0] === 0x89 && ascii(bytes, 1, "PNG")) return "image";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image";
    if (ascii(bytes, 0, "GIF8")) return "image";
    if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "image";
    if (ascii(bytes, 0, "BM") && bytes.length > 26) return "image";
    if (ascii(bytes, 4, "ftypavif")) return "image";
    if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio";
    if (ascii(bytes, 0, "ID3") || ascii(bytes, 0, "fLaC") || ascii(bytes, 0, "OggS")) return "audio";
    if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return "audio";
    if (ascii(bytes, 4, "ftypM4A")) return "audio";
    if (ascii(bytes, 4, "ftyp")) return "video";
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video";
    if (ascii(bytes, 0, "PK\x03\x04") || ascii(bytes, 0, "PK\x05\x06")) return "archive";
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "archive";
    if (ascii(bytes, 0, "7z\xbc\xaf") || ascii(bytes, 0, "Rar!")) return "archive";
    if (ascii(bytes, 257, "ustar")) return "archive";
    if (!looksLikeText(bytes)) return "binary";
    const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
    if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
    if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
    // JSON starts with an object, or an array whose first value is JSON. "[Interface]" (INI, TOML) is not JSON.
    if (head.startsWith("{") || /^\[\s*([[{"\]\d-]|true|false|null)/.test(head)) return "json";
    return "code";
}

/** No NUL bytes and decodes as UTF-8 (a cut multi-byte sequence at the very end is allowed). */
export function looksLikeText(bytes: Uint8Array): boolean {
    const sample = bytes.subarray(0, 4096);
    if (sample.includes(0)) return false;
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4)));
        return true;
    } catch {
        return false;
    }
}

/** Human label for a kind ("PDF document"), refined by the extension where that helps. */
export function kindLabel(kind: RenderKind, name: string): string {
    const ext = extensionOf(name);
    switch (kind) {
        case "openui":
            return translate("genui-kind-openui");
        case "pdf":
            return translate("render-kind-pdf");
        case "sheet":
            return ext === "tsv" || ext === "tab" ? translate("render-kind-tsv") : translate("render-kind-csv");
        case "markdown":
            return "Markdown";
        case "docx":
            return translate("render-kind-docx");
        case "json":
            return ext === "jsonl" || ext === "ndjson" ? "JSON Lines" : "JSON";
        case "code":
            return languageOf(name)[1];
        case "image":
            return ext
                ? translate("render-kind-image-ext", { ext: ext.toUpperCase() })
                : translate("render-kind-image");
        case "svg":
            return translate("render-kind-svg");
        case "audio":
            return ext
                ? translate("render-kind-audio-ext", { ext: ext.toUpperCase() })
                : translate("render-kind-audio");
        case "video":
            return ext
                ? translate("render-kind-video-ext", { ext: ext.toUpperCase() })
                : translate("render-kind-video");
        case "html":
            return translate("render-kind-html");
        case "archive":
            if (ext === "zip") return translate("render-kind-archive-zip");
            return ext
                ? translate("render-kind-archive-ext", { ext: ext.toUpperCase() })
                : translate("render-kind-archive");
        case "binary":
            if (OFFICE[ext]) return translate(OFFICE[ext]);
            return ext
                ? translate("render-kind-binary-ext", { ext: ext.toUpperCase() })
                : translate("render-kind-binary");
    }
}

const OFFICE: Record<string, string> = {
    doc: msg("render-office-doc"),
    xls: msg("render-office-xls"),
    xlsx: msg("render-office-xlsx"),
    ppt: msg("render-office-ppt"),
    pptx: msg("render-office-pptx"),
    odt: msg("render-office-odt"),
    ods: msg("render-office-ods"),
};

/**
 * Largest file each kind loads into memory for a preview. Streamed kinds (PDF, audio, video) have
 * no limit; archives read only their directory from the end of the file.
 */
export const PREVIEW_LIMIT: Record<RenderKind, number> = {
    pdf: Number.POSITIVE_INFINITY,
    audio: Number.POSITIVE_INFINITY,
    video: Number.POSITIVE_INFINITY,
    sheet: 160 * 1024 * 1024,
    code: 16 * 1024 * 1024,
    markdown: 4 * 1024 * 1024,
    json: 24 * 1024 * 1024,
    docx: 48 * 1024 * 1024,
    html: 4 * 1024 * 1024,
    openui: 1024 * 1024,
    image: 80 * 1024 * 1024,
    svg: 8 * 1024 * 1024,
    archive: Number.POSITIVE_INFINITY,
    binary: Number.POSITIVE_INFINITY,
};

/** A file size in the active locale ("1.2 MB"). The number and the unit both follow the locale. */
export function formatBytes(bytes: number): string {
    const { locale } = activeLocalization();
    const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return new Intl.NumberFormat(locale, {
        style: "unit",
        unit: units[i],
        unitDisplay: i === 0 ? "long" : "short",
        maximumFractionDigits: i > 0 && v < 10 ? 1 : 0,
    }).format(v);
}

/** A whole number in the active locale. */
export const formatCount = (n: number) => new Intl.NumberFormat(activeLocalization().locale).format(n);
