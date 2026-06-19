/**
 * Human input engine.
 *
 * Turns intended text into a realistic stream of keystrokes — with
 * keystroke-dynamics timing, QWERTY-aware typos, and a believable
 * backspace-and-retype correction dance — that the PiKVM control core plays out
 * over the HID WebSocket.
 *
 * Hard invariants:
 *  - The *final* typed buffer always equals the intended text. Corruption lives
 *    only in the keystroke path, never the result.
 *  - No Enter/submit-class key is ever emitted while the buffer differs from the
 *    intended text.
 *
 * Everything is driven by a seeded PRNG so a run is reproducible if needed but
 * different every session.
 */

/** A single physical key actuation. `code` is a JS `KeyboardEvent.code`. */
export interface KeyStroke {
    /** JS event.code, e.g. "KeyA", "Digit1", "Space", "Backspace", "Enter". */
    code: string;
    /** Whether Shift is held for this stroke. */
    shift: boolean;
    /** How long the key is held down (ms). */
    downMs: number;
    /** Idle gap after the key is released, before the next stroke (ms). */
    gapMs: number;
}

export interface Persona {
    /** Target words-per-minute for fluent stretches. */
    wpm: number;
    /** 0..1 skill — higher = lower variance, fewer errors, better correction. */
    skill: number;
    /** Base per-character error probability for prose. */
    errorRate: number;
    /** Baseline key-down dwell (ms). */
    dwell: number;
}

export interface TypingOptions {
    /** Treat the text as code (whitespace/indent never corrupted, different rhythm). */
    code?: boolean;
    /** Persona to type as. Defaults to a fresh random persona. */
    persona?: Persona;
    /**
     * 0..1 multiplier that *tempers* (never disables) the human feel. 1 = full
     * humanity; lower reduces typo frequency for precision-critical fields.
     * Timing/cadence always stays on.
     */
    intensity?: number;
    /** Baseline words-per-minute the random persona centers on (randomness kept). */
    wpm?: number;
    /** Explicit seed for reproducibility. */
    seed?: number;
    /** Target keyboard layout. We send physical key codes, so this decides glyphs. */
    layout?: "us" | "uk";
}

/* ------------------------------------------------------------------ *
 * Seeded PRNG (mulberry32)
 * ------------------------------------------------------------------ */

function makeRng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

type Rng = () => number;

function randRange(rng: Rng, min: number, max: number) {
    return min + (max - min) * rng();
}

function randInt(rng: Rng, min: number, max: number) {
    return Math.floor(randRange(rng, min, max + 1));
}

/** Right-skewed (log-normal-ish) positive noise centred near 1. */
function lognormalNoise(rng: Rng, sigma: number) {
    // Box–Muller for a standard normal, then exponentiate.
    const u1 = Math.max(rng(), 1e-9);
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.exp(z * sigma);
}

/* ------------------------------------------------------------------ *
 * US-QWERTY key map + physical geometry
 * ------------------------------------------------------------------ */

interface KeyInfo {
    code: string;
    shift: boolean;
    /** Physical row (0 = number row .. 3 = bottom). */
    row: number;
    /** Physical column index within the row. */
    col: number;
    /** Hand that normally presses the key. */
    hand: "L" | "R";
}

// Physical rows as they sit on the board. Each entry: unshifted char.
const ROWS: string[][] = [
    "`1234567890-=".split(""),
    "qwertyuiop[]\\".split(""),
    "asdfghjkl;'".split(""),
    "zxcvbnm,./".split(""),
];

// Shifted counterparts, positionally aligned with ROWS.
const SHIFT_ROWS: string[][] = [
    "~!@#$%^&*()_+".split(""),
    "QWERTYUIOP{}|".split(""),
    'ASDFGHJKL:"'.split(""),
    "ZXCVBNM<>?".split(""),
];

// JS event.code per physical key, aligned with ROWS.
const CODE_ROWS: string[][] = [
    "Backquote Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 Minus Equal".split(" "),
    "KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP BracketLeft BracketRight Backslash".split(" "),
    "KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL Semicolon Quote".split(" "),
    "KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash".split(" "),
];

// Rough hand split by column (QWERTY): left hand presses the left half.
function handFor(row: number, col: number): "L" | "R" {
    const splits = [6, 5, 4, 4]; // first right-hand column per row
    return col < splits[row]! ? "L" : "R";
}

const CHAR_TO_KEY = new Map<string, KeyInfo>();
for (let r = 0; r < ROWS.length; r++) {
    for (let c = 0; c < ROWS[r]!.length; c++) {
        const hand = handFor(r, c);
        const code = CODE_ROWS[r]![c]!;
        CHAR_TO_KEY.set(ROWS[r]![c]!, { code, shift: false, row: r, col: c, hand });
        const sh = SHIFT_ROWS[r]![c];
        if (sh) CHAR_TO_KEY.set(sh, { code, shift: true, row: r, col: c, hand });
    }
}
CHAR_TO_KEY.set(" ", { code: "Space", shift: false, row: 4, col: 4, hand: "R" });

// UK ISO layout overrides for the printable chars whose PHYSICAL key differs from
// US (everything else is identical). We send physical key codes over HID, so the
// target's layout decides the glyph; without this, `cd ~/...` types `cd ¬/...` and
// `"` types `@` on a UK target. row/col/hand are approximate (only used by the
// typo engine, which rarely substitutes symbols).
const UK_OVERRIDES = new Map<string, KeyInfo>([
    ['"', { code: "Digit2", shift: true, row: 0, col: 2, hand: "L" }],
    ["@", { code: "Quote", shift: true, row: 2, col: 10, hand: "R" }],
    ["#", { code: "Backslash", shift: false, row: 1, col: 12, hand: "R" }],
    ["~", { code: "Backslash", shift: true, row: 1, col: 12, hand: "R" }],
    ["\\", { code: "IntlBackslash", shift: false, row: 3, col: 0, hand: "L" }],
    ["|", { code: "IntlBackslash", shift: true, row: 3, col: 0, hand: "L" }],
    ["£", { code: "Digit3", shift: true, row: 0, col: 3, hand: "L" }],
    ["¬", { code: "Backquote", shift: true, row: 0, col: 0, hand: "L" }],
]);

/** Physical neighbours of a printable char (same row ±1, adjacent rows). */
function neighbours(ch: string): string[] {
    const k = CHAR_TO_KEY.get(ch);
    if (!k || k.code === "Space") return [];
    const out: string[] = [];
    for (let dr = -1; dr <= 1; dr++) {
        const r = k.row + dr;
        if (r < 0 || r >= ROWS.length) continue;
        for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const c = k.col + dc;
            if (c < 0 || c >= ROWS[r]!.length) continue;
            // Preserve the original char's case-ness so substitutions stay plausible.
            const base = ROWS[r]![c]!;
            out.push(k.shift ? base.toUpperCase() : base);
        }
    }
    return out.filter((x) => CHAR_TO_KEY.has(x));
}

function keyFor(ch: string, layout: "us" | "uk" = "us"): KeyInfo | undefined {
    if (layout === "uk") {
        const override = UK_OVERRIDES.get(ch);
        if (override) return override;
    }
    return CHAR_TO_KEY.get(ch);
}

/* ------------------------------------------------------------------ *
 * Persona
 * ------------------------------------------------------------------ */

/** Default baseline WPM the random persona centers on. */
export const DEFAULT_BASE_WPM = 95;

export function createPersona(seed?: number, baseWpm = DEFAULT_BASE_WPM): Persona {
    const rng = makeRng(seed ?? ((Math.random() * 2 ** 31) | 0));
    const skill = randRange(rng, 0.35, 0.95);
    return {
        // Randomised ±18% around the configured baseline, so each run differs
        // but tracks the chosen speed.
        wpm: Math.round(randRange(rng, baseWpm * 0.82, baseWpm * 1.18)),
        skill,
        // Better typists make fewer mistakes.
        errorRate: randRange(rng, 0.005, 0.035) * (1.2 - skill),
        dwell: randRange(rng, 60, 110),
    };
}

/* ------------------------------------------------------------------ *
 * Timing model
 * ------------------------------------------------------------------ */

/** Base inter-key gap (ms) implied by a WPM (≈5 chars/word). */
function baseGapMs(wpm: number) {
    return 60000 / (wpm * 5);
}

/** Digraph factor: same-finger/same-hand slower, alternating hands faster. */
function digraphFactor(prev: KeyInfo | undefined, cur: KeyInfo): number {
    if (!prev) return 1;
    if (prev.code === cur.code) return 1.7; // same key repeated
    if (prev.hand === cur.hand) {
        // crude "same finger" proxy: same hand & adjacent column
        return Math.abs(prev.col - cur.col) <= 1 ? 1.7 : 1.15;
    }
    return 0.82; // alternating hands
}

const COMMON_BIGRAMS = new Set([
    "th", "he", "in", "er", "an", "re", "on", "at", "en", "nd", "ti", "es",
    "or", "te", "of", "ed", "is", "it", "al", "ar", "st", "to", "nt", "ng",
]);

/* ------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------ */

interface Plan {
    strokes: KeyStroke[];
}

/** A pending corruption applied to a single intended character. */
type Corruption =
    | { kind: "substitute"; wrong: string }
    | { kind: "transpose" } // swap this char with the next
    | { kind: "insert"; extra: string } // type an extra char before the correct one
    | { kind: "double" } // type this char twice
    | { kind: "omit" }; // skip this char (deletion)

function pickCorruption(rng: Rng, ch: string, next: string | undefined): Corruption | null {
    const nb = neighbours(ch);
    const roll = rng();
    if (nb.length && roll < 0.45) {
        return { kind: "substitute", wrong: nb[randInt(rng, 0, nb.length - 1)]! };
    }
    if (next && next !== " " && roll < 0.65) return { kind: "transpose" };
    if (nb.length && roll < 0.82) {
        return { kind: "insert", extra: nb[randInt(rng, 0, nb.length - 1)]! };
    }
    if (roll < 0.92) return { kind: "double" };
    return { kind: "omit" };
}

class Planner {
    private strokes: KeyStroke[] = [];
    private prevKey: KeyInfo | undefined;
    private readonly base: number;

    constructor(
        private rng: Rng,
        private persona: Persona,
        private opts: Required<Pick<TypingOptions, "code" | "intensity" | "layout">>,
    ) {
        this.base = baseGapMs(persona.wpm);
    }

    private pushChar(ch: string, extraGap = 0, pause = false) {
        const key = keyFor(ch, this.opts.layout);
        if (!key) {
            // Unsupported char (e.g. newline handled by caller) — skip silently.
            return;
        }
        const factor = digraphFactor(this.prevKey, key);
        const sigma = 0.45 * (1.2 - this.persona.skill);
        // Full key-to-key interval (down + idle), so the cadence matches WPM.
        let interval = this.base * factor * lognormalNoise(this.rng, sigma);
        if (pause) interval += randRange(this.rng, 250, this.opts.code ? 1400 : 900);
        interval += extraGap;
        const dwell = this.persona.dwell * randRange(this.rng, 0.7, 1.3);
        const gap = Math.max(interval - dwell, 12);
        this.strokes.push({ code: key.code, shift: key.shift, downMs: Math.round(dwell), gapMs: Math.round(gap) });
        this.prevKey = key;
    }

    private pushKey(code: string, gap?: number) {
        const dwell = this.persona.dwell * randRange(this.rng, 0.6, 1.1);
        this.strokes.push({
            code,
            shift: false,
            downMs: Math.round(dwell),
            gapMs: Math.round(gap ?? this.base * randRange(this.rng, 0.5, 0.9)),
        });
        this.prevKey = undefined;
    }

    /** Type a run of plain characters with realistic typos + correction. */
    private typeRun(text: string) {
        // `typed` mirrors what is currently in the target buffer for this run.
        let typed = "";
        let i = 0;
        const errorRate = this.persona.errorRate * this.opts.intensity * (this.opts.code ? 0.5 : 1);
        // Bound total corrections so no seed can ever livelock real hardware.
        let corrections = 0;
        const maxCorrections = Math.ceil(text.length * 0.25) + 2;

        while (i < text.length) {
            const ch = text[i]!;
            const next = text[i + 1];
            const isBoundary = ch === " " || typed.length === 0;
            const bigram = (text[i - 1] ?? "") + ch;
            const burst = COMMON_BIGRAMS.has(bigram.toLowerCase());

            const corrupt =
                keyFor(ch, this.opts.layout) && ch !== " " && corrections < maxCorrections && this.rng() < errorRate
                    ? pickCorruption(this.rng, ch, next)
                    : null;

            if (!corrupt) {
                this.pushChar(ch, burst ? -this.base * 0.25 : 0, isBoundary && this.rng() < 0.18);
                typed += ch;
                i++;
                continue;
            }

            // Apply a corruption, then notice + correct it a few keystrokes later.
            corrections++;
            const wrongStart = typed.length;
            switch (corrupt.kind) {
                case "substitute":
                    this.pushChar(corrupt.wrong);
                    typed += corrupt.wrong;
                    break;
                case "double":
                    this.pushChar(ch);
                    this.pushChar(ch);
                    typed += ch + ch;
                    break;
                case "insert":
                    this.pushChar(corrupt.extra);
                    this.pushChar(ch);
                    typed += corrupt.extra + ch;
                    break;
                case "omit":
                    // Skip the char entirely; will be caught on correction.
                    break;
                case "transpose":
                    if (next) {
                        this.pushChar(next);
                        this.pushChar(ch);
                        typed += next + ch;
                        i++; // consumed `next` as well
                    } else {
                        this.pushChar(ch);
                        typed += ch;
                    }
                    break;
            }
            i++;

            // Keep typing a few more (wrong, since text diverged) characters before
            // noticing — humans run ahead of their eyes.
            const lag = randInt(this.rng, 0, this.persona.skill > 0.7 ? 2 : 4);
            let lagDone = 0;
            while (lagDone < lag && i < text.length && text[i] !== " ") {
                this.pushChar(text[i]!);
                typed += text[i]!;
                i++;
                lagDone++;
            }

            // Notice: pause, then backspace past the error to a restart point.
            // For an `omit` (which added nothing) bias toward retyping the whole
            // word so the correction is actually visible.
            const target = this.chooseRestart(typed, wrongStart, corrupt.kind === "omit");
            const deleteCount = typed.length - target;
            for (let d = 0; d < deleteCount; d++) {
                // The first backspace is a deliberate "I noticed" pause; the rest
                // run off in a quicker rhythm.
                const gap = d === 0 ? randRange(this.rng, 180, 500) : this.base * randRange(this.rng, 0.35, 0.7);
                this.pushKey("Backspace", gap);
            }
            typed = typed.slice(0, target);
            // Rewind the source index so we retype from the restart point forward.
            i = this.sourceIndexFor(text, typed);
        }
    }

    /** Pick how far back to delete: usually a couple chars before the error,
     *  sometimes all the way to the start of the current word/token. */
    private chooseRestart(typed: string, errorAt: number, preferWord = false): number {
        const wordStart = Math.max(typed.lastIndexOf(" ", errorAt - 1) + 1, 0);
        if (preferWord || this.rng() < 0.5) return wordStart; // retype the whole word
        const before = Math.max(wordStart, errorAt - randInt(this.rng, 1, 2));
        // Occasionally over-delete one correct char.
        return Math.max(wordStart, this.rng() < 0.2 ? before - 1 : before);
    }

    /** Map a correctly-typed prefix back to its index in the source text. */
    private sourceIndexFor(text: string, typedPrefix: string): number {
        // typedPrefix is by construction a correct prefix of the current word run,
        // so its length maps 1:1 onto the source once we account for the run start.
        return typedPrefix.length;
    }

    plan(text: string): Plan {
        // Split on newlines so Enter is an explicit, never-corrupted key, and so
        // indentation/whitespace is preserved verbatim in code mode.
        const lines = text.split("\n");
        for (let l = 0; l < lines.length; l++) {
            const line = lines[l]!;
            if (this.opts.code) {
                // Preserve leading indentation exactly, type the rest humanly.
                const indent = line.match(/^[\t ]*/)?.[0] ?? "";
                for (const ws of indent) this.pushChar(ws === "\t" ? "\t" : " ");
                this.typeRun(line.slice(indent.length));
            } else {
                this.typeRun(line);
            }
            if (l < lines.length - 1) this.pushKey("Enter", this.base * randRange(this.rng, 1.5, 3));
        }
        return { strokes: this.strokes };
    }
}

// Tab isn't in CHAR_TO_KEY by default; register it for code indentation.
CHAR_TO_KEY.set("\t", { code: "Tab", shift: false, row: 1, col: -1, hand: "L" });

/**
 * Plan a humanlike keystroke sequence for `text`. The returned strokes, when
 * played in order, leave exactly `text` in the target buffer.
 */
/** True if the text contains any line break (so callers can warn before typing). */
export function hasNewline(text: string): boolean {
    return /[\r\n]/.test(text);
}

/**
 * HARD GUARDRAIL: collapse every line break to a single space so typing can NEVER
 * emit Enter. Pressing Enter mid-type would submit a chat message, run a command,
 * or confirm a dialog — an Enter/submit must always be a separate, explicit,
 * reviewable key press, never a side effect of typing text.
 */
export function stripNewlines(text: string): string {
    return text.replace(/[\r\n]+/g, " ");
}

export function planTyping(text: string, opts: TypingOptions = {}): KeyStroke[] {
    text = stripNewlines(text);
    // `wpm` is a *baseline* the random persona centers on — randomness is kept.
    const persona = opts.persona ?? createPersona(opts.seed, opts.wpm && opts.wpm > 0 ? opts.wpm : undefined);
    const seed = opts.seed ?? ((persona.wpm * 7919 + Math.floor(persona.skill * 1e6)) | 0);
    const rng = makeRng(seed);
    const planner = new Planner(rng, persona, {
        code: opts.code ?? looksLikeCode(text),
        intensity: clamp01(opts.intensity ?? 1),
        layout: opts.layout ?? "us",
    });
    return applyCapsLock(planner.plan(text).strokes, makeRng((seed ^ 0x9e3779b1) >>> 0), persona);
}

const isUpperLetter = (s: KeyStroke) => s.shift && /^Key[A-Z]$/.test(s.code);

/**
 * Like a human, use Caps Lock for runs of 3+ consecutive uppercase letters
 * (acronyms / ALL-CAPS words) instead of holding Shift the whole time. Shorter
 * runs and sentence-initial capitals keep using Shift.
 */
function applyCapsLock(strokes: KeyStroke[], rng: Rng, persona: Persona): KeyStroke[] {
    const caps = (): KeyStroke => ({
        code: "CapsLock",
        shift: false,
        downMs: Math.round(persona.dwell * randRange(rng, 0.7, 1.1)),
        gapMs: Math.round(baseGapMs(persona.wpm) * randRange(rng, 0.5, 1.0)),
    });
    const out: KeyStroke[] = [];
    let i = 0;
    while (i < strokes.length) {
        if (isUpperLetter(strokes[i]!)) {
            let j = i;
            while (j < strokes.length && isUpperLetter(strokes[j]!)) j++;
            if (j - i >= 3 && rng() < 0.65) {
                out.push(caps());
                for (let k = i; k < j; k++) out.push({ ...strokes[k]!, shift: false });
                out.push(caps());
                i = j;
                continue;
            }
        }
        out.push(strokes[i]!);
        i++;
    }
    return out;
}

function clamp01(n: number) {
    return Math.max(0, Math.min(1, n));
}

/** Heuristic: does this text read like source code? */
export function looksLikeCode(text: string): boolean {
    const symbols = (text.match(/[{}();=<>[\]]/g) ?? []).length;
    const lines = text.split("\n");
    const indented = lines.filter((l) => /^[\t ]{2,}/.test(l)).length;
    return symbols / Math.max(text.length, 1) > 0.04 || indented >= 2;
}
