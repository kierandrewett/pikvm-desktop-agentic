import { PASTE_DELAY_S } from "../paste/print-query";

/** One step of a macro, as the server stores it. */
export type MacroStep =
    | { readonly type: "chord"; readonly mods?: readonly string[]; readonly code: string }
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "delay"; readonly ms: number };

/** The slice of a stored macro the engine needs to run or describe it. */
export interface MacroLike {
    readonly label: string;
    readonly icon?: string;
    readonly steps: readonly MacroStep[];
}

/**
 * The modifiers a chord can hold. Left-hand codes because that is what the target expects for
 * a plain modifier; AltGr is the exception worth offering separately, since on a UK layout it
 * is the only way to reach several characters and it is genuinely a different key from Alt.
 */
export const MACRO_MODS: ReadonlyArray<readonly [code: string, label: string]> = [
    ["ControlLeft", "Ctrl"],
    ["AltLeft", "Alt"],
    ["ShiftLeft", "Shift"],
    ["MetaLeft", "Super"],
    ["AltRight", "AltGr"],
];

export type MacroKeyGroup = readonly [group: string, keys: ReadonlyArray<readonly [code: string, label: string]>];

/**
 * The chord's key, offered as a list instead of recorded from a real press.
 *
 * A recorder can only ever capture what the HOST desktop lets through, and the chords most
 * worth keeping as a macro are exactly the ones it does not: Super+L locks the session before
 * the page sees it, Ctrl+Alt+F2 switches virtual terminal, and a compositor takes most Super
 * combinations for itself. Picking the key also means a macro can use a key this keyboard does
 * not physically have: F13-F24, or a numpad on a laptop.
 */
export function macroKeyGroups(): MacroKeyGroup[] {
    const letters = Array.from({ length: 26 }, (_, i): [string, string] => {
        const ch = String.fromCharCode(65 + i);
        return [`Key${ch}`, ch];
    });
    const digits = Array.from({ length: 10 }, (_, d): [string, string] => [`Digit${d}`, String(d)]);
    const fkeys = Array.from({ length: 24 }, (_, i): [string, string] => [`F${i + 1}`, `F${i + 1}`]);
    const numpad: Array<[string, string]> = Array.from({ length: 10 }, (_, n): [string, string] => [
        `Numpad${n}`,
        `Numpad ${n}`,
    ]);
    numpad.push(
        ["NumpadEnter", "Numpad Enter"],
        ["NumpadAdd", "Numpad +"],
        ["NumpadSubtract", "Numpad -"],
        ["NumpadMultiply", "Numpad *"],
        ["NumpadDivide", "Numpad /"],
        ["NumpadDecimal", "Numpad ."],
    );
    return [
        ["Letters", letters],
        ["Digits", digits],
        ["Function", fkeys],
        [
            "Editing",
            [
                ["Enter", "Enter"],
                ["Tab", "Tab"],
                ["Space", "Space"],
                ["Backspace", "Backspace"],
                ["Delete", "Delete"],
                ["Insert", "Insert"],
                ["Escape", "Escape"],
            ],
        ],
        [
            "Navigation",
            [
                ["Home", "Home"],
                ["End", "End"],
                ["PageUp", "Page Up"],
                ["PageDown", "Page Down"],
                ["ArrowUp", "Arrow Up"],
                ["ArrowDown", "Arrow Down"],
                ["ArrowLeft", "Arrow Left"],
                ["ArrowRight", "Arrow Right"],
            ],
        ],
        [
            "Punctuation",
            [
                ["Minus", "- minus"],
                ["Equal", "= equals"],
                ["BracketLeft", "[ bracket"],
                ["BracketRight", "] bracket"],
                ["Backslash", "\\ backslash"],
                ["Semicolon", "; semicolon"],
                ["Quote", "' quote"],
                ["Backquote", "` backquote"],
                ["Comma", ", comma"],
                ["Period", ". period"],
                ["Slash", "/ slash"],
            ],
        ],
        ["Numpad", numpad],
        [
            "System",
            [
                ["PrintScreen", "Print Screen"],
                ["ScrollLock", "Scroll Lock"],
                ["Pause", "Pause"],
                ["CapsLock", "Caps Lock"],
                ["NumLock", "Num Lock"],
                ["ContextMenu", "Menu"],
            ],
        ],
    ];
}

/**
 * What to draw in an icon-only macro button when the icon name did not resolve to one of ours.
 *
 * A MISSING icon falls through to the label's initials; an UNRECOGNISED one is a non-empty
 * string, so it must not short-circuit: it is what a macro written by another version of the
 * app, or an icon since dropped, looks like, and drawing its name into a 15 px box renders
 * "not-a-real-icon" clipped inside 30 px. A one or two character value is kept as-is, so a
 * literal glyph still works; anything longer is data we cannot draw.
 */
export function macroGlyph(macro: { readonly icon?: string; readonly label: string }): string {
    const icon = typeof macro.icon === "string" ? macro.icon.trim() : "";
    if (icon && Array.from(icon).length <= 2) return icon;
    return macro.label.slice(0, 2).toUpperCase();
}

/** A chord is charged a flat 120 ms: it is played out of a queue over a few timeouts. */
export const MACRO_CHORD_MS = 120;
/** Below this a run is over before a notice could be read. */
export const MACRO_NOTICE_MS = 2000;

/**
 * How long a macro will take, from its own steps. A text step posts to the same endpoint at the
 * same rate as the paste dialog, so a macro carrying 5,000 characters occupies the target for a
 * minute and a half. The estimate only has to be right enough to decide whether the run is
 * worth mentioning and roughly how long to expect.
 */
export function macroDuration(macro: Pick<MacroLike, "steps"> | null | undefined): number {
    let ms = 0;
    for (const step of macro?.steps ?? []) {
        if (step.type === "delay") ms += Number(step.ms) || 0;
        else if (step.type === "text") ms += String(step.text || "").length * PASTE_DELAY_S * 1000;
        else ms += MACRO_CHORD_MS;
    }
    return ms;
}

/**
 * A macro that cannot reach the target right now: chord steps go over the HID socket, text
 * steps POST to /api/hid/print and are unaffected by it. Per macro rather than for all of them,
 * because a text-only macro works perfectly well with the socket down.
 */
export function macroNeedsInput(macro: Pick<MacroLike, "steps"> | null | undefined): boolean {
    return (macro?.steps ?? []).some((s) => s.type === "chord");
}
