/**
 * Keyboard chord decisions.
 *
 * Pure: takes a KeyboardEvent-shaped object plus the armed sticky modifiers, and returns what
 * the target should receive. This is the part that has to be exactly right. A dropped
 * modifier here is not a missing keystroke, it is a DIFFERENT one: Shift+Enter arriving as
 * Enter sends the message instead of breaking the line, and Ctrl+Shift+Esc arriving as
 * Ctrl+Esc opens the Start menu instead of Task Manager.
 */

/** The slice of KeyboardEvent the engine reads; a real event satisfies it. */
export interface KeyEventLike {
    readonly code?: string;
    readonly key?: string;
    readonly shiftKey?: boolean;
    readonly ctrlKey?: boolean;
    readonly altKey?: boolean;
    readonly metaKey?: boolean;
    readonly repeat?: boolean;
    readonly isComposing?: boolean;
    /** 229 is what an IME reports for everything it handles. */
    readonly keyCode?: number;
    getModifierState?(key: string): boolean;
}

export type IgnoreReason = "composing" | "bare-modifier" | "no-code" | "printable-handled-elsewhere";

export type Decision =
    /** Send these modifiers held around this key. */
    | { readonly kind: "chord"; readonly mods: string[]; readonly code: string }
    /** A printable character; case is resolved by the layout and the target's Caps Lock. */
    | { readonly kind: "char"; readonly char: string }
    /** Consume the event, send nothing. */
    | { readonly kind: "swallow"; readonly why: string }
    /** Not ours; leave the event alone. */
    | { readonly kind: "ignore"; readonly why: IgnoreReason };

export interface DecideOptions {
    /** Sticky on-screen modifiers the user armed. */
    readonly armed?: readonly string[];
    /** False for the hidden-input path, where beforeinput (and the soft keyboard) produce characters. */
    readonly printable?: boolean;
}

/** Named keys forwarded by code rather than by the character they produce. */
const CONTROL_KEYS: ReadonlySet<string> = new Set([
    "Enter",
    "Backspace",
    "Tab",
    "Escape",
    "Delete",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
]);

const BARE_MODIFIER = /^(Control|Alt|Meta|Shift)(Left|Right)?$/;
const FUNCTION_KEY = /^F\d{1,2}$/;

function hasShift(mods: readonly string[]): boolean {
    return mods.includes("ShiftLeft") || mods.includes("ShiftRight");
}

/**
 * Every modifier that should be held for this chord: the ones physically down on the host,
 * plus any sticky on-screen modifiers the user armed. Shift is resolved HERE rather than left
 * to each call site: passing it separately is what let the control-key path drop it silently.
 * A physical ShiftRight or an armed Shift is never doubled up with a synthetic ShiftLeft,
 * because pressing one physical key twice leaves it stuck down on the target.
 */
export function chordMods(ev: KeyEventLike, armed?: readonly string[]): string[] {
    const mods: string[] = [];
    if (ev.ctrlKey) mods.push("ControlLeft");
    if (ev.altKey) mods.push("AltLeft");
    if (ev.metaKey) mods.push("MetaLeft");
    for (const code of armed ?? []) if (!mods.includes(code)) mods.push(code);
    if (ev.shiftKey && !hasShift(mods)) mods.push("ShiftLeft");
    return mods;
}

/** What to send for a keydown. */
export function decide(ev: KeyEventLike, opts: DecideOptions = {}): Decision {
    const code = ev.code || "";
    const key = ev.key || "";
    if (ev.isComposing) return { kind: "ignore", why: "composing" };
    if (BARE_MODIFIER.test(code)) return { kind: "ignore", why: "bare-modifier" };
    // Caps Lock is forwarded on its own, never inside a chord: the engine keeps the target's
    // Caps Lock in step with the host's and resolves letter case against the target's LED
    // when each key is played.
    if (code === "CapsLock" || key === "CapsLock") return { kind: "chord", mods: [], code: "CapsLock" };

    const mods = chordMods(ev, opts.armed);
    const control = CONTROL_KEYS.has(code) ? code : CONTROL_KEYS.has(key) ? key : FUNCTION_KEY.test(code) ? code : null;
    if (control) return { kind: "chord", mods, code: control };

    // A hardware chord (Ctrl+C, Ctrl+Shift+T). Shift alone does NOT land here: it belongs to
    // the printable path, where the layout map resolves the glyph.
    if (ev.ctrlKey || ev.altKey || ev.metaKey) {
        if (!code) return { kind: "ignore", why: "no-code" };
        return { kind: "chord", mods, code };
    }

    if (!opts.printable) return { kind: "ignore", why: "printable-handled-elsewhere" };
    if (key.length === 1) return { kind: "char", char: key };
    // A named key we have no mapping for (Insert, PrintScreen, media keys).
    if (code) return { kind: "chord", mods, code };
    return { kind: "ignore", why: "no-code" };
}
