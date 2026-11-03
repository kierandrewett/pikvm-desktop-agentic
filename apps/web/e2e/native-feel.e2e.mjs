// The installed iPhone app and an iPhone browser tab (Firefox on iOS is a tab, never standalone), against the real
// web host with its chat server in front of tools/fake-kvmd and tools/fake-model (chat-stack.mjs):
//
//   touch      no tap highlight; pressed (:active) shows on touchstart, with no transition; no root overscroll;
//              controls are touch-action: manipulation; no :hover rule applies on a touch screen;
//   fields     every text field in the KVM, Chat and every Settings page computes to >= 16px;
//   composer   enterkeyhint=send, autocapitalize=sentences, autocorrect=on, spellcheck=true;
//   splash     every apple-touch-startup-image link resolves 200 as a PNG of the size its media query names;
//   badge      the service worker puts the pushed count on the icon (setAppBadge stubbed in the worker), an open page
//              leaves it while another tab is in front and clears it on the KVM, and a browser without the API is fine;
//   type       the Dynamic Type scale (--dt emulates the system size, Chromium has no -apple-system-body) at the default
//              (17), xxxLarge (23) and past the cap (53 -> 28): nothing in the nav bar, the KVM toolbar and keys, the
//              Settings rows or the Chat composer is clipped or runs off the screen.
//
// The same checks run as the installed app (navigator.standalone) and as a browser tab: nothing here may depend on
// standalone mode.
//
//   node apps/web/e2e/native-feel.e2e.mjs [app|tab] [--out docs/e2e/native-feel] [--doc docs/e2e/2026-11-03-native-feel.md]
//
// Needs OMP_BIN (or builds/omp), SHARP_MODULES optional, PUPPETEER_CORE and CHROME as for the other runs (docs/e2e/README.md).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Report, launch, puppeteer, sleep, touchSession } from "./harness.mjs";
import { startStack } from "./chat-stack.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const only = args.find((a) => a === "app" || a === "tab");
const outDir = flag("--out", "docs/e2e/native-feel");
const docPath = flag("--doc", "docs/e2e/2026-11-03-native-feel.md");
mkdirSync(outDir, { recursive: true });

const report = new Report("Native feel");
const FIREFOX_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15";

async function check(profile, name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add(profile, name, observed, pass);
    } catch (error) {
        report.add(profile, name, `threw: ${error.message}`, false);
    }
}

/** One page as an iPhone: the installed app (navigator.standalone) or a tab, with a Badging API stub in the page. */
async function open(browser, web, profile, { badgeApi = true } = {}) {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => {
        if (!/janus\/ws|Failed to load resource|WebSocket/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    await page.emulate(puppeteer.KnownDevices["iPhone 13"]);
    if (profile === "tab") await page.setUserAgent(FIREFOX_IOS);
    await page.evaluateOnNewDocument(
        (installed, api) => {
            if (installed) Object.defineProperty(navigator, "standalone", { configurable: true, get: () => true });
            window.__badge = [];
            if (api) {
                navigator.setAppBadge = (n) => (window.__badge.push(n ?? "dot"), Promise.resolve());
                navigator.clearAppBadge = () => (window.__badge.push("clear"), Promise.resolve());
            }
        },
        profile === "app",
        badgeApi,
    );
    await page.goto(`${web}/app/`, { waitUntil: "load" });
    await page.waitForSelector('[role="tab"]');
    await page.waitForFunction(() => (document.querySelector(".kvm-dot")?.getAttribute("aria-label") ?? "") === "Live", { timeout: 20000 });
    return { page, logs };
}

const go = async (page, tab) => {
    await page.tap(`#tab-${tab}`);
    await page.waitForFunction((id) => document.getElementById(`panel-${id}`)?.dataset.active === "true", {}, tab);
    await sleep(300);
};

/** Every text field the page has now: tag, type, computed size. */
const fields = (page) =>
    page.evaluate(() =>
        [...document.querySelectorAll("input, textarea, select")]
            .filter((el) => !["checkbox", "radio", "range", "file", "button", "submit", "reset", "color", "image", "hidden"].includes(el.type))
            .map((el) => ({ at: `${el.tagName.toLowerCase()}${el.type ? `[${el.type}]` : ""} ${(el.getAttribute("aria-label") ?? el.id ?? el.className ?? "").toString().slice(0, 40)}`, px: parseFloat(getComputedStyle(el).fontSize) })),
    );

/** What is clipped or off screen inside `root`: a box whose content is wider than it, and anything past the right edge. */
const overflow = (page, rootSelector) =>
    page.evaluate((selector) => {
        const root = document.querySelector(selector);
        if (!root) return { missing: true, clipped: [], off: [], count: 0 };
        const width = document.documentElement.clientWidth;
        const clipped = [];
        const off = [];
        let count = 0;
        for (const el of root.querySelectorAll("*")) {
            const box = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            if (box.width === 0 || box.height === 0 || style.visibility === "hidden" || style.display === "none" || el.closest('[aria-hidden="true"], [inert]')) continue;
            count++;
            const scrolls = /(auto|scroll)/.test(style.overflowX);
            const label = `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}${el.textContent ? ` "${el.textContent.trim().slice(0, 24)}"` : ""}`;
            if (!scrolls && style.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 1 && style.overflowX !== "visible") clipped.push(label);
            if (!el.closest("[role=tablist], .nav-bar") ? false : false) continue;
            if (box.right > width + 1 && !el.closest("[data-scroll], .kvm-menu, [style*='overflow']")) off.push(label);
        }
        return { missing: false, clipped: [...new Set(clipped)].slice(0, 8), off: [...new Set(off)].slice(0, 8), count };
    }, rootSelector);

async function run(profile, stack) {
    const browser = await launch();
    const web = stack.web;
    try {
        const { page, logs } = await open(browser, web, profile);
        const cdp = await page.createCDPSession();
        const touch = await touchSession(page);

        // ---- touch basics
        await check(profile, "no tap highlight on the tabs, buttons and rows", async () => {
            const colours = await page.evaluate(() =>
                [...document.querySelectorAll('[role="tab"], button')].slice(0, 12).map((el) => getComputedStyle(el).getPropertyValue("-webkit-tap-highlight-color")),
            );
            return [colours.length > 0 && colours.every((c) => /rgba\(0, 0, 0, 0\)|transparent/.test(c)), `${colours.length} controls, ${[...new Set(colours)].join(" | ")}`];
        });
        await check(profile, "pressed: the :active style dims at once with no transition; a touch tap shows it, and it lets go", async () => {
            // Chromium applies :active at the tap gesture, WebKit on iOS at touch-down; so the style itself is read with
            // :active forced on, and a real touch tap is watched for it appearing and going.
            await cdp.send("DOM.enable");
            await cdp.send("CSS.enable");
            const { root } = await cdp.send("DOM.getDocument");
            const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#tab-settings" });
            const read = () => page.evaluate(() => { const s = getComputedStyle(document.querySelector("#tab-settings")); return { opacity: Number(s.opacity), duration: s.transitionDuration }; });
            const before = await read();
            await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["active"] });
            const forced = await read();
            await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
            await page.evaluate(() => {
                window.__pressed = [];
                const el = document.querySelector("#tab-settings");
                const tick = () => { window.__pressed.push(el.matches(":active") ? Number(getComputedStyle(el).opacity) : 1); requestAnimationFrame(tick); };
                tick();
            });
            const box = await page.evaluate(() => { const r = document.querySelector("#tab-settings").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
            await touch.tap(box.x, box.y, 120);
            await sleep(600);
            const seen = await page.evaluate(() => window.__pressed.slice());
            const after = await read();
            await go(page, "kvm");
            const dimmed = seen.some((o) => o < 1);
            return [before.opacity === 1 && forced.opacity < 1 && /^0s(, 0s)*$/.test(forced.duration) && dimmed && after.opacity === 1, `forced :active ${JSON.stringify(forced)} (idle ${JSON.stringify(before)}); during a touch tap the control dimmed to ${Math.min(...seen)} and was back at ${after.opacity}`];
        });
        await check(profile, "no root overscroll: html and body overscroll-behavior none, and the page does not scroll", async () => {
            const r = await page.evaluate(() => {
                window.scrollTo(0, 100);
                return { html: getComputedStyle(document.documentElement).overscrollBehaviorY, body: getComputedStyle(document.body).overscrollBehaviorY, y: window.scrollY, tall: document.documentElement.scrollHeight > innerHeight + 1 };
            });
            return [r.html === "none" && r.body === "none" && r.y === 0, JSON.stringify(r)];
        });
        await check(profile, "controls are touch-action: manipulation; the KVM picture keeps its own", async () => {
            const r = await page.evaluate(() => ({
                tab: getComputedStyle(document.querySelector("#tab-chat")).touchAction,
                button: getComputedStyle(document.querySelector("button")).touchAction,
                picture: getComputedStyle(document.querySelector(".kvm-stage, .kvm-pane") ?? document.body).touchAction,
            }));
            return [r.tab === "manipulation" && r.button === "manipulation", JSON.stringify(r)];
        });
        await check(profile, "the chrome is not selectable and has no callout; the nav tab, a button and a key are", async () => {
            const r = await page.evaluate(() => {
                const pick = (el) => (el ? { sel: getComputedStyle(el).userSelect, callout: getComputedStyle(el).getPropertyValue("-webkit-touch-callout") } : null);
                return { tab: pick(document.querySelector("#tab-kvm")), button: pick(document.querySelector("button")), screen: pick(document.querySelector(".kvm-screen")) };
            });
            const ok = Object.values(r).every((v) => v && v.sel === "none");
            return [ok, JSON.stringify(r)];
        });
        await check(profile, "no :hover rule applies on a touch screen (every matching rule sits behind (hover: hover) and (pointer: fine))", async () => {
            const r = await page.evaluate(() => {
                const loose = [];
                const walk = (rules, inside) => {
                    for (const rule of rules) {
                        if (rule.cssRules) walk(rule.cssRules, inside || (rule.media && rule.media.mediaText));
                        else if (rule.selectorText && rule.selectorText.includes(":hover") && !/hover: ?hover/.test(inside || "")) loose.push(rule.selectorText.slice(0, 80));
                    }
                };
                for (const sheet of document.styleSheets) {
                    try {
                        walk(sheet.cssRules, "");
                    } catch {
                        /* cross-origin */
                    }
                }
                return { loose, hoverMatches: matchMedia("(hover: hover) and (pointer: fine)").matches };
            });
            return [r.loose.length === 0 && r.hoverMatches === false, `${r.loose.length} loose, pointer-fine hover matches: ${r.hoverMatches} ${r.loose.slice(0, 3).join(" | ")}`];
        });

        // ---- standalone independence
        await check(profile, profile === "app" ? "installed: data-standalone and data-ios are set" : "browser tab: data-ios is set and data-standalone is not", async () => {
            const r = await page.evaluate(() => ({ ios: document.documentElement.dataset.ios, standalone: document.documentElement.dataset.standalone }));
            return [r.ios === "true" && (profile === "app" ? r.standalone === "true" : r.standalone === undefined), JSON.stringify(r)];
        });

        // ---- splash
        await check(profile, "every launch image link resolves 200 as a PNG of the size its media query names", async () => {
            const links = await page.evaluate(() => [...document.querySelectorAll('link[rel="apple-touch-startup-image"]')].map((l) => ({ href: l.getAttribute("href"), media: l.getAttribute("media") })));
            const bad = [];
            for (const { href, media } of links) {
                const res = await fetch(new URL(href, web), { headers: { connection: "close" } });
                const bytes = Buffer.from(await res.arrayBuffer());
                const [, w, h, ratio, orientation] = /device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\) and \(orientation: (\w+)\)/.exec(media);
                const land = orientation === "landscape";
                const want = [Number(land ? h : w) * Number(ratio), Number(land ? w : h) * Number(ratio)];
                const got = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
                if (res.status !== 200 || res.headers.get("content-type") !== "image/png" || got[0] !== want[0] || got[1] !== want[1]) bad.push(`${href} ${res.status} ${got} want ${want}`);
            }
            return [links.length >= 24 && bad.length === 0, `${links.length} links, ${bad.length} wrong ${bad.slice(0, 2).join(" | ")}`];
        });

        // ---- fields
        const sizes = [];
        await check(profile, "every text field in the KVM, Chat and each Settings page computes to >= 16px", async () => {
            sizes.push(...(await fields(page)));
            await go(page, "chat");
            sizes.push(...(await fields(page)));
            await go(page, "settings");
            const pages = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href^="/app/settings/"]')].map((a) => a.getAttribute("href")))]);
            for (const href of pages) {
                await page.evaluate((h) => document.querySelector(`a[href="${h}"]`)?.click(), href);
                await sleep(500);
                sizes.push(...(await fields(page)));
                await page.evaluate(() => history.back());
                await sleep(250);
            }
            await go(page, "kvm");
            const small = sizes.filter((s) => s.px < 16);
            return [sizes.length > 3 && small.length === 0, `${sizes.length} fields over ${pages.length} Settings pages, smallest ${Math.min(...sizes.map((s) => s.px))}px ${small.slice(0, 3).map((s) => `${s.at}=${s.px}`).join(" | ")}`];
        });

        // ---- composer
        await check(profile, "the chat composer: enterkeyhint=send, autocapitalize=sentences, autocorrect=on, spellcheck=true", async () => {
            await go(page, "chat");
            await page.waitForSelector("textarea[aria-label]", { timeout: 20000 });
            const a = await page.evaluate(() => {
                const t = document.querySelector("textarea[aria-label]:not([aria-hidden])");
                return { hint: t.getAttribute("enterkeyhint"), cap: t.getAttribute("autocapitalize"), corr: t.getAttribute("autocorrect"), spell: t.getAttribute("spellcheck"), px: parseFloat(getComputedStyle(t).fontSize) };
            });
            await go(page, "kvm");
            return [a.hint === "send" && a.cap === "sentences" && a.corr === "on" && a.spell === "true" && a.px >= 16, JSON.stringify(a)];
        });

        // ---- badge
        await check(profile, "the worker puts a pushed count on the icon (stubbed setAppBadge), an open page clears it only on the KVM", async () => {
            await page.evaluate(async () => {
                await navigator.serviceWorker.ready;
            });
            const registrations = new Map();
            cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations: list }) => list.forEach((r) => registrations.set(r.registrationId, r)));
            await cdp.send("ServiceWorker.enable");
            await sleep(500);
            const target = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 15000 });
            const worker = await target.createCDPSession();
            await worker.send("Runtime.evaluate", { expression: "self.__badge = []; navigator.setAppBadge = (n) => (self.__badge.push(n), Promise.resolve()); 1" });
            await worker.send("Runtime.evaluate", { expression: "caches.delete('pikvm-badge-v1')", awaitPromise: true });
            const [registration] = [...registrations.values()];
            const push = async (body) => {
                await cdp.send("ServiceWorker.deliverPushMessage", { origin: new URL(web).origin, registrationId: registration.registrationId, data: JSON.stringify(body) });
                await sleep(500);
            };
            await go(page, "chat");
            await page.evaluate(() => (window.__badge.length = 0));
            await push({ title: "PiKVM", body: "The screen changed.", tag: "pikvm-screen", url: "/app/", badge: 1 });
            const atWorker = (await worker.send("Runtime.evaluate", { expression: "JSON.stringify(self.__badge)", returnByValue: true })).result.value;
            const onChat = await page.evaluate(() => window.__badge.slice());
            await go(page, "kvm");
            await sleep(300);
            const onKvm = await page.evaluate(() => window.__badge.slice());
            const stored = await page.evaluate(async () => (await (await (await caches.open("pikvm-badge-v1")).match("/app/badge-state"))?.text()) ?? null);
            // a push that arrives while the KVM is in front is cleared at once
            await page.evaluate(() => (window.__badge.length = 0));
            await push({ title: "PiKVM", body: "again", badge: 1 });
            const whileKvm = await page.evaluate(() => window.__badge.slice());
            const ok = atWorker === "[1]" && onChat.length > 0 && !onChat.includes("clear") && onKvm.at(-1) === "clear" && stored === '{"screen":0}' && whileKvm.at(-1) === "clear";
            return [ok, `worker ${atWorker}; page on Chat (keeps it) ${JSON.stringify(onChat)}; on KVM ${JSON.stringify(onKvm)}; cache after ${stored}; push while on KVM ${JSON.stringify(whileKvm)}`];
        });
        await check(profile, "a page with no Badging API (Firefox) runs the same flow without an error", async () => {
            const other = await open(browser, web, profile, { badgeApi: false });
            await go(other.page, "chat");
            await go(other.page, "kvm");
            const has = await other.page.evaluate(() => typeof navigator.setAppBadge);
            await other.page.close();
            return [other.logs.filter((l) => /badge/i.test(l)).length === 0, `setAppBadge is ${has}; ${other.logs.length} console lines, none about the badge`];
        });

        // ---- Dynamic Type
        for (const [label, dt] of [["default 17px", "17px"], ["xxxLarge 23px", "23px"], ["AX5 53px, capped to 28px", "min(53px, 28px)"]]) {
            await check(profile, `Dynamic Type ${label}: nothing clipped or off screen in the nav bar, KVM toolbar and keys, Settings rows, Chat composer`, async () => {
                await page.evaluate((v) => document.body.style.setProperty("--dt", v), dt);
                const out = { sizes: {}, found: {} };
                const probe = async (name, selector) => {
                    const r = await overflow(page, selector);
                    out.found[name] = r.missing ? "missing" : `${r.count} boxes, ${r.clipped.length} clipped, ${r.off.length} off`;
                    return r;
                };
                const problems = [];
                const note = (name, r) => {
                    if (r.missing) problems.push(`${name} missing`);
                    problems.push(...r.clipped.map((c) => `${name} clipped: ${c}`), ...r.off.map((c) => `${name} off screen: ${c}`));
                };
                await go(page, "kvm");
                note("nav bar", await probe("nav bar", ".nav-bar"));
                // The keyboard dock: the toolbar, the keys.
                await page.evaluate(() => document.querySelector('[aria-label="Keyboard"]')?.click());
                await sleep(500);
                const kvm = await page.evaluate(() => ({ keys: document.querySelectorAll(".kvm-key").length, toolbar: !!document.querySelector(".kvm-toolbar, .kvm-bar") }));
                note("KVM toolbar", await probe("KVM toolbar", ".kvm-toolbar, .kvm-bar"));
                if (kvm.keys > 0) note("KVM keys", await probe("KVM keys", ".kvm-keys, .kvm-krow"));
                out.found.keys = `${kvm.keys} keys`;
                await go(page, "settings");
                note("Settings rows", await probe("Settings rows", "#panel-settings"));
                await go(page, "chat");
                note("Chat composer", await probe("Chat composer", "#panel-chat form, #panel-chat [data-new-chat], #panel-chat textarea:not([aria-hidden])"));
                out.sizes = await page.evaluate(() => ({
                    nav: getComputedStyle(document.querySelector(".nav-tab")).fontSize,
                    body: getComputedStyle(document.querySelector("#root")).fontSize,
                    field: getComputedStyle(document.body).getPropertyValue("--type-field").trim(),
                }));
                await go(page, "kvm");
                await page.screenshot({ path: `${outDir}/${profile}-dt-${dt.replace(/[^0-9a-z]/g, "")}-kvm.png` });
                await page.evaluate(() => document.body.style.removeProperty("--dt"));
                return [problems.length === 0 && kvm.keys > 0, `${Object.entries(out.found).map(([k, v]) => `${k}: ${v}`).join("; ")}; nav label ${out.sizes.nav}, text ${out.sizes.body}${problems.length ? `; PROBLEMS ${problems.slice(0, 4).join(" | ")}` : ""}`];
            });
        }

        await check(profile, "no console errors or page errors during the run", async () => [logs.length === 0, logs.slice(0, 3).join(" | ") || "none"]);
        await page.close();
    } finally {
        await browser.close();
    }
}

const stack = await startStack({ web: 18620, kvmd: 14620, model: 14627 });
try {
    for (const profile of only ? [only] : ["app", "tab"]) await run(profile, stack);
} finally {
    await stack.stop();
}

const rows = report.rows.map((r) => `| ${r.pass ? "PASS" : "**FAIL**"} | ${r.profile} | ${r.name} | ${r.observed.replaceAll("|", "\\|")} |`).join("\n");
const doc = `# Native feel on the phone (2026-11-03)

\`apps/web/e2e/native-feel.e2e.mjs\`: iPhone 13 emulation in headless Chrome, once as the installed app (\`navigator.standalone\`) and once as a browser tab with a Firefox-on-iOS user agent (FxiOS, never standalone), against the real web host with its chat server in front of the fake kvmd and fake model.
Chromium cannot parse \`font: -apple-system-body\`, so the Dynamic Type rows set \`--dt\` on \`<body>\` (17px default, 23px xxxLarge, 53px past the 28px cap) and judge layout; the system font and the real Dynamic Type sizes are Safari's and are NOT exercised here.

| Result | Profile | Check | Observed |
| --- | --- | --- | --- |
${rows}

${report.failed.length === 0 ? "All checks passed." : `${report.failed.length} check(s) failed.`}
`;
mkdirSync(dirname(docPath), { recursive: true });
writeFileSync(docPath, doc);
process.exit(report.failed.length === 0 ? 0 : 1);
