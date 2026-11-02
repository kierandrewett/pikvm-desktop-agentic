/**
 * Soft keyboard: mirror the field, do not trust the events.
 *
 * Phone keyboards do not describe what they type. Android IMEs send keyCode 229 for
 * everything and deliver words through composition; dictation drops whole phrases in at once
 * and rewrites them as recognition settles; swipe typing inserts a word and then swaps it for
 * a suggestion; an empty field gives Gboard nothing to delete, so its Backspace fires no event
 * at all. Reading event by event loses keys in every one of those cases.
 *
 * So the field is treated as the record of what has been typed, and every change to it is
 * replayed on the target as a diff against the last value: one Backspace per character
 * removed after the common prefix, then the characters added. A rewrite in the middle
 * (dictation correcting a word, the iOS space-bar cursor) becomes "back up to the edit,
 * retype the rest", which is exactly what the target needs for its caret at the end.
 *
 * This file is the pure core: `diffField` is a function, `createFieldMirror` the small state
 * machine around it. The DOM adapter (hidden-field.dom.ts) only forwards events.
 */

/**
 * Keeps something in front of the caret, so a Backspace on an "empty" field still changes it.
 * Pad characters count as typed for deletion and are never sent themselves.
 */
export const KB_PAD = "\u200b\u200b\u200b\u200b";
/** Past this, start a fresh buffer between words. */
export const KB_MAX = 96;
const PAD_CHAR = "\u200b";
/** The placeholder iOS dictation holds the caret with while it listens. */
const DICTATION_PLACEHOLDER = /\uFFFC/g;

/**
 * Typographic substitutions a phone keyboard makes on its own (smart quotes, "--" to an em
 * dash). The target only has ASCII keys, and dropping the character would lose an apostrophe
 * from every "don't" typed on an iPhone.
 */
export const KB_FOLD: Readonly<Record<string, string>> = {
    "\u2018": "'",
    "\u2019": "'",
    "\u201a": "'",
    "\u201c": '"',
    "\u201d": '"',
    "\u201e": '"',
    "\u2013": "-",
    "\u2014": "--",
    "\u2026": "...",
    "\u00a0": " ",
};

export type MirrorAction =
    | { readonly type: "backspace" }
    | { readonly type: "newline" }
    | { readonly type: "char"; readonly char: string };

export interface FieldDiff {
    /** What to do on the target, in order. */
    readonly actions: MirrorAction[];
    /** The value to remember as "already replayed" (dictation placeholders removed). */
    readonly synced: string;
}

/**
 * The target actions that turn what `previous` represents into what `value` holds, or null if
 * nothing changed. `canType` says whether the layout has a key for a character: only those
 * (plus pad and folded characters) were ever sent, so only those need a Backspace.
 */
export function diffField(previous: string, value: string, canType: (ch: string) => boolean): FieldDiff | null {
    const next = Array.from(value.replace(DICTATION_PLACEHOLDER, ""));
    const prev = Array.from(previous);
    let p = 0;
    while (p < prev.length && p < next.length && prev[p] === next[p]) p++;
    if (p === prev.length && p === next.length) return null;

    const actions: MirrorAction[] = [];
    for (let i = p; i < prev.length; i++) {
        const ch = prev[i];
        if (ch === undefined) continue;
        const fold = KB_FOLD[ch];
        if (ch === PAD_CHAR || fold || canType(ch)) {
            for (let r = 0; r < (fold ? fold.length : 1); r++) actions.push({ type: "backspace" });
        }
    }
    for (let j = p; j < next.length; j++) {
        const ch = next[j];
        if (ch === undefined || ch === PAD_CHAR) continue;
        if (ch === "\n") {
            actions.push({ type: "newline" });
            continue;
        }
        for (const c of KB_FOLD[ch] ?? ch) actions.push({ type: "char", char: c });
    }
    return { actions, synced: next.join("") };
}

/** The input element, as the mirror sees it. */
export interface FieldPort {
    read(): string;
    /** Replace the value and put the caret at the end. */
    write(value: string): void;
}

/** What the mirror drives on the target; the keyboard facade satisfies it. */
export interface MirrorSink {
    canType(ch: string): boolean;
    sendBackspace(): void;
    sendNewline(): void;
    sendChar(ch: string): void;
}

export interface FieldMirror {
    /** Bring the field back to the pad and forget the history (the target's caret moved, or focus was lost). */
    reset(): void;
    /** Replay what changed since the last sync. */
    sync(): void;
    /**
     * Bring the field back to the pad when the pad was eaten into or the buffer grew long.
     * Never mid-composition: replacing the value under an IME aborts the word it is building.
     */
    settle(): void;
    /**
     * An `input` event. `blocked` (a modal or the full PiKVM UI owns the keyboard) discards
     * the field instead of replaying it.
     */
    input(isComposing: boolean, blocked?: boolean): void;
    compositionStart(): void;
    compositionEnd(): void;
    blur(): void;
    isComposing(): boolean;
}

export function createFieldMirror(field: FieldPort, sink: MirrorSink): FieldMirror {
    let prev = "";
    let composing = false;

    const reset = (): void => {
        prev = KB_PAD;
        if (field.read() === KB_PAD) return;
        field.write(KB_PAD);
    };
    const sync = (): void => {
        const diff = diffField(prev, field.read(), (ch) => sink.canType(ch));
        if (!diff) return;
        prev = diff.synced;
        for (const action of diff.actions) {
            if (action.type === "backspace") sink.sendBackspace();
            else if (action.type === "newline") sink.sendNewline();
            else sink.sendChar(action.char);
        }
    };
    const settle = (): void => {
        if (composing) return;
        const value = field.read();
        if (!value.startsWith(KB_PAD) || (value.length > KB_MAX && /\s$/.test(value))) reset();
    };

    return {
        reset,
        sync,
        settle,
        input(isComposing, blocked = false) {
            if (blocked) {
                reset();
                return;
            }
            if (isComposing) composing = true;
            sync();
            settle();
        },
        compositionStart() {
            composing = true;
        },
        compositionEnd() {
            composing = false;
            sync();
            settle();
        },
        blur() {
            composing = false;
            reset();
        },
        isComposing: () => composing,
    };
}
