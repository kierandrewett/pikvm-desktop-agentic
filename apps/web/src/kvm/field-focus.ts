/**
 * Who has the soft keyboard. The hidden field is the one focus owner: raising the keyboard is
 * focusing it, lowering it is blurring it, and every other control must leave it alone.
 *
 * "Is the keyboard wanted" is the user's INTENT, not where focus happens to be. A tap on a dock
 * key can blur the field on the way through, and reading focus then reopened a keyboard the user
 * had just asked to close (or dropped one they had not).
 */

import { createStore, type Clock, type ReadableStore } from "@pikvm/kvm-engine";

/** A blur this soon after a dock tap is that tap passing through, not the user putting the keyboard away. */
export const DOCK_PRESS_MS = 700;

export interface FieldFocusState {
    /** The field has focus, so the system keyboard is up (or a hardware keyboard is typing into it). */
    readonly focused: boolean;
}

export interface FieldFocus {
    readonly store: ReadableStore<FieldFocusState>;
    attach(field: HTMLInputElement): () => void;
    /** Focus without scrolling the page: a focused field at the bottom makes iOS drag the dock up with it. */
    focus(): void;
    blur(): void;
    /** The system keyboard button: raise it, or put it away. */
    toggle(): void;
    /** After a dock key: give focus back, but only if the soft keyboard was up. */
    refocus(): void;
    /** Hand the keyboard back for good (a sheet opening over it). */
    release(): void;
    /** A dock button is being pressed: the focus it may take is not the user's choice. */
    notePress(): void;
    recentPress(): boolean;
}

export function createFieldFocus(clock: Clock): FieldFocus {
    const store = createStore<FieldFocusState>({ focused: false });
    let field: HTMLInputElement | null = null;
    let wanted = false;
    let pressAt = Number.NEGATIVE_INFINITY;

    const paint = (): void => {
        const focused = !!field && document.activeElement === field;
        if (store.getState().focused !== focused) store.setState({ focused });
    };

    const self: FieldFocus = {
        store,
        attach(el) {
            field = el;
            const onFocus = (): void => paint();
            const onBlur = (): void => {
                if (clock.now() - pressAt > DOCK_PRESS_MS) wanted = false;
                paint();
            };
            el.addEventListener("focus", onFocus);
            el.addEventListener("blur", onBlur);
            paint();
            return () => {
                el.removeEventListener("focus", onFocus);
                el.removeEventListener("blur", onBlur);
                if (field === el) field = null;
                paint();
            };
        },
        focus() {
            wanted = true;
            field?.focus({ preventScroll: true });
        },
        blur() {
            wanted = false;
            field?.blur();
        },
        toggle() {
            if (wanted) self.blur();
            else self.focus();
            paint();
        },
        refocus() {
            if (wanted) field?.focus({ preventScroll: true });
        },
        release() {
            wanted = false;
            if (field && document.activeElement === field) field.blur();
            paint();
        },
        notePress() {
            pressAt = clock.now();
        },
        recentPress: () => clock.now() - pressAt < DOCK_PRESS_MS,
    };
    return self;
}
