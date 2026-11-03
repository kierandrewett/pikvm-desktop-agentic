// Settings -> Macros against a real web host in front of tools/fake-kvmd: iPhone 13 and a
// 1400x900 window. The page is Settings' list of macros with one macro's editor behind it, on the same
// editor as the KVM screen's Macros dialog, so each case drives it the way a person would (create, edit
// steps, icon, pin, reorder, delete with a confirmation, run) and
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
const named = (list, label) => list.find((m) => m.label === label);

/**
 * The server's list once `ok` holds for it. A save is a request still on its way when the page looks finished, so a case
 * waits for the list it expects, not for a time; if it never arrives the last list read comes back and the case fails on it.
 */
async function storedWhen(ok, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) {
        const list = await stored();
        if (ok(list) || Date.now() > end) return list;
        await sleep(50);
    }
}

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
    // The phone's page slide is a view transition (and the desktop has none): keep each one's `finished`, so a case can wait it out.
    await page.evaluateOnNewDocument(() => {
        window.__slides = [];
        const start = document.startViewTransition?.bind(document);
        if (start) {
            document.startViewTransition = (...args) => {
                const transition = start(...args);
                window.__slides.push(transition.finished);
                return transition;
            };
        }
    });
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

/**
 * Waits until a click at the control's centre would reach it. The phone's page slide is a view transition: while it runs the
 * new page is already in the DOM (its heading reads right) but the click goes to <html>, so a press the moment the page
 * "appears" does nothing. A control that is still moving is not pressed either.
 */
async function reachable(el, ms = 5000) {
    const ok = await el.evaluate(
        (e, limit) =>
            new Promise((resolve) => {
                const end = performance.now() + limit;
                let last = "";
                let still = 0;
                const frame = () => {
                    const r = e.getBoundingClientRect();
                    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                    const here = `${r.x},${r.y},${r.width},${r.height}`;
                    still = hit && e.contains(hit) && here === last ? still + 1 : 0;
                    last = here;
                    if (still >= 2) resolve(true);
                    else if (performance.now() > end) resolve(false);
                    else requestAnimationFrame(frame);
                };
                frame();
            }),
        ms,
    );
    if (!ok) throw new Error("the control never held still where a click reaches it");
}

async function press(page, name, role = "button") {
    const el = await control(page, name, role);
    await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await reachable(el);
    await el.click();
}

async function setText(page, selector, text) {
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
}

/** The list of macros: from the Settings list on a phone (the row opens the page, as it would for a person). */
async function openMacros(page, tag) {
    if (tag === "phone") {
        await page.goto(`${WEB}/app/settings`, { waitUntil: "load" });
        await page.waitForSelector('nav[aria-label="Settings"]');
        await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="Settings"] a')].find((a) => a.textContent.includes("Macros")).click());
    } else {
        await page.goto(`${WEB}/app/settings/macros`, { waitUntil: "load" });
    }
    await page.waitForSelector("[data-settings-page]");
    await page.waitForFunction(() => document.querySelector("[data-settings-page] h1")?.textContent === "Macros" && !document.querySelector("[data-settings-page]")?.textContent?.includes("Loading"));
    // The phone's page slides in as a view transition; a screenshot before it ends shows the page half way.
    await page.evaluate(() => Promise.allSettled(window.__slides));
}

/** One macro's editor, opened from the list by its name. */
async function openEditor(page, name) {
    await page.evaluate((n) => [...document.querySelectorAll("#panel-settings [data-settings-page] button")].find((b) => b.textContent.includes(n)).click(), name);
    await page.waitForFunction((n) => document.querySelector("[data-settings-page] h1")?.textContent === n, {}, name);
}

/** From an editor back to the list: the desktop's link is named "Macros", the phone's back button "Back to Macros". */
async function backToList(page) {
    await page.evaluate(() => [...document.querySelectorAll("#panel-settings button")].find((b) => ["Macros", "Back to Macros"].includes((b.getAttribute("aria-label") ?? b.textContent).trim())).click());
    await page.waitForFunction(() => document.querySelector("[data-settings-page] h1")?.textContent === "Macros");
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
    // The last edit is the last save: it has landed when the server's macro ends in this pause.
    await storedWhen((list) => named(list, name)?.steps.at(-1)?.ms === pause);
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
        const text = await page.$eval("[data-settings-page]", (el) => el.textContent);
        const dialogs = await page.$$('[role="dialog"]');
        const done = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Done"));
        return [/No macros yet/.test(text) && dialogs.length === 0 && !done, `${JSON.stringify(text.slice(0, 80))}; dialogs ${dialogs.length}; Done ${done}`];
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
        const m = named(await storedWhen((list) => named(list, "Run box")?.icon === "terminal" && named(list, "Run box")?.steps[0]?.type === "text"), "Run box");
        const order = m.steps.map((s) => s.type);
        await press(page, "Pin to the toolbar and menu", "switch");
        const unpinned = named(await storedWhen((list) => named(list, "Run box")?.pinned === false), "Run box")?.pinned === false;
        await press(page, "Pin to the toolbar and menu", "switch");
        const repinned = named(await storedWhen((list) => named(list, "Run box")?.pinned !== false), "Run box")?.pinned !== false;
        return [m.icon === "terminal" && equal(order, ["text", "chord", "delay"]) && unpinned && repinned, `icon ${m.icon}; steps ${order.join(",")}; unpinned ${unpinned}; repinned ${repinned}`];
    });
    // Put the step back, so the run below sends Super+R first.
    await press(page, "Move step 2 up");
    await storedWhen((list) => named(list, "Run box")?.steps[0]?.type === "chord");

    await check(profile, "run from Settings: keys over the socket, text through kvmd, the page stays", async () => {
        const m = (await stored()).find((x) => x.label === "Run box");
        if (m.steps[0].type !== "chord") throw new Error(`steps are ${m.steps.map((s) => s.type)}`);
        await sleep(1200); // the page starts the link to the target when it opens
        await rec.mark();
        await press(page, "Run");
        const { events, prints } = await rec.events(1800);
        const lines = describe(events);
        const here = new URL(page.url()).pathname;
        const toast = await page.evaluate(() => [...document.querySelectorAll("#panel-settings li, #panel-settings [role=status]")].map((e) => e.textContent).find((t) => /sent/.test(t)) ?? "");
        const pass = equal(lines, ["key MetaLeft down", "key KeyR down", "key KeyR up", "key MetaLeft up"]) && prints.length === 1 && prints[0].text === "calc" && here.startsWith("/app/settings");
        await shot(page, `${tag}-run`);
        return [pass, `${lines.join(", ")}; typed "${prints[0]?.text}"; still on ${here}; toast ${JSON.stringify(toast)}`];
    });

    await check(profile, "second macro, then reorder: the list on the server follows", async () => {
        await backToList(page);
        await createMacro(page, { name: "Task manager", mods: ["Ctrl", "Shift"], key: "Escape", text: "x", pause: 100 });
        const before = (await stored()).map((m) => m.label);
        await press(page, "Move up the list");
        const after = (await storedWhen((list) => list[0]?.label === "Task manager")).map((m) => m.label);
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
        await openEditor(page, "Task manager");
        await press(page, "Pin to the toolbar and menu", "switch");
        // The next step leaves this page, and a save still on its way would go with it.
        await storedWhen((list) => named(list, "Task manager")?.pinned === false);
        const names = await tilesOrStrip(page, tag);
        return [equal(names, ["Run box"]), names.join(", ")];
    });

    await check(profile, "delete asks first: Cancel keeps the macro, Delete removes it from the server and returns to the list", async () => {
        await openMacros(page, tag);
        await openEditor(page, "Task manager");
        await press(page, "Delete macro");
        await page.waitForSelector('[role="dialog"]');
        await shot(page, `${tag}-confirm`);
        await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Cancel").click());
        await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
        const kept = (await stored()).length === 2;
        await press(page, "Delete macro");
        await page.waitForSelector('[role="dialog"]');
        await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Delete macro").click());
        const left = (await storedWhen((list) => list.length === 1)).map((m) => m.label);
        const onList = await page.evaluate(() => document.querySelector("[data-settings-page] h1")?.textContent === "Macros");
        return [kept && left.length === 1 && onList, `after Cancel ${kept ? "both kept" : "LOST"}; after Delete: ${left.join(", ")}; back on the list ${onList}`];
    });

    await check(profile, "no page errors", async () => [logs.filter((l) => l.startsWith("pageerror") || l.startsWith("error")).length === 0, logs.join(" | ") || "clean"]);
    await page.close();
}

// The cases load pages one after another in one tab; a page Chrome parks in its back/forward cache would keep the app's
// connections open and starve the next page's saves (see `launch` in harness.mjs).
const browser = await launch({ backForwardCache: false });
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
    "Settings -> Macros is Settings' list of macros with one macro's editor behind it, on the same editor as the KVM screen's Macros dialog. Each case drives it as a person would and asserts what the server STORED and what the fake kvmd RECEIVED.",
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
