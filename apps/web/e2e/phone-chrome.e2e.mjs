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

async function open(browser, device, theme, insets) {
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

/** What the page says about its chrome right now. */
const chrome = (page) =>
    page.evaluate(() => {
        const bar = document.querySelector(".nav-bar");
        const rail = document.querySelector(".nav-rail");
        const nav = bar ?? rail;
        const rect = nav.getBoundingClientRect();
        const style = getComputedStyle(nav);
        const shell = getComputedStyle(document.querySelector(".app-shell"));
        const at = document.elementFromPoint(Math.min(innerWidth - 3, rect.left + 3), innerHeight - 2);
        return {
            kind: bar ? "bar" : "rail",
            width: innerWidth,
            height: innerHeight,
            strip: getComputedStyle(document.documentElement, "::before").height,
            stripBg: getComputedStyle(document.documentElement, "::before").backgroundColor,
            navRect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.right), Math.round(rect.bottom)],
            navBg: style.backgroundColor,
            navPad: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
            shellPadBottom: shell.paddingBottom,
            shellPadTop: shell.paddingTop,
            shellBg: shell.backgroundColor,
            bodyBg: getComputedStyle(document.body).backgroundColor,
            underBottomEdge: at ? (at.closest(".nav-bar, .nav-rail") ? "nav" : at.className || at.tagName) : "none",
        };
    });

/** One phone orientation, one theme, every tab. */
async function phone(browser, scratch, label, device, insets, theme) {
    const profile = `${label}, ${theme}`;
    await fakeReset();
    const { page, logs } = await open(browser, device, theme, insets);
    const dsf = await page.evaluate(() => devicePixelRatio);
    try {
        for (const tab of TABS) {
            await goTo(page, tab, true);
            const c = await chrome(page);
            const png = await page.screenshot({ path: `${outDir}/${label.replace(/\W+/g, "-")}-${theme}-${tab}.png` });
            const navHex = rgbToHex(c.navBg);
            const w = c.width;
            const h = c.height;

            await check(profile, `${tab}: status-bar strip is ${insets.top}px of #000000`, async () => {
                if (insets.top === 0) return [c.strip === "0px" && c.shellPadTop === "0px", `strip height ${c.strip}, shell padding-top ${c.shellPadTop} (nothing of ours at the top: the bar is the system's, the page is below it)`];
                const xs = [1, Math.round(w / 2), w - 2];
                const ys = [1, Math.round(insets.top / 2), insets.top - 1];
                const got = await pixels(scratch, png, dsf, ys.flatMap((y) => xs.map((x) => [x, y])));
                const below = await pixels(scratch, png, dsf, [[Math.round(w / 2), insets.top + 3]]);
                return [
                    c.strip === `${insets.top}px` && c.stripBg === "rgb(0, 0, 0)" && got.every((p) => p === "#000000"),
                    `strip ${c.strip}, ${got.length} pixels over the inset all ${[...new Set(got)].join("/")}; first pixel below it ${below[0]} (page bg ${rgbToHex(c.shellBg)})`,
                ];
            });

            // The system's own scrim (iOS 26 over black-translucent) cannot be seen headless; what can be: the page
            // fills the viewport exactly, and nothing of ours paints a gradient or blur over the top of it.
            await check(profile, `${tab}: the shell fills the viewport and nothing of ours is a full-width gradient or blur at the top`, async () => {
                const seen = await page.evaluate(() => {
                    const shell = document.querySelector(".app-shell").getBoundingClientRect();
                    const painted = [...document.querySelectorAll("body *")]
                        .filter((el) => {
                            const r = el.getBoundingClientRect();
                            const s = getComputedStyle(el);
                            return r.width > innerWidth * 0.5 && r.height > 0 && r.top < 140 && r.bottom > 0 && s.visibility !== "hidden" && el.closest("[data-active=false]") === null && (/gradient/.test(s.backgroundImage) || s.backdropFilter !== "none");
                        })
                        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
                    return { rect: [shell.left, shell.top, shell.right, shell.bottom].map(Math.round), w: innerWidth, h: innerHeight, painted };
                });
                return [
                    seen.rect[0] === 0 && seen.rect[2] === seen.w && seen.rect[3] === seen.h + 0 && seen.rect[1] === 0 && seen.painted.length === 0,
                    `shell ${seen.rect.join(",")} of ${seen.w}x${seen.h}; full-width gradient or blur in the top 140px: ${seen.painted.length ? seen.painted.join(", ") : "none"}`,
                ];
            });

            await check(profile, `${tab}: home-indicator strip is the navigation bar's ${navHex}`, async () => {
                const inset = insets.bottom;
                const xs = [insets.left + 2, Math.round(w / 2), w - 2 - insets.right];
                const ys = [h - 2, h - Math.round(inset / 2), h - inset];
                const strip = await pixels(scratch, png, dsf, ys.flatMap((y) => xs.map((x) => [x, y])));
                // The bar's own padding row, just above the inset, and the bar outside the notch's side insets.
                const above = await pixels(scratch, png, dsf, [[w / 2, h - inset - 3]]);
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

        // The shell is sized from the visual viewport. If that is ever reported short of the screen, whatever is
        // left under the bar must be the bar's colour, not the page's (black on the KVM, the page colour elsewhere).
        await check(profile, "a shell that stops short of the screen edge leaves the bar's colour under it", async () => {
            const seen = [];
            let ok = true;
            for (const tab of TABS) {
                await goTo(page, tab, true);
                const previous = await page.$eval(".app-shell", (el) => el.style.getPropertyValue("--app-height"));
                await page.$eval(".app-shell", (el, gap) => el.style.setProperty("--app-height", `${innerHeight - gap}px`), insets.bottom);
                await sleep(200);
                const c = await chrome(page);
                const png = await page.screenshot({ path: `${outDir}/${label.replace(/\W+/g, "-")}-${theme}-${tab}-short-shell.png` });
                const h = c.height;
                const edge = await pixels(scratch, png, dsf, [[insets.left + 2, h - 2], [c.width / 2, h - 2], [c.width / 2, h - insets.bottom + 1]]);
                const navHex = rgbToHex(c.navBg);
                const stopped = c.navRect[3] === h - insets.bottom;
                ok &&= stopped && edge.every((p) => p === navHex);
                seen.push(`${tab}: bar ends ${c.navRect[3]} of ${h}, strip ${[...new Set(edge)].join("/")} (bar ${navHex})`);
                await page.$eval(".app-shell", (el, value) => el.style.setProperty("--app-height", value), previous);
            }
            return [ok, seen.join("; ")];
        });

        await check(profile, "theme-color meta and the strip are black whatever the theme", async () => {
            const meta = await page.$eval('meta[name="theme-color"]', (m) => m.content);
            const themeAttr = await page.evaluate(() => document.documentElement.dataset.theme);
            return [meta === "#000000" && themeAttr === theme, `meta ${meta}, data-theme ${themeAttr}`];
        });

        if (insets.top > 0) {
            // A full-page sheet pads for the inset with its own background; the black strip has to sit over it.
            await check(profile, "a full-page sheet does not paint the status-bar strip", async () => {
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
                const dialog = await page.$eval('[data-testid="log-dialog"]', (el) => ({ bg: getComputedStyle(el).backgroundColor, top: Math.round(el.getBoundingClientRect().top), size: el.dataset.size ?? el.closest("[data-size]")?.dataset.size ?? "" }));
                const png = await page.screenshot({ path: `${outDir}/${label.replace(/\W+/g, "-")}-${theme}-sheet.png` });
                const got = await pixels(scratch, png, dsf, [[2, 2], [Math.round(page.viewport().width / 2), insets.top - 2], [Math.round(page.viewport().width / 2), insets.top + 12]]);
                return [opened && got[0] === "#000000" && got[1] === "#000000", `opened ${opened}; sheet ${dialog.bg} from y=${dialog.top}; pixels in the strip ${got.slice(0, 2).join("/")}, just below ${got[2]}`];
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
            const c = await chrome(page);
            await page.screenshot({ path: `${outDir}/${tag}-light-${tab}.png` });
            await check(profile, `${tab}: no strips without an inset`, async () => {
                const pads = tag === "desktop" ? c.navPad : [c.navPad[2]];
                return [
                    c.strip === "0px" && (tag === "desktop" ? c.navRect[0] === 0 && c.navPad[2] === "8px" && c.navPad[3] === "8px" : c.navPad[2] === "4px" && c.navRect[3] === c.height && c.navPad[1] === "8px"),
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
    for (const theme of ["light", "dark"]) {
        await phone(browser, scratch, "iPhone 13 standalone, black bar", { width: 390, height: 797, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, BELOW_BAR, theme);
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
    `Run ${today}. Host under test: \`node dist/web-server.js\` (${WEB}) in front of \`tools/fake-kvmd\` (${FAKE}). Headless Chrome through puppeteer-core; the iPhone 13 profile (touch, 390x844 portrait and 844x390 landscape) with the safe-area insets emulated by CDP \`Emulation.setSafeAreaInsetsOverride\` (portrait top 47 / bottom 34; landscape top 0 / bottom 21 / left and right 47). Colours are read back from the screenshots' pixels. The \`black bar\` profile is the installed app as iOS draws it with the \`black\` status-bar style: the page starts below the bar, so the viewport is 390x797 with no top inset and 34 at the bottom. The \`update\` cases drive coming back to the app after a deploy (the host's \`/app/version.json\` answered with another build) and check Settings > About against it. Script: \`apps/web/e2e/phone-chrome.e2e.mjs\`; how to run it: \`docs/e2e/README.md\`.`,
    "",
    "**What the first version missed.** On a real iPhone (iOS 26, installed app, screenshot 14:57) the top was a grey-to-black gradient over ~120 px and a light-grey strip sat under the white bar. Both come from `apple-mobile-web-app-status-bar-style=black-translucent`: from iOS 26.1 the system draws its own scrim over the top of the page (no CSS removes it; our black strip is under it), and the page was laid out 62 px short of the screen (the bar ended at 812 of 874 pt, the system background below it, outside the web view where nothing of ours can paint). The headless emulation sets a safe-area inset on a viewport that already fills the screen, so it could not show either. The meta is now `black` (a solid bar, the page below it, no top inset), and the `black bar` profile below is that geometry. The scrim and the short web view themselves are system behaviour and cannot be reproduced headless: the check on the device is Settings > About > App build, then the status bar and the strip under the bar.",
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
