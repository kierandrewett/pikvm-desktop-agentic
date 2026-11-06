// Settings in Chat's style, against a real web host in front of tools/fake-kvmd: every Settings page on a phone (iPhone 13,
// installed-app profile) and on desktop windows (1280x800, 1920x1080), light and dark, side by side with the matching
// the upstream chat app's screen where there is one; and the phone's page stack: one tap on a row opens its page (from KVM, from Chat and
// from a fresh load, with real CDP touch events), the page slides in and out (a view transition, not on desktop, not under
// reduced motion), and a swipe from the left edge goes back with the page following the finger.
//
//   node apps/web/e2e/settings-style.e2e.mjs [--out docs/e2e/settings-style] [--ref docs/e2e/settings-style/chat-ref]
//
// See docs/e2e/README.md for how to bring the two servers up. The chat references are screenshots of the upstream chat app's own
// Settings in an isolated stack (ref/README in the record says how they were taken); without them the side-by-sides are skipped.
// iOS's hover-on-first-tap cannot be emulated headless: the tap cases use real touch events, and the CSS case asserts the
// cause instead (no :hover rule in the settings and navigation styles outside a (hover: hover) media query).

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { Report, WEB, fakeReset, launch, puppeteer, sleep, touchSession } from "./harness.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const outDir = flag("--out", "docs/e2e/settings-style");
const refDir = flag("--ref", "docs/e2e/settings-style/chat-ref");
const only = args.find((a) => ["checks", "shots"].includes(a));
mkdirSync(outDir, { recursive: true });

const report = new Report("Settings style");
const THEME_KEY = "pikvm-console-theme";

const PAGES = ["connection", "notifications", "keyboard", "macros", "providers", "models", "agent", "display", "audio", "account", "about"];
const VIEWPORTS = [
    { name: "phone", phone: true },
    { name: "desktop-1280x800", width: 1280, height: 800 },
    { name: "desktop-1920x1080", width: 1920, height: 1080 },
];

/** Page -> the upstream chat app's screen it answers to (chat's slug). */
const CHAT_PAIRS = { notifications: "notifications", display: "appearance", providers: "providers", models: "chat", account: "me" };

async function check(profile, name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add(profile, name, observed, pass);
    } catch (error) {
        report.add(profile, name, `threw: ${error.message}`, false);
    }
}

async function seedMacros() {
    const macros = [
        { id: "reboot", label: "Reboot", icon: "power", steps: [{ type: "chord", mods: ["ControlLeft", "AltLeft"], code: "Delete" }] },
        { id: "login", label: "Login", pinned: false, steps: [{ type: "text", text: "admin" }, { type: "chord", mods: [], code: "Tab" }, { type: "delay", ms: 300 }] },
    ];
    await fetch(`${WEB}/app/api/v1/macros`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ macros }) });
}

/**
 * A page for one profile. `ios` makes it the installed app (navigator.standalone before any script). `account` answers the
 * session read like a host that signs users in would, so the Account page is listed. The host's startViewTransition is counted.
 */
async function openPage(browser, vp, theme, { ios = true, account = true, reduced = false } = {}) {
    const page = await browser.newPage();
    const logs = [];
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource|janus\/ws/.test(m.text())) logs.push(`console: ${m.text()}`);
    });
    if (vp.phone) await page.emulate(puppeteer.KnownDevices["iPhone 13"]);
    else await page.setViewport({ width: vp.width, height: vp.height });
    await page.evaluateOnNewDocument(
        (key, value, standalone) => {
            localStorage.setItem(key, value);
            if (standalone) Object.defineProperty(navigator, "standalone", { configurable: true, get: () => true });
            window.__transitions = 0;
            const original = document.startViewTransition?.bind(document);
            if (original) {
                document.startViewTransition = (...a) => {
                    window.__transitions++;
                    return original(...a);
                };
            }
        },
        THEME_KEY,
        theme,
        ios && vp.phone === true,
    );
    if (reduced) await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    if (account) {
        await page.setRequestInterception(true);
        page.on("request", (request) => {
            if (new URL(request.url()).pathname === "/app/api/v1/session") {
                request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ signIn: true, method: "password", subject: "admin", canSignOut: true }) });
            } else request.continue();
        });
    }
    return { page, logs };
}

const settle = () => sleep(1600);
const go = async (page, path) => {
    await page.goto(`${WEB}${path}`, { waitUntil: "domcontentloaded" });
    // A page that cannot draw its content (the chat pages without a chat server) still has its list or its note.
    await page.waitForSelector("#panel-settings h1, #panel-settings nav", { visible: true, timeout: 60000 });
    await settle();
};

/* ---- the screenshots ---- */

async function shots(browser) {
    await seedMacros();
    for (const vp of VIEWPORTS) {
        for (const theme of ["light", "dark"]) {
            const { page } = await openPage(browser, vp, theme);
            for (const slug of PAGES) {
                await go(page, `/app/settings/${slug}`);
                await page.screenshot({ path: `${outDir}/${slug}-${vp.name}-${theme}.png` });
            }
            // One macro's editor: the list is the page above, this is the editor behind it.
            await go(page, "/app/settings/macros");
            await page.evaluate(() => [...document.querySelectorAll("#panel-settings [data-settings-page] button")].find((b) => b.textContent.includes("Login"))?.click());
            await sleep(900);
            await page.screenshot({ path: `${outDir}/macros-editor-${vp.name}-${theme}.png` });
            if (vp.phone) {
                await go(page, "/app/settings");
                await page.screenshot({ path: `${outDir}/list-${vp.name}-${theme}.png` });
            }
            await page.close();
        }
    }
    report.add("all", "screenshots", `${readdirSync(outDir).filter((f) => f.endsWith(".png")).length} pages in ${VIEWPORTS.length} viewports, light and dark`, true);
}

/** Our screen on the left, the upstream chat app's on the right, as one image, rendered by the browser from the two PNGs. */
async function sideBySides(browser) {
    if (!existsSync(refDir)) return [];
    const { readFileSync } = await import("node:fs");
    const made = [];
    const uri = (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;
    const page = await browser.newPage();
    const pairs = { ...CHAT_PAIRS, list: "list" };
    for (const vp of VIEWPORTS) {
        for (const theme of ["light", "dark"]) {
            for (const [ours, theirs] of Object.entries(pairs)) {
                const a = `${outDir}/${ours}-${vp.name}-${theme}.png`;
                const b = `${refDir}/${theirs}-${vp.phone ? "phone" : vp.name}-${theme}.png`;
                if (!existsSync(a) || !existsSync(b)) continue;
                const frame = vp.phone ? { width: 2 * 390 + 24, height: 844 } : { width: 2 * vp.width + 24, height: vp.height };
                await page.setViewport(frame);
                await page.setContent(
                    `<style>body{margin:0;display:flex;gap:24px;background:#888;font:12px sans-serif}figure{margin:0;flex:1;min-width:0}img{width:100%;display:block}figcaption{position:absolute;top:0;padding:2px 6px;background:#000c;color:#fff}</style>` +
                        `<figure><figcaption>PiKVM ${ours}</figcaption><img src="${uri(a)}"></figure><figure><figcaption style="right:0">upstream chat ${theirs}</figcaption><img src="${uri(b)}"></figure>`,
                );
                await sleep(150);
                const file = `side-by-side-${ours}-${vp.name}-${theme}.jpg`;
                await page.screenshot({ path: `${outDir}/${file}`, type: "jpeg", quality: 80, fullPage: false });
                made.push(file);
            }
        }
    }
    await page.close();
    report.add("all", "side by side with the upstream chat app", `${made.length} images (${Object.keys(pairs).join(", ")})`, made.length > 0);
    return made;
}

/* ---- the phone's page stack ---- */

const CENTER = (selector) =>
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const b = el.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`;

const pathOf = (page) => page.evaluate(() => location.pathname);

async function tap(touch, page, selector) {
    const [x, y] = await page.evaluate(CENTER(selector));
    await sleep(150);
    await touch.tap(x, y);
    return [x, y];
}

async function phoneChecks(browser) {
    const profile = "iPhone 13 standalone";
    const ABOUT = '#panel-settings nav[aria-label="Settings"] a[href$="/settings/about"]';
    const SETTINGS_TAB = 'a.nav-tab[aria-label="Settings"]';

    for (const start of ["kvm", "chat", "settings"]) {
        await check(profile, `one tap on About opens it: ${start === "settings" ? "from a fresh load of Settings" : `coming from the ${start.toUpperCase()} tab`}`, async () => {
            const { page, logs } = await openPage(browser, { phone: true }, "dark");
            await page.goto(`${WEB}/app/${start}`, { waitUntil: "domcontentloaded" });
            await page.waitForSelector(SETTINGS_TAB, { visible: true });
            await settle();
            const touch = await touchSession(page);
            if (start !== "settings") {
                await tap(touch, page, SETTINGS_TAB);
                await page.waitForFunction(() => location.pathname === "/app/settings");
                await sleep(400);
            }
            await page.waitForSelector(ABOUT, { visible: true });
            const [px, py] = await page.evaluate(CENTER(ABOUT));
            const under = await page.evaluate((x, y) => document.elementFromPoint(x, y)?.closest("a")?.getAttribute("href") ?? null, px, py);
            await touch.tap(px, py);
            await page.waitForFunction(() => location.pathname === "/app/settings/about", { timeout: 3000 }).catch(() => {});
            const path = await pathOf(page);
            await page.close();
            return [path === "/app/settings/about" && under?.endsWith("/settings/about") === true && logs.length === 0, `after ONE touch tap: ${path}; the row was under the finger: ${under}; page errors ${logs.length}`];
        });
    }

    await check(profile, "no :hover rule in the settings and navigation styles sits outside a (hover: hover) media query", async () => {
        const { page } = await openPage(browser, { phone: true }, "dark");
        await go(page, "/app/settings");
        const bare = await page.evaluate(() => {
            const out = [];
            const ours = /\.chat-scope|\.nav-|\.tb-btn|\.btn\b|\.window-|settings-/;
            const walk = (rules, gated, href) => {
                for (const rule of rules) {
                    if (rule instanceof CSSMediaRule) walk(rule.cssRules, gated || /hover:\s*hover/.test(rule.conditionText), href);
                    else if (rule instanceof CSSStyleRule) {
                        if (!gated && /:hover/.test(rule.selectorText) && ours.test(rule.selectorText)) out.push(rule.selectorText.slice(0, 120));
                        if (rule.cssRules?.length) walk(rule.cssRules, gated, href);
                    } else if (rule.cssRules) walk(rule.cssRules, gated, href);
                }
            };
            for (const sheet of document.styleSheets) {
                try {
                    walk(sheet.cssRules, false, sheet.href);
                } catch {
                    /* a sheet from another origin */
                }
            }
            return out;
        });
        await page.close();
        return [bare.length === 0, bare.length ? `ungated: ${bare.slice(0, 6).join(" || ")}` : "every :hover rule of the app's chrome and the settings kit is inside (hover: hover)"];
    });

    await check(profile, "the page slides in from the list (a view transition, forward) and back out (back)", async () => {
        const { page } = await openPage(browser, { phone: true }, "dark");
        await go(page, "/app/settings");
        const touch = await touchSession(page);
        const sample = () => page.evaluate(() => ({ n: window.__transitions, dir: document.documentElement.getAttribute("data-settings-nav") }));
        await tap(touch, page, '#panel-settings nav[aria-label="Settings"] a[href$="/settings/keyboard"]');
        await sleep(60);
        const forward = await sample();
        await page.waitForFunction(() => location.pathname === "/app/settings/keyboard");
        await sleep(700);
        await tap(touch, page, '#panel-settings button[aria-label="Back to settings"]');
        await sleep(60);
        const back = await sample();
        await page.waitForFunction(() => location.pathname === "/app/settings");
        await sleep(700);
        const settled = await sample();
        await page.close();
        return [forward.n === 1 && forward.dir === "forward" && back.n === 2 && back.dir === "back" && settled.dir === null, `forward ${JSON.stringify(forward)}; back ${JSON.stringify(back)}; after ${JSON.stringify(settled)}`];
    });

    await check(profile, "reduced motion: the page just changes (no view transition, no direction)", async () => {
        const { page } = await openPage(browser, { phone: true }, "dark", { reduced: true });
        await go(page, "/app/settings");
        const touch = await touchSession(page);
        await tap(touch, page, '#panel-settings nav[aria-label="Settings"] a[href$="/settings/keyboard"]');
        await page.waitForFunction(() => location.pathname === "/app/settings/keyboard");
        await sleep(100);
        const state = await page.evaluate(() => ({ n: window.__transitions, dir: document.documentElement.getAttribute("data-settings-nav"), running: document.getAnimations().filter((a) => a.playState === "running" && !(a.effect?.target instanceof Element && a.effect.target.closest("[data-radix-popper-content-wrapper], .nav-tab"))).length }));
        await page.close();
        return [state.n === 0 && state.dir === null, `view transitions started ${state.n}; direction ${state.dir}`];
    });

    // The edge swipe: a touch from x=2 drags the page; released past a third it goes back; short of it, it springs home.
    const onAbout = async () => {
        const { page, logs } = await openPage(browser, { phone: true }, "dark");
        await go(page, "/app/settings/about");
        return { page, logs, touch: await touchSession(page) };
    };
    const detailX = (page) => page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector("#panel-settings .settings-stack > div:last-child")).transform).m41);

    await check(profile, "edge swipe from x=2: the page follows the finger, and released past a third it goes back", async () => {
        const { page, touch } = await onAbout();
        const pid = await touch.start(2, 420);
        await touch.drag(pid, [[20, 421], [60, 421], [110, 422], [180, 422]], 24);
        const during = await detailX(page);
        await touch.end(pid);
        await page.waitForFunction(() => location.pathname === "/app/settings", { timeout: 3000 }).catch(() => {});
        const path = await pathOf(page);
        await sleep(400);
        const list = await page.evaluate(() => !!document.querySelector('#panel-settings nav[aria-label="Settings"]') && !document.querySelector("#panel-settings [data-settings-page]"));
        await page.close();
        return [Math.abs(during - 178) < 12 && path === "/app/settings" && list, `page ${during.toFixed(0)}px right with the finger at 180; after release ${path}; the list is showing: ${list}`];
    });

    await check(profile, "a short, slow swipe is cancelled: the page springs back and stays", async () => {
        const { page, touch } = await onAbout();
        const pid = await touch.start(2, 420);
        await touch.drag(pid, [[20, 420], [50, 420], [80, 420]], 60);
        const during = await detailX(page);
        await touch.end(pid);
        await sleep(600);
        const path = await pathOf(page);
        const rest = await detailX(page);
        await page.close();
        return [during > 50 && path === "/app/settings/about" && rest === 0, `dragged to ${during.toFixed(0)}px; released short of a third (130px): ${path}, page at ${rest}px`];
    });

    await check(profile, "a fast flick back is honoured even when short", async () => {
        const { page, touch } = await onAbout();
        const pid = await touch.start(2, 420);
        await touch.drag(pid, [[30, 420], [70, 420], [110, 420]], 12);
        await touch.end(pid);
        await page.waitForFunction(() => location.pathname === "/app/settings", { timeout: 3000 }).catch(() => {});
        const path = await pathOf(page);
        await page.close();
        return [path === "/app/settings", `110px in 36ms: ${path}`];
    });

    await check(profile, "a swipe that starts away from the edge, or goes up, is left alone (the page scrolls)", async () => {
        const { page, touch } = await onAbout();
        const middle = await touch.start(120, 420);
        await touch.drag(middle, [[170, 420], [260, 420]], 24);
        await touch.end(middle);
        await sleep(300);
        const a = await pathOf(page);
        const vertical = await touch.start(2, 500);
        await touch.drag(vertical, [[3, 460], [4, 400], [5, 330]], 24);
        await touch.end(vertical);
        await sleep(300);
        const b = await pathOf(page);
        await page.close();
        return [a === "/app/settings/about" && b === "/app/settings/about", `from x=120: ${a}; from the edge but upward: ${b}`];
    });

    await check(profile, "the swipe is not attached on the KVM or Chat tabs", async () => {
        const out = [];
        for (const tab of ["kvm", "chat"]) {
            const { page } = await openPage(browser, { phone: true }, "dark");
            await page.goto(`${WEB}/app/kvm`, { waitUntil: "domcontentloaded" });
            await page.waitForSelector('a.nav-tab[aria-label="Settings"]', { visible: true, timeout: 60000 });
            await settle();
            const touch = await touchSession(page);
            // Settings is open behind (visited once), as in use: keep-mounted, hidden.
            await page.evaluate(() => document.querySelector('a.nav-tab[aria-label="Settings"]').click());
            await page.waitForFunction(() => location.pathname.startsWith("/app/settings"));
            await page.evaluate((t) => document.querySelector(`a.nav-tab[aria-label="${t === "kvm" ? "KVM" : "Chat"}"]`).click(), tab);
            await page.waitForFunction((t) => location.pathname === `/app/${t}`, {}, tab);
            await sleep(500);
            const pid = await touch.start(2, 400);
            await touch.drag(pid, [[40, 401], [120, 402], [220, 402]], 24);
            const moved = await page.evaluate(() => [...document.querySelectorAll("#panel-settings *")].some((e) => getComputedStyle(e).transform !== "none" && e.closest(".settings-stack") === e.parentElement));
            await touch.end(pid);
            await sleep(300);
            out.push(`${tab}: ${await pathOf(page)}, settings page moved ${moved}`);
            await page.close();
        }
        return [out.every((o, i) => o.startsWith(`${["kvm", "chat"][i]}: /app/${["kvm", "chat"][i]}, settings page moved false`)), out.join("; ")];
    });
}

async function desktopChecks(browser) {
    const profile = "Desktop 1280x800";
    await check(profile, "no slide on desktop: choosing a page changes it, with no view transition", async () => {
        const { page } = await openPage(browser, { width: 1280, height: 800 }, "dark");
        await go(page, "/app/settings/connection");
        await page.click('#panel-settings nav[aria-label="Settings"] a[href$="/settings/keyboard"]');
        await page.waitForFunction(() => location.pathname === "/app/settings/keyboard");
        const n = await page.evaluate(() => [window.__transitions, document.documentElement.getAttribute("data-settings-nav")]);
        await page.close();
        return [n[0] === 0 && n[1] === null, `view transitions ${n[0]}; direction ${n[1]}`];
    });

    await check(profile, "keyboard: the list comes first in the tab order, Enter opens a page and the focus stays on its link", async () => {
        const { page } = await openPage(browser, { width: 1280, height: 800 }, "dark");
        await go(page, "/app/settings/keyboard");
        const order = await page.evaluate(() => {
            const focusable = [...document.querySelectorAll("#panel-settings a[href], #panel-settings button, #panel-settings input, #panel-settings select")].filter((e) => e.offsetParent !== null);
            const nav = focusable.findIndex((e) => e.closest('nav[aria-label="Settings"]'));
            const lastNav = focusable.map((e) => !!e.closest('nav[aria-label="Settings"]')).lastIndexOf(true);
            const page = focusable.findIndex((e) => e.closest("[data-settings-page]"));
            return { nav, lastNav, page };
        });
        await page.focus('#panel-settings nav[aria-label="Settings"] a[href$="/settings/macros"]');
        // A keyboard user has arrived on it by keys, so the focus ring is drawn.
        await page.keyboard.press("Tab");
        await page.keyboard.down("Shift");
        await page.keyboard.press("Tab");
        await page.keyboard.up("Shift");
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => location.pathname === "/app/settings/macros");
        const focused = await page.evaluate(() => document.activeElement?.getAttribute("href"));
        const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
        await page.close();
        return [order.nav === 0 && order.lastNav < order.page && focused?.endsWith("/settings/macros") === true && ring !== "none", `nav links at 0..${order.lastNav}, the page's first control at ${order.page}; focus after Enter on ${focused}, outline ${ring}`];
    });

    await check(profile, "a macro's delete still asks first, and Cancel keeps it", async () => {
        await seedMacros();
        const { page } = await openPage(browser, { width: 1280, height: 800 }, "dark");
        await go(page, "/app/settings/macros");
        await page.evaluate(() => [...document.querySelectorAll("#panel-settings [data-settings-page] button")].find((b) => b.textContent.includes("Login")).click());
        await page.waitForFunction(() => document.querySelector("[data-settings-page] h1")?.textContent === "Login");
        await page.evaluate(() => [...document.querySelectorAll("#panel-settings button")].find((b) => b.textContent.trim() === "Delete macro").click());
        await page.waitForSelector('[role="dialog"]');
        const asked = await page.evaluate(() => document.querySelector('[role="dialog"]').textContent);
        await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Cancel").click());
        await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
        const kept = (await (await fetch(`${WEB}/app/api/v1/macros`)).json()).macros.length;
        await page.close();
        return [/Delete the macro/.test(asked) && kept === 2, `asked: ${JSON.stringify(asked.slice(0, 50))}; macros after Cancel: ${kept}`];
    });
}

const browser = await launch();
try {
    await fakeReset();
    if (only !== "shots") {
        await phoneChecks(browser);
        await desktopChecks(browser);
    }
    if (only !== "checks") {
        await shots(browser);
        await sideBySides(browser);
    }
} finally {
    await browser.close();
}

const today = new Date().toISOString().slice(0, 10);
const images = readdirSync(outDir).filter((f) => /\.(png|jpg)$/.test(f)).sort();
const md = [
    `# E2E run: Settings in Chat's style (${today})`,
    "",
    `Host under test: \`node dist/web-server.js\` (${WEB}) in front of \`tools/fake-kvmd\`. Headless Chrome through puppeteer-core; iPhone 13 (touch, coarse pointer, the installed app: \`navigator.standalone\`) and desktop windows of 1280x800 and 1920x1080. Script: \`apps/web/e2e/settings-style.e2e.mjs\`.`,
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed.`,
    "",
    "## Screenshots",
    "",
    `${images.length} images in \`${outDir.replace(/^docs\/e2e\//, "")}/\`: \`<page>-<viewport>-<theme>.png\` for every page, \`macros-editor-…\` for one macro's editor, \`list-phone-…\` for the phone's list, and \`side-by-side-<page>-<viewport>-<theme>.jpg\` with the upstream chat app's matching screen (\`chat-ref/\`) on the right.`,
    "",
];
if (only !== "shots") writeFileSync(`${outDir}/last-run.md`, md.join("\n"));
process.exit(report.failed.length ? 1 : 0);
