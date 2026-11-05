import type { HttpPort } from "../../http";
import { errorMessage, type Notify } from "../notice";
import type { TypingGate } from "../typing-gate";
import { humanCount, humanDuration, pasteDuration, PASTE_DELAY_S, printPath } from "./print-query";
import { MAX_TYPED_CHARS, prepareTypedText } from "./typed-text";

/**
 * Type text on the target: kvmd types the text itself (`POST /api/hid/print`), faster than sending keys
 * and layout-correct through the chosen keymap. This is the only way the clipboard of the machine in front of the
 * screen reaches the target: Ctrl+V on the screen is the target's own paste. What is typed is `prepareTypedText` of the
 * text, so a clipboard with curly quotes, CRLF line ends, zero-width marks or emoji types what a keyboard can.
 */

export type PasteResult =
    /** Nothing to send. */
    | { readonly kind: "empty" }
    /** A macro (or another paste) already holds the target; nothing was sent. */
    | { readonly kind: "refused"; readonly reason: "macro-running" | "paste-busy" }
    | { readonly kind: "typed"; readonly chars: number; readonly dropped?: number }
    /** Nothing in the text can be typed by a keyboard (it was all emoji, say); nothing was sent. */
    | { readonly kind: "nothing-typable" }
    /** More than `MAX_TYPED_CHARS` once prepared; nothing was sent. */
    | { readonly kind: "too-long"; readonly chars: number }
    /** kvmd answered 413: too much text for one request. */
    | { readonly kind: "too-large" }
    | { readonly kind: "failed"; readonly status: number }
    | { readonly kind: "network"; readonly message: string };

export interface PasterOptions {
    readonly http: HttpPort;
    readonly gate: TypingGate;
    /** The keymap text is typed with, read at send time ("wherever it is typed from"). */
    readonly keymap: () => string | null;
    readonly notify: Notify;
    /** Locale for the character count in messages. */
    readonly locale?: string;
}

export interface Paster {
    paste(text: string): Promise<PasteResult>;
}

export function createPaster(options: PasterOptions): Paster {
    const { http, gate, notify } = options;

    return {
        async paste(text) {
            if (!text) return { kind: "empty" };
            const prepared = prepareTypedText(text);
            const typed = prepared.text;
            if (typed === "") {
                notify({ text: "Nothing in that text can be typed on the target", error: true });
                return { kind: "nothing-typable" };
            }
            if (typed.length > MAX_TYPED_CHARS) {
                const howLong = humanDuration(typed.length * PASTE_DELAY_S * 1000);
                notify({
                    text: `That is ${humanCount(typed.length, options.locale)} characters, which would take ${howLong}. The most that can be typed at once is ${humanCount(MAX_TYPED_CHARS, options.locale)}.`,
                    error: true,
                });
                return { kind: "too-long", chars: typed.length };
            }
            const state = gate.store.getState();
            if (state.macro !== null) {
                // Ctrl/Cmd+Enter reaches here without touching the disabled button, so the
                // guard cannot live in the control's disabled state alone.
                notify({ text: `${state.macro} is still running`, error: true });
                return { kind: "refused", reason: "macro-running" };
            }
            if (!gate.beginPaste()) {
                // A second send while the first is in flight would put two POSTs on the
                // endpoint, and kvmd would type both interleaved.
                notify({ text: "A paste is still typing on the target", error: true });
                return { kind: "refused", reason: "paste-busy" };
            }
            const count = `${humanCount(typed.length, options.locale)} ${typed.length === 1 ? "character" : "characters"}`;
            const leftOut =
                prepared.dropped > 0
                    ? ` (${humanCount(prepared.dropped, options.locale)} ${prepared.dropped === 1 ? "character the keyboard cannot type was" : "characters the keyboard cannot type were"} left out)`
                    : "";
            // A paste is a LONG operation (kvmd answers when it is done), and closing the
            // dialog does not stop it, so say that it is happening for as long as it takes.
            const typingFor = pasteDuration(typed.length);
            notify({
                text: `Typing ${count} on the target${typingFor ? ` \u2014 ${typingFor}` : ""}\u2026`,
                sticky: true,
            });
            try {
                const res = await http.request({
                    method: "POST",
                    path: printPath(options.keymap()),
                    body: typed,
                    contentType: "text/plain",
                });
                if (res.status === 413) {
                    notify({ text: "That is too much text for one paste.", error: true });
                    return { kind: "too-large" };
                }
                if (!res.ok) {
                    notify({ text: `Paste failed (${res.status})`, error: true });
                    return { kind: "failed", status: res.status };
                }
                notify({ text: `Typed ${count} on the target${leftOut}` });
                return { kind: "typed", chars: typed.length, ...(prepared.dropped > 0 ? { dropped: prepared.dropped } : {}) };
            } catch (e) {
                const message = errorMessage(e);
                notify({ text: `Paste failed: ${message}`, error: true });
                return { kind: "network", message };
            } finally {
                gate.endPaste();
            }
        },
    };
}
