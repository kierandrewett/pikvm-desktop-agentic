import { charToKey, isLetterKey, keyToChar, type KeyboardLayout } from "../input/keyboard/char-map";

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

export interface LayoutSensitiveCharacter extends Stroke {
    readonly character: string;
    readonly otherLayout: KeyboardLayout;
    /** Null means that the other send-side map has no known glyph for this physical key. */
    readonly otherCharacter: string | null;
}

/** Evidence about the selected physical mapping, not confirmation of the target OS output. */
export interface TypingAnalysis {
    readonly layout: KeyboardLayout;
    readonly sensitiveCharacters: readonly LayoutSensitiveCharacter[];
}

export interface TypingPlan extends TypingAnalysis {
    readonly strokes: readonly Stroke[];
    /** Distinct characters with no key on this layout, in order of first appearance. */
    readonly unmappable: readonly string[];
}

/**
 * @param capsOn the target's Caps Lock LED. It inverts letters, so Shift is inverted for them
 *   instead of toggling Caps Lock, which would race the LED report.
 */
export function planText(text: string, layout: KeyboardLayout, capsOn: boolean): TypingPlan {
    const strokes: Stroke[] = [];
    const unmappable: string[] = [];
    const sensitive = new Map<string, LayoutSensitiveCharacter>();
    const otherLayout = layout === "us" ? "uk" : "us";
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
        if (!sensitive.has(ch)) {
            const otherCharacter = keyToChar(key, otherLayout);
            if (otherCharacter !== ch) {
                sensitive.set(ch, { character: ch, ...key, otherLayout, otherCharacter });
            }
        }
    }
    return { strokes, unmappable, layout, sensitiveCharacters: [...sensitive.values()] };
}
