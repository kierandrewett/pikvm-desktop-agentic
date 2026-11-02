/**
 * A touch long-press, as a set of pointer handlers to spread on an element.
 *
 * Touch only: a mouse has right-click and hover actions already, and a pen is treated as
 * touch. The press is cancelled by movement past a small slop (the person is scrolling),
 * by lifting early, and by the pointer being cancelled, which is what the browser sends
 * when it decides a touch is a scroll. After a press fires, the click that follows the
 * lift is swallowed so the long press does not also activate whatever was under it. Only
 * a click on the pressed element's own DOM is swallowed: a sheet the press opens is
 * portalled, its React events still pass through this element, and its buttons must work.
 */

import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef } from "react";

export const LONG_PRESS_MS = 450;
const SLOP_PX = 10;
const SWALLOW_WINDOW_MS = 400;

export function useLongPress(onLongPress: () => void, { enabled = true, delay = LONG_PRESS_MS } = {}) {
    const timer = useRef<number | undefined>(undefined);
    const origin = useRef<{ x: number; y: number } | null>(null);
    const fired = useRef(false);
    const latest = useRef(onLongPress);
    latest.current = onLongPress;

    const cancel = useCallback(() => {
        window.clearTimeout(timer.current);
        timer.current = undefined;
        origin.current = null;
    }, []);

    // The click that ends a long press arrives right after the lift or not at all; do not
    // leave the swallow armed for an unrelated tap later.
    const lifted = useCallback(() => {
        cancel();
        if (fired.current) window.setTimeout(() => (fired.current = false), SWALLOW_WINDOW_MS);
    }, [cancel]);

    useEffect(() => cancel, [cancel]);

    const onPointerDown = useCallback(
        (event: ReactPointerEvent) => {
            if (!enabled || event.pointerType === "mouse") return;
            // Events from a portalled sheet bubble through React's tree to here.
            if (!event.currentTarget.contains(event.target as Node)) return;
            fired.current = false;
            origin.current = { x: event.clientX, y: event.clientY };
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => {
                timer.current = undefined;
                fired.current = true;
                latest.current();
            }, delay);
        },
        [delay, enabled],
    );

    const onPointerMove = useCallback(
        (event: ReactPointerEvent) => {
            const start = origin.current;
            if (!start) return;
            if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > SLOP_PX) cancel();
        },
        [cancel],
    );

    return {
        onPointerDown,
        onPointerMove,
        onPointerUp: lifted,
        onPointerCancel: lifted,
        onPointerLeave: cancel,
        onClickCapture: (event: {
            currentTarget: Element;
            target: EventTarget;
            preventDefault(): void;
            stopPropagation(): void;
        }) => {
            if (!fired.current || !event.currentTarget.contains(event.target as Node)) return;
            fired.current = false;
            event.preventDefault();
            event.stopPropagation();
        },
        // Stops the browser's own callout / context menu competing with the sheet.
        onContextMenu: (event: { preventDefault(): void }) => {
            if (enabled && fired.current) event.preventDefault();
        },
    };
}
