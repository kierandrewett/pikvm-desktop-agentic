/**
 * Layout mode and soft-keyboard tracking.
 *
 * The keyboard rule is the console's (console.js, paintViewport): the keyboard is up when
 * the visual viewport has lost more than an address bar's worth of the tallest height seen
 * since the last orientation change. It is read from the viewport, not from focus, because
 * focus can be held with the keyboard down (an external keyboard) and a missed blur would
 * leave the bar hidden for good.
 *
 * In the installed app (standalone) there is no URL bar, so the large viewport, 100vh, IS the screen. The
 * visual viewport, innerHeight, 100dvh and 100svh all report the screen minus an inset when the app starts, so
 * they can neither size the shell nor serve as the "tallest" the keyboard is measured against (a short report
 * would read as a keyboard, or the shell would stop short of the bottom). There the baseline is a probe of
 * height 100vh, the shell is 100vh (styles.css, `full`) while the keyboard is closed, and the visual viewport's
 * own height is used only while the keyboard is open.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { isStandalone } from "./standalone";

/** More than this lost from the tallest viewport means the soft keyboard is showing. */
export const KEYBOARD_THRESHOLD_PX = 150;

export interface ViewportTrack {
    readonly tallest: number;
    readonly keyboardOpen: boolean;
}

/**
 * Pure step: fold one visual-viewport height into the running track. `baseline` is the height the keyboard is
 * measured against when it is known (standalone: the 100vh probe); without it, the tallest height seen.
 */
export function trackViewport(previous: ViewportTrack, height: number, baseline?: number): ViewportTrack {
    const tallest = baseline !== undefined && baseline > 0 ? baseline : Math.max(previous.tallest, height);
    return { tallest, keyboardOpen: tallest - height > KEYBOARD_THRESHOLD_PX };
}

export const INITIAL_TRACK: ViewportTrack = { tallest: 0, keyboardOpen: false };

export interface ViewportFrame {
    /** The height to size the shell to in px (the full screen in standalone with the keyboard closed). */
    readonly height: number;
    readonly top: number;
    readonly keyboardOpen: boolean;
    /** Standalone with the keyboard closed: the CSS (100vh) owns the height and nothing is written for it. */
    readonly full: boolean;
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
        full: isStandalone(),
    }));

    useEffect(() => {
        const viewport = window.visualViewport;
        const standalone = isStandalone();
        // Zero-size and invisible: only its height is read. 100vh is the large viewport, whole in standalone.
        const probe = document.createElement("div");
        probe.setAttribute("aria-hidden", "true");
        probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:100vh;visibility:hidden;pointer-events:none";
        if (standalone) document.body.append(probe);
        let track = INITIAL_TRACK;
        let pending = 0;
        const paint = () => {
            pending = 0;
            const visual = viewport?.height ?? window.innerHeight;
            const large = standalone ? Math.round(probe.getBoundingClientRect().height) : 0;
            track = trackViewport(track, visual, standalone ? large : undefined);
            const full = standalone && !track.keyboardOpen && large > 0;
            setFrame((current) => {
                const next = {
                    height: Math.round(full ? large : visual),
                    top: Math.round(viewport?.offsetTop ?? 0),
                    keyboardOpen: track.keyboardOpen,
                    full,
                };
                return current.height === next.height && current.top === next.top && current.keyboardOpen === next.keyboardOpen && current.full === next.full
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
        window.addEventListener("resize", schedule);
        window.addEventListener("orientationchange", onOrientation);
        return () => {
            viewport?.removeEventListener("resize", schedule);
            viewport?.removeEventListener("scroll", schedule);
            window.removeEventListener("resize", schedule);
            window.removeEventListener("orientationchange", onOrientation);
            probe.remove();
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
