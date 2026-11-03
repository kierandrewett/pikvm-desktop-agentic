/**
 * What the phone reports about its own viewport and how the page is laid out in it, as text for Settings > About
 * (shown, and copied with one button).
 *
 * The installed iPhone app's viewport units disagree with each other (with the black status-bar style 100vh is the
 * whole screen while 100dvh, innerHeight, the visual viewport and the web view are the screen minus the bar), the
 * status-bar style and iOS version change what is under the bar, and a fixed element is clipped to the layout
 * viewport. A screenshot or a pasted copy of this settles which of those a device is doing without a debugger.
 */

import { isStandalone } from "./standalone";

/** A zero-size fixed probe with the given CSS declarations, read with `read`, removed again. */
function probe<T>(css: string, read: (el: HTMLElement) => T): T {
    const el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = `position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;${css}`;
    document.body.append(el);
    try {
        return read(el);
    } finally {
        el.remove();
    }
}

const px = (value: number): string => `${Math.round(value * 10) / 10}`;
const height = (css: string): string => px(probe(`height:${css}`, (el) => el.getBoundingClientRect().height));
const width = (css: string): string => px(probe(`width:${css}`, (el) => el.getBoundingClientRect().width));

function media(query: string): string {
    try {
        return String(matchMedia(query).matches);
    } catch {
        return "n/a";
    }
}

function box(el: Element | null): string {
    if (!el) return "absent";
    const r = el.getBoundingClientRect();
    return `${px(r.left)},${px(r.top)} - ${px(r.right)},${px(r.bottom)} (${px(r.width)} x ${px(r.height)})`;
}

function style(el: Element | null): string {
    if (!el) return "absent";
    const s = getComputedStyle(el);
    const parts = [`position ${s.position}`, `height ${s.height}`, `overflow ${s.overflowX}/${s.overflowY}`, `bg ${s.backgroundColor}`];
    if (s.contain !== "none") parts.push(`contain ${s.contain}`);
    if (s.transform !== "none") parts.push(`transform ${s.transform}`);
    if (s.filter !== "none") parts.push(`filter ${s.filter}`);
    return parts.join(", ");
}

/** Every ancestor of `el` that is shorter than it, or that clips: where a too-tall child would be cut off. */
function clippers(el: Element | null): string {
    if (!el) return "absent";
    const own = el.getBoundingClientRect();
    const found: string[] = [];
    for (let up = el.parentElement; up; up = up.parentElement) {
        const s = getComputedStyle(up);
        const r = up.getBoundingClientRect();
        const clips = s.overflowX !== "visible" || s.overflowY !== "visible" || s.contain !== "none";
        if (clips && r.bottom < own.bottom - 0.5) found.push(`${up.tagName.toLowerCase()}${up.id ? `#${up.id}` : ""} ends ${px(r.bottom)} (${s.position}, overflow ${s.overflowY})`);
    }
    return found.length ? found.join("; ") : "none";
}

export function viewportReport(): string {
    const root = document.documentElement;
    const visual = window.visualViewport;
    const shell = document.querySelector(".app-shell");
    const nav = document.querySelector(".nav-bar, .nav-rail");
    const edge = document.getElementById("status-edge");
    const rows: [string, string][] = [
        ["build", __BUILD_ID__],
        ["user agent", navigator.userAgent],
        ["navigator.standalone", String("standalone" in navigator ? navigator.standalone : "absent")],
        ["display-mode", `standalone ${media("(display-mode: standalone)")}, fullscreen ${media("(display-mode: fullscreen)")}, minimal-ui ${media("(display-mode: minimal-ui)")}, browser ${media("(display-mode: browser)")}`],
        ["html data", `standalone ${root.getAttribute("data-standalone")}, ios-standalone ${root.getAttribute("data-ios-standalone")}, keyboard ${root.getAttribute("data-keyboard")}, theme ${root.getAttribute("data-theme")}`],
        ["app standalone()", String(isStandalone())],
        ["safe-area insets", `top ${height("env(safe-area-inset-top, 0px)")}, bottom ${height("env(safe-area-inset-bottom, 0px)")}, left ${width("env(safe-area-inset-left, 0px)")}, right ${width("env(safe-area-inset-right, 0px)")}`],
        ["--app-height", `${getComputedStyle(root).getPropertyValue("--app-height").trim()} = ${height("var(--app-height)")}px (inline "${root.style.getPropertyValue("--app-height")}")`],
        ["--top-reserved / --status-edge", `${height("var(--top-reserved)")}px / ${height("var(--status-edge)")}px`],
        ["screen", `${screen.width} x ${screen.height} (avail ${screen.availWidth} x ${screen.availHeight})`],
        ["100vh / 100lvh / 100svh / 100dvh", `${height("100vh")} / ${height("100lvh")} / ${height("100svh")} / ${height("100dvh")}`],
        ["inner / outer", `${innerWidth} x ${innerHeight} / ${outerWidth} x ${outerHeight}`],
        ["visualViewport", visual ? `${px(visual.width)} x ${px(visual.height)}, offsetTop ${px(visual.offsetTop)}, pageTop ${px(visual.pageTop)}, scale ${visual.scale}` : "absent"],
        ["documentElement", `client ${root.clientWidth} x ${root.clientHeight}, scroll ${root.scrollWidth} x ${root.scrollHeight}, scrollY ${px(scrollY)}`],
        ["fixed element, top 0 bottom 0", `height ${px(probe("height:auto;bottom:0", (el) => el.getBoundingClientRect().height))} (the layout viewport a fixed element fills)`],
        ["html", `${box(root)} | ${style(root)}`],
        ["body", `${box(document.body)} | ${style(document.body)}`],
        ["#root", `${box(document.getElementById("root"))} | ${style(document.getElementById("root"))}`],
        [".app-shell", `${box(shell)} | ${style(shell)}`],
        ["nav", `${box(nav)}`],
        ["#status-edge", `${box(edge)} | ${style(edge)}`],
        ["ancestors that would clip the shell", clippers(shell)],
        ["ancestors that would clip the nav", clippers(nav)],
    ];
    return rows.map(([name, value]) => `${name}: ${value}`).join("\n");
}
