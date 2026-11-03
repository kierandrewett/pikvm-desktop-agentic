import { charToKey } from "../input/keyboard/char-map";

/**
 * Key chords as the model writes them: `ctrl+c`, `Alt+F4`, `super`, `ctrl+alt+Delete`.
 *
 * A chord is modifiers then at most one key. The result names physical key codes, the same
 * `KeyboardEvent.code` strings the HID socket takes, so the target's own layout decides the glyph.
 */

export interface Chord {
    /** Modifier codes in the order they are pressed. */
    readonly mods: readonly string[];
    /** The one non-modifier key, or null for a modifier pressed on its own (`super`). */
    readonly key: string | null;
    /** Canonical lower-case spelling, left/right folded: what the risk rules match against. */
    readonly canonical: string;
}

export class ChordError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ChordError";
    }
}

const MODIFIERS: ReadonlyMap<string, string> = new Map([
    ["ctrl", "ControlLeft"],
    ["control", "ControlLeft"],
    ["alt", "AltLeft"],
    ["option", "AltLeft"],
    ["altgr", "AltRight"],
    ["shift", "ShiftLeft"],
    ["meta", "MetaLeft"],
    ["super", "MetaLeft"],
    ["win", "MetaLeft"],
    ["windows", "MetaLeft"],
    ["cmd", "MetaLeft"],
    ["command", "MetaLeft"],
]);

/** The canonical modifier word for a code, left and right alike. */
const MOD_WORD: ReadonlyMap<string, string> = new Map([
    ["ControlLeft", "ctrl"],
    ["ControlRight", "ctrl"],
    ["AltLeft", "alt"],
    ["AltRight", "altgr"],
    ["ShiftLeft", "shift"],
    ["ShiftRight", "shift"],
    ["MetaLeft", "meta"],
    ["MetaRight", "meta"],
]);

/** Canonical modifier order, so `shift+ctrl+x` and `ctrl+shift+x` are one chord. */
const MOD_ORDER = ["ctrl", "alt", "altgr", "shift", "meta"];

const NAMED: ReadonlyMap<string, string> = new Map([
    ["enter", "Enter"],
    ["return", "Enter"],
    ["esc", "Escape"],
    ["escape", "Escape"],
    ["tab", "Tab"],
    ["space", "Space"],
    ["spacebar", "Space"],
    ["backspace", "Backspace"],
    ["delete", "Delete"],
    ["del", "Delete"],
    ["insert", "Insert"],
    ["ins", "Insert"],
    ["home", "Home"],
    ["end", "End"],
    ["pageup", "PageUp"],
    ["pgup", "PageUp"],
    ["pagedown", "PageDown"],
    ["pgdn", "PageDown"],
    ["up", "ArrowUp"],
    ["down", "ArrowDown"],
    ["left", "ArrowLeft"],
    ["right", "ArrowRight"],
    ["capslock", "CapsLock"],
    ["numlock", "NumLock"],
    ["scrolllock", "ScrollLock"],
    ["printscreen", "PrintScreen"],
    ["prtsc", "PrintScreen"],
    ["pause", "Pause"],
    ["menu", "ContextMenu"],
    ["minus", "Minus"],
    ["equal", "Equal"],
    ["comma", "Comma"],
    ["period", "Period"],
    ["slash", "Slash"],
    ["semicolon", "Semicolon"],
    ["quote", "Quote"],
    ["backquote", "Backquote"],
    ["backslash", "Backslash"],
    ["bracketleft", "BracketLeft"],
    ["bracketright", "BracketRight"],
]);

const CODE_NAMES: ReadonlySet<string> = new Set([
    ...NAMED.values(),
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "IntlBackslash",
]);

function keyCode(token: string): string | null {
    const lower = token.toLowerCase();
    const named = NAMED.get(lower);
    if (named) return named;
    if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) return `F${lower.slice(1)}`;
    if (/^[a-z]$/.test(lower)) return `Key${lower.toUpperCase()}`;
    if (/^[0-9]$/.test(lower)) return `Digit${lower}`;
    // A raw KeyboardEvent.code the model already knows (`KeyA`, `Numpad5`, `ArrowUp`).
    if (CODE_NAMES.has(token) || /^(Key[A-Z]|Digit[0-9]|Numpad\w+|F\d{1,2})$/.test(token)) return token;
    // A bare punctuation character (`ctrl+/`, `alt+;`) resolves through the US layout's physical key.
    if (token.length === 1) {
        const physical = charToKey(token, "us");
        if (physical && !physical.shift) return physical.code;
    }
    return null;
}

/** `KeyC` is `c` and `Digit1` is `1`; everything else is its code in lower case (`f4`, `delete`). */
function keyWord(code: string): string {
    const letterOrDigit = /^(?:Key|Digit)(.)$/.exec(code);
    return letterOrDigit?.[1] ? letterOrDigit[1].toLowerCase() : code.toLowerCase();
}

/** Parse one chord. Throws ChordError, naming the part it could not read. */
export function parseChord(text: string): Chord {
    const trimmed = text.trim();
    if (!trimmed) throw new ChordError("an empty key chord");
    // "+" is the separator, so a literal plus key cannot be written; `ctrl++` fails below as an empty part.
    const tokens = trimmed.split("+").map((t) => t.trim());
    if (tokens.some((t) => !t)) throw new ChordError(`"${text}" has an empty part; join keys with a single "+"`);
    const mods: string[] = [];
    let key: string | null = null;
    for (const token of tokens) {
        const mod = MODIFIERS.get(token.toLowerCase());
        if (mod) {
            if (!mods.includes(mod)) mods.push(mod);
            continue;
        }
        const code = keyCode(token);
        if (!code) throw new ChordError(`"${token}" is not a key name I know (in "${text}")`);
        if (key) throw new ChordError(`"${text}" has two non-modifier keys (${key} and ${code}); send them as separate chords`);
        key = code;
    }
    if (key === null && mods.length === 0) throw new ChordError(`"${text}" names no key`);
    const words = new Set(mods.map((m) => MOD_WORD.get(m) ?? m));
    const ordered = MOD_ORDER.filter((w) => words.has(w));
    const canonical = [...ordered, ...(key ? [keyWord(key)] : [])].join("+");
    return { mods, key, canonical };
}

/** Parse a list of chords, failing on the first bad one before anything is sent. */
export function parseChords(texts: readonly string[]): Chord[] {
    return texts.map(parseChord);
}
