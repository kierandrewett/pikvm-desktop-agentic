import { charToKey, isLetterKey, type KeyboardLayout } from "../input/keyboard/char-map";

/**
 * Text to key strokes for the agent.
 *
 * Each character becomes a physical key plus Shift, through the SAME map the person's own typing
 * uses (`charToKey`), so the agent's `"` and a hand-typed `"` land on the same key of the target.
 * A newline is Enter and a tab is Tab. A character the layout has no key for (an accented letter,
 * an emoji) is reported up front rather than dropped silently halfway through a sentence.
 */

export interface Stroke {
    readonly code: string;
    readonly shift: boolean;
}

export interface TypingPlan {
    readonly strokes: readonly Stroke[];
    /** Distinct characters with no key on this layout, in order of first appearance. */
    readonly unmappable: readonly string[];
}

/** kvmd's keymap names the target layout: `en-gb` is the UK ISO keyboard, anything else is treated as US. */
export function layoutFromKeymap(keymap: string | undefined): KeyboardLayout {
    return keymap?.toLowerCase().startsWith("en-gb") ? "uk" : "us";
}

/**
 * @param capsOn the target's Caps Lock LED. It inverts letters, so Shift is inverted for them
 *   instead of toggling Caps Lock, which would race the LED report.
 */
export function planText(text: string, layout: KeyboardLayout, capsOn: boolean): TypingPlan {
    const strokes: Stroke[] = [];
    const unmappable: string[] = [];
    // Windows line endings are one line break, not two.
    for (const ch of text.replace(/\r\n?/g, "\n")) {
        if (ch === "\n") {
            strokes.push({ code: "Enter", shift: false });
            continue;
        }
        if (ch === "\t") {
            strokes.push({ code: "Tab", shift: false });
            continue;
        }
        const key = charToKey(ch, layout);
        if (!key) {
            if (!unmappable.includes(ch)) unmappable.push(ch);
            continue;
        }
        strokes.push({ code: key.code, shift: capsOn && isLetterKey(key.code) ? !key.shift : key.shift });
    }
    return { strokes, unmappable };
}
