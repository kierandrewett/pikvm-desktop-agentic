import { useEffect, useRef } from "react";
import { useInBackground } from "../kvm/platform";
import { newClientId, createPresenceReporter } from "./presence";
import { sendPresence } from "./watch-api";

/**
 * Mounted once in the app's shell: reports real keyboard and pointer input, and whether this page has focus, to the host (see
 * presence.ts for what and when). Focus is the existing `useInBackground` (hidden, or visible but not the window typed into).
 */
export function usePresence(): void {
    const background = useInBackground();
    const focusedRef = useRef(!background);
    const evaluateRef = useRef<() => void>(() => undefined);
    focusedRef.current = !background;

    useEffect(() => {
        const clientId = newClientId();
        const reporter = createPresenceReporter({
            now: () => Date.now(),
            focused: () => focusedRef.current,
            send: (report) => void sendPresence({ clientId, ...report }).catch(() => undefined),
        });
        evaluateRef.current = reporter.evaluate;
        const onKey = (event: KeyboardEvent): void => reporter.key(event.isTrusted);
        const onMove = (event: PointerEvent): void => reporter.move(event.clientX, event.clientY, event.isTrusted);
        const onTouchMove = (event: TouchEvent): void => {
            const touch = event.touches[0];
            if (touch) reporter.move(touch.clientX, touch.clientY, event.isTrusted);
        };
        const onDown = (event: PointerEvent): void => {
            if (event.pointerType === "touch" || event.pointerType === "pen") reporter.touch(event.isTrusted);
        };
        const onFocusChange = (): void => reporter.evaluate();
        // Capture, so a view that stops propagation (the KVM screen forwards its input) is still seen.
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("pointermove", onMove, true);
        document.addEventListener("pointerdown", onDown, true);
        document.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
        window.addEventListener("focus", onFocusChange);
        window.addEventListener("blur", onFocusChange);
        document.addEventListener("visibilitychange", onFocusChange);
        const timer = setInterval(reporter.evaluate, 1000);
        return () => {
            document.removeEventListener("keydown", onKey, true);
            document.removeEventListener("pointermove", onMove, true);
            document.removeEventListener("pointerdown", onDown, true);
            document.removeEventListener("touchmove", onTouchMove, true);
            window.removeEventListener("focus", onFocusChange);
            window.removeEventListener("blur", onFocusChange);
            document.removeEventListener("visibilitychange", onFocusChange);
            clearInterval(timer);
        };
    }, []);

    // The focus the hook sees can change before the window's own events (a re-render on a store change): re-read it.
    useEffect(() => evaluateRef.current(), [background]);
}
