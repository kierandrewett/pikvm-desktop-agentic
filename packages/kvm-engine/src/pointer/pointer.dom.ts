// DOM adapter for the pointer machine: DOM events in, machine inputs out; and the
// handful of commands that are about the DOM itself (capture, focus, hold cue).
//
// Listeners are registered here, outside any framework, because touch handling has
// to run in the capture phase with non-passive listeners and call preventDefault
// synchronously: a React synthetic event cannot do either.

import type { PointerDriver } from "./driver";
import type { OutputCommand, PointerKind } from "./types";

export interface PointerDomOptions {
    readonly pane: HTMLElement;
    readonly driver: PointerDriver;
    /** True for events that belong to overlaid UI (key rows, bars): not KVM input. */
    readonly ignoreTarget?: (target: EventTarget | null) => boolean;
    /** Resolve the keys to hold across a mouse click: host modifiers plus armed sticky ones, de-duplicated. */
    readonly clickMods?: (e: PointerEvent) => readonly string[];
}

function kindOf(e: PointerEvent): PointerKind {
    return e.pointerType === "mouse" ? "mouse" : e.pointerType === "pen" ? "pen" : "touch";
}

/** A touch starting within this many px of the screen's left or right edge is the system's, unless the page cancels it. */
const EDGE_GUARD_PX = 24;

/** Attach every listener; returns the detach function. */
export function attachPointerInput(opts: PointerDomOptions): () => void {
    const { pane, driver } = opts;
    const off: (() => void)[] = [];
    const on = <K extends keyof HTMLElementEventMap>(
        type: K,
        fn: (e: HTMLElementEventMap[K]) => void,
        options?: AddEventListenerOptions,
    ): void => {
        pane.addEventListener(type, fn as EventListener, options);
        off.push(() => pane.removeEventListener(type, fn as EventListener, options));
    };

    const ignored = (e: Event): boolean => !!opts.ignoreTarget && opts.ignoreTarget(e.target);

    on(
        "pointerdown",
        (e) => {
            if (ignored(e)) return;
            const mods = e.pointerType === "mouse" ? opts.clickMods?.(e) : undefined;
            const r = driver.send({
                type: "down",
                id: e.pointerId,
                kind: kindOf(e),
                x: e.clientX,
                y: e.clientY,
                button: e.button,
                ...(mods ? { clickMods: mods } : {}),
            });
            if (r.preventDefault) e.preventDefault();
        },
        { capture: true },
    );
    // The system reads a touch that starts in the strip at the screen's edge as its back swipe, so a drag begun
    // there leaves the page instead of moving the cursor. Cancelling the touchstart is the page's one say in that.
    // Touches on overlaid UI keep their own behaviour.
    on(
        "touchstart",
        (e) => {
            if (ignored(e) || !e.cancelable) return;
            for (const touch of Array.from(e.changedTouches)) {
                if (touch.clientX <= EDGE_GUARD_PX || touch.clientX >= window.innerWidth - EDGE_GUARD_PX) {
                    e.preventDefault();
                    return;
                }
            }
        },
        { capture: true, passive: false },
    );
    on(
        "pointermove",
        (e) => {
            const r = driver.send({ type: "move", id: e.pointerId, kind: kindOf(e), x: e.clientX, y: e.clientY, buttons: e.buttons, at: e.timeStamp });
            if (r.preventDefault) e.preventDefault();
        },
        { capture: true },
    );
    const up = (e: PointerEvent): void => {
        driver.send({
            type: "up",
            id: e.pointerId,
            kind: kindOf(e),
            button: e.button,
            ...(e.type === "pointercancel" ? { cancelled: true } : {}),
        });
    };
    on("pointerup", up, { capture: true });
    on("pointercancel", up, { capture: true });
    on("pointerenter", (e) => {
        driver.send({ type: "enter", kind: kindOf(e) });
    });
    on("pointerleave", (e) => {
        driver.send({ type: "leave", kind: kindOf(e), buttons: e.buttons });
    });
    on("contextmenu", (e) => e.preventDefault());
    on(
        "wheel",
        (e) => {
            if (ignored(e)) return;
            const r = driver.send({
                type: "wheel",
                x: e.clientX,
                y: e.clientY,
                deltaY: e.deltaY,
                modifier: e.metaKey ? "meta" : e.ctrlKey ? "control" : "none",
            });
            if (r.preventDefault) e.preventDefault();
        },
        { passive: false },
    );

    // Losing the window mid-drag leaves the button and any click modifiers down on the
    // target with no pointerup ever coming. On the pane, not only the desktop block: switching
    // app mid-gesture is MORE likely on a phone.
    const blur = (): void => {
        driver.send({ type: "blur" });
    };
    window.addEventListener("blur", blur);
    off.push(() => window.removeEventListener("blur", blur));
    // A page sent to the background (an app switched away from, a tab left, a frozen page) gets no pointerup either.
    // iOS does not blur the window when it does that, so the page being hidden is the signal.
    const hide = (): void => {
        if (document.hidden) blur();
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", blur);
    off.push(
        () => document.removeEventListener("visibilitychange", hide),
        () => window.removeEventListener("pagehide", blur),
    );

    return () => off.forEach((f) => f());
}

export interface DomSinkOptions {
    readonly pane: HTMLElement;
    /** Put keyboard focus on the hidden input (web). */
    readonly focusKeyboard: () => void;
    /** Drop focus from whatever has it (desktop, where the global key handler owns the keyboard). */
    readonly blurActive?: () => void;
    /** Everything the DOM sink does not handle itself. */
    readonly next: (command: OutputCommand) => void;
}

/** Wraps a command consumer with the commands that are the pane's own business. */
export function createDomCommandSink(opts: DomSinkOptions): (command: OutputCommand) => void {
    const { pane } = opts;
    return (c) => {
        switch (c.type) {
            case "capture":
                try {
                    if (c.on) pane.setPointerCapture(c.id);
                    else pane.releasePointerCapture(c.id);
                } catch {
                    // The pointer may already be gone; there is nothing to capture.
                }
                return;
            case "holdCue":
                pane.classList.toggle("hold-armed", c.on);
                if (c.on && typeof navigator !== "undefined" && navigator.vibrate) {
                    try {
                        navigator.vibrate(12);
                    } catch {
                        // Not every browser lets a page vibrate.
                    }
                }
                opts.next(c);
                return;
            case "focus":
                if (c.target === "keyboard") opts.focusKeyboard();
                else opts.blurActive?.();
                return;
            default:
                opts.next(c);
        }
    };
}
