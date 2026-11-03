/**
 * Is this the installed app (standalone), decided once.
 *
 * The inline script in index.html decides it before first paint and puts it on <html>
 * (data-standalone, data-ios-standalone), where the CSS reads it (styles.css). This is the same rule for
 * a page that script did not run for, and it is what the layout code asks afterwards: the attribute, not a
 * fresh look at the window, so CSS and JS cannot disagree and a later change (an orientation, a media
 * query that flickers during launch) cannot flip the layout mid-session.
 */

const STANDALONE = "data-standalone";
const IOS_STANDALONE = "data-ios-standalone";

/** Set the flags on <html> if the inline script did not (the same rule as index.html). Idempotent: a flag already there is kept. */
export function markStandalone(root: HTMLElement = document.documentElement): void {
    if (root.hasAttribute(STANDALONE)) return;
    try {
        const legacy = "standalone" in navigator && navigator.standalone === true;
        const display = matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: fullscreen)").matches;
        const ios = legacy || /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        if (legacy || display) root.setAttribute(STANDALONE, "true");
        if ((legacy || display) && ios) root.setAttribute(IOS_STANDALONE, "true");
    } catch {
        // No matchMedia: a browser tab.
    }
}

/** The installed app: no URL bar, so the large viewport (100vh) is the whole screen. */
export function isStandalone(root: HTMLElement = document.documentElement): boolean {
    return root.getAttribute(STANDALONE) === "true";
}
