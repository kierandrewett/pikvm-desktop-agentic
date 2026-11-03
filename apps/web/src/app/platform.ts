/**
 * iOS, decided once, for the two things that only iOS needs from the page.
 *
 *  - `data-ios` on <html>: the type tokens (styles.css) switch to the system's text styles and Dynamic Type under
 *    it. index.html's inline script sets it before first paint; this is the same rule for a page that script did not
 *    run for (and what the page asks afterwards, so CSS and JS cannot disagree).
 *  - A touchstart listener on the document, which does nothing: Safari on iOS only applies :active to an element
 *    when the page has a touch listener somewhere above it, and without one a pressed button shows nothing until
 *    the finger lifts. Passive, so it can never delay a scroll.
 */

const IOS = "data-ios";

interface IosHost {
    readonly userAgent: string;
    readonly platform: string;
    readonly maxTouchPoints: number;
    readonly standalone?: boolean | undefined;
}

/** An iPhone, an iPod, or an iPad (which says it is a Mac, with a touch screen). */
export function isIos(host: IosHost): boolean {
    return host.standalone === true || /iPhone|iPad|iPod/.test(host.userAgent) || (host.platform === "MacIntel" && host.maxTouchPoints > 1);
}

/** Set `data-ios` on <html> if the inline script did not. Idempotent. Returns whether this is iOS. */
export function markIos(root: HTMLElement = document.documentElement, host: IosHost = navigator): boolean {
    if (root.hasAttribute(IOS)) return true;
    if (!isIos(host)) return false;
    root.setAttribute(IOS, "true");
    return true;
}

/** Let :active work on iOS. Returns what removes the listener. */
export function enablePressedState(doc: Document = document, host: IosHost = navigator): () => void {
    if (!isIos(host)) return () => {};
    const noop = (): void => {};
    doc.addEventListener("touchstart", noop, { passive: true });
    return () => doc.removeEventListener("touchstart", noop);
}
