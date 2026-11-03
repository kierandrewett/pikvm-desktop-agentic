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
 * `opts.lie`: it reports `lie` px less than the screen from innerHeight and visualViewport.height, as the app
 * does when it starts; 100vh stays the screen. `window.__keyboard(px)` then takes `px` more away and tells
 * the visual viewport, as the soft keyboard does.
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
        (ios, lie) => {
            if (ios) Object.defineProperty(navigator, "standalone", { configurable: true, get: () => true });
            if (!lie) return;
            let keys = 0;
            const inner = Object.getOwnPropertyDescriptor(window, "innerHeight")?.get;
            const visual = Object.getOwnPropertyDescriptor(VisualViewport.prototype, "height")?.get;
            if (!inner || !visual) throw new Error("cannot lie about the viewport here");
            Object.defineProperty(window, "innerHeight", { configurable: true, get: () => inner.call(window) - lie - keys });
            Object.defineProperty(window.visualViewport, "height", { configurable: true, get: () => visual.call(window.visualViewport) - lie - keys });
            window.__keyboard = (px) => {
                keys = px;
                window.visualViewport.dispatchEvent(new Event("resize"));
            };
        },
        opts.ios === true,
        opts.lie ?? 0,
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
            appHeightVar: document.documentElement.style.getPropertyValue("--app-height"),
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
            if (why.length) found.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 36)}@${Math.round(r.top)}: ${why.join(", ")}`);
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
    // The screen the page is in, whatever the page reports (it may lie, see open()).
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

            await check(profile, `${tab}: the top edge is ${edge}px of solid black and the shell is padded by it`, async () => {
                if (edge === 0) return [c.strip === "0px" && c.shellPadTop === "0px", `strip height ${c.strip}, shell padding-top ${c.shellPadTop} (nothing of ours at the top: the bar is the system's, the page is below it)`];
                const xs = [1, Math.round(w / 2), w - 2];
                const ys = [1, Math.round(edge / 2), edge - 1];
                const got = await pixels(scratch, png, dsf, ys.flatMap((y) => xs.map((x) => [x, y])));
                const below = await pixels(scratch, png, dsf, [[Math.round(w / 2), edge + 3]]);
                return [
                    c.strip === `${edge}px` && c.stripBg === "rgb(0, 0, 0)" && c.stripPosition === "fixed" && c.stripWidth === w && c.shellPadTop === `${edge}px` && got.every((p) => p === "#000000"),
                    `status-edge ${c.strip} x ${c.stripWidth} (${c.stripPosition}), shell padding-top ${c.shellPadTop}; ${got.length} pixels over it all ${[...new Set(got)].join("/")}; first pixel below it ${below[0]} (page bg ${rgbToHex(c.shellBg)})`,
                ];
            });

            await check(profile, `${tab}: the shell fills the screen exactly (bottom ${real})`, async () => {
                const ok = c.shellRect[0] === 0 && c.shellRect[2] === w && c.shellRect[3] === real && c.shellRect[1] === 0;
                return [ok, `shell ${c.shellRect.join(",")} of ${w}x${real}; the page reports innerHeight ${c.reported}; --app-height written by the shell: "${c.appHeightVar}"`];
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
                const px = edge > 0 ? await pixels(scratch, png, dsf, [[2, 2], [c.width / 2, Math.max(1, edge - 2)], [c.width - 3, 2]]) : ["#000000"];
                const black = edge === 0 || px.every((p) => p === "#000000");
                ok &&= found.length === 0 && black && c.strip === `${edge}px`;
                seen.push(`${n + 1}. ${tab}: ${found.length ? found.join("; ") : "nothing"}, edge ${c.strip} ${edge > 0 ? [...new Set(px)].join("/") : ""}`.trim());
            }
            return [ok, seen.join(" | ")];
        });

        if (opts.lie) {
            // The soft keyboard in the installed app: the visual viewport shrinks (from its short launch value), the shell
            // follows it and the bar goes; when it closes the shell is the whole screen again, not the short value.
            await check(profile, "the keyboard in the installed app resizes the shell and closing it restores the whole screen", async () => {
                await goTo(page, "kvm", true);
                await page.evaluate(() => window.__keyboard(350));
                await page.waitForFunction(() => !document.querySelector(".nav-bar"), { timeout: 3000 });
                const heightOpen = await page.evaluate(() => Math.round(document.querySelector(".app-shell").getBoundingClientRect().height));
                await page.evaluate(() => window.__keyboard(0));
                await page.waitForSelector(".nav-bar", { timeout: 3000 });
                await sleep(300);
                const closed = await chrome(page, real);
                const expectedOpen = real - opts.lie - 350;
                return [
                    Math.abs(heightOpen - expectedOpen) <= 1 && closed.shellRect[3] === real && closed.navRect[3] === real && closed.appHeightVar === "",
                    `keyboard up: shell ${heightOpen}px (visual viewport ${expectedOpen}), no bar; closed: shell bottom ${closed.shellRect[3]} of ${real}, bar bottom ${closed.navRect[3]}, --app-height written "${closed.appHeightVar}"`,
                ];
            });
        }

        await check(profile, "theme-color meta and the strip are black whatever the theme", async () => {
            const meta = await page.$eval('meta[name="theme-color"]', (m) => m.content);
            const themeAttr = await page.evaluate(() => document.documentElement.dataset.theme);
            return [meta === "#000000" && themeAttr === theme, `meta ${meta}, data-theme ${themeAttr}`];
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
        // And as it launches: innerHeight, the visual viewport (and 100dvh) report 62px less than the screen, 100vh does not.
        await phone(browser, scratch, "iPhone 13 standalone, viewport reports 62px short", BELOW, BELOW_BAR, theme, { ios: true, lie: 62 });
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
    `Run ${today}. Host under test: \`node dist/web-server.js\` (${WEB}) in front of \`tools/fake-kvmd\` (${FAKE}). Headless Chrome through puppeteer-core; the iPhone 13 profile (touch, 390x844 portrait and 844x390 landscape) with the safe-area insets emulated by CDP \`Emulation.setSafeAreaInsetsOverride\` (portrait top 47 / bottom 34; landscape top 0 / bottom 21 / left and right 47). Colours are read back from the screenshots' pixels. The two \`standalone\` profiles are the installed app as iOS draws it with the \`black\` status-bar style: the page starts below the bar, so the viewport is 390x797 with no top inset and 34 at the bottom, and \`navigator.standalone\` is true before any script runs. In the second one the page also reports 62px less than the screen from \`innerHeight\` and the visual viewport (injected before any script; \`100vh\` stays the screen), and \`window.__keyboard(px)\` takes more away as the soft keyboard does. The \`update\` cases drive coming back to the app after a deploy (the host's \`/app/version.json\` answered with another build) and check Settings > About against it. Script: \`apps/web/e2e/phone-chrome.e2e.mjs\`; how to run it: \`docs/e2e/README.md\`.`,
    "",
    "**What the earlier versions got wrong.** (1) The status bar: on a real iPhone (iOS 26) the top showed a grey-to-black gradient. That is the system's own scrim over a `black-translucent` page, which no CSS removes, so the style is now `black` (a solid bar, the page below it, no top inset; iOS keeps the style from when the app was added, so the app had to be added again). (2) The gap under the navigation bar was first put down to the web view being short and the system background showing outside it. That was wrong: nothing is outside the web view. In the installed app (no URL bar) `100vh` is the whole screen, while `100dvh`, `100svh`, `innerHeight` and the visual viewport report the screen minus an inset when the app starts, and the shell was sized from those, so it stopped short and what showed under the bar was the page behind the shell. The shell is now `100vh` in the installed app, and the visual viewport's height is used only while the soft keyboard is up (its baseline is a `100vh` probe, so a short launch value is not read as a keyboard). The emulation missed it because it set an inset on a viewport that already filled the screen; the `viewport reports 62px short` profile reproduces the report (before the change: shell 0,0,390,735 of 390x797, the bar ending 62px above the bottom). (3) The blur that appeared at the top after visiting Chat or Settings: nothing on the page is a gradient or mask there, but the resolution pill (`.kvm-res-toast`, top 10px, a `backdrop-filter`) is, and it was still showing; it is no longer a backdrop blur, and the top edge is one opaque black `#status-edge` element (12px deep in the installed iOS app) that the shell is padded by, so no scroller touches it. The `KVM > Chat > Settings > KVM` case scans the top 60px after each step. What the system draws over the page on a real device cannot be reproduced headless: the check on the device is Settings > About > Viewport (what the phone reports) and the status bar after visiting each tab.",
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
