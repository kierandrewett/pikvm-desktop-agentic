// The installed iPhone app's system chrome, against a real web host in front of tools/fake-kvmd:
// the status-bar strip is solid black and the home-indicator strip is the navigation bar's own
// colour, on every tab, in both themes, in portrait and landscape. Also: the meta tags and the
// manifest, and that desktop and Android (no insets) are untouched.
//
// Headless Chrome has no notch, so the insets are emulated with CDP Emulation.setSafeAreaInsetsOverride:
// env(safe-area-inset-*) then reads exactly what an iPhone 13 reports (portrait 47 / 34, landscape
// 0 / 21 with 47 on each side). Colours are read back from the screenshot's pixels, not from CSS.
//
//   node apps/web/e2e/phone-chrome.e2e.mjs [--out docs/e2e/phone-chrome] [--doc docs/e2e/2026-11-03-phone-feedback.md]
//
// See docs/e2e/README.md for how to bring the two servers up.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WEB, FAKE, Report, fakeReset, launch, puppeteer, sleep } from "./harness.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const outDir = flag("--out", "docs/e2e/phone-chrome");
const docPath = flag("--doc", "docs/e2e/2026-11-03-phone-feedback.md");
mkdirSync(outDir, { recursive: true });

const report = new Report("Phone chrome");
const THEME_KEY = "pikvm-console-theme";
const TABS = ["kvm", "chat", "settings"];

/** What an iPhone 13 reports in each orientation. */
const PORTRAIT = { top: 47, bottom: 34, left: 0, right: 0 };
const LANDSCAPE = { top: 0, bottom: 21, left: 47, right: 47 };
/** The page starts BELOW the system's black status bar (style "black"): no top inset, the home indicator still at the bottom. */
const BELOW_BAR = { top: 0, bottom: 34, left: 0, right: 0 };

/** The system's status area follows the page (app/status-colour.ts): black over the KVM, the page's own colour on Chat and Settings. */
const PAGE = { light: "#eef0f4", dark: "#0a0a0c" };
const expectedStatus = (tab, theme) => (tab === "chat" || tab === "settings" ? PAGE[theme] : "#000000");
const rgbOf = (hexColour) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hexColour.slice(i, i + 2), 16)).join(", ")})`;

async function check(profile, name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add(profile, name, observed, pass);
    } catch (error) {
        report.add(profile, name, `threw: ${error.message}`, false);
    }
}

const hex = (r, g, b) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const rgbToHex = (css) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
    return m ? hex(Number(m[1]), Number(m[2]), Number(m[3])) : css;
};

/** Read pixel colours out of a PNG screenshot (css px -> device px by `scale`) with a canvas in a scratch page. */
async function pixels(scratch, png, scale, points) {
    return scratch.evaluate(
        async (b64, k, pts) => {
            const image = new Image();
            image.src = `data:image/png;base64,${b64}`;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(image, 0, 0);
            return pts.map(([x, y]) => {
                const [r, g, b] = ctx.getImageData(Math.min(image.width - 1, Math.round(x * k)), Math.min(image.height - 1, Math.round(y * k)), 1, 1).data;
                return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
            });
        },
        Buffer.from(png).toString("base64"),
        scale,
        points,
    );
}

/**
 * `opts.ios`: the page runs as the installed iPhone app (navigator.standalone is true, before any script).
 * `opts.keyboard`: `window.__keyboard(px)` takes `px` from innerHeight and visualViewport.height and tells the
 * visual viewport, as the soft keyboard does.
 */
async function open(browser, device, theme, insets, opts = {}) {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => {
        if (!/janus\/ws|Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    if (typeof device === "string") await page.emulate(puppeteer.KnownDevices[device]);
    else await page.setViewport(device);
    if (insets) {
        const cdp = await page.createCDPSession();
        await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
    }
    await page.evaluateOnNewDocument((key, value) => localStorage.setItem(key, value), THEME_KEY, theme);
    await page.evaluateOnNewDocument(
        (ios, keyboard, fx) => {
            if (ios || fx) Object.defineProperty(navigator, "standalone", { configurable: true, get: () => true });
            if (ios) {
                // The Safari-made app: the manifest's display mode applies. (The Firefox-made one has navigator.standalone and display-mode browser.)
                const real = window.matchMedia.bind(window);
                window.matchMedia = (query) => {
                    const list = real(query);
                    if (!/display-mode:\s*standalone/.test(query)) return list;
                    return new Proxy(list, { get: (target, key) => (key === "matches" ? true : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
                };
            }
            if (!keyboard) return;
            let keys = 0;
            const inner = Object.getOwnPropertyDescriptor(window, "innerHeight")?.get;
            const visual = Object.getOwnPropertyDescriptor(VisualViewport.prototype, "height")?.get;
            if (!inner || !visual) throw new Error("cannot shrink the viewport here");
            Object.defineProperty(window, "innerHeight", { configurable: true, get: () => inner.call(window) - keys });
            Object.defineProperty(window.visualViewport, "height", { configurable: true, get: () => visual.call(window.visualViewport) - keys });
            window.__keyboard = (px) => {
                keys = px;
                window.visualViewport.dispatchEvent(new Event("resize"));
            };
        },
        opts.ios === true,
        opts.keyboard === true,
        opts.firefox === true,
    );
    await page.goto(`${WEB}/app/`, { waitUntil: "load" });
    await page.waitForSelector('[role="tab"]');
    await page.waitForFunction(() => (document.querySelector(".kvm-dot")?.getAttribute("aria-label") ?? "") === "Live", { timeout: 15000 });
    return { page, logs };
}

async function goTo(page, tab, touch) {
    if (touch) await page.tap(`#tab-${tab}`);
    else await page.click(`#tab-${tab}`);
    await page.waitForFunction((id) => document.getElementById(`panel-${id}`)?.dataset.active === "true", {}, tab);
    await sleep(250);
}

/** What the page says about its chrome right now. `realHeight` is the screen the page is in, whatever it reports. */
const chrome = (page, realHeight) =>
    page.evaluate((realHeight) => {
        const bar = document.querySelector(".nav-bar");
        const rail = document.querySelector(".nav-rail");
        const nav = bar ?? rail;
        const rect = nav.getBoundingClientRect();
        const style = getComputedStyle(nav);
        const shell = getComputedStyle(document.querySelector(".app-shell"));
        const shellRect = document.querySelector(".app-shell").getBoundingClientRect();
        const edge = document.getElementById("status-edge");
        const edgeStyle = edge ? getComputedStyle(edge) : null;
        const at = document.elementFromPoint(Math.min(innerWidth - 3, rect.left + 3), realHeight - 2);
        return {
            kind: bar ? "bar" : "rail",
            width: innerWidth,
            height: realHeight,
            reported: innerHeight,
            // #status-edge: the black strip at the very top (called `strip` here and in the report).
            strip: edgeStyle?.height ?? "no #status-edge",
            stripBg: edgeStyle?.backgroundColor ?? "",
            stripPosition: edgeStyle?.position ?? "",
            stripWidth: edge ? Math.round(edge.getBoundingClientRect().width) : 0,
            shellRect: [shellRect.left, shellRect.top, shellRect.right, shellRect.bottom].map(Math.round),
            navRect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.right), Math.round(rect.bottom)],
            navBg: style.backgroundColor,
            navPad: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
            shellPadBottom: shell.paddingBottom,
            shellPadTop: shell.paddingTop,
            shellBg: shell.backgroundColor,
            bodyBg: getComputedStyle(document.body).backgroundColor,
            htmlBg: getComputedStyle(document.documentElement).backgroundColor,
            metaColour: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
            statusVar: document.documentElement.style.getPropertyValue("--status-colour"),
            appHeightVar: document.documentElement.style.getPropertyValue("--app-height"),
            htmlPos: getComputedStyle(document.documentElement).position,
            bodyPos: getComputedStyle(document.body).position,
            shellPos: shell.position,
            keyboardAttr: document.documentElement.getAttribute("data-keyboard"),
            // Every ancestor of the shell that clips and ends above the shell's bottom: where it would be cut off.
            clippers: (() => {
                const out = [];
                for (let up = document.querySelector(".app-shell").parentElement; up; up = up.parentElement) {
                    const s = getComputedStyle(up);
                    const clips = s.overflowX !== "visible" || s.overflowY !== "visible" || s.contain !== "none";
                    if (clips && up.getBoundingClientRect().bottom < shellRect.bottom - 0.5) out.push(`${up.tagName.toLowerCase()} ends ${Math.round(up.getBoundingClientRect().bottom)}`);
                }
                return out;
            })(),
            underBottomEdge: at ? (at.closest(".nav-bar, .nav-rail") ? "nav" : at.className || at.tagName) : "none",
        };
    }, realHeight);

/**
 * Everything within the top 60px that is blurred, masked, a gradient or translucent and wide enough to be a veil,
 * or a scroller that touches the edge. Hidden panes count for blur and masks (they are still in the page), not for
 * what is only painted.
 */
const topScan = (page) =>
    page.evaluate(() => {
        const edge = document.getElementById("status-edge")?.getBoundingClientRect().height ?? 0;
        const found = [];
        for (const el of document.querySelectorAll("html *")) {
            if (el.id === "status-edge") continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.top >= 60) continue;
            const s = getComputedStyle(el);
            const hiddenPane = el.closest('.app-pane[data-active="false"]') !== null || s.visibility === "hidden";
            const wide = r.width >= innerWidth * 0.25;
            const why = [];
            if (s.backdropFilter && s.backdropFilter !== "none") why.push("backdrop-filter");
            if (s.maskImage && s.maskImage !== "none") why.push("mask");
            if (s.filter && s.filter !== "none" && wide) why.push("filter");
            if (!hiddenPane && wide && /gradient/.test(s.backgroundImage)) why.push("gradient");
            const alpha = s.backgroundColor.match(/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*([\d.]+)\)/)?.[1];
            if (!hiddenPane && wide && alpha !== undefined && Number(alpha) > 0 && Number(alpha) < 1) why.push(`translucent ${s.backgroundColor}`);
            if (/auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1 && r.top < edge - 0.5) why.push("scroller under the edge");
            // A soft shadow cast by something wide near the top (a resting drop shadow under a pane, say) reads as a line under the bar.
            if (!hiddenPane && wide && s.boxShadow !== "none") {
                for (const part of s.boxShadow.split(/,(?![^(]*\))/)) {
                    const nums = part.replace(/rgba?\([^)]*\)/g, "").match(/-?[\d.]+px/g)?.map(Number.parseFloat) ?? [];
                    if (!part.includes("inset") && (nums[2] ?? 0) >= 6) why.push(`shadow ${part.trim()}`);
                }
            }
            if (why.length) found.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 36)}@${Math.round(r.top)}: ${why.join(", ")}`);
        }
        return found;
    });

/** Every element (and its ::before and ::after) with a backdrop-filter or a blur filter, anywhere on the page, hidden panes and overlays included. */
const blurScan = (page) =>
    page.evaluate(() => {
        const found = [];
        for (const el of document.querySelectorAll("html, html *")) {
            for (const pseudo of [null, "::before", "::after"]) {
                const s = getComputedStyle(el, pseudo);
                const backdrop = s.backdropFilter || s.webkitBackdropFilter || "none";
                if (backdrop !== "none" || /blur/.test(s.filter || "")) found.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String(el.className).slice(0, 30)}${pseudo ?? ""}: ${backdrop !== "none" ? `backdrop-filter ${backdrop}` : `filter ${s.filter}`}`);
            }
        }
        return found;
    });

/** One phone orientation, one theme, every tab. */
async function phone(browser, scratch, label, device, insets, theme, opts = {}) {
    const profile = `${label}, ${theme}`;
    const file = label.replace(/\W+/g, "-");
    await fakeReset();
    const { page, logs } = await open(browser, device, theme, insets, opts);
    const dsf = await page.evaluate(() => devicePixelRatio);
    // The screen the page is in, whatever the page reports (the keyboard hook shrinks it, see open()).
    const real = page.viewport().height;
    // The black strip at the top: the status-bar inset, and in the installed iOS app at least 12px.
    const edge = Math.max(insets.top, opts.ios ? 12 : 0);
    try {
        for (const tab of TABS) {
            await goTo(page, tab, true);
            const c = await chrome(page, real);
            const png = await page.screenshot({ path: `${outDir}/${file}-${theme}-${tab}.png` });
            const navHex = rgbToHex(c.navBg);
            const w = c.width;
            const h = real;

            const want = expectedStatus(tab, theme);
            await check(profile, `${tab}: the top edge is ${edge}px of ${want} (the page's colour at the top) and the shell is padded by it`, async () => {
                if (edge === 0) return [c.strip === "0px" && c.shellPadTop === "0px", `strip height ${c.strip}, shell padding-top ${c.shellPadTop} (nothing of ours at the top: the bar is the system's, the page is below it)`];
                const xs = [1, Math.round(w / 2), w - 2];
                const ys = [1, Math.round(edge / 2), edge - 1];
                const got = await pixels(scratch, png, dsf, ys.flatMap((y) => xs.map((x) => [x, y])));
                const below = await pixels(scratch, png, dsf, [[Math.round(w / 2), edge + 3]]);
                // html and body take the same colour in the installed app (the KVM paints its own black over a transparent body).
                const page = !opts.ios || (c.htmlBg === rgbOf(want) && [rgbOf(want), "rgba(0, 0, 0, 0)"].includes(c.bodyBg));
                return [
                    c.strip === `${edge}px` && c.stripBg === rgbOf(want) && c.stripPosition === "fixed" && c.stripWidth === w && c.shellPadTop === `${edge}px` && got.every((p) => p === want) && c.metaColour === want && c.statusVar === want && page,
                    `status-edge ${c.strip} x ${c.stripWidth} (${c.stripPosition}) ${c.stripBg}, shell padding-top ${c.shellPadTop}; ${got.length} pixels over it all ${[...new Set(got)].join("/")}; first pixel below it ${below[0]} (page bg ${rgbToHex(c.shellBg)}); html ${c.htmlBg}, body ${c.bodyBg}, theme-color ${c.metaColour}`,
                ];
            });

            await check(profile, `${tab}: the shell fills the screen exactly (bottom ${real})`, async () => {
                // The installed app (ios profiles): no fixed html, body or shell for iOS 26 to clip to a short layout viewport,
                // and no clipping ancestor shorter than the shell.
                const flow = !opts.ios || (c.htmlPos !== "fixed" && c.bodyPos !== "fixed" && c.shellPos !== "fixed" && c.clippers.length === 0);
                const ok = flow && c.shellRect[0] === 0 && c.shellRect[2] === w && c.shellRect[3] === real && c.shellRect[1] === 0;
                return [ok, `shell ${c.shellRect.join(",")} of ${w}x${real}; the page reports innerHeight ${c.reported}; --app-height written by the shell: "${c.appHeightVar}"; position html ${c.htmlPos} / body ${c.bodyPos} / shell ${c.shellPos}; clipping ancestors shorter than the shell: ${c.clippers.length ? c.clippers.join(", ") : "none"}`];
            });

            await check(profile, `${tab}: home-indicator strip is the navigation bar's ${navHex}`, async () => {
                const inset = insets.bottom;
                const xs = [insets.left + 2, Math.round(w / 2), w - 2 - insets.right];
                const ys = [h - 2, h - Math.round(inset / 2), h - inset];
                const strip = await pixels(scratch, png, dsf, ys.flatMap((y) => xs.map((x) => [x, y])));
                // The bar outside the notch's side insets, at its bottom corners.
                const sides = await pixels(scratch, png, dsf, [[1, h - inset - 6], [w - 2, h - inset - 6], [1, h - 2], [w - 2, h - 2]]);
                const ok =
                    strip.every((p) => p === navHex) &&
                    sides.every((p) => p === navHex) &&
                    c.kind === "bar" &&
                    c.navRect[3] === h &&
                    c.navRect[0] === 0 &&
                    c.navRect[2] === w &&
                    c.underBottomEdge === "nav" &&
                    c.shellPadBottom === "0px" &&
                    Number.parseFloat(c.navPad[2]) >= inset;
                return [
                    ok,
                    `nav ${c.navRect.join(",")} of ${w}x${h}, padding-bottom ${c.navPad[2]}, shell padding-bottom ${c.shellPadBottom}; inset pixels ${[...new Set(strip)].join("/")}, bar edge pixels ${[...new Set(sides)].join("/")}, element at the bottom edge: ${c.underBottomEdge}`,
                ];
            });
        }

        // The soft blur that appeared at the top once Chat or Settings had been visited: whatever the order, nothing
        // blurred, masked, gradient, translucent or scrolling sits in the top 60px of any tab, and the edge stays black.
        await check(profile, "KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black", async () => {
            const seen = [];
            let ok = true;
            for (const [n, tab] of ["kvm", "chat", "settings", "kvm"].entries()) {
                await goTo(page, tab, true);
                const found = await topScan(page);
                const c = await chrome(page, real);
                const png = await page.screenshot({ path: `${outDir}/${file}-${theme}-order-${n + 1}-${tab}.png` });
                const want = expectedStatus(tab, theme);
                const px = edge > 0 ? await pixels(scratch, png, dsf, [[2, 2], [c.width / 2, Math.max(1, edge - 2)], [c.width - 3, 2]]) : [want];
                const tint = px.every((p) => p === want) && c.metaColour === want;
                ok &&= found.length === 0 && tint && c.strip === `${edge}px`;
                seen.push(`${n + 1}. ${tab}: ${found.length ? found.join("; ") : "nothing"}, edge ${c.strip} ${edge > 0 ? [...new Set(px)].join("/") : ""}`.trim());
            }
            return [ok, seen.join(" | ")];
        });

        // Whatever sits in the band under the top edge is opaque and the page's colour, so nothing can scroll into it as a
        // visible, blurred-under-the-system's-glass shape: the first thing with a background at the top of each tab has
        // alpha 1 and the tab's status colour (Chat's header, Settings' sticky title bar, the KVM's black stage).
        await check(profile, "the header under the top edge is opaque in the page's colour on every tab", async () => {
            const seen = [];
            let ok = true;
            for (const tab of TABS) {
                await goTo(page, tab, true);
                const want = expectedStatus(tab, theme);
                const probe = await page.evaluate((y) => {
                    for (const el of document.elementsFromPoint(innerWidth / 2, y)) {
                        if (el.id === "status-edge") continue;
                        const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]*)\)/);
                        const parts = m ? m[1].split(",").map((s) => Number.parseFloat(s)) : [];
                        const alpha = parts.length === 4 ? parts[3] : parts.length === 3 ? 1 : 0;
                        if (alpha > 0) return { what: `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 28)}`, alpha, colour: `rgb(${parts.slice(0, 3).join(", ")})` };
                    }
                    return null;
                }, edge + 22);
                const good = probe !== null && probe.alpha === 1 && probe.colour === rgbOf(want);
                ok &&= good;
                seen.push(`${tab}: ${probe ? `${probe.what} ${probe.colour} alpha ${probe.alpha}` : "nothing"} (want ${want})`);
            }
            return [ok, seen.join(" | ")];
        });

        // No backdrop-filter or blur anywhere in the app: every tab, then the sheets and dialogs that can be opened here.
        await check(profile, "no backdrop-filter or blur anywhere, on every tab and with the sheets open", async () => {
            const seen = [];
            let ok = true;
            const scan = async (what) => {
                const found = await blurScan(page);
                ok &&= found.length === 0;
                seen.push(`${what}: ${found.length ? found.slice(0, 4).join("; ") : "none"}`);
            };
            for (const tab of TABS) {
                await goTo(page, tab, true);
                await scan(tab);
            }
            await goTo(page, "kvm", true);
            await page.tap('[aria-label="More"]');
            await sleep(350);
            await scan("KVM More sheet");
            await page.evaluate(() => [...document.querySelectorAll("button, [role=menuitem]")].find((b) => /PiKVM log/.test(b.textContent ?? ""))?.click());
            await page.waitForSelector('[data-testid="log-dialog"]', { timeout: 5000 });
            await sleep(350);
            await scan("KVM full-page dialog");
            await page.keyboard.press("Escape");
            await page.evaluate(() => document.querySelector('[data-testid="log-dialog"] button')?.click());
            await page.reload({ waitUntil: "load" });
            await page.waitForSelector('[role="tab"]');
            await goTo(page, "chat", true);
            const add = await page.$('[aria-label="Add photos, files and more"], [aria-label*="Add"]');
            if (add) {
                await add.tap();
                await sleep(450);
                await scan("Chat add sheet");
                // The sheet is modal and covers the tab bar: start the next step from a fresh page.
                await page.reload({ waitUntil: "load" });
                await page.waitForSelector('[role="tab"]');
            }
            await goTo(page, "settings", true);
            return [ok, seen.join(" | ")];
        });

        if (opts.keyboard) {
            // The soft keyboard in the installed app: the visual viewport shrinks, the shell follows it and the bar
            // goes; when it closes the shell is the whole web view again and the CSS owns the height.
            await check(profile, "the keyboard in the installed app resizes the shell and closing it restores the whole screen", async () => {
                await goTo(page, "kvm", true);
                await page.evaluate(() => window.__keyboard(350));
                await page.waitForFunction(() => !document.querySelector(".nav-bar"), { timeout: 3000 });
                const heightOpen = await page.evaluate(() => Math.round(document.querySelector(".app-shell").getBoundingClientRect().height));
                const during = await chrome(page, real).catch(() => null);
                const openState = await page.evaluate(() => ({ attr: document.documentElement.getAttribute("data-keyboard"), shell: getComputedStyle(document.querySelector(".app-shell")).position, body: getComputedStyle(document.body).position }));
                await page.evaluate(() => window.__keyboard(0));
                await page.waitForSelector(".nav-bar", { timeout: 3000 });
                await sleep(300);
                const closed = await chrome(page, real);
                const expectedOpen = real - 350;
                return [
                    Math.abs(heightOpen - expectedOpen) <= 1 && openState.attr === "open" && openState.shell === "fixed" && closed.keyboardAttr === "closed" && closed.shellPos === "relative" && closed.bodyPos === "relative" && closed.shellRect[3] === real && closed.navRect[3] === real && closed.appHeightVar === "" && during === null,
                    `keyboard up: shell ${heightOpen}px (visual viewport ${expectedOpen}), data-keyboard ${openState.attr}, shell ${openState.shell}, no bar; closed: data-keyboard ${closed.keyboardAttr}, shell ${closed.shellPos}, body ${closed.bodyPos}, shell bottom ${closed.shellRect[3]} of ${real}, bar bottom ${closed.navRect[3]}, --app-height written "${closed.appHeightVar}"`,
                ];
            });
        }

        await check(profile, "Settings: switching the theme in Display repaints the status area to the other theme's page colour at once, with no navigation", async () => {
            await page.goto(`${WEB}/app/settings/display`, { waitUntil: "load" });
            await page.waitForSelector('[role="radiogroup"], [role="radio"], input[type="radio"]');
            const before = await chrome(page, real);
            const other = theme === "light" ? "dark" : "light";
            const clicked = await page.evaluate((label) => {
                const radio = [...document.querySelectorAll('input[type="radio"], [role="radio"]')].find((r) => (r.closest("label")?.textContent ?? r.getAttribute("aria-label") ?? r.textContent ?? "").trim().toLowerCase() === label);
                (radio?.closest("label") ?? radio)?.click();
                return radio !== undefined;
            }, other);
            await page.waitForFunction((v) => document.documentElement.dataset.theme === v, { timeout: 3000 }, other);
            await sleep(300);
            const after = await chrome(page, real);
            const wantBefore = expectedStatus("settings", theme);
            const wantAfter = expectedStatus("settings", other);
            return [
                clicked && before.metaColour === wantBefore && after.metaColour === wantAfter && after.stripBg === rgbOf(wantAfter) && after.statusVar === wantAfter && (!opts.ios || after.htmlBg === rgbOf(wantAfter)),
                `${theme} -> ${other}: theme-color ${before.metaColour} -> ${after.metaColour}, status edge ${before.stripBg} -> ${after.stripBg}, html ${before.htmlBg} -> ${after.htmlBg}`,
            ];
        });

        if (edge > 0) {
            // A full-page sheet pads for the top with its own background; the black edge has to sit over it.
            await check(profile, "a full-page sheet does not paint over the top edge", async () => {
                await goTo(page, "kvm", true);
                await page.tap('[aria-label="More"]');
                await sleep(300);
                const opened = await page.evaluate(() => {
                    const item = [...document.querySelectorAll("button, [role=menuitem]")].find((b) => /PiKVM log/.test(b.textContent ?? ""));
                    item?.click();
                    return item !== undefined;
                });
                await page.waitForSelector('[data-testid="log-dialog"]', { timeout: 5000 });
                await sleep(400);
                const dialog = await page.$eval('[data-testid="log-dialog"]', (el) => ({ bg: getComputedStyle(el).backgroundColor, top: Math.round(el.getBoundingClientRect().top) }));
                const png = await page.screenshot({ path: `${outDir}/${file}-${theme}-sheet.png` });
                const got = await pixels(scratch, png, dsf, [[2, 2], [Math.round(page.viewport().width / 2), edge - 2], [Math.round(page.viewport().width / 2), edge + 12]]);
                return [opened && got[0] === "#000000" && got[1] === "#000000", `opened ${opened}; sheet ${dialog.bg} from y=${dialog.top}; pixels in the edge ${got.slice(0, 2).join("/")}, just below ${got[2]}`];
            });
        }

        if (opts.ios) {
            // Real device (402x874, black bar): 100vh is the 874 screen, the web view 812. Headless Chrome cannot make 100vh
            // differ from the viewport, so what is asserted is the rule: the height is 100dvh, and the bar ends at the web view's bottom.
            await check(profile, "the installed app is 100dvh tall, not the screen-tall 100vh, and the bar ends at the bottom", async () => {
                await goTo(page, "kvm", true);
                const m = await page.evaluate(() => ({
                    heightVar: getComputedStyle(document.documentElement).getPropertyValue("--app-height").trim(),
                    shell: Math.round(document.querySelector(".app-shell").getBoundingClientRect().bottom),
                    nav: Math.round(document.querySelector(".nav-bar").getBoundingClientRect().bottom),
                }));
                return [m.heightVar === "100dvh" && m.shell === real && m.nav === real, `--app-height ${m.heightVar}; shell bottom ${m.shell}, bar bottom ${m.nav} of ${real}`];
            });
        }

        if (opts.ios) {
            // Settings > About > Display: what a device reports, as text; read here the way Kieran's phone would copy it.
            await check(profile, "Settings > About > Display reports the viewport, the flags and the clipping chain", async () => {
                await page.goto(`${WEB}/app/settings/about`, { waitUntil: "load" });
                await page.waitForSelector('[data-testid="display-report"]');
                await sleep(500);
                const text = await page.$eval('[data-testid="display-report"]', (el) => el.textContent ?? "");
                await page.screenshot({ path: `${outDir}/${file}-${theme}-about-display.png` });
                const fields = ["navigator.standalone:", "display-mode:", "html data: standalone true, ios-standalone true", "safe-area insets:", "screen:", "100vh / 100lvh / 100svh / 100dvh:", "visualViewport:", "fixed element, top 0 bottom 0:", "html:", "body:", "#root:", ".app-shell:", "nav:", "#status-edge:", "ancestors that would clip the shell: none", "ancestors that would clip the nav: none"];
                const missing = fields.filter((f) => !text.includes(f));
                return [missing.length === 0, missing.length ? `missing: ${missing.join(" | ")}` : `${text.split("\n").length} lines; ${text.split("\n").filter((l) => /^(html|body|\.app-shell|#status-edge):/.test(l)).join(" || ")}`];
            });
        }

        if (opts.firefox) {
            // navigator.standalone true with display-mode browser (seen once from a Firefox-made app): not the installed layout.
            await check(profile, "navigator.standalone alone is not standalone: the plain browser layout, and the bar fully inside the 812", async () => {
                await goTo(page, "kvm", true);
                const m = await page.evaluate(() => ({
                    nav: navigator.standalone,
                    display: matchMedia("(display-mode: browser)").matches,
                    flags: ["data-standalone", "data-ios-standalone", "data-ios"].map((a) => `${a}=${document.documentElement.getAttribute(a)}`).join(" "),
                    standalone: document.documentElement.hasAttribute("data-standalone") || document.documentElement.hasAttribute("data-ios-standalone"),
                    htmlPos: getComputedStyle(document.documentElement).position,
                    shellPos: getComputedStyle(document.querySelector(".app-shell")).position,
                    heightVar: getComputedStyle(document.documentElement).getPropertyValue("--app-height").trim(),
                    edge: getComputedStyle(document.getElementById("status-edge")).height,
                    shell: Math.round(document.querySelector(".app-shell").getBoundingClientRect().bottom),
                    nav_: (({ top, bottom }) => [Math.round(top), Math.round(bottom)])(document.querySelector(".nav-bar").getBoundingClientRect()),
                }));
                return [
                    m.nav === true && m.display && !m.standalone && m.htmlPos === "fixed" && m.shellPos === "fixed" && m.heightVar !== "100vh" && m.edge === "0px" && m.shell === real && m.nav_[1] === real,
                    `navigator.standalone ${m.nav}, display-mode browser ${m.display}, ${m.flags}; html ${m.htmlPos}, shell ${m.shellPos}, --app-height ${m.heightVar}, top edge ${m.edge}; shell bottom ${m.shell} of ${real}, bar ${m.nav_.join("..")}`,
                ];
            });
        }

        await check(profile, "no console errors", async () => [logs.length === 0, logs.length ? logs.slice(0, 3).join(" | ") : "none"]);
    } finally {
        await page.close();
    }
}

/** No insets: desktop and Android must lay out as before, the strips collapsing to nothing. */
async function uninsetted(browser, scratch, label, device, tag) {
    const profile = label;
    await fakeReset();
    const { page } = await open(browser, device, "light", undefined);
    const touch = tag !== "desktop";
    try {
        for (const tab of TABS) {
            await goTo(page, tab, touch);
            const c = await chrome(page, page.viewport().height);
            await page.screenshot({ path: `${outDir}/${tag}-light-${tab}.png` });
            await check(profile, `${tab}: no strips without an inset`, async () => {
                const pads = tag === "desktop" ? c.navPad : [c.navPad[2]];
                return [
                    c.strip === "0px" && (tag === "desktop" ? c.navRect[0] === 0 && c.navPad[2] === "4px" && c.navPad[3] === "4px" : c.navPad[2] === "4px" && c.navRect[3] === c.height && c.navPad[1] === "8px"),
                    `${c.kind}; strip ${c.strip}; nav padding ${pads.join(" ")}; nav bottom ${c.navRect[3]} of ${c.height}`,
                ];
            });
        }
    } finally {
        await page.close();
    }
}

async function staticContract() {
    const profile = "static";
    const html = await (await fetch(`${WEB}/app/`)).text();
    const meta = (name) => new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`).exec(html)?.[1];
    const manifestHref = /<link rel="manifest" href="([^"]+)"/.exec(html)?.[1] ?? "";
    const manifest = await (await fetch(`${WEB}${manifestHref}`)).json();
    const worker = await (await fetch(`${WEB}/app/sw.js`)).text();
    await check(profile, "meta served at /app/", async () => {
        const got = {
            "theme-color": meta("theme-color"),
            "apple-mobile-web-app-capable": meta("apple-mobile-web-app-capable"),
            "apple-mobile-web-app-status-bar-style": meta("apple-mobile-web-app-status-bar-style"),
            "mobile-web-app-capable": meta("mobile-web-app-capable"),
        };
        const viewport = meta("viewport") ?? "";
        return [
            got["theme-color"] === "#000000" &&
                got["apple-mobile-web-app-capable"] === "yes" &&
                got["apple-mobile-web-app-status-bar-style"] === "black" &&
                got["mobile-web-app-capable"] === "yes" &&
                /viewport-fit=cover/.test(viewport),
            `${JSON.stringify(got)}; viewport "${viewport}"`,
        ];
    });
    await check(profile, "manifest", async () => [
        manifest.theme_color === "#000000" && manifest.display === "standalone" && manifest.background_color === "#0a0a0c" && manifestHref === "/app/manifest.webmanifest",
        `${manifestHref}: theme_color ${manifest.theme_color}, background_color ${manifest.background_color}, display ${manifest.display}`,
    ]);
    await check(profile, "offline page", async () => [
        /<meta name="theme-color" content="#000000">/.test(worker) && /html::before[^}]*env\(safe-area-inset-top/.test(worker),
        "theme-color #000000 and the inset strip are in /app/sw.js",
    ]);
    // The update path: nothing the installed app starts from may come out of a cache. The page, the worker and the
    // build id are revalidated on every load, the worker never serves a page itself, and only hashed assets are immutable.
    await check(profile, "the page, sw.js and version.json are revalidated, hashed assets are immutable, the worker never caches a page", async () => {
        const heads = {};
        for (const path of ["/app/", "/app/sw.js", "/app/version.json", "/app/manifest.webmanifest"]) heads[path] = (await fetch(`${WEB}${path}`)).headers.get("cache-control");
        const asset = /src="(\/app\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? "";
        const assetHead = (await fetch(`${WEB}${asset}`)).headers.get("cache-control");
        const navigationsAreNetwork = /req\.mode === "navigate"[\s\S]{0,200}fetch\(req\)\.catch\(offlinePage\)/.test(worker) && /self\.skipWaiting\(\)/.test(worker) && /self\.clients\.claim\(\)/.test(worker);
        return [
            Object.values(heads).every((v) => v === "no-cache") && /immutable/.test(assetHead ?? "") && navigationsAreNetwork,
            `${JSON.stringify(heads)}; ${asset} ${assetHead}; worker navigations go to the network, skipWaiting and clients.claim present: ${navigationsAreNetwork}`,
        ];
    });
}

/** What the page gives an About reader, and what /app/version.json says: the same build; and what coming back after a deploy does. */
async function buildIdAndUpdate(browser) {
    const profile = "update";
    await fakeReset();
    const served = await (await fetch(`${WEB}/app/version.json`)).json();
    const { page } = await open(browser, "iPhone 13", "light", undefined);
    const comeBack = () =>
        page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
            document.dispatchEvent(new Event("visibilitychange"));
        });
    try {
        await check(profile, "Settings > About shows the build the host serves in /app/version.json", async () => {
            await page.goto(`${WEB}/app/settings/about`, { waitUntil: "load" });
            await page.waitForFunction(() => document.body.innerText.includes("App build"));
            const shown = await page.evaluate(() => document.body.innerText);
            return [served.build !== undefined && shown.includes("App build") && shown.includes(served.build), `About lists "App build" and "${served.build}": ${shown.includes(served.build)}`];
        });

        await check(profile, "coming back to the same build does not reload", async () => {
            await page.evaluate(() => (window.__alive = 1));
            await comeBack();
            await sleep(800);
            const alive = await page.evaluate(() => window.__alive);
            return [alive === 1, `page kept its state: ${alive === 1}`];
        });

        await check(profile, "coming back after a deploy reloads once, and never twice for the same build", async () => {
            // The worker answers /app/ requests itself, and puppeteer only sees the page's: bypass it so the host's answer can be replaced.
            await page.setBypassServiceWorker(true);
            // Returns closer together than 5 s are one check (src/host/update.ts); the previous case just made one.
            await sleep(5300);
            await page.setRequestInterception(true);
            page.on("request", (req) => {
                if (req.url().endsWith("/app/version.json")) {
                    req.respond({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify({ build: "next.20991231-235959" }) });
                } else req.continue();
            });
            await page.evaluate(() => (window.__alive = 1));
            await comeBack();
            await page.waitForFunction(() => window.__alive === undefined, { timeout: 8000 });
            await page.waitForSelector('[role="tab"]');
            await page.evaluate(() => (window.__alive = 2));
            await comeBack();
            await sleep(1500);
            const alive = await page.evaluate(() => window.__alive);
            const marked = await page.evaluate(() => sessionStorage.getItem("pikvm-reloaded-for-build"));
            return [alive === 2 && marked === "next.20991231-235959", `reloaded for "${marked}", and the second return kept the page (state ${alive})`];
        });
    } finally {
        await page.close();
    }
}

const browser = await launch();
const scratch = await browser.newPage();
await scratch.goto("about:blank");
try {
    await staticContract();
    await buildIdAndUpdate(browser);
    for (const theme of ["light", "dark"]) {
        await phone(browser, scratch, "iPhone 13 portrait", "iPhone 13", PORTRAIT, theme);
        await phone(browser, scratch, "iPhone 13 landscape", "iPhone 13 landscape", LANDSCAPE, theme);
    }
    // The installed app as iOS draws it with the black status-bar style: the page starts BELOW the bar, so the
    // viewport is the screen minus the bar (844 - 47) and the top inset is 0, while the bottom still has the
    // home indicator. The layout has to be right with no top inset at all.
    const BELOW = { width: 390, height: 797, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
    for (const theme of ["light", "dark"]) {
        await phone(browser, scratch, "iPhone 13 standalone, black bar", BELOW, BELOW_BAR, theme, { ios: true });
        // With the soft keyboard: the visual viewport shrinks under the layout viewport.
        await phone(browser, scratch, "iPhone 13 standalone, soft keyboard", BELOW, BELOW_BAR, theme, { ios: true, keyboard: true });
        // The device the 100dvh fix was measured on (Firefox-made home-screen app, 402x874): display-mode standalone, the web view
        // 812 tall below the black bar. Headless 100vh is the 812 too, so this asserts the rule and the geometry, not the 874.
        const IPHONE_402 = { width: 402, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
        await phone(browser, scratch, "iPhone 402x812 installed app, display-mode standalone", IPHONE_402, BELOW_BAR, theme, { ios: true });
        // navigator.standalone true with display-mode browser (an earlier report from the same app): the plain browser layout.
        await phone(browser, scratch, "iPhone 402x812, navigator.standalone with display-mode browser", IPHONE_402, BELOW_BAR, theme, { firefox: true });
    }
    await uninsetted(browser, scratch, "Android (Pixel 5, no insets)", "Pixel 5", "android");
    await uninsetted(browser, scratch, "Desktop 1400x900, no insets", { width: 1400, height: 900 }, "desktop");
} finally {
    await browser.close();
}

const today = new Date().toISOString().slice(0, 10);
const shots = readdirSync(outDir).filter((f) => f.endsWith(".png")).sort();
const START = "<!-- phone-chrome:start -->";
const END = "<!-- phone-chrome:end -->";
const section = [
    START,
    "## Status bar and home-indicator strip (PhoneChrome)",
    "",
    `Run ${today}. Host under test: \`node dist/web-server.js\` (${WEB}) in front of \`tools/fake-kvmd\` (${FAKE}). Headless Chrome through puppeteer-core; the iPhone 13 profile (touch, 390x844 portrait and 844x390 landscape) with the safe-area insets emulated by CDP \`Emulation.setSafeAreaInsetsOverride\` (portrait top 47 / bottom 34; landscape top 0 / bottom 21 / left and right 47). Colours are read back from the screenshots' pixels. The two \`standalone\` profiles are the installed app as iOS draws it with the \`black\` status-bar style: the page starts below the bar, so the viewport is 390x797 with no top inset and 34 at the bottom, and \`navigator.standalone\` is true before any script runs. In the second one \`window.__keyboard(px)\` takes \`px\` from \`innerHeight\` and the visual viewport as the soft keyboard does. The \`update\` cases drive coming back to the app after a deploy (the host's \`/app/version.json\` answered with another build) and check Settings > About against it. Script: \`apps/web/e2e/phone-chrome.e2e.mjs\`; how to run it: \`docs/e2e/README.md\`.`,
    "",
    "**What the earlier versions got wrong.** (1) The status bar: on a real iPhone (iOS 26) the top showed a grey-to-black gradient. That is the system's own scrim over a `black-translucent` page, which no CSS removes, so the style is now `black` (a solid bar, the page below it, no top inset; iOS keeps the style from when the app was added, so the app had to be added again). (2) The height. The shell was made `100vh` in the installed app on the theory that `100dvh`, `innerHeight` and the visual viewport report the screen minus an inset only while the app starts. That theory was wrong. Settings > About > Display on the device (iPhone, 402x874, `black` style, display-mode standalone) showed `100vh` and `100lvh` at 874, the screen, while `innerHeight`, the visual viewport, `100dvh`, `documentElement.clientHeight` and a fixed `top: 0; bottom: 0` element were all 812: with the `black` style the web view starts below the 62 pt bar and is 812 tall, so a `100vh` shell put the bottom 62 px of the navigation bar below the screen (the bar cut at 811 of 874). The height is now `100dvh` everywhere, and the keyboard's baseline in the installed app is the layout viewport (a fixed `top: 0; bottom: 0` probe). On iOS 26 a `position: fixed` html, body or app container is clipped to the layout viewport (docs: cjnova/piclaw-monaco PWA.md 8.6 and 8.9), so in the installed app with the keyboard closed html, body and the shell stay normal flow and each `--app-height` tall, with no ancestor that clips or is shorter (the `shell fills the screen exactly` case reads the position of html, body and the shell and lists any clipping ancestor shorter than the shell); while the keyboard is up they are fixed to the visual viewport (`data-keyboard` on html says which). Headless Chrome cannot make `100vh` differ from the viewport, so the e2e asserts the rule (`--app-height` is `100dvh`) and the geometry. (3) The blur at the top after visiting Chat or Settings: the resolution pill (`.kvm-res-toast`, top 10px) was a `backdrop-filter` and was still showing; it no longer blurs. With the `black` style the page starts below the bar and the system paints the bar area itself, from what it finds at the top edge of the page, so the top edge is one opaque black `#status-edge` element (12px deep in the installed iOS app, now also recognised by the device when `navigator.standalone` is not true) that the shell is padded by. The `KVM > Chat > Settings > KVM` case scans the top 60px after each step. What the system draws over the page on a real device cannot be reproduced headless: Settings > About > Display lists what the phone reports (flags, insets, every viewport unit, the boxes and positions of html, body, #root, the shell, the bar and #status-edge, and any clipping ancestor) and copies it as text.",
    "",
    "**The status area, as read from the phone (iOS 27.2, through the inspector) and decided.** Nothing of ours blurred anything at the top on any tab, and `#status-edge` was opaque black, 62 px, on top of everything on every tab; the grey frosted bar on Chat and Settings is iOS's own glass, tinted from the page (body was `rgb(238, 240, 244)` there and transparent over a black html on the KVM, which is why only the KVM bar was black). So the black edge in point (3) above is superseded: the status area now follows the page, one colour from the active tab and the theme (`app/status-colour.ts`): black over the KVM; the page's own colour on Chat and Settings (`#eef0f4` light, `#0a0a0c` dark). The top edge, html, body and the `theme-color` meta all take it (the `--status-colour` property), the shell updates it on a tab change and on a theme change, and `index.html` works it out before first paint for the route it opens on, so the system samples one solid colour and picks its own text colour for it. Every remaining `backdrop-filter` and blur in the app and the chat is gone (the resolution pill, the dialog scrim, the stream-state card, menus and toolbars, the lightbox, table headers, the composer's progressive-blur scrim, tailed surfaces, ui.blur's glass), and the chat's page card has no resting shadow (it was a soft shadow over the top edge); the `no backdrop-filter or blur anywhere` case scans every element and its pseudo-elements on every tab and with the sheets open, and the `KVM > Chat > Settings > KVM` case also flags a wide soft shadow near the top.",
    "",
    "**The source-level finding (so nobody chases it again).** The blur is UIKit's soft scroll edge effect (the top scroll pocket) of the WKWebView's scroll view, about the status bar and 40 pt below it. WebKit hides it only when a top colour extension view exists, which needs `_obscuredInsets.top > 0` and a fixed or sticky opaque full-width box over 10 px deep at the top edge; in the installed app with the `black` style the top obscured inset is 0, and live tests with `#status-edge` at 62 px, at 80 px and with `pointer-events: auto` stayed blurred. No page change removes it; what the page controls is what lies under it, so the headers there are opaque in the status colour. Details and the WebKit source references: `docs/rebuild/ios-top-edge.md`. This does not apply in a normal browser tab (Safari or Firefox on iOS), which has no top inset and draws its own bars.",
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed.`,
    "",
    "Screenshots (`docs/e2e/phone-chrome/`):",
    "",
    ...shots.map((f) => `- [${f.replace(".png", "")}](phone-chrome/${f})`),
    END,
    "",
];
mkdirSync(dirname(docPath), { recursive: true });
const existing = existsSync(docPath) ? readFileSync(docPath, "utf8") : `# E2E: phone feedback (${today})\n\nOne section per change.\n\n`;
const block = section.join("\n");
const next =
    existing.includes(START) && existing.includes(END)
        ? existing.slice(0, existing.indexOf(START)) + block + existing.slice(existing.indexOf(END) + END.length + 1)
        : `${existing.trimEnd()}\n\n${block}`;
writeFileSync(docPath, next);
process.exit(report.failed.length ? 1 : 0);
