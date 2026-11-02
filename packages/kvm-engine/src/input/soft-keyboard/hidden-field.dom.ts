import type { Keyboard } from "../keyboard/keyboard";
import { createFieldMirror, type FieldMirror, type FieldPort } from "./field-mirror";

/**
 * Binds the hidden 1x1 `<input>` that owns the soft keyboard to the keyboard engine and the
 * field mirror. It forwards events and nothing else: every decision lives in the pure cores.
 *
 * Keep this an UNCONTROLLED imperative input. A framework that re-renders `value` fights the
 * diff algorithm, which treats the field as the record of what was typed.
 */
export interface HiddenFieldOptions {
    readonly keyboard: Keyboard;
    /**
     * True while something else owns the keyboard (a modal, the framed full PiKVM UI): input
     * events are swallowed and the field is discarded instead of replayed. Two things must
     * never type at the target at once.
     */
    readonly isBlocked?: () => boolean;
}

export interface HiddenFieldBinding {
    readonly mirror: FieldMirror;
    unbind(): void;
}

function fieldPort(el: HTMLInputElement | HTMLTextAreaElement): FieldPort {
    return {
        read: () => el.value,
        write(value) {
            el.value = value;
            try {
                el.setSelectionRange(value.length, value.length);
            } catch {
                // Some input types refuse selection; the value is what matters.
            }
        },
    };
}

export function bindHiddenField(field: HTMLInputElement | HTMLTextAreaElement, options: HiddenFieldOptions): HiddenFieldBinding {
    const { keyboard } = options;
    // Typed as the base element: the union of the two field types defeats addEventListener's event-name overloads.
    const el: HTMLElement = field;
    const blocked = (): boolean => options.isBlocked?.() ?? false;
    const mirror = createFieldMirror(fieldPort(field), {
        canType: (ch) => keyboard.canType(ch),
        sendBackspace: () => keyboard.sendBackspace(),
        sendNewline: () => keyboard.sendNewline(),
        sendChar: (ch) => keyboard.sendChar(ch),
    });

    /** Swallow an event completely while something else owns the keyboard. */
    const block = (e: Event): boolean => {
        if (!blocked()) return false;
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        return true;
    };

    // Plain Backspace is left to the field, so the diff sends it and the field stays an exact
    // record. Sent from keydown instead, the field would keep a character the target no longer
    // has, and the next rewrite would back up one too far. Capture, so it runs ahead of the
    // chord handler below, and stops the event so nothing else forwards it a second time.
    const onBackspaceCapture = (e: KeyboardEvent): void => {
        if (!keyboard.isPlainBackspace(e)) return;
        if (block(e)) return;
        e.stopImmediatePropagation();
    };
    const onKeydown = (e: KeyboardEvent): void => {
        if (!block(e)) {
            const outcome = keyboard.keydown(e, false);
            if (outcome.preventDefault) e.preventDefault();
        }
        // Any other key the target took from keydown (arrows, Tab, Enter, Ctrl+X) has moved
        // its caret away from the end of what the field holds.
        if (e.defaultPrevented) mirror.reset();
    };
    const onKeyup = (e: KeyboardEvent): void => keyboard.keyup(e);
    const onBeforeInput = (e: InputEvent): void => {
        if (block(e)) return;
        if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
            // Soft-keyboard fallback only. Matched on the CODE, not the full chord, so a
            // Shift+Enter that keydown already sent is not followed by a bare Enter.
            keyboard.sendEnterFallback();
            e.preventDefault();
        }
    };
    const onInput = (e: Event): void => mirror.input(e instanceof InputEvent && e.isComposing, blocked());
    const onCompositionStart = (): void => mirror.compositionStart();
    const onCompositionEnd = (): void => mirror.compositionEnd();
    const onBlur = (): void => mirror.blur();

    el.addEventListener("keydown", onBackspaceCapture, true);
    el.addEventListener("keydown", onKeydown);
    el.addEventListener("keyup", onKeyup);
    el.addEventListener("beforeinput", onBeforeInput);
    el.addEventListener("input", onInput);
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("compositionend", onCompositionEnd);
    el.addEventListener("blur", onBlur);
    const stopCaret = keyboard.onCaretMoved(() => mirror.reset());
    mirror.reset();

    return {
        mirror,
        unbind() {
            el.removeEventListener("keydown", onBackspaceCapture, true);
            el.removeEventListener("keydown", onKeydown);
            el.removeEventListener("keyup", onKeyup);
            el.removeEventListener("beforeinput", onBeforeInput);
            el.removeEventListener("input", onInput);
            el.removeEventListener("compositionstart", onCompositionStart);
            el.removeEventListener("compositionend", onCompositionEnd);
            el.removeEventListener("blur", onBlur);
            stopCaret();
        },
    };
}
