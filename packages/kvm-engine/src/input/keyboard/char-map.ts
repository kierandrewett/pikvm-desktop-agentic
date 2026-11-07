/**
 * Printable character -> physical key + shift, for the send-side layout.
 *
 * Both this and the agent's typing engine map a character to a PHYSICAL key code sent over
 * HID, and the target's own layout decides the glyph. If they disagree, a key typed by hand
 * and the same character typed by the agent land on different keys of the remote machine
 * (`"` arriving as `@`, or `\` as `#`) and nothing reports it.
 */

export type KeyboardLayout = "us" | "uk";

export interface PhysicalKey {
    readonly code: string;
    readonly shift: boolean;
}

const ROWS = ["`1234567890-=", "qwertyuiop[]\\", "asdfghjkl;'", "zxcvbnm,./"];
const SHIFT_ROWS = ["~!@#$%^&*()_+", "QWERTYUIOP{}|", 'ASDFGHJKL:"', "ZXCVBNM<>?"];
const CODE_ROWS = [
    "Backquote Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 Minus Equal".split(" "),
    "KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP BracketLeft BracketRight Backslash".split(" "),
    "KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL Semicolon Quote".split(" "),
    "KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash".split(" "),
];

function buildUs(): Map<string, PhysicalKey> {
    const map = new Map<string, PhysicalKey>();
    for (let r = 0; r < ROWS.length; r++) {
        const row = ROWS[r] ?? "";
        for (let c = 0; c < row.length; c++) {
            const code = CODE_ROWS[r]?.[c];
            const plain = row[c];
            const shifted = SHIFT_ROWS[r]?.[c];
            if (!code || !plain) continue;
            map.set(plain, { code, shift: false });
            if (shifted) map.set(shifted, { code, shift: true });
        }
    }
    map.set(" ", { code: "Space", shift: false });
    return map;
}

const US_MAP = buildUs();

/** UK ISO overrides on top of the US map. */
const UK_MAP: ReadonlyMap<string, PhysicalKey> = new Map<string, PhysicalKey>([
    ['"', { code: "Digit2", shift: true }],
    ["@", { code: "Quote", shift: true }],
    ["#", { code: "Backslash", shift: false }],
    ["~", { code: "Backslash", shift: true }],
    ["\\", { code: "IntlBackslash", shift: false }],
    ["|", { code: "IntlBackslash", shift: true }],
    ["\u00a3", { code: "Digit3", shift: true }],
    ["\u00ac", { code: "Backquote", shift: true }],
]);

function reverseMap(map: ReadonlyMap<string, PhysicalKey>): ReadonlyMap<string, readonly [string | null, string | null]> {
    const result = new Map<string, [string | null, string | null]>();
    for (const [character, key] of map) {
        const pair = result.get(key.code) ?? [null, null];
        pair[key.shift ? 1 : 0] = character;
        result.set(key.code, pair);
    }
    return result;
}

const REVERSE_MAPS = {
    us: reverseMap(US_MAP),
    uk: reverseMap(new Map([...US_MAP, ...UK_MAP])),
};

/** Reverse the known send-side map. Null means unknown, not that the physical key produces no text. */
export function keyToChar(key: PhysicalKey, layout: KeyboardLayout): string | null {
    return REVERSE_MAPS[layout].get(key.code)?.[key.shift ? 1 : 0] ?? null;
}

/** Map a single character to a physical key + shift state for the layout, or null if the layout has none. */
export function charToKey(ch: string, layout: KeyboardLayout): PhysicalKey | null {
    if (layout === "uk") {
        const uk = UK_MAP.get(ch);
        if (uk) return uk;
    }
    return US_MAP.get(ch) ?? null;
}

/** True for A-Z keys, whose case Caps Lock inverts. */
export function isLetterKey(code: string): boolean {
    return /^Key[A-Z]$/.test(code);
}
