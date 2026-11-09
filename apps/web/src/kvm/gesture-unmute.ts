/**
 * Run something once, inside the next real user gesture.
 *
 * Safari lets a page unmute audio only from a user gesture, and a touch is one when it is RELEASED (`pointerup`,
 * `touchend`) or clicked, not when it lands (`pointerdown`): waiting for the touch to land left an iPhone silent
 * however often it was tapped (K38). Capture phase on the document, so it runs before the pointer machine and
 * anything else that handles the same event, while the gesture is still live.
 *
 * Returns the cancel. Cancelling after it has run does nothing.
 */

const ACTIVATION_EVENTS = ["pointerup", "touchend", "click", "keydown"] as const;

export function onNextActivation(target: Document, run: (event: Event) => void): () => void {
    const stop = (): void => {
        for (const type of ACTIVATION_EVENTS) target.removeEventListener(type, handler, true);
    };
    function handler(event: Event): void {
        stop();
        run(event);
    }
    for (const type of ACTIVATION_EVENTS) target.addEventListener(type, handler, true);
    return stop;
}
