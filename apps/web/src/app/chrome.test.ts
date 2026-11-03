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
 *  7. The shell is sized from 100dvh, innerHeight or the visual viewport in the installed app. On the iPhone those
 *     report the screen minus an inset when the app starts (100vh does not), so the shell stops short and the
 *     system background shows under the navigation bar. The height is 100vh there, and only the keyboard may
 *     replace it.
 *  8. The status-bar style goes back to black-translucent. On the iPhone this was reported from (iOS 26) that
 *     style gets the system's own gradient over the top of the page, which no CSS can remove, and a page 62px
 *     short of the screen with the system background under the bar. Real-device evidence, not reproducible
 *     headless: the meta is what has to stay "black" (a solid bar, the page below it).
 *  9. A soft blur or gradient at the top that appears once a pane has been visited: a backdrop-filter, mask or
 *     gradient near the top edge, or no solid black element there for the system to find. The top edge is one
 *     opaque black #status-edge on every tab, deep enough to count, and the shell is padded by the same amount.
 *
 * What a browser draws from this is asserted in e2e/phone-chrome.e2e.mjs; this file is the static
 * contract the pixels depend on.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setThemeChoice } from "../theme";

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
    it("is black in the manifest, the meta tag and the offline page", () => {
        expect(meta("theme-color")).toBe("#000000");
        expect(manifest.theme_color).toBe("#000000");
        expect(worker).toMatch(/<meta name="theme-color" content="#000000">/);
    });

    it("is not re-tinted by the theme", () => {
        setThemeChoice("light");
        expect(meta("theme-color")).toBe("#000000");
        setThemeChoice("dark");
        expect(meta("theme-color")).toBe("#000000");
    });

    it("is one opaque black element at the top edge, above every surface, as deep as the reserved top", () => {
        expect(html).toMatch(/<div id="status-edge" aria-hidden="true"><\/div>/);
        const strip = rule(css, "#status-edge");
        expect(strip).toMatch(/height:\s*var\(--top-reserved\)/);
        expect(strip).toMatch(/background:\s*#000\s*;/);
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

    it("reaches the bottom: 100vh in the installed app (the dvh/visual viewport report short at launch), and no backstop", () => {
        expect(rule(css, "html[data-standalone]")).toMatch(/--app-height:\s*100vh/);
        expect(rule(css, ":root")).toMatch(/--app-height:\s*100dvh/);
        expect(rule(css, ".app-shell")).toMatch(/height:\s*var\(--app-height\)/);
        expect(css).not.toMatch(/body:has\([^)]*\)::after/);
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
        const shown = rule(css, ".nav-tab:hover .nav-tip,\n.nav-tab:focus-visible .nav-tip");
        expect(shown).toMatch(/visibility:\s*visible/);
    });

    it("marks the open item with more than colour", () => {
        expect(rule(css, '.nav-rail .nav-tab[aria-selected="true"]')).toMatch(/background:/);
    });
});
