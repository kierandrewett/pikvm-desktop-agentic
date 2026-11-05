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
 *
 * Every chord is the target's, Ctrl+C and Ctrl+V included: they are sent as keys, so copy and paste
 * work inside the target with the target's own clipboard. This machine's clipboard never reaches the
 * target from here (no shortcut reads it); it goes through "Type text on the target" and nowhere else.
 */

import { bindHiddenField } from "@pikvm/kvm-engine";
import { useEffect, useRef } from "react";
import { useKvmActive } from "./active";
import { useKvmLocked } from "./locked";
import type { FieldFocus } from "./field-focus";
import type { KvmSession } from "./session";

export interface KeyboardInputProps {
    readonly session: KvmSession;
    readonly focus: FieldFocus;
    /** The desktop app: the window's own key events drive the target. */
    readonly desktop: boolean;
}

/** Something the user is typing into on this side of the glass: it keeps its keys. */
function isOwnControl(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function KeyboardInput({ session, focus, desktop }: KeyboardInputProps) {
    const field = useRef<HTMLInputElement>(null);
    // Read by the handlers below, which are bound once: a tab change must not rebind them (a
    // rebind would release every held key, and it is the handlers' own answer that matters).
    const active = useKvmActive();
    const activeRef = useRef(active);
    activeRef.current = active;
    // The agent has the keyboard: the same, and the server would drop the keys anyway.
    const lockedRef = useRef(useKvmLocked());
    lockedRef.current = useKvmLocked();

    useEffect(() => {
        const el = field.current;
        if (!el) return;
        const { keyboard, dialogs } = session;
        // Another tab in front, or a dialog open: either way the keys are not the target's.
        const blocked = (): boolean => !activeRef.current || lockedRef.current || dialogs.store.getState().open !== null;
        const binding = bindHiddenField(el, { keyboard, isBlocked: blocked });
        const detachFocus = focus.attach(el);
        const offs: Array<() => void> = [];
        if (desktop) {
            const down = (e: KeyboardEvent): void => {
                // The field's own handlers already cover it, and forwarding twice would double every key.
                if (e.target === el || blocked() || isOwnControl(e.target)) return;
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
            // Leaving the screen with a key down would leave it down on the target.
            keyboard.releaseAll();
            detachFocus();
            binding.unbind();
        };
    }, [session, focus, desktop]);

    // Leaving the KVM tab: the screen stays mounted, so nothing unmounts to let go of what the
    // target is holding or to put the soft keyboard away. Both happen here, once, on the change.
    useEffect(() => {
        if (active) return;
        session.keyboard.releaseAll();
        focus.release();
    }, [active, session, focus]);

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
