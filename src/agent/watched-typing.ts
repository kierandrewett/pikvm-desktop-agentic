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

/** Smallest box covering both regions (grows the located field as typing extends). */
function unionRegion(a: Region, b: Region): Region {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const x2 = Math.max(a.x + a.width, b.x + b.width);
    const y2 = Math.max(a.y + a.height, b.y + b.height);
    return { x, y, width: x2 - x, height: y2 - y };
}

/** Forgiving compare: case + whitespace insensitive. */
function norm(s: string): string {
    return s.toLowerCase().replace(/\s+/g, " ").trim();
}
/** Letters + digits only (what a layout slip leaves UNCHANGED). */
function alnum(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
/**
 * Glyphs OCR (and the human eye, in a terminal font) genuinely cannot tell apart:
 * 0/O/o, 1/l/I/|, 5/S, 8/B, 2/Z, 9/g/q/6. We fold each to one canonical member so a
 * read-back that differs ONLY by such characters (e.g. `oel9` vs `oe19`) is treated as
 * a MATCH — the read can't reliably distinguish them, so destroying correct text on
 * that basis is always wrong. Leans lenient on purpose: a missed confusable-only typo
 * is rare and self-evident; a false clear of good input is the failure the user hits.
 */
const CONFUSABLE: Record<string, string> = {
    "0": "o",
    "1": "l", i: "l", "|": "l",
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
function confKey(s: string): string {
    return foldConfusables(norm(s));
}
function wordSet(s: string): string {
    return norm(s).split(" ").filter(Boolean).sort().join(" ");
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

/** Classify a structural mismatch, or null if it's a match / within OCR tolerance. */
export function classifyMismatch(intended: string, readBack: string): CorrectionKind | null {
    const ni = norm(intended);
    const nr = norm(readBack);
    if (!nr) return null; // read nothing — don't thrash on a flaky read
    if (ni === nr) return null;
    if (nr.includes(ni)) return null; // field shows our text (plus extra) — fine
    // Differs ONLY by OCR-confusable glyphs (l/1, O/0, S/5…) ⇒ the read can't resolve
    // them either, so this is NOT a real mismatch. Checked before layout/fuzzy so a
    // path like `oel9` read as `oe19` never triggers a destructive clear.
    const ck = confKey(intended);
    const cr = confKey(readBack);
    if (ck === cr || cr.includes(ck)) return null;
    // Letters+digits identical but the rest differs ⇒ the UK/US symbol-key signature.
    // Checked BEFORE the fuzzy tolerance, else a single wrong symbol looks like OCR noise.
    if (alnum(ni).length > 0 && alnum(ni) === alnum(nr)) return "layout";
    const tol = Math.max(1, Math.ceil(ni.length * 0.08));
    if (levenshtein(ni, nr, tol) <= tol) return null; // fuzzy OCR noise (l/I, 0/O)
    if (nr.endsWith(ni) || wordSet(ni) === wordSet(nr)) return "prepend-autocorrect";
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

function computeVerdict(intended: string, readBack: string): WatchedTypingResult["verdict"] {
    if (!readBack) return "unverified";
    const ni = norm(intended);
    const nr = norm(readBack);
    if (ni === nr) return "match";
    if (nr.includes(ni)) return "contains";
    // Confusable-only difference (l/1, O/0…) ⇒ a clean read for our purposes.
    const ck = confKey(intended);
    const cr = confKey(readBack);
    if (ck === cr) return "match";
    if (cr.includes(ck)) return "contains";
    const tol = Math.max(1, Math.ceil(ni.length * 0.08));
    if (levenshtein(ni, nr, tol) <= tol) return "match";
    // A read sharing almost nothing with the intent is an unreliable read (glitch or
    // mislocated crop), not a confirmed mismatch — report "unverified", not a failure.
    if (overlapRatio(ni, nr) < 0.5) return "unverified";
    return "mismatch";
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
            if (norm(snapshot) === norm(intended)) verifiedClean = true;
            emit({ phase: "verified", ...(region ? { region } : {}) });
        };
        if (!classifyMismatch(intendedSnapshot, readBack)) {
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
        const confirmKind = classifyMismatch(typedSoFar, confirm);
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
                    "Typed but the screen did not change — the field isn't focused. Click the field first, then type again.";
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

    const verdict = computeVerdict(intended, lastReadBack);
    const corrected = corrections > 0;
    const summary =
        verdict === "mismatch"
            ? `Typed, but read-back still doesn't match — check the field.`
            : corrected
              ? `Typed and self-corrected (verified the field).`
              : verdict === "unverified"
                ? `Typed.`
                : `Typed and verified the field reads correctly.`;
    emit({ phase: "done", ok: verdict !== "mismatch", corrected, summary, ...(region ? { region } : {}) });
    return { intended, readBack: lastReadBack, verdict, corrected, summary, ...(region ? { region } : {}) };
}
