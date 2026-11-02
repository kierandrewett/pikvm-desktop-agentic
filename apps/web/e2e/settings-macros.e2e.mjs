// Settings -> Macros against a real web host in front of tools/fake-kvmd: iPhone 13 and a
// 1400x900 window. The page is the KVM screen's macro manager, so each case drives it the way a
// person would (create, edit steps, icon, pin, reorder, delete with a confirmation, run) and
// asserts what the SERVER stored and what the fake kvmd RECEIVED. The middle cases leave Settings
// for the KVM screen to see the pinned macros arrive as tiles and as a toolbar strip.
//
//   node apps/web/e2e/settings-macros.e2e.mjs [phone|desktop] [--out docs/e2e/settings-macros]
//
// See docs/e2e/README.md for how to bring the two servers up.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WEB, FAKE, Report, describe, fakeReset, launch, puppeteer, recorder, sleep } from "./harness.mjs";

const args = process.argv.slice(2);
const only = args.find((a) => a === "phone" || a === "desktop");
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e/settings-macros";
mkdirSync(outDir, { recursive: true });

const report = new Report("Settings macros");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The host closes idle keep-alive sockets after five seconds; a fetch that lands on one just closed fails, so ask again.
async function get(url, tries = 3) {
    for (let i = 1; ; i++) {
        try {
            return await fetch(url, { headers: { connection: "close" } });
        } catch (error) {
            if (i >= tries) throw error;
            await sleep(100);
        }
    }
}
const stored = async () => (await (await get(`${WEB}/app/api/v1/macros`)).json()).macros;
const store = (macros) =>
    fetch(`${WEB}/app/api/v1/macros`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ macros }) });

async function check(profile, name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add(profile, name, observed, pass);
    } catch (error) {
        report.add(profile, name, `threw: ${error.message}`, false);
    }
}

const shot = (page, name) => page.screenshot({ path: `${outDir}/${name}.png` });

async function launchPage(browser, tag) {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => {
        // A failed load is reported with its URL below; Chrome's own line for it has none.
        if (!/janus\/ws|Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`);
    });
    // Settings asks /oauth2/userinfo to learn whether a login proxy is in front; a host without one answers 404, by design.
    page.on("response", (r) => {
        if (r.status() >= 400 && !/\/oauth2\/userinfo$/.test(r.url())) logs.push(`error: ${r.status()} ${r.url()}`);
    });
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    if (tag === "phone") await page.emulate(puppeteer.KnownDevices["iPhone 13"]);
    else await page.setViewport({ width: 1400, height: 900 });
    return { page, logs };
}

/** A visible control by its text or accessible name. */
async function control(page, name, role = "button") {
    const handle = await page.evaluateHandle(
        (n, r) => {
            const sel = r === "button" ? "button" : `[role="${r}"]`;
            const all = [...document.querySelectorAll(sel)].filter((el) => el.offsetParent !== null);
            return all.find((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim() === n) ?? null;
        },
        name,
        role,
    );
    const el = handle.asElement();
    if (!el) throw new Error(`no ${role} "${name}"`);
    return el;
}

async function press(page, name, role = "button") {
    const el = await control(page, name, role);
    await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await el.click();
}

async function setText(page, selector, text) {
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
}

async function openMacros(page, tag) {
    if (tag === "phone") {
        // Settings is a list on a phone: the row opens the page, as it would for a person.
        await page.goto(`${WEB}/app/settings`, { waitUntil: "load" });
        await page.waitForSelector('nav[aria-label="Settings"]');
        await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="Settings"] a')].find((a) => a.textContent.includes("Macros")).click());
    } else {
        await page.goto(`${WEB}/app/settings/macros`, { waitUntil: "load" });
    }
    await page.waitForSelector('[data-testid="macros-dialog"][data-presentation="page"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="macros-dialog"]')?.textContent?.includes("Loading"));
}

async function createMacro(page, { name, mods, key, text, pause }) {
    await press(page, "New macro");
    await setText(page, 'input[aria-label="Name"]', name);
    for (const mod of mods) await press(page, mod, "switch");
    await page.select('select[aria-label="Key for step 1"]', key);
    await press(page, "Add text");
    await setText(page, 'input[aria-label="Text for step 2"]', text);
    await press(page, "Add pause");
    await setText(page, 'input[aria-label="Pause for step 3, milliseconds"]', String(pause));
    await sleep(500);
}

async function tilesOrStrip(page, tag) {
    await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
    if (tag === "phone") {
        await page.waitForSelector('[aria-label="More"]');
        await page.tap('[aria-label="More"]');
        await page.waitForSelector(".kvm-macro-tile");
        return page.$$eval(".kvm-macro-tile", (els) => els.map((e) => e.textContent.trim()));
    }
    await page.waitForSelector(".kvm-macro-strip");
    return page.$$eval(".kvm-macro-strip button", (els) => els.map((e) => e.getAttribute("aria-label")));
}

async function run(browser, profile, tag) {
    await fakeReset();
    await store([]);
    const { page, logs } = await launchPage(browser, tag);
    await openMacros(page, tag);
    const rec = recorder();
    await shot(page, `${tag}-empty`);

    await check(profile, "empty list says how to start; the page is a page (no dialog, no Done)", async () => {
        const text = await page.$eval('[data-testid="macros-dialog"]', (el) => el.textContent);
        const dialogs = await page.$$('[role="dialog"]');
        const done = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Done"));
        return [/Use New macro to add one/.test(text) && dialogs.length === 0 && !done, `${JSON.stringify(text.slice(0, 60))}; dialogs ${dialogs.length}; Done ${done}`];
    });

    await check(profile, "create: name, Super+R, text and pause are stored by the server", async () => {
        await createMacro(page, { name: "Run box", mods: ["Super"], key: "KeyR", text: "calc", pause: 300 });
        const m = (await stored()).find((x) => x.label === "Run box");
        const steps = [
            { type: "chord", mods: ["MetaLeft"], code: "KeyR" },
            { type: "text", text: "calc" },
            { type: "delay", ms: 300 },
        ];
        await shot(page, `${tag}-created`);
        return [!!m && equal(m.steps, steps) && m.pinned !== false, JSON.stringify(m)];
    });

    await check(profile, "edit: an icon, a step moved up, pin switched off and on", async () => {
        await press(page, "terminal", "radio");
        await press(page, "Move step 2 up");
        await sleep(400);
        const m = (await stored()).find((x) => x.label === "Run box");
        const order = m.steps.map((s) => s.type);
        const pin = await page.$('input[type="checkbox"]');
        await pin.click();
        await sleep(400);
        const unpinned = (await stored()).find((x) => x.label === "Run box")?.pinned === false;
        await pin.click();
        await sleep(400);
        const repinned = (await stored()).find((x) => x.label === "Run box")?.pinned !== false;
        return [m.icon === "terminal" && equal(order, ["text", "chord", "delay"]) && unpinned && repinned, `icon ${m.icon}; steps ${order.join(",")}; unpinned ${unpinned}; repinned ${repinned}`];
    });
    // Put the step back, so the run below sends Super+R first.
    await press(page, "Move step 2 up");
    await sleep(400);

    await check(profile, "run from Settings: keys over the socket, text through kvmd, the page stays", async () => {
        const m = (await stored()).find((x) => x.label === "Run box");
        if (m.steps[0].type !== "chord") throw new Error(`steps are ${m.steps.map((s) => s.type)}`);
        await sleep(1200); // the page starts the link to the target when it opens
        await rec.mark();
        await press(page, "Run");
        const { events, prints } = await rec.events(1800);
        const lines = describe(events);
        const here = new URL(page.url()).pathname;
        const toast = await page.evaluate(() => document.querySelector(".kvm-toast")?.textContent ?? "");
        const pass = equal(lines, ["key MetaLeft down", "key KeyR down", "key KeyR up", "key MetaLeft up"]) && prints.length === 1 && prints[0].text === "calc" && here.startsWith("/app/settings");
        await shot(page, `${tag}-run`);
        return [pass, `${lines.join(", ")}; typed "${prints[0]?.text}"; still on ${here}; toast ${JSON.stringify(toast)}`];
    });

    await check(profile, "second macro, then reorder: the list on the server follows", async () => {
        await createMacro(page, { name: "Task manager", mods: ["Ctrl", "Shift"], key: "Escape", text: "x", pause: 100 });
        const before = (await stored()).map((m) => m.label);
        await press(page, "Move up the list");
        await sleep(500);
        const after = (await stored()).map((m) => m.label);
        await shot(page, `${tag}-reordered`);
        return [equal(before, ["Run box", "Task manager"]) && equal(after, ["Task manager", "Run box"]), `${before.join(" > ")}  ->  ${after.join(" > ")}`];
    });

    await check(profile, tag === "phone" ? "pin: both macros are tiles in the KVM's menu, in list order" : "pin: both macros are in the KVM toolbar, in list order", async () => {
        const names = await tilesOrStrip(page, tag);
        await shot(page, `${tag}-${tag === "phone" ? "tiles" : "strip"}`);
        return [equal(names, ["Task manager", "Run box"]), names.join(", ")];
    });

    await check(profile, "unpin in Settings: it leaves the tiles / toolbar", async () => {
        await openMacros(page, tag);
        await page.evaluate(() => [...document.querySelectorAll(".macro-list button")].find((b) => b.textContent.includes("Task manager")).click());
        await sleep(200);
        await (await page.$('input[type="checkbox"]')).click();
        await sleep(500);
        const names = await tilesOrStrip(page, tag);
        return [equal(names, ["Run box"]), names.join(", ")];
    });

    await check(profile, "delete asks first: Cancel keeps the macro, Delete removes it from the server", async () => {
        await openMacros(page, tag);
        await press(page, "Delete macro");
        await page.waitForSelector('[role="alertdialog"]');
        await shot(page, `${tag}-confirm`);
        await page.evaluate(() => [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.trim() === "Cancel").click());
        await sleep(400);
        const kept = (await stored()).length === 2;
        await press(page, "Delete macro");
        await page.waitForSelector('[role="alertdialog"]');
        await page.evaluate(() => [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.trim() === "Delete macro").click());
        await sleep(600);
        const left = (await stored()).map((m) => m.label);
        return [kept && left.length === 1, `after Cancel ${kept ? "both kept" : "LOST"}; after Delete: ${left.join(", ")}`];
    });

    await check(profile, "no page errors", async () => [logs.filter((l) => l.startsWith("pageerror") || l.startsWith("error")).length === 0, logs.join(" | ") || "clean"]);
    await page.close();
}

const browser = await launch();
try {
    if (only !== "desktop") await run(browser, "iPhone 13", "phone");
    if (only !== "phone") await run(browser, "Desktop 1400x900", "desktop");
} finally {
    await browser.close();
}

const today = new Date().toISOString().slice(0, 10);
const shots = readdirSync(outDir).filter((f) => f.endsWith(".png")).sort();
const md = [
    `# E2E run: Settings -> Macros (${today})`,
    "",
    `Host under test: \`node dist/web-server.js\` (${WEB}) in front of \`tools/fake-kvmd\` (${FAKE}).`,
    "",
    "Browser: headless Chrome through puppeteer-core. Profiles: iPhone 13 (390x844, touch, coarse pointer) and desktop 1400x900. Script: `apps/web/e2e/settings-macros.e2e.mjs`; how to run it: `docs/e2e/README.md`.",
    "",
    "Settings -> Macros is the same component as the KVM screen's Macros dialog. Each case drives it as a person would and asserts what the server STORED and what the fake kvmd RECEIVED.",
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed.`,
    "",
    "## Screenshots",
    "",
    ...shots.map((f) => `- [${f.replace(".png", "")}](settings-macros/${f})`),
    "",
];
writeFileSync(`${dirname(outDir)}/${today}-settings-macros${only ? `-${only}` : ""}.md`, md.join("\n"));
process.exit(report.failed.length ? 1 : 0);
