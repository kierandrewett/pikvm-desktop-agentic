/**
 * The transient message over the picture ("Macro sent", "Paste failed"). The engine only supplies
 * words and severity; this owns the timing the console's toast had: an error stays up longer than
 * a confirmation, a sticky notice (a long paste under way) until something replaces it, and the
 * text is emptied only once the fade has finished.
 */

import { createStore, type Clock, type Notify, type ReadableStore } from "@pikvm/kvm-engine";

export const TOAST_OK_MS = 2600;
export const TOAST_ERROR_MS = 6000;
/** The fade is 0.25 s; the text goes a little after, or the pill visibly empties before it fades. */
export const TOAST_FADE_MS = 300;

export interface ToastState {
    readonly text: string;
    readonly error: boolean;
    readonly show: boolean;
}

export interface NoticeCenter {
    readonly store: ReadableStore<ToastState>;
    readonly notify: Notify;
    /** Fade out now (a sticky notice whose work has finished). */
    dismiss(): void;
}

const IDLE: ToastState = { text: "", error: false, show: false };

export function createNoticeCenter(clock: Clock): NoticeCenter {
    const store = createStore<ToastState>(IDLE);
    let hideTimer: (() => void) | null = null;
    let emptyTimer: (() => void) | null = null;

    const clearTimers = (): void => {
        hideTimer?.();
        emptyTimer?.();
        hideTimer = null;
        emptyTimer = null;
    };

    const dismiss = (): void => {
        hideTimer?.();
        hideTimer = null;
        const now = store.getState();
        if (!now.show) return;
        store.setState({ ...now, show: false });
        emptyTimer?.();
        emptyTimer = clock.setTimeout(() => {
            emptyTimer = null;
            // Something newer may have been shown in the meantime.
            if (!store.getState().show) store.setState(IDLE);
        }, TOAST_FADE_MS);
    };

    return {
        store,
        dismiss,
        notify(notice) {
            clearTimers();
            store.setState({ text: notice.text, error: !!notice.error, show: true });
            if (notice.sticky) return;
            hideTimer = clock.setTimeout(dismiss, notice.error ? TOAST_ERROR_MS : TOAST_OK_MS);
        },
    };
}
