import { createStore, type ReadableStore } from "../store";

/**
 * Only one thing may type on the target at a time: a macro run or a paste.
 *
 * Both end up on kvmd's `/api/hid/print` or the key queue, and a second one started during the
 * first interleaves with it. A macro of "type the username, Tab, type the password, Enter"
 * landing inside a paste, or fired three times 120 ms apart (the click has no visible
 * consequence on THIS machine, so clicking again is the natural thing to do), types the
 * password into whatever the second run's earlier steps left on screen.
 *
 * The state is a store because the UI greys the macro and paste controls from it.
 */
export interface TypingState {
    /** Label of the macro playing, or null. */
    readonly macro: string | null;
    readonly pasting: boolean;
}

export interface TypingGate {
    readonly store: ReadableStore<TypingState>;
    /** Claim the target for a macro; false if a macro or a paste already holds it. */
    beginMacro(label: string): boolean;
    endMacro(): void;
    /** Claim the target for a paste; false if a macro or a paste already holds it. */
    beginPaste(): boolean;
    endPaste(): void;
}

export function createTypingGate(): TypingGate {
    const store = createStore<TypingState>({ macro: null, pasting: false });
    return {
        store,
        beginMacro(label) {
            const s = store.getState();
            if (s.macro !== null || s.pasting) return false;
            store.setState({ ...s, macro: label });
            return true;
        },
        endMacro: () => store.setState({ ...store.getState(), macro: null }),
        beginPaste() {
            const s = store.getState();
            if (s.macro !== null || s.pasting) return false;
            store.setState({ ...s, pasting: true });
            return true;
        },
        endPaste: () => store.setState({ ...store.getState(), pasting: false }),
    };
}
