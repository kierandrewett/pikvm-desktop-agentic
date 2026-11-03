// Phosphor icons app-wide against a real web host in front of tools/fake-kvmd: nav, Settings, the
// KVM dock and toolbar and the macro icon picker, light and dark, on an iPhone 13 and a
// 1400x900 window. Asserts what the DOM draws (an svg per control, no hand-drawn leftovers, the
// active tab in the fill weight) and saves a screenshot per surface.
//
//   node apps/web/e2e/icons.e2e.mjs [phone|desktop] [--out docs/e2e/icons]
//
// See docs/e2e/README.md for how to bring the two servers up.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WEB, FAKE, Report, fakeReset, launch, puppeteer, sleep } from "./harness.mjs";

const args = process.argv.slice(2);
const only = args.find((a) => a === "phone" || a === "desktop");
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e/icons";
mkdirSync(outDir, { recursive: true });

const report = new Report("Phosphor icons");
const THEME_KEY = "pikvm-console-theme";

async function check(profile, name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add(profile, name, observed, pass);
    } catch (error) {
        report.add(profile, name, `threw: ${error.message}`, false);
    }
}

const live = (page) =>
    page.waitForFunction(() => (document.querySelector(".kvm-dot")?.getAttribute("aria-label") ?? "") === "Live", { timeout: 15000 });

/** The drawing of each svg under a selector: a Phosphor icon is only filled paths in currentColor (a few have a tighter viewBox). */
const glyphs = (page, selector) =>
    page.$$eval(selector, (els) =>
        els.map((svg) => ({
            viewBox: svg.getAttribute("viewBox"),
            fill: svg.getAttribute("fill"),
            paths: svg.querySelectorAll("path").length,
            nonPath: svg.querySelectorAll("rect,circle,line,polyline").length,
            d: svg.querySelector("path")?.getAttribute("d") ?? "",
            box: (({ width, height }) => [Math.round(width), Math.round(height)])(svg.getBoundingClientRect()),
        })),
    );

const phosphor = (g) => /^[\d. ]+$/.test(g.viewBox ?? "") && g.fill === "currentColor" && g.paths > 0 && g.nonPath === 0 && g.box[0] > 0;

async function open(browser, tag, theme) {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => {
        if (!/janus\/ws|Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    if (tag === "phone") await page.emulate(puppeteer.KnownDevices["iPhone 13"]);
    else await page.setViewport({ width: 1400, height: 900 });
    await page.evaluateOnNewDocument((key, value) => localStorage.setItem(key, value), THEME_KEY, theme);
    return { page, logs };
}

async function goTo(page, tag, tab) {
    if (tag === "phone") await page.tap(`#tab-${tab}`);
    else await page.click(`#tab-${tab}`);
    await page.waitForFunction((id) => document.getElementById(`panel-${id}`)?.dataset.active === "true", {}, tab);
}

async function run(browser, profile, tag, theme) {
    const label = `${profile}, ${theme}`;
    await fakeReset();
    const { page, logs } = await open(browser, tag, theme);
    const shot = (name) => page.screenshot({ path: `${outDir}/${tag}-${theme}-${name}.png` });
    await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
    await live(page);
    await sleep(700);

    await check(label, "the theme is applied", async () => {
        const got = await page.evaluate(() => document.documentElement.dataset.theme);
        return [got === theme, got];
    });

    await check(label, "the nav draws three Phosphor icons, and the open tab is in the fill weight", async () => {
        const kvm = await glyphs(page, ".nav-tab svg");
        const kvmD = kvm.map((g) => g.d);
        await goTo(page, tag, "settings");
        const settings = await glyphs(page, ".nav-tab svg");
        await goTo(page, tag, "kvm");
        const changed = kvmD.map((d, i) => d !== settings[i]?.d);
        const ok = kvm.length === 3 && kvm.every(phosphor) && changed[0] === true && changed[2] === true && changed[1] === false;
        return [ok, `${kvm.length} svgs, all Phosphor ${kvm.every(phosphor)}; weight changed per tab ${changed.join("/")}`];
    });
    await shot("nav-kvm");

    await check(label, "the KVM dock or toolbar draws its controls with Phosphor", async () => {
        const selector = tag === "phone" ? ".kvm-ibtn svg" : ".kvm-tb-btn svg";
        await page.waitForSelector(selector);
        const g = await glyphs(page, selector);
        return [g.length >= 3 && g.every(phosphor), `${g.length} svgs on ${selector}, all Phosphor ${g.every(phosphor)}`];
    });
    await shot("kvm");

    if (tag === "desktop") {
        await page.click('[data-testid="more"]').catch(() => {});
        await sleep(300);
        await shot("kvm-more-menu");
        await page.keyboard.press("Escape");
    }

    await goTo(page, tag, "settings");
    await check(label, "Settings draws its page icons with Phosphor", async () => {
        await page.waitForSelector("#panel-settings nav svg");
        const g = await glyphs(page, "#panel-settings nav svg");
        return [g.length >= 8 && g.every(phosphor), `${g.length} svgs in the page list, all Phosphor ${g.every(phosphor)}`];
    });
    await shot("settings");

    await check(label, "a Settings page draws its back or list icons with Phosphor", async () => {
        await page.goto(`${WEB}/app/settings/macros`, { waitUntil: "load" });
        await page.waitForSelector('[data-testid="macros-dialog"]');
        const g = await glyphs(page, "#panel-settings svg");
        return [g.length > 0 && g.every(phosphor), `${g.length} svgs in the Macros page, all Phosphor ${g.every(phosphor)}`];
    });
    await check(label, "the macro icon picker offers every stored name as a Phosphor icon", async () => {
        const create = await page.$$("button");
        const newMacro = (await Promise.all(create.map(async (b) => [b, await b.evaluate((e) => e.textContent)]))).find(([, t]) => /New macro/i.test(t));
        if (newMacro) await newMacro[0].click();
        await page.waitForSelector(".macro-icons .macro-icon");
        const g = await glyphs(page, ".macro-icons .macro-icon svg");
        return [g.length === 22 && g.every(phosphor), `${g.length} picker icons, all Phosphor ${g.every(phosphor)}`];
    });
    await shot("macro-picker");

    await check(label, "no inline-drawn svg is left anywhere on the page (no stroke-drawn glyphs)", async () => {
        const n = await page.$$eval("svg", (els) => els.filter((s) => s.getAttribute("stroke") === "currentColor").length);
        return [n === 0, `${n} stroke-drawn svgs`];
    });
    await check(label, "no page errors", async () => [logs.length === 0, logs.length === 0 ? "clean" : logs.join(" | ")]);
    await page.close();
}

const browser = await launch();
try {
    for (const theme of ["light", "dark"]) {
        if (only !== "desktop") await run(browser, "iPhone 13", "phone", theme);
        if (only !== "phone") await run(browser, "Desktop 1400x900", "desktop", theme);
    }
} finally {
    await browser.close();
}

const today = new Date().toISOString().slice(0, 10);
const shots = readdirSync(outDir).filter((f) => f.endsWith(".png")).sort();
const md = [
    `# E2E run: Phosphor icons app-wide (${today})`,
    "",
    `Host under test: \`node dist/web-server.js\` (${WEB}) in front of \`tools/fake-kvmd\` (${FAKE}).`,
    "",
    "Browser: headless Chrome through puppeteer-core. Profiles: iPhone 13 (390x844, touch) and desktop 1400x900, each light and dark. Script: `apps/web/e2e/icons.e2e.mjs`; how to run it: `docs/e2e/README.md`.",
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed.`,
    "",
    "## Screenshots",
    "",
    ...shots.map((f) => `- [${f.replace(".png", "")}](icons/${f})`),
    "",
];
writeFileSync(`${dirname(outDir)}/${today}-icons${only ? `-${only}` : ""}.md`, md.join("\n"));
process.exit(report.failed.length ? 1 : 0);
