/**
 * The hidden field that owns the keyboard, bound to the engine.
 *
 * It is an UNCONTROLLED input and must stay one: the soft-keyboard mirror treats its value as the
 * record of what was typed and diffs every change against the last, and a framework re-rendering
 * `value` underneath would fight it. React only creates the element; everything after is the
 * engine's.
 *
 * On a computer a click on the picture focuses it (the pointer machine asks for that), so a
 * hardware keyboard types into it. In the desktop app there is no such focus step: the window's
 * own key events are the keyboard, so they are forwarded directly.
 */

import { bindHiddenField } from "@pikvm/kvm-engine";
import { useEffect, useRef } from "react";
import type { FieldFocus } from "./field-focus";
import type { KvmSession } from "./session";

export interface KeyboardInputProps {
    readonly session: KvmSession;
    readonly focus: FieldFocus;
    /** The desktop app: the window's own key events drive the target. */
    readonly desktop: boolean;
}

/** Ctrl/Cmd+V is the HOST's paste: the target cannot see this machine's clipboard, so it is typed for it. */
export function isHostPasteShortcut(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "code">): boolean {
    return (e.ctrlKey || e.metaKey) && !e.altKey && e.code === "KeyV";
}

/**
 * Forwarding the shortcut would paste nothing (or the target's own old clipboard), so it is
 * consumed here and the host clipboard goes through the same path as the paste dialog, with
 * the same refusals while a macro or another paste holds the target.
 */
export async function pasteHostClipboard(session: KvmSession): Promise<void> {
    const { notify } = session.notices;
    if (!navigator.clipboard?.readText) {
        notify({ text: "Could not read the host clipboard", error: true });
        return;
    }
    let text: string;
    try {
        text = await navigator.clipboard.readText();
    } catch {
        notify({ text: "Could not read the host clipboard", error: true });
        return;
    }
    if (!text) {
        notify({ text: "Host clipboard is empty", error: true });
        return;
    }
    await session.paster.paste(text);
}

/** Something the user is typing into on this side of the glass: it keeps its keys. */
function isOwnControl(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function KeyboardInput({ session, focus, desktop }: KeyboardInputProps) {
    const field = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const el = field.current;
        if (!el) return;
        const { keyboard, dialogs } = session;
        const blocked = (): boolean => dialogs.store.getState().open !== null;
        const binding = bindHiddenField(el, { keyboard, isBlocked: blocked });
        const detachFocus = focus.attach(el);
        // After the field's own capture handler, ahead of everything it does on keydown.
        const hostPaste = (e: KeyboardEvent): void => {
            if (blocked() || !isHostPasteShortcut(e)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            void pasteHostClipboard(session);
        };
        el.addEventListener("keydown", hostPaste, true);

        const offs: Array<() => void> = [];
        if (desktop) {
            const down = (e: KeyboardEvent): void => {
                // The field's own handlers already cover it, and forwarding twice would double every key.
                if (e.target === el || blocked() || isOwnControl(e.target)) return;
                if (isHostPasteShortcut(e)) {
                    e.preventDefault();
                    void pasteHostClipboard(session);
                    return;
                }
                if (keyboard.keydown(e, true).preventDefault) e.preventDefault();
            };
            const up = (e: KeyboardEvent): void => {
                if (e.target !== el) keyboard.keyup(e);
            };
            document.addEventListener("keydown", down);
            document.addEventListener("keyup", up);
            offs.push(
                () => document.removeEventListener("keydown", down),
                () => document.removeEventListener("keyup", up),
            );
        }
        // Switching away mid-chord leaves modifiers down on the target with no keyup ever coming.
        const release = (): void => keyboard.releaseAll();
        window.addEventListener("blur", release);
        offs.push(() => window.removeEventListener("blur", release));

        return () => {
            for (const off of offs) off();
            el.removeEventListener("keydown", hostPaste, true);
            detachFocus();
            binding.unbind();
        };
    }, [session, focus, desktop]);

    return (
        <input
            ref={field}
            className="kvm-kbd"
            type="text"
            tabIndex={-1}
            aria-label="Keyboard input to the remote target"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="enter"
            data-form-type="other"
        />
    );
}
