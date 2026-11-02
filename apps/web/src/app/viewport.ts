/**
 * Layout mode and soft-keyboard tracking.
 *
 * The keyboard rule is the console's (console.js, paintViewport): the keyboard is up when
 * the visual viewport has lost more than an address bar's worth of the tallest height seen
 * since the last orientation change. It is read from the viewport, not from focus, because
 * focus can be held with the keyboard down (an external keyboard) and a missed blur would
 * leave the bar hidden for good.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

/** More than this lost from the tallest viewport means the soft keyboard is showing. */
export const KEYBOARD_THRESHOLD_PX = 150;

export interface ViewportTrack {
    readonly tallest: number;
    readonly keyboardOpen: boolean;
}

/** Pure step: fold one visual-viewport height into the running track. */
export function trackViewport(previous: ViewportTrack, height: number): ViewportTrack {
    const tallest = Math.max(previous.tallest, height);
    return { tallest, keyboardOpen: tallest - height > KEYBOARD_THRESHOLD_PX };
}

export const INITIAL_TRACK: ViewportTrack = { tallest: 0, keyboardOpen: false };

export interface ViewportFrame {
    readonly height: number;
    readonly top: number;
    readonly keyboardOpen: boolean;
}

/**
 * The visual viewport's box and whether the keyboard is up. The shell sizes itself to this
 * because iOS shrinks the visual viewport for the keyboard without resizing the layout
 * viewport, which would leave the bottom of a fixed shell hidden behind the keys.
 */
export function useViewportFrame(): ViewportFrame {
    const [frame, setFrame] = useState<ViewportFrame>(() => ({
        height: window.visualViewport?.height ?? window.innerHeight,
        top: window.visualViewport?.offsetTop ?? 0,
        keyboardOpen: false,
    }));

    useEffect(() => {
        const viewport = window.visualViewport;
        let track = INITIAL_TRACK;
        let pending = 0;
        const paint = () => {
            pending = 0;
            const height = viewport?.height ?? window.innerHeight;
            track = trackViewport(track, height);
            setFrame((current) => {
                const next = { height: Math.round(height), top: Math.round(viewport?.offsetTop ?? 0), keyboardOpen: track.keyboardOpen };
                return current.height === next.height && current.top === next.top && current.keyboardOpen === next.keyboardOpen
                    ? current
                    : next;
            });
        };
        const schedule = () => {
            if (!pending) pending = requestAnimationFrame(paint);
        };
        // A new orientation has a new "tallest"; the old one would read as a keyboard.
        let settle = 0;
        const onOrientation = () => {
            track = INITIAL_TRACK;
            window.clearTimeout(settle);
            settle = window.setTimeout(paint, 300);
        };
        paint();
        viewport?.addEventListener("resize", schedule);
        viewport?.addEventListener("scroll", schedule);
        window.addEventListener("orientationchange", onOrientation);
        return () => {
            viewport?.removeEventListener("resize", schedule);
            viewport?.removeEventListener("scroll", schedule);
            window.removeEventListener("orientationchange", onOrientation);
            if (pending) cancelAnimationFrame(pending);
            window.clearTimeout(settle);
        };
    }, []);

    return frame;
}

/** A coarse primary pointer (a phone or tablet) or a narrow window gets the bottom bar. */
export const COMPACT_QUERY = "(pointer: coarse), (max-width: 719px)";

export function useMediaQuery(query: string): boolean {
    return useSyncExternalStore(
        (notify) => {
            const list = window.matchMedia(query);
            list.addEventListener("change", notify);
            return () => list.removeEventListener("change", notify);
        },
        () => window.matchMedia(query).matches,
        () => false,
    );
}
