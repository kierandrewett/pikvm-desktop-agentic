/**
 * Watched typing — the brain behind `type_text`.
 *
 * Types in humanized chunks while WATCHING the field: a cheap grayscale pixel-diff
 * after each chunk (≈10ms, local, free) confirms keystrokes are actually landing
 * AND auto-locates the field (the bounding box of changed pixels), and at adaptive
 * checkpoints a cropped image of the field is read back by a vision model and
 * compared to what we meant to type. Mistakes — especially a wrong keyboard layout —
 * are self-corrected inline (select-all + re-type) without burning an agent turn.
 *
 * It is a pure orchestrator: every side effect (keystrokes, capture, vision, the
 * on-screen overlay) is injected via `WatchedTypingDeps`, so it's unit-testable and
 * never imports Electron. It NEVER emits Enter — corrective keys are whitelisted.
 */

import { looksLikeCode } from "../human-typing";

export interface Region {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface GridSnapshot {
    cols: number;
    rows: number;
    /** Row-major grayscale 0..255, length cols*rows. */
    cells: Uint8Array;
}

export const VISIBLE_TYPING_TARGET_REQUIRED =
    "Before typing, look at the current screen: call screenshot/get_regions, make sure the target text box/text area/terminal input line is visible, click/focus it, then call type_text with verify_region set to that visible box.";

export type CorrectionKind = "no-focus" | "layout" | "prepend-autocorrect" | "prefix-tail";

export type TypingEvent =
    | { phase: "start"; total: number; region?: Region }
    | { phase: "located"; region: Region }
    | { phase: "progress"; done: number; total: number; region?: Region }
    | { phase: "verifying"; region?: Region }
    | { phase: "verified"; region?: Region }
    | { phase: "correcting"; reason: CorrectionKind; detail: string; region?: Region }
    | { phase: "done"; ok: boolean; corrected: boolean; summary: string; region?: Region };

export interface WatchedTypingDeps {
    /** Humanized typing of one chunk. Honors signal + onProgress + secret. */
    typeChunk(
        text: string,
        opts: { signal?: AbortSignal; code?: boolean; secret?: boolean; onProgress?: (done: number, total: number) => void },
    ): Promise<void>;
    /** Single key press for corrections (Backspace, …). Throws on Enter. */
    pressKey(code: string): Promise<void>;
    /** Chord for corrections (Ctrl+A, …). Throws if it contains Enter. */
    hotkey(codes: string[]): Promise<void>;
    /** Dense grayscale grid of the live frame, in getDimensions() pixel space. */
    captureGrid(): Promise<GridSnapshot | null>;
    /** Crop the field region → a JPEG for the read-back. */
    cropField(region: Region): Promise<{ data: string; mimeType: string } | null>;
    /** Fast optical read of the cropped field (local OCR). "" on failure. */
    opticalRead(image: { data: string; mimeType: string }): Promise<string>;
    /** Stronger read (vision model), used ONLY to confirm a suspected mismatch
     *  before a destructive retype, so a local-OCR glitch can't trigger a redo. */
    opticalReadStrong?(image: { data: string; mimeType: string }): Promise<string>;
    getLayout(): "us" | "uk";
    setLayout(l: "us" | "uk"): void;
    /** Persist a learned fact (e.g. the target's keyboard layout). */
    remember?(text: string): void;
    /** Live event sink → overlay X-ray (fire-and-forget). */
    emit?(ev: TypingEvent): void;
    getDimensions(): { width: number; height: number };
    /** FAST server-side print (kvmd /api/hid/print) for long prose — types the whole
     *  string in one call, layout-correct, far faster than per-key humanized typing.
     *  When present, long non-exact non-secret text takes this path + a single verify. */
    printText?(text: string): Promise<void>;
    /** Sleep (ms) — lets a print finish + the video settle before the read-back. */
    wait?(ms: number): Promise<void>;
    /** Target Caps-Lock LED, if known. The fast print path can't compensate per-letter
     *  (kvmd builds the keys), so when caps is ON we fall back to humanized typing. */
    capsLockOn?(): boolean | undefined;
}

export interface WatchedTypingResult {
    intended: string;
    /** Last optical read ("" if never read — secret/trivial/failed). */
    readBack: string;
    region?: Region;
    verdict: "match" | "contains" | "mismatch" | "unverified";
    corrected: boolean;
    /** Human one-liner for the tool output / sidebar. */
    summary: string;
}

export function visibleTypingRegionIssue(region: Region | undefined, dims: { width: number; height: number }): string | null {
    if (!region) return VISIBLE_TYPING_TARGET_REQUIRED;
    const nums = [region.x, region.y, region.width, region.height, dims.width, dims.height];
    if (nums.some((n) => !Number.isFinite(n))) return "verify_region must be numeric and based on the latest visible screen.";
    if (dims.width <= 0 || dims.height <= 0) return "Screen dimensions are not available yet; screenshot first, then retry with a visible verify_region.";
    if (region.width < 8 || region.height < 8) return "verify_region is too small to prove a visible typing target; screenshot/get_regions and pass the full visible field box.";
    const x1 = Math.max(0, region.x);
    const y1 = Math.max(0, region.y);
    const x2 = Math.min(dims.width, region.x + region.width);
    const y2 = Math.min(dims.height, region.y + region.height);
    const visibleArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const area = region.width * region.height;
    if (visibleArea <= 0) return "verify_region is outside the current screen; screenshot/get_regions and pass the visible target field.";
    if (visibleArea / area < 0.8) return "verify_region is mostly off-screen; scroll or reveal the field first, then pass the visible field box.";
    return null;
}

// Pixel-diff tuning.
const CELL_DELTA = 18; // grayscale delta for a grid cell to count as "changed"
const MIN_CHANGED_CELLS = 2; // fewer than this after pruning ⇒ nothing landed
const LOCATE_MIN_CHARS = 5; // only attempt auto-locate once the first chunk is at least this long
const ABORT_MIN_CHARS = 8; // only HARD-fail "no focus" when enough was typed to move ≥2 cells
const MAX_BOX_HEIGHT_FRAC = 0.6; // a change taller than this is a repaint, not a field

// Chunking + correction caps.
const CHUNK_TARGET = 16;
const MAX_TOTAL_CORRECTIONS = 1; // one clean retry, never a compounding clear/retype loop
const MAX_BACKSPACES = 400; // safety cap on a correction's clear
// Above this length, plain (non-exact, non-secret) text takes the FAST server-side print
// path instead of per-char humanized typing — the "took too long" fix for long prose.
const FAST_PRINT_MIN = 40;
const NO_FOCUS_SUMMARY =
    "Typed but the screen did not change — the field isn't focused. STOP: do not call type_text again yet. First screenshot/get_regions, click inside the target field (or otherwise focus it), verify the caret/focus, then call type_text once.";
interface CompareOptions {
    /** Exact command/code/password-style text: case and symbols are meaningful. */
    precise?: boolean;
}

/** Smallest box covering both regions (grows the located field as typing extends). */
function unionRegion(a: Region, b: Region): Region {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const x2 = Math.max(a.x + a.width, b.x + b.width);
    const y2 = Math.max(a.y + a.height, b.y + b.height);
    return { x, y, width: x2 - x, height: y2 - y };
}

/**
 * Quote glyphs OCR genuinely cannot tell apart at terminal font sizes — straight vs
 * curly, single vs double, backtick, prime. Fold them ALL to one canonical `'` so a
 * read-back differing only by quote style (e.g. typed '*.md' read back as "*.md")
 * isn't a false mismatch. This does NOT weaken layout detection: a quote-vs-non-quote
 * difference (e.g. `"`→`@` from a US/UK slip) still differs because `@` isn't a quote.
 */
const QUOTE_RE = /['"`´‘’“”′″]/g;
function foldQuotes(s: string): string {
    return s.replace(QUOTE_RE, "'");
}

/**
 * Strip a leading shell/REPL prompt the field crop captured. A terminal read-back is
 * "<prompt> <command>" — `$ `, `# `, `% `, `user@host:~/p$ `, `PS C:\>`, `C:\>`, or a
 * glyph prompt (❯ ➜ λ). That prompt is NOT typed text, and treating it as such was the
 * reported "it thought the $ at the bash prompt was part of the typed text" bug. Only
 * applied to the READ-BACK, never to the intended text.
 */
const PROMPT_RE = /^\s*(?:PS\s+[^>\n]*>|[A-Za-z]:\\[^>\n]*>|[^\s@]+@[^\s@]+[^$#%>\n]*[$#%>]|[$#%>❯➜λ»])\s+/;
function stripPrompt(s: string): string {
    return s.replace(PROMPT_RE, "");
}

/** Compare key: whitespace-insensitive; quote-glyph-insensitive; case-insensitive
 *  unless exact text matters. */
function norm(s: string, opts: CompareOptions = {}): string {
    const compact = foldQuotes(s).replace(/\s+/g, " ").trim();
    return opts.precise ? compact : compact.toLowerCase();
}
/** Letters + digits only (what a layout slip leaves UNCHANGED). */
function alnum(s: string, opts: CompareOptions = {}): string {
    return (opts.precise ? s : s.toLowerCase()).replace(/[^a-z0-9]/gi, "");
}
function alnumFoldCase(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
/**
 * Glyphs OCR (and the human eye, in a terminal font) genuinely cannot tell apart:
 * 0/O/o, 1/l/I, 5/S, 8/B, 2/Z, 9/g/q/6. We fold each to one canonical member so a
 * read-back that differs ONLY by such characters (e.g. `oel9` vs `oe19`) is treated as
 * a MATCH — the read can't reliably distinguish them, so destroying correct text on
 * that basis is always wrong. Leans lenient on purpose: a missed confusable-only typo
 * is rare and self-evident; a false clear of good input is the failure the user hits.
 *
 * These are ALPHANUMERIC confusables only. We deliberately do NOT fold the pipe `|`
 * (which used to map to `l`): a pipe is a layout-/shell-critical symbol — folding it
 * hid a real keyboard-layout slip (`cat … | wc` read back as `… l wc`) as "verified".
 * Symbols are never OCR-folded; a symbol difference is decided by the layout/precise
 * branches instead. See classifyMismatch / computeVerdict.
 */
const CONFUSABLE: Record<string, string> = {
    "0": "o",
    "1": "l", i: "l",
    "5": "s",
    "8": "b",
    "2": "z",
    "9": "g", q: "g", "6": "g",
};
function foldConfusables(s: string): string {
    let out = "";
    for (const ch of s) out += CONFUSABLE[ch] ?? ch;
    return out;
}
/** norm + confusable-fold: the canonical key for "are these the same text?". */
function confKey(s: string, opts: CompareOptions = {}): string {
    // In precise mode a pipe, slash, quote or case difference can change a command.
    // Do not fold those away as OCR noise; fail closed instead.
    return opts.precise ? norm(s, opts) : foldConfusables(norm(s, opts));
}
function wordSet(s: string, opts: CompareOptions = {}): string {
    return norm(s, opts).split(" ").filter(Boolean).sort().join(" ");
}

/**
 * Should this text be compared in PRECISE mode (case + symbols are load-bearing)?
 * Callers (esp. the MCP `type_text`) rarely set `code`, yet shell commands, paths,
 * URLs and the like are exactly where a layout slip silently corrupts a symbol. We
 * infer precise from the content so those are never compared with the lenient
 * confusable/Levenshtein tolerance that masked the reported `"`→`@`, `|`→`~` bug.
 * Deliberately conservative: ordinary prose (incl. `name@domain.com`) stays lenient.
 */
export function isExactText(s: string): boolean {
    if (looksLikeCode(s)) return true;
    if (/[|<>$`~\\]/.test(s)) return true; // shell metachars: pipe, redirect, var, backtick, tilde, escape
    if (/(^|\s)(--?[A-Za-z]|\/[\w./-]+|~\/|\.{1,2}\/)/.test(s)) return true; // flags, absolute/home/relative paths
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true; // url scheme
    if (/(^|\s)(sudo|git|npm|yarn|pnpm|node|cd|ls|cat|grep|find|echo|rm|mkdir|cp|mv|chmod|chown|ssh|scp|curl|wget|docker|kubectl|systemctl|tar|sed|awk)(\s|$)/.test(s))
        return true; // common command heads
    return false;
}

/** OCR/crops often only see the visible prefix of a scrolled text field. */
function isPrefixRead(intendedNorm: string, readNorm: string): boolean {
    return readNorm.length > 0 && intendedNorm.length > readNorm.length && intendedNorm.startsWith(readNorm);
}

/** Bounded Levenshtein (early-out once it exceeds `max`). */
function levenshtein(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const prev = new Array(b.length + 1);
    const cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        let rowMin = cur[0];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            if (cur[j] < rowMin) rowMin = cur[j];
        }
        if (rowMin > max) return max + 1;
        for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
}

/** Word-boundary chunks of ~CHUNK_TARGET chars (never split a short word). */
export function chunkText(s: string): string[] {
    if (s.length <= CHUNK_TARGET) return s.length ? [s] : [];
    const out: string[] = [];
    let buf = "";
    for (const word of s.split(/(\s+)/)) {
        if (buf && buf.length + word.length > CHUNK_TARGET && buf.trim()) {
            out.push(buf);
            buf = "";
        }
        // A single word longer than the cap: hard-split it.
        if (word.length > CHUNK_TARGET) {
            if (buf) {
                out.push(buf);
                buf = "";
            }
            for (let i = 0; i < word.length; i += CHUNK_TARGET) out.push(word.slice(i, i + CHUNK_TARGET));
            continue;
        }
        buf += word;
    }
    if (buf) out.push(buf);
    return out;
}

/**
 * Bounding box of the cells that changed between two grids, in frame-pixel space.
 * Returns null when too little changed (≈ "keystrokes didn't land / not focused").
 */
export function locateChangedBBox(
    before: GridSnapshot,
    after: GridSnapshot,
    dims: { width: number; height: number },
): Region | null {
    if (before.cols !== after.cols || before.rows !== after.rows) return null;
    const { cols, rows } = after;
    const changed = new Uint8Array(cols * rows);
    let count = 0;
    for (let i = 0; i < changed.length; i++) {
        if (Math.abs((after.cells[i] ?? 0) - (before.cells[i] ?? 0)) > CELL_DELTA) {
            changed[i] = 1;
            count++;
        }
    }
    if (count < MIN_CHANGED_CELLS) return null;
    // Prune isolated cells (cursor blink / stream noise): typed text forms runs.
    let pruned = 0;
    let minC = cols,
        minR = rows,
        maxC = -1,
        maxR = -1;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (!changed[r * cols + c]) continue;
            const up = r > 0 && changed[(r - 1) * cols + c];
            const dn = r < rows - 1 && changed[(r + 1) * cols + c];
            const lf = c > 0 && changed[r * cols + (c - 1)];
            const rt = c < cols - 1 && changed[r * cols + (c + 1)];
            if (!up && !dn && !lf && !rt) continue; // isolated ⇒ noise
            pruned++;
            if (c < minC) minC = c;
            if (c > maxC) maxC = c;
            if (r < minR) minR = r;
            if (r > maxR) maxR = r;
        }
    }
    if (pruned < MIN_CHANGED_CELLS || maxC < 0) return null;
    const cw = dims.width / cols;
    const ch = dims.height / rows;
    let x = (minC - 1) * cw;
    let y = (minR - 1) * ch;
    let w = (maxC - minC + 3) * cw;
    let h = (maxR - minR + 3) * ch;
    x = Math.max(0, x);
    y = Math.max(0, y);
    w = Math.min(dims.width - x, w);
    h = Math.min(dims.height - y, h);
    if (h > dims.height * MAX_BOX_HEIGHT_FRAC) return null; // whole-screen repaint, not a field
    return { x, y, width: w, height: h };
}

/** The read-back is much longer than what we typed AND doesn't contain it — the field
 *  crop likely caught SURROUNDING UI (a shell prompt, a results dropdown, wrapped lines,
 *  a status bar), not a typing error. Bias to "couldn't verify" over a scary mismatch or
 *  a destructive retype. */
function readCaughtExtra(ni: string, nr: string): boolean {
    return ni.length >= 3 && nr.length > ni.length * 1.6 && !nr.includes(ni);
}

/** Classify a structural mismatch, or null if it's a match / within OCR tolerance. */
export function classifyMismatch(intended: string, readBack: string, opts: CompareOptions = {}): CorrectionKind | null {
    const ni = norm(intended, opts);
    const nr = norm(stripPrompt(readBack), opts); // drop a leading shell prompt the crop caught
    if (!nr) return null; // read nothing — don't thrash on a flaky read
    if (ni === nr) return null;
    if (nr.includes(ni)) return null; // field shows our text (plus extra) — fine
    if (isPrefixRead(ni, nr)) return null; // crop/field viewport only read the beginning — not a typo
    // Letters/digits identical but punctuation/symbols differ ⇒ the UK/US symbol-key signature.
    // Use case-folded alnum even in precise mode so "README" → "readme" plus wrong symbols
    // still points at the keyboard layout first; the retry types uppercase with Shift.
    if (alnumFoldCase(ni).length > 0 && alnumFoldCase(ni) === alnumFoldCase(nr)) return "layout";
    if (readCaughtExtra(ni, nr)) return null; // crop read a results list / extra UI, not a typo
    if (opts.precise) {
        // Exact text matters for commands/code. Avoid fuzzy/confusable forgiveness;
        // a wrong quote, pipe, slash, or letter case can change behavior.
        if (overlapRatio(ni, nr) < 0.5) return null;
        return "prefix-tail";
    }
    // Differs ONLY by OCR-confusable glyphs (l/1, O/0, S/5…) ⇒ the read can't resolve
    // them either, so this is NOT a real mismatch. Checked before layout/fuzzy so a
    // path like `oel9` read as `oe19` never triggers a destructive clear.
    const ck = confKey(intended, opts);
    const cr = confKey(readBack, opts);
    if (ck === cr || cr.includes(ck)) return null;
    if (isPrefixRead(ck, cr)) return null;
    const tol = Math.max(1, Math.ceil(ni.length * 0.08));
    if (levenshtein(ni, nr, tol) <= tol) return null; // fuzzy OCR noise (l/I, 0/O)
    if (nr.endsWith(ni) || wordSet(ni, opts) === wordSet(nr, opts)) return "prepend-autocorrect";
    // If the read-back shares almost nothing with what we typed, it's far more
    // likely a misread or a MISLOCATED crop (reading the wrong line) than a typing
    // error — never destructively clear/retype on that basis; leave it for the agent.
    if (overlapRatio(ni, nr) < 0.5) return null;
    return "prefix-tail";
}

/** Fraction of `a`'s characters also present in `b` (multiset). ~0 ⇒ unrelated text. */
function overlapRatio(a: string, b: string): number {
    if (!a.length) return 1;
    const pool = new Map<string, number>();
    for (const c of b) pool.set(c, (pool.get(c) ?? 0) + 1);
    let hit = 0;
    for (const c of a) {
        const n = pool.get(c) ?? 0;
        if (n > 0) {
            hit++;
            pool.set(c, n - 1);
        }
    }
    return hit / a.length;
}

export function computeVerdict(intended: string, readBack: string, opts: CompareOptions = {}): WatchedTypingResult["verdict"] {
    if (!readBack) return "unverified";
    const ni = norm(intended, opts);
    const nr = norm(stripPrompt(readBack), opts); // drop a leading shell prompt the crop caught
    if (ni === nr) return "match";
    if (nr.includes(ni)) return "contains";
    if (isPrefixRead(ni, nr)) return "unverified";
    // Letters/digits identical, only symbols/case differ ⇒ a confident layout/caps slip,
    // not noise — never report this as a clean match.
    if (alnumFoldCase(ni).length > 0 && alnumFoldCase(ni) === alnumFoldCase(nr) && ni !== nr) return "mismatch";
    if (readCaughtExtra(ni, nr)) return "unverified"; // crop read surrounding UI, not the field
    if (opts.precise) {
        if (overlapRatio(ni, nr) < 0.5) return "unverified";
        return "mismatch";
    }
    // Confusable-only difference (l/1, O/0…) ⇒ a clean read for our purposes.
    const ck = confKey(intended, opts);
    const cr = confKey(readBack, opts);
    if (ck === cr) return "match";
    if (cr.includes(ck)) return "contains";
    if (isPrefixRead(ck, cr)) return "unverified";
    const tol = Math.max(1, Math.ceil(ni.length * 0.08));
    if (levenshtein(ni, nr, tol) <= tol) return "match";
    // A read sharing almost nothing with the intent is an unreliable read (glitch or
    // mislocated crop), not a confirmed mismatch — report "unverified", not a failure.
    if (overlapRatio(ni, nr) < 0.5) return "unverified";
    return "mismatch";
}

/**
 * FAST path for long prose: print the whole string server-side (kvmd /api/hid/print)
 * in ONE call, then verify the field ONCE (not per-chunk). Reuses the field-focus
 * pixel-diff + the lenient read-back verdict, and on a confirmed mismatch clears the
 * field (Home + Delete×N — terminal-safe, never Ctrl+A) and reprints exactly once.
 * This replaces the per-char humanized loop + per-chunk OCR-verify (the slow,
 * break-down-prone path) for ordinary multi-sentence text.
 */
export async function runFastPrint(
    intended: string,
    opts: { verifyRegion?: Region; signal?: AbortSignal },
    deps: WatchedTypingDeps,
): Promise<WatchedTypingResult> {
    const dims = deps.getDimensions();
    const emit = (ev: TypingEvent): void => {
        try {
            deps.emit?.(ev);
        } catch {
            /* overlay errors never affect typing */
        }
    };
    let region: Region | undefined = opts.verifyRegion;
    emit({ phase: "start", total: intended.length, ...(region ? { region } : {}) });

    const before = await deps.captureGrid();
    await deps.printText!(intended);
    await deps.wait?.(450); // let kvmd finish typing + the video settle before reading back
    const after = await deps.captureGrid();

    const changed = before && after ? locateChangedBBox(before, after, dims) : null;
    if (!region && changed) {
        region = changed;
        emit({ phase: "located", region: changed });
    }
    // Nothing changed on screen ⇒ the field wasn't focused (don't blindly reprint).
    if (before && after && !changed) {
        emit({ phase: "correcting", reason: "no-focus", detail: "no visible change" });
        emit({ phase: "done", ok: false, corrected: false, summary: NO_FOCUS_SUMMARY });
        return { intended, readBack: "", verdict: "mismatch", corrected: false, summary: NO_FOCUS_SUMMARY };
    }

    let readBack = "";
    let verdict: WatchedTypingResult["verdict"] = "unverified";
    let corrected = false;
    if (region) {
        emit({ phase: "verifying", region });
        const img = await deps.cropField(region);
        if (img) {
            readBack = await deps.opticalRead(img);
            verdict = computeVerdict(intended, readBack, { precise: false });
            if (verdict === "mismatch") {
                // Confirm with the stronger (vision) read before any destructive reprint.
                const confirm = deps.opticalReadStrong ? await deps.opticalReadStrong(img) : readBack;
                if (computeVerdict(intended, confirm, { precise: false }) !== "mismatch") {
                    readBack = confirm;
                    verdict = computeVerdict(intended, confirm, { precise: false });
                } else {
                    emit({ phase: "correcting", reason: "prefix-tail", detail: "re-print", region });
                    await deps.pressKey("Home");
                    const n = Math.min(MAX_BACKSPACES, Math.max(intended.length, readBack.length) + 4);
                    for (let k = 0; k < n; k++) {
                        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
                        await deps.pressKey("Delete");
                    }
                    await deps.wait?.(150);
                    await deps.printText!(intended);
                    await deps.wait?.(450);
                    corrected = true;
                    const img2 = await deps.cropField(region);
                    if (img2) {
                        readBack = await (deps.opticalReadStrong ?? deps.opticalRead)(img2);
                        verdict = computeVerdict(intended, readBack, { precise: false });
                    }
                }
            }
        }
    }

    const summary =
        verdict === "mismatch"
            ? "Typed (fast), but read-back still doesn't match — check the field."
            : corrected
              ? "Typed (fast) and self-corrected (verified the field)."
              : verdict === "unverified"
                ? readBack
                    ? "Typed (fast); read-back only verified part of the field."
                    : "Typed (fast)."
                : "Typed (fast) and verified the field reads correctly.";
    emit({ phase: "done", ok: verdict !== "mismatch", corrected, summary, ...(region ? { region } : {}) });
    return { intended, readBack, verdict, corrected, summary, ...(region ? { region } : {}) };
}

export async function runWatchedTyping(
    intended: string,
    opts: { code?: boolean; secret?: boolean; verify?: boolean; verifyRegion?: Region; signal?: AbortSignal },
    deps: WatchedTypingDeps,
): Promise<WatchedTypingResult> {
    const { signal, secret = false } = opts;
    const dims = deps.getDimensions();
    const chunks = chunkText(intended);
    const total = intended.length;
    // Compare PRECISELY (case + symbols matter) for code/commands/paths/URLs — either the
    // caller flagged it as code or the content looks like it. Prose stays lenient. This is
    // what makes a wrong symbol/case (e.g. a US/UK layout slip) a real mismatch instead of
    // being absorbed as OCR noise and reported "verified correctly".
    const precise = opts.code ?? isExactText(intended);

    // FAST PATH: long, plain (non-exact, non-secret) text goes server-side via the kvmd
    // keymap printer in one call + a single verify — far faster than per-char humanized
    // typing and without the per-chunk verify/correct loop that breaks down on long text.
    // Exact/symbol-critical (commands, paths), secrets, short fields, and a Caps-Lock-on
    // target (the printer can't compensate per-letter) keep the humanized self-correcting
    // path below.
    if (deps.printText && !secret && !precise && total > FAST_PRINT_MIN && deps.capsLockOn?.() !== true) {
        return runFastPrint(
            intended,
            { ...(opts.verifyRegion ? { verifyRegion: opts.verifyRegion } : {}), ...(signal ? { signal } : {}) },
            deps,
        );
    }

    let region: Region | undefined = opts.verifyRegion;
    let located = !!opts.verifyRegion;
    let typedSoFar = "";
    let corrections = 0;
    let lastReadBack = "";
    let verifiedClean = false;

    const emit = (ev: TypingEvent) => {
        try {
            deps.emit?.(ev);
        } catch {
            /* overlay errors never affect typing */
        }
    };

    const canVision = !secret && total > 4;
    const cadenceCheckpoint = (i: number): boolean => {
        if (!canVision || !region) return false;
        if (i === 0) return true; // catch wrong layout / autocorrect EARLY
        if (total <= 20) return false; // short: first + final only
        return i % 3 === 0; // longer: periodic
    };

    /**
     * Re-establish a known-good field: clear what's there and re-type everything so
     * far. Uses End + Backspace (NOT Ctrl+A — in a terminal Ctrl+A means "go to line
     * start", which would retype on top and duplicate the command). Backspace stops at
     * the field/line start, so an over-estimate of the length is harmless.
     */
    const correct = async (kind: CorrectionKind, fieldText: string): Promise<void> => {
        corrections++;
        if (kind === "layout") {
            const cur = deps.getLayout();
            const next = cur === "us" ? "uk" : "us";
            deps.setLayout(next);
            deps.remember?.(
                `The target machine uses the ${next.toUpperCase()} keyboard layout — symbols came out wrong typing as ${cur.toUpperCase()}.`,
            );
            emit({ phase: "correcting", reason: kind, detail: `layout → ${next.toUpperCase()}`, ...(region ? { region } : {}) });
        } else {
            emit({ phase: "correcting", reason: kind, detail: "re-typing", ...(region ? { region } : {}) });
        }
        // Clear from the START with forward Delete (Home → Delete×N), not End +
        // Backspace and NEVER Ctrl+A — this matches both a terminal's readline and a
        // GUI field, and Delete past the end is a no-op so over-counting is safe.
        const n = Math.min(MAX_BACKSPACES, Math.max(typedSoFar.length, fieldText.length) + 4);
        await deps.pressKey("Home");
        for (let k = 0; k < n; k++) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            await deps.pressKey("Delete");
        }
        // Let the (possibly laggy) clear actually land before retyping, so we never
        // type onto a not-yet-cleared line — that interleaving is what duplicated text.
        await new Promise((r) => setTimeout(r, 150));
        await deps.typeChunk(typedSoFar, { ...(signal ? { signal } : {}), ...(opts.code ? { code: opts.code } : {}), secret });
    };

    /**
     * Compare a (fast, local-OCR) read-back to its intended snapshot. If it looks
     * wrong, CONFIRM with a stronger read of the CURRENT field before any destructive
     * retype — local OCR is cheap but fuzzier, so the vision model is the safety net.
     */
    const maybeCorrect = async (readBack: string, intendedSnapshot: string): Promise<void> => {
        lastReadBack = readBack;
        if (corrections >= MAX_TOTAL_CORRECTIONS) return;
        const markCleanIfFull = (snapshot: string) => {
            if (norm(snapshot, { precise }) === norm(intended, { precise })) verifiedClean = true;
            emit({ phase: "verified", ...(region ? { region } : {}) });
        };
        if (!classifyMismatch(intendedSnapshot, readBack, { precise })) {
            // Only declare the WHOLE field clean when this read covered all of it.
            markCleanIfFull(intendedSnapshot);
            return;
        }
        if (!region) return; // nothing to crop/confirm against — leave it to the agent
        // A suspicion that PASSED the overlap/garbage gate is plausibly real — confirm
        // it once with the stronger (vision) read before any destructive retype. This
        // fires rarely now (the gate drops mislocated/garbage reads, which were the
        // real cause of the long waits), so it no longer stacks up seconds.
        emit({ phase: "verifying", region });
        const img = await deps.cropField(region);
        const confirm = img ? await (deps.opticalReadStrong ?? deps.opticalRead)(img) : readBack;
        lastReadBack = confirm;
        const confirmKind = classifyMismatch(typedSoFar, confirm, { precise });
        if (!confirmKind) {
            markCleanIfFull(typedSoFar);
            return;
        }
        await correct(confirmKind, confirm);
    };

    emit({ phase: "start", total, ...(region ? { region } : {}) });

    let gridPrev = await deps.captureGrid();
    let pending: { intended: string; promise: Promise<string> } | null = null;

    for (let i = 0; i < chunks.length; i++) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const chunk = chunks[i]!;
        const before = typedSoFar.length;
        await deps.typeChunk(chunk, {
            ...(signal ? { signal } : {}),
            ...(opts.code ? { code: opts.code } : {}),
            secret,
            onProgress: (kd, kt) =>
                emit({
                    phase: "progress",
                    done: before + Math.round((kd / Math.max(1, kt)) * chunk.length),
                    total,
                    ...(region ? { region } : {}),
                }),
        });
        typedSoFar += chunk;
        emit({ phase: "progress", done: typedSoFar.length, total, ...(region ? { region } : {}) });

        const gridNow = await deps.captureGrid();

        // Auto-locate the field from the pixels that change as we type, GROWING the
        // box each chunk so it spans the whole line (not just the first word) — and
        // catch "not focused" when nothing changes at all. Skipped if the caller gave
        // an explicit verify_region.
        if (!opts.verifyRegion && typedSoFar.length >= LOCATE_MIN_CHARS) {
            const loc = gridPrev && gridNow ? locateChangedBBox(gridPrev, gridNow, dims) : null;
            if (loc) {
                region = located ? unionRegion(region!, loc) : loc;
                located = true;
                emit({ phase: "located", region });
            } else if (!located && !secret && typedSoFar.length >= ABORT_MIN_CHARS) {
                // Nothing has visibly changed despite typing a real word ⇒ wrong target.
                emit({ phase: "correcting", reason: "no-focus", detail: "no visible change" });
                const summary =
                    "Typed but the screen did not change — the field isn't focused. STOP: do not call type_text again yet. First screenshot/get_regions, click inside the target field (or otherwise focus it), verify the caret/focus, then call type_text once.";
                emit({ phase: "done", ok: false, corrected: false, summary });
                return { intended, readBack: "", verdict: "mismatch", corrected: false, summary };
            }
        }
        if (gridNow) gridPrev = gridNow;

        // Resolve a verify launched last iteration (it overlapped this chunk's typing).
        if (pending) {
            const rb = await pending.promise;
            await maybeCorrect(rb, pending.intended);
            pending = null;
            if (corrections > 0) gridPrev = await deps.captureGrid(); // field changed under us
        }

        // Launch this checkpoint's verify to overlap the NEXT chunk.
        if (cadenceCheckpoint(i) && region) {
            emit({ phase: "verifying", region });
            const img = await deps.cropField(region);
            pending = { intended: typedSoFar, promise: img ? deps.opticalRead(img) : Promise.resolve("") };
        }
    }

    // Drain a still-in-flight verify.
    if (pending) {
        const rb = await pending.promise;
        await maybeCorrect(rb, pending.intended);
        pending = null;
    }

    // Final correctness check if we never got a clean read mid-stream.
    if (!verifiedClean && region && canVision) {
        emit({ phase: "verifying", region });
        const img = await deps.cropField(region);
        if (img) await maybeCorrect(await deps.opticalRead(img), intended);
    }

    const verdict = computeVerdict(intended, lastReadBack, { precise });
    const corrected = corrections > 0;
    const summary =
        verdict === "mismatch"
            ? `Typed, but read-back still doesn't match — check the field.`
            : corrected
              ? `Typed and self-corrected (verified the field).`
              : verdict === "unverified"
                ? lastReadBack
                    ? `Typed; read-back only verified part of the field.`
                    : `Typed.`
                : `Typed and verified the field reads correctly.`;
    emit({ phase: "done", ok: verdict !== "mismatch", corrected, summary, ...(region ? { region } : {}) });
    return { intended, readBack: lastReadBack, verdict, corrected, summary, ...(region ? { region } : {}) };
}
