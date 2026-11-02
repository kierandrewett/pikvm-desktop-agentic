import type { HttpPort } from "../../http";
import { errorMessage, type Notify } from "../notice";
import type { TypingGate } from "../typing-gate";
import { humanCount, pasteDuration, printPath } from "./print-query";

/**
 * Paste to target: kvmd types the text itself (`POST /api/hid/print`), faster than sending keys
 * and layout-correct through the chosen keymap.
 */

export type PasteResult =
    /** Nothing to send. */
    | { readonly kind: "empty" }
    /** A macro (or another paste) already holds the target; nothing was sent. */
    | { readonly kind: "refused"; readonly reason: "macro-running" | "paste-busy" }
    | { readonly kind: "typed"; readonly chars: number }
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
            const count = `${humanCount(text.length, options.locale)} ${text.length === 1 ? "character" : "characters"}`;
            // A paste is a LONG operation (kvmd answers when it is done), and closing the
            // dialog does not stop it, so say that it is happening for as long as it takes.
            const typingFor = pasteDuration(text.length);
            notify({
                text: `Typing ${count} on the target${typingFor ? ` \u2014 ${typingFor}` : ""}\u2026`,
                sticky: true,
            });
            try {
                const res = await http.request({
                    method: "POST",
                    path: printPath(options.keymap()),
                    body: text,
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
                notify({ text: `Typed ${count} on the target` });
                return { kind: "typed", chars: text.length };
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
