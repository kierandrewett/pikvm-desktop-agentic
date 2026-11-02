/**
 * How much of the workspace the soft keyboard is covering.
 *
 * iOS shrinks the VISUAL viewport for the keyboard and leaves the layout viewport (and
 * everything sized from it) full height, so a composer docked to the bottom of the
 * layout sits behind the keys. The answer is not "the keyboard's height" but "how far
 * the bottom of this element hangs below the bottom of what can be seen":
 *
 *   covered = element.bottom - (visualViewport.offsetTop + visualViewport.height)
 *
 * Measured against the element, that is also correct when a host has already resized
 * the workspace to the visual viewport (the PiKVM app's shell does): it reads 0 there
 * and the workspace adds no second, doubled gap.
 *
 * `open` follows the shell's rule: more than an address bar's worth lost from the
 * tallest height seen since the last orientation change. It is read from the viewport,
 * not from focus, because focus can stay in the composer with an external keyboard
 * attached and no soft keyboard at all.
 */

import { type RefObject, useEffect, useState } from "react";

export const KEYBOARD_THRESHOLD_PX = 150;

export interface KeyboardState {
    /** Pixels of the element's bottom edge hidden below the visual viewport. */
    readonly inset: number;
    readonly open: boolean;
}

const CLOSED: KeyboardState = { inset: 0, open: false };

export function useKeyboardInset(target: RefObject<HTMLElement | null>, enabled: boolean): KeyboardState {
    const [state, setState] = useState<KeyboardState>(CLOSED);

    useEffect(() => {
        const viewport = window.visualViewport;
        if (!enabled || !viewport) {
            setState(CLOSED);
            return;
        }
        let tallest = viewport.height;
        let frame = 0;

        const measure = () => {
            frame = 0;
            tallest = Math.max(tallest, viewport.height);
            const bottom = target.current?.getBoundingClientRect().bottom ?? window.innerHeight;
            const covered = Math.max(0, Math.round(bottom - (viewport.offsetTop + viewport.height)));
            const open = tallest - viewport.height > KEYBOARD_THRESHOLD_PX;
            setState((current) => (current.inset === covered && current.open === open ? current : { inset: covered, open }));
        };
        const schedule = () => {
            if (!frame) frame = requestAnimationFrame(measure);
        };
        // A new orientation has a new tallest height; the old one would read as a keyboard.
        const onOrientation = () => {
            tallest = 0;
            schedule();
        };

        measure();
        viewport.addEventListener("resize", schedule);
        viewport.addEventListener("scroll", schedule);
        window.addEventListener("orientationchange", onOrientation);
        return () => {
            viewport.removeEventListener("resize", schedule);
            viewport.removeEventListener("scroll", schedule);
            window.removeEventListener("orientationchange", onOrientation);
            if (frame) cancelAnimationFrame(frame);
        };
    }, [enabled, target]);

    return state;
}
