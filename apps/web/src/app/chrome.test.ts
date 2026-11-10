/**
 * FAILURE MODES (written before the tests) — the installed iPhone app's system chrome
 *
 *  1. The status bar is the page colour (dark #0a0a0c or light #eef0f4) instead of black: the
 *     theme-color meta or the manifest follows the theme, or the inset strip is not painted.
 *  2. Switching theme re-tints the theme-color meta, so light mode gets a light status bar.
 *  3. The strip is painted with the shell's own background, so a full-page sheet (which pads for the
 *     inset with its own background) shows its colour there.
 *  4. The home-indicator strip is not the navigation bar's: the bar does not pad by the bottom inset,
 *     or the shell pads by it too and paints its own background under the bar.
 *  5. The meta that makes the inset exist at all is dropped (viewport-fit=cover, the standalone flags),
 *     so env(safe-area-inset-*) is 0 and the strips collapse.
 *  6. The offline page the service worker serves comes up with a different status bar than the app.
 *  7. The installed app's shell is not what the web view shows. Two apps on one iPhone (402x874) both report 100dvh,
 *     innerHeight and the visual viewport as 812 and 100vh as 874. Added under the black status-bar style (top inset
 *     0) the web view is 812 and a 100vh shell put the bottom 62px of the navigation bar below the screen; added under
 *     black-translucent (top inset 62) the page runs under the bar, the web view is 874 and a 100dvh shell left a 62px
 *     gap under the bar. The height is 100dvh plus the top inset, at most 100vh, and only the keyboard may replace it.
 *  8. The status-bar style goes back to black-translucent. On the iPhone this was reported from (iOS 26) that
 *     style gets the system's own gradient over the top of the page, which no CSS can remove, and a page 62px
 *     short of the screen with the system background under the bar. Real-device evidence, not reproducible
 *     headless: the meta is what has to stay "black" (a solid bar, the page below it).
 *  9. A soft blur or gradient at the top that appears once a pane has been visited: a backdrop-filter, mask or
 *     gradient near the top edge, or no solid black element there for the system to find. The top edge is one
 *     opaque black #status-edge on every tab, deep enough to count, and the shell is padded by the same amount.
 * 10. The shell is a position:fixed element (or sits in a fixed html or body) in the installed app: iOS 26 clips a
 *     fixed root to the layout viewport, and the page background shows below the cut (real device: the navigation
 *     bar cut in half at 811 of 874 pt). With the
 *     keyboard closed html, body and the shell are normal flow and as tall as each other; while it is up,
 *     everything is fixed to the visual viewport as before.
 * 11. The diagnostics that settle a device (Settings > About > Display) lose a field, or cannot be copied.
 * 12. On Chat or Settings the status-bar area is the theme's light grey with a frosted gradient (real device): iOS colours
 *     the bar from the page, and with no qualifying fixed element it falls back to the body's background-color. In the
 *     installed app html and body are black (the KVM was black already, which is why only the other tabs showed it).
 * 13. A backdrop-filter or blur is back anywhere in the app or the chat (menus, bars, the lightbox, the composer scrim,
 *     tailed surfaces, ui.blur's glass), or the page card of the chat carries a resting shadow that reads as a line under the bar.
 * 14. The phone's new-chat composer pads the bottom inset a second time (the navigation bar owns it), leaving a dead gap
 *     under it that a conversation's composer does not have.
 *
 * What a browser draws from this is asserted in e2e/phone-chrome.e2e.mjs; this file is the static
 * contract the pixels depend on.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setThemeChoice } from "../theme";
import { KVM_COLOUR, PAGE_COLOUR } from "./status-colour";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, "../..", path), "utf8");

const html = read("index.html");
const css = read("src/styles.css");
const worker = read("public/sw.js");
const manifest = JSON.parse(read("public/manifest.webmanifest")) as Record<string, string>;

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(source: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(source);
    if (!match) throw new Error(`no rule for ${selector}`);
    return match[1] ?? "";
}

function meta(name: string): string | null {
    return document.head.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? null;
}

beforeEach(() => {
    // The real document head, so the test reads what the app ships rather than a copy of it.
    const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";
    document.head.innerHTML = head.replace(/<script>[\s\S]*?<\/script>/, "");
});

afterEach(() => {
    document.head.innerHTML = "";
    localStorage.clear();
});

describe("status bar", () => {
    it("starts black in the manifest, the meta tag and the offline page (the shell then paints it per tab)", () => {
        expect(meta("theme-color")).toBe("#000000");
        expect(manifest.theme_color).toBe("#000000");
        expect(worker).toMatch(/<meta name="theme-color" content="#000000">/);
    });

    it("is not re-tinted by theme.ts itself: the shell paints it, from the tab and the theme (status-colour.ts)", () => {
        setThemeChoice("light");
        expect(meta("theme-color")).toBe("#000000");
        setThemeChoice("dark");
        expect(meta("theme-color")).toBe("#000000");
    });

    it("is worked out before first paint for the route it opens on, with the same colours as status-colour.ts", () => {
        expect(html).toMatch(/\^\\\/app\\\/\(chat\|settings\|recordings\)/);
        expect(html).toContain(`"${PAGE_COLOUR.light}"`);
        expect(html).toContain(`"${PAGE_COLOUR.dark}"`);
        expect(html).toContain(`"${KVM_COLOUR}"`);
        expect(html).toMatch(/setProperty\("--status-colour", status\)/);
    });

    it("is one opaque element at the top edge in the status colour, above every surface, as deep as the reserved top", () => {
        expect(html).toMatch(/<div id="status-edge" aria-hidden="true"><\/div>/);
        const strip = rule(css, "#status-edge");
        expect(strip).toMatch(/height:\s*var\(--top-reserved\)/);
        expect(strip).toMatch(/background:\s*var\(--status-colour\)\s*;/);
        expect(strip).toMatch(/position:\s*fixed/);
        expect(strip).toMatch(/left:\s*0/);
        expect(strip).toMatch(/right:\s*0/);
        expect(strip).toMatch(/top:\s*var\(--app-top/);
        expect(strip).toMatch(/z-index:\s*2147483647/);
        expect(strip).toMatch(/pointer-events:\s*none/);
    });

    it("is deeper than the 10px the system needs to read its colour, in the installed iOS app", () => {
        expect(rule(css, "html[data-ios-standalone]")).toMatch(/--status-edge:\s*(1[1-9]|[2-9]\d)px/);
        expect(rule(css, ":root")).toMatch(/--top-reserved:\s*max\(env\(safe-area-inset-top, 0px\), var\(--status-edge\)\)/);
    });

    it("is reserved by the shell, so nothing, scrollers included, touches the top edge", () => {
        expect(rule(css, ".app-shell")).toMatch(/padding-top:\s*var\(--top-reserved\)/);
    });

    it("has nothing translucent at the top of the KVM: the resolution pill is not a backdrop blur", () => {
        const kvmCss = read("src/kvm/kvm.css");
        expect(rule(kvmCss, ".kvm-res-toast,\n.kvm-toast")).not.toMatch(/backdrop-filter/);
    });

    it("is also black on the offline page", () => {
        expect(worker).toMatch(/html::before\s*\{[^}]*env\(safe-area-inset-top[^}]*background:\s*#000/);
    });
});

describe("home indicator strip", () => {
    it("belongs to the navigation bar: its own background, padded by the inset", () => {
        const bar = rule(css, ".nav-bar");
        expect(bar).toMatch(/background:\s*var\(--card\)/);
        expect(bar).toMatch(/padding:[^;]*env\(safe-area-inset-bottom\)/);
    });

    it("is not padded or painted by the shell in the phone layout", () => {
        expect(rule(css, ".app-shell")).not.toMatch(/padding(-bottom)?:[^;]*safe-area-inset-bottom/);
        expect(rule(css, '.app-shell[data-layout="compact"] .app-main')).not.toMatch(/safe-area-inset-bottom/);
    });

    it("lets the bar run to the screen edge under a landscape notch", () => {
        expect(rule(css, ".app-shell")).not.toMatch(/safe-area-inset-(left|right)/);
        expect(rule(css, ".nav-bar")).toMatch(/safe-area-inset-left/);
        expect(rule(css, ".nav-bar")).toMatch(/safe-area-inset-right/);
    });

    it("reaches the bottom: 100dvh in a tab, 100dvh plus the top inset (at most 100vh) in the installed app, and no backstop", () => {
        expect(rule(css, ":root")).toMatch(/--app-height:\s*100dvh/);
        expect(rule(css, "html[data-standalone]")).toMatch(/--app-height:\s*min\(100vh,\s*calc\(100dvh \+ env\(safe-area-inset-top/);
        expect(rule(css, ".app-shell")).toMatch(/height:\s*var\(--app-height\)/);
        expect(css).not.toMatch(/body:has\([^)]*\)::after/);
    });

    it("is normal flow in the installed app while the keyboard is closed: no fixed root that iOS 26 would clip", () => {
        const flow = (selector: string) => rule(css, `html[data-standalone]:not([data-keyboard="open"])${selector}`);
        expect(flow("")).toMatch(/position:\s*static/);
        expect(flow("")).toMatch(/height:\s*var\(--app-height\)/);
        expect(flow(" body")).toMatch(/position:\s*relative/);
        expect(flow(" body")).toMatch(/height:\s*var\(--app-height\)/);
        expect(flow(" .app-shell")).toMatch(/position:\s*relative/);
        expect(flow(" .app-shell")).toMatch(/height:\s*var\(--app-height\)/);
        expect(flow(" .dlg-scrim,\nhtml[data-standalone]:not([data-keyboard=\"open\"]) .kvm-toast")).toMatch(/position:\s*absolute/);
    });

    it("is told apart for iOS by the device as well as navigator.standalone", () => {
        expect(html).toMatch(/iPhone\|iPad\|iPod/);
        expect(html).toMatch(/standalone && ios/);
    });

    it("is standalone only where the manifest's display mode applies: navigator.standalone alone (Firefox's home-screen app) is the browser layout", () => {
        const script = /var standalone = ([^;]*);/.exec(html)?.[1] ?? "";
        expect(script).toMatch(/display-mode: standalone/);
        expect(script).toMatch(/display-mode: fullscreen/);
        expect(script).not.toMatch(/navigator\.standalone/);
        const source = read("src/app/standalone.ts");
        const decision = /const display = ([^;]*);/.exec(source)?.[1] ?? "";
        expect(decision).toMatch(/display-mode: standalone/);
        expect(source).toMatch(/if \(display\) root\.setAttribute\(STANDALONE/);
        expect(source).toMatch(/if \(display && ios\) root\.setAttribute\(IOS_STANDALONE/);
        expect(source).not.toMatch(/legacy \|\| display/);
    });

    it("takes the status colour on html and body in the installed app, so the page the system samples is the bar's colour on every tab", () => {
        expect(rule(css, "html[data-standalone],\nhtml[data-standalone] body")).toMatch(/background-color:\s*var\(--status-colour\)/);
        expect(css).toMatch(/:root\s*\{\s*--status-colour:\s*#000;\s*\}/);
    });

    it("has no backdrop-filter or blur anywhere in the app's or the chat's styles and classes", () => {
        const files = [
            "src/styles.css",
            "src/kvm/kvm.css",
            "src/kvm/dialogs/dialogs.css",
            "../../packages/chat-web/src/styles/chat.css",
            "../../packages/chat-web/src/styles/tokens.css",
            "../../packages/chat-web/src/components/thread/markdown.css",
            "../../packages/chat-web/src/ui/tailed-surface.css",
            "../../packages/chat-web/src/components/ui/menu.tsx",
            "../../packages/chat-web/src/components/render/toolbar.tsx",
            "../../packages/chat-web/src/components/composer/attachments.tsx",
        ];
        for (const file of files) {
            const text = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
            const live = text.split("\n").filter((line) => /backdrop-blur|backdrop-filter|(^|[^.\w])blur\(|--scrim-blur/.test(line) && !/backdrop-filter:\s*none|var\(--glass-filter\)/.test(line));
            expect({ file, live }).toEqual({ file, live: [] });
        }
        // ui.blur no longer turns anything on: the glass tokens stay solid and unfiltered.
        const tokens = read("../../packages/chat-web/src/styles/tokens.css");
        expect(tokens).toMatch(/\.chat-scope\[data-blur="on"\]\s*\{\s*--glass-alpha:\s*100%;\s*--glass-filter:\s*none;/);
    });

    it("docks the chat's in-pane padding on nothing: the navigation bar owns the bottom inset", () => {
        expect(rule(css, ".app-main")).toMatch(/--host-dock-safe-bottom:\s*0px/);
    });

    it("is decided before first paint, from the same rule as the app's own", () => {
        expect(html).toMatch(/navigator\.standalone === true/);
        expect(html).toMatch(/data-standalone/);
        expect(html).toMatch(/data-ios-standalone/);
        expect(html.indexOf("data-standalone")).toBeLessThan(html.indexOf('src="/src/main.tsx"'));
    });
});

describe("the installed app's meta", () => {
    it("is edge to edge at the bottom, with a solid black bar and the page below it", () => {
        expect(meta("viewport")).toMatch(/viewport-fit=cover/);
        expect(meta("apple-mobile-web-app-capable")).toBe("yes");
        expect(meta("mobile-web-app-capable")).toBe("yes");
        expect(meta("apple-mobile-web-app-status-bar-style")).toBe("black");
    });

    it("is standalone", () => {
        expect(manifest.display).toBe("standalone");
    });
});

describe("desktop navigation rail", () => {
    it("is as narrow as an icon: 45px with its edge, not the 64px of icon-and-label tabs", () => {
        expect(rule(css, ".nav-rail")).toMatch(/width:\s*calc\(45px \+ env\(safe-area-inset-left\)\)/);
        expect(rule(css, ".nav-rail .nav-tab")).toMatch(/min-height:\s*36px/);
    });

    it("shows a tooltip only on hover and on keyboard focus", () => {
        expect(rule(css, ".nav-tip")).toMatch(/visibility:\s*hidden/);
        expect(rule(css, ".nav-tip")).toMatch(/pointer-events:\s*none/);
        expect(rule(css, ".nav-tab:focus-visible .nav-tip")).toMatch(/visibility:\s*visible/);
        // Hover only where there is a hover (a mouse): on a touch screen a :hover that shows something swallows the first tap.
        expect(rule(css, ".nav-tab:hover .nav-tip")).toMatch(/visibility:\s*visible/);
    });

    it("marks the open item with more than colour", () => {
        expect(rule(css, '.nav-rail .nav-tab[aria-selected="true"]')).toMatch(/background:/);
    });
});
