/**
 * The colour of the system's status area, one value from the active tab and the theme.
 *
 * On the installed iPhone the bar area is the system's own glass, tinted from the page at the top edge, with its text
 * dark or light to suit. So that tint is not left to chance (it was the theme's grey over a black KVM, and a frosted
 * gradient between the two): the top edge (#status-edge), the page behind everything (html and body) and the
 * theme-color meta are all this one colour. The KVM is black: the picture's own letterboxing is black, and a light bar
 * over it would be a stripe. Chat, Recordings and Settings are the page's own colour, so the bar reads as the page, white-ish in
 * the light theme and the dark page colour in the dark one.
 *
 * The same rule is in index.html's inline script, so the first frame is right for the route it opens on.
 */

import type { TabId } from "./nav";
import type { Theme } from "../theme";

/** The pages' own background in each theme (--background in styles.css). */
export const PAGE_COLOUR: Record<Theme, string> = { light: "#eef0f4", dark: "#0a0a0c" };

export const KVM_COLOUR = "#000000";

export function statusColour(tab: TabId | undefined, theme: Theme): string {
    return tab === "chat" || tab === "recordings" || tab === "settings" ? PAGE_COLOUR[theme] : KVM_COLOUR;
}

/** Put it where the page and the system look for it: the custom property the CSS reads, and theme-color. */
export function paintStatusColour(colour: string, root: HTMLElement = document.documentElement): void {
    root.style.setProperty("--status-colour", colour);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", colour);
}
