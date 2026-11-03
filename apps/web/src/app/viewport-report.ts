/**
 * What the phone reports about its own viewport, as one line for Settings > About.
 *
 * The installed iPhone app's viewport units disagree with each other (100vh is the screen, 100dvh and the
 * visual viewport are the screen minus an inset when it starts), and which one is right depends on the iOS
 * version and the status-bar style. A screenshot of this line settles it without a debugger.
 */

import { isStandalone } from "./standalone";

/** Height in px of a zero-width fixed probe with the given CSS height (a length that depends on the viewport or on env()). */
function measure(height: string): number {
    const probe = document.createElement("div");
    probe.style.cssText = `position:fixed;left:0;top:0;width:0;height:${height};visibility:hidden;pointer-events:none`;
    document.body.append(probe);
    const px = probe.getBoundingClientRect().height;
    probe.remove();
    return Math.round(px);
}

export function viewportReport(): string {
    const standalone = isStandalone() ? (document.documentElement.hasAttribute("data-ios-standalone") ? "ios standalone" : "standalone") : "browser";
    const parts = [
        standalone,
        `100vh ${measure("100vh")}`,
        `100dvh ${measure("100dvh")}`,
        `100svh ${measure("100svh")}`,
        `inner ${window.innerHeight}`,
        `visual ${Math.round(window.visualViewport?.height ?? 0)}`,
        `screen ${window.screen.height}`,
        `app ${measure("var(--app-height)")}`,
        `inset top ${measure("env(safe-area-inset-top, 0px)")} bottom ${measure("env(safe-area-inset-bottom, 0px)")}`,
    ];
    return parts.join(" · ");
}
