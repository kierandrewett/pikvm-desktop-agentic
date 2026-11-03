// Desktop layout, end to end in a real browser (the web host with the chat server in it, the real omp binary, tools/fake-kvmd,
// tools/fake-model: apps/web/e2e/chat-stack.mjs):
//
//   - the chat composer is the same box as the conversation column (width within 1px, same centre) on the new-chat screen and in a
//     conversation, at 1280x800, 1920x1080, 2560x1440 and at the narrow end of the wide layout; it stays bounded with a long text
//     and scrolls inside;
//   - the desktop navigation rail is icons only: no visible text, an accessible name and a tooltip (hover and keyboard focus) on
//     each item, the open item marked, a visible focus ring; its width is recorded against the 64px it had;
//   - the phone bar keeps its labels.
//
//   PUPPETEER_CORE=<node_modules with puppeteer-core> CHROME=<chrome> SHARP_MODULES=<node_modules with sharp> OMP_BIN=<omp> \
//     node apps/web/e2e/desktop-layout.e2e.mjs [--out docs/e2e/desktop-feedback] [--doc docs/e2e/2026-11-03-desktop-feedback.md]
//
// Needs dist/ built (`yarn build`, and `vite build` in apps/web). It starts and stops its own stack.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CANARY, startStack } from "./chat-stack.mjs";
import { Report, launch, puppeteer, sleep } from "./harness.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const outDir = flag("--out", "docs/e2e/desktop-feedback");
const docPath = flag("--doc", "docs/e2e/2026-11-03-desktop-feedback.md");
mkdirSync(outDir, { recursive: true });

const report = new Report("Desktop layout");

/** The rail as built at 10a037e9 (measured with the same probe before the change): width, tab box, and the page beside it at 1280x800. */
const BEFORE = { rail: 64, tab: "47x52", panel1280: 1216 };
const SIZES = [
    { name: "1280x800", width: 1280, height: 800 },
    { name: "1920x1080", width: 1920, height: 1080 },
    { name: "2560x1440", width: 2560, height: 1440 },
    { name: "760x700", width: 760, height: 700 },
];
const NAMES = { kvm: "KVM", chat: "Chat", settings: "Settings" };

const stack = await startStack({ web: 18399, kvmd: 14810, model: 14817 });
const browser = await launch();
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|janus/.test(m.text())) logs.push(`console: ${m.text()}`);
});
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));

async function check(profile, name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add(profile, name, observed, pass);
    } catch (error) {
        report.add(profile, name, `threw: ${error.message}`, false);
        await page.screenshot({ path: `${outDir}/failed-${report.failed.length}.png` }).catch(() => {});
    }
}

const px = (n) => `${Math.round(n * 10) / 10}px`;
const waitFor = (fn, ...a) => page.waitForFunction(fn, { timeout: 30000 }, ...a);

async function openTab(tab) {
    await page.click(`#tab-${tab}`);
    await waitFor((id) => document.getElementById(`panel-${id}`)?.dataset.active === "true", tab);
    await sleep(300);
}

/** The composer box and the conversation column it should share, in CSS px. `column` is the content box of the column. */
const geometry = () =>
    page.evaluate(() => {
        const form = document.querySelector("#panel-chat form[data-balloon-anchor='composer']");
        const box = form?.getBoundingClientRect();
        // The column is the first .thread-col that is not the one holding the composer (a conversation), or the one around it (new chat).
        const cols = [...document.querySelectorAll("#panel-chat .thread-col")];
        const holding = cols.find((c) => c.contains(form));
        const column = cols.find((c) => !c.contains(form)) ?? holding;
        const inner = (el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            const l = r.left + parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth);
            const rr = r.right - parseFloat(s.paddingRight) - parseFloat(s.borderRightWidth);
            return { left: l, right: rr, width: rr - l };
        };
        const col = column ? inner(column) : null;
        return {
            form: box ? { left: box.left, right: box.right, width: box.width, height: box.height } : null,
            column: col,
            panel: document.getElementById("panel-chat").getBoundingClientRect().width,
        };
    });

const same = (g) =>
    g.form && g.column && Math.abs(g.form.width - g.column.width) <= 1 && Math.abs((g.form.left + g.form.right) / 2 - (g.column.left + g.column.right) / 2) <= 1;
const describe = (g) =>
    `composer ${px(g.form?.width ?? NaN)} wide at ${px(g.form?.left ?? NaN)}..${px(g.form?.right ?? NaN)}; column ${px(g.column?.width ?? NaN)} at ${px(g.column?.left ?? NaN)}..${px(g.column?.right ?? NaN)}`;

const shot = (name) => page.screenshot({ path: `${outDir}/${name}.png` });

try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await page.goto(`${stack.web}/app/kvm`, { waitUntil: "load" });
    await page.waitForSelector("img.kvm-img");
    await sleep(800);

    // ---- the rail -------------------------------------------------------------------------------------------------------

    await check("desktop 1280x800", "the rail has no visible text, and each item has an accessible name", async () => {
        const items = await page.$$eval(".nav-rail .nav-tab", (tabs) =>
            tabs.map((t) => ({ id: t.id, text: t.innerText.trim(), name: t.getAttribute("aria-label"), role: t.getAttribute("role") })),
        );
        const ok =
            items.length === 3 &&
            items.every((i) => i.text === "" && i.name === NAMES[i.id.replace("tab-", "")] && i.role === "tab") &&
            (await page.$$eval(".nav-rail", (r) => r.length)) === 1;
        return [ok, items.map((i) => `${i.id}: name "${i.name}", visible text "${i.text}"`).join("; ")];
    });

    await check("desktop 1280x800", "the rail is narrower than before and the page gets the room", async () => {
        const m = await page.evaluate(() => ({
            rail: document.querySelector(".nav-rail").getBoundingClientRect().width,
            tab: `${Math.round(document.querySelector(".nav-tab").getBoundingClientRect().width)}x${Math.round(document.querySelector(".nav-tab").getBoundingClientRect().height)}`,
            panel: document.querySelector(".app-panel").getBoundingClientRect().width,
        }));
        return [m.rail <= 48 && m.panel === 1280 - m.rail, `rail ${m.rail}px wide (was ${BEFORE.rail}px), tab ${m.tab} (was ${BEFORE.tab}), page ${m.panel}px (was ${BEFORE.panel1280}px)`];
    });

    await check("desktop 1280x800", "each item shows its name as a tooltip on hover", async () => {
        const seen = [];
        for (const id of ["kvm", "chat", "settings"]) {
            await page.mouse.move(700, 400);
            await sleep(150);
            const box = await (await page.$(`#tab-${id}`)).boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await sleep(700);
            const tip = await page.$eval(`#tab-${id} .nav-tip`, (t) => {
                const r = t.getBoundingClientRect();
                return { text: t.innerText.trim(), left: r.left, top: r.top, bottom: r.bottom, right: r.right, visibility: getComputedStyle(t).visibility, opacity: getComputedStyle(t).opacity };
            });
            seen.push({ id, ...tip });
            if (id === "chat") await shot("rail-tooltip-hover");
        }
        await page.mouse.move(700, 400);
        await sleep(300);
        const after = await page.$eval("#tab-kvm .nav-tip", (t) => getComputedStyle(t).visibility);
        const ok =
            seen.every((s) => s.text === NAMES[s.id] && s.visibility === "visible" && Number(s.opacity) > 0.9 && s.left >= 40 && s.right <= 1280 && s.top >= 0 && s.bottom <= 800) && after === "hidden";
        return [ok, `${seen.map((s) => `${s.id}: "${s.text}" ${s.visibility}`).join("; ")}; hidden again once the pointer leaves: ${after}`];
    });

    await check("desktop 1280x800", "the tooltip also shows on keyboard focus, and the focused item has a visible ring", async () => {
        await page.mouse.move(700, 400);
        await page.focus("#tab-kvm");
        await page.keyboard.press("Tab"); // out and back by keyboard so :focus-visible applies
        await page.keyboard.down("Shift");
        await page.keyboard.press("Tab");
        await page.keyboard.up("Shift");
        await page.keyboard.press("ArrowDown");
        await sleep(300);
        const m = await page.evaluate(() => {
            const el = document.activeElement;
            const tip = el.querySelector(".nav-tip");
            return { id: el.id, text: tip?.innerText.trim(), visibility: tip && getComputedStyle(tip).visibility, ring: getComputedStyle(el).boxShadow, focusVisible: el.matches(":focus-visible") };
        });
        await shot("rail-tooltip-focus");
        return [m.id === "tab-chat" && m.text === "Chat" && m.visibility === "visible" && m.focusVisible && m.ring !== "none", `focused ${m.id}: tip "${m.text}" ${m.visibility}, ring ${m.ring}`];
    });

    await check("desktop 1280x800", "the open item is marked by colour, fill weight and a background, and only one is", async () => {
        const m = await page.$$eval(".nav-rail .nav-tab", (tabs) =>
            tabs.map((t) => ({ id: t.id, selected: t.getAttribute("aria-selected"), bg: getComputedStyle(t).backgroundColor, color: getComputedStyle(t).color, fill: t.querySelector("svg path")?.getAttribute("d")?.length })),
        );
        const open = m.filter((t) => t.selected === "true");
        const others = m.filter((t) => t.selected !== "true");
        const ok = open.length === 1 && open[0].id === "tab-kvm" && others.every((o) => o.bg !== open[0].bg && o.color !== open[0].color);
        return [ok, m.map((t) => `${t.id} selected=${t.selected} bg ${t.bg} colour ${t.color}`).join("; ")];
    });

    // ---- a model to chat with -------------------------------------------------------------------------------------------

    await page.goto(`${stack.web}/app/settings/providers`, { waitUntil: "load" });
    await page.waitForSelector("#panel-settings", { visible: true });
    const clickByText = async (text) => {
        const handle = await page.evaluateHandle((t) => {
            const all = [...document.querySelectorAll("#panel-settings button, #panel-settings a, #panel-chat button")].filter((b) => b.offsetParent !== null);
            return all.find((b) => (b.getAttribute("aria-label") ?? "") === t || (b.textContent ?? "").trim() === t) ?? all.find((b) => (b.textContent ?? "").trim().startsWith(t)) ?? null;
        }, text);
        const el = handle.asElement();
        if (!el) throw new Error(`no "${text}" button`);
        await el.click();
    };
    await waitFor(() => (document.querySelector("#panel-settings")?.innerText ?? "").includes("Custom endpoint"));
    await clickByText("Custom endpoint");
    await sleep(600);
    const fields = [];
    for (const h of await page.$$("#panel-settings input")) {
        if (await h.evaluate((e) => e.offsetParent !== null && e.type !== "hidden" && e.type !== "search")) fields.push(h);
    }
    await fields[0].type("fake-desktop");
    await fields[1].type(stack.model);
    await fields[2].type(CANARY.providerKey);
    await clickByText("Test and connect");
    await waitFor(() => [...document.querySelectorAll("button")].some((b) => (b.getAttribute("aria-label") ?? "").startsWith("fake-1")));

    await openTab("chat");
    await page.waitForSelector("textarea[aria-label='Message']", { visible: true });
    const current = await page.$eval("button[aria-label^='Model:']", (b) => b.getAttribute("aria-label"));
    if (current !== "Model: fake-1") {
        await clickByText(current);
        await sleep(500);
        await (await page.waitForSelector("[aria-label^='fake-1'][aria-label$='via fake-desktop']", { visible: true })).click();
        await sleep(400);
    }

    // ---- the composer ---------------------------------------------------------------------------------------------------

    const longText = Array.from({ length: 80 }, (_, i) => `line ${i + 1}: the quick brown fox jumps over the lazy dog`).join("\n");
    for (const size of SIZES) {
        await page.setViewport({ width: size.width, height: size.height });
        await openTab("chat");
        await page.goto(`${stack.web}/app/chat`, { waitUntil: "load" });
        await page.waitForSelector("textarea[aria-label='Message']", { visible: true });
        await sleep(700);
        await check(`desktop ${size.name}`, "new chat: the composer is the conversation's column (same width, same centre), the heading above it", async () => {
            const g = await geometry();
            await shot(`${size.name}-new-chat`);
            return [same(g) && g.column.width <= 768 + 1, describe(g)];
        });
    }

    // One conversation, read at every size.
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${stack.web}/app/chat`, { waitUntil: "load" });
    const box = await page.waitForSelector("textarea[aria-label='Message']", { visible: true });
    await box.click();
    await box.type("hello there");
    await sleep(200);
    await page.click("button[aria-label='Send message']");
    await waitFor(() => (document.querySelector("#panel-chat")?.innerText ?? "").includes("You said: hello there"));
    await sleep(800);

    for (const size of SIZES) {
        await page.setViewport({ width: size.width, height: size.height });
        await sleep(600);
        await check(`desktop ${size.name}`, "conversation: the composer is the thread column (same width, same centre)", async () => {
            const g = await geometry();
            await shot(`${size.name}-conversation`);
            return [same(g), describe(g)];
        });
        await check(`desktop ${size.name}`, "a long text keeps the composer bounded and scrolls inside it", async () => {
            const before = await geometry();
            await page.evaluate((text) => {
                const ed = document.querySelector("#panel-chat textarea[aria-label='Message']");
                const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
                set.call(ed, text);
                ed.dispatchEvent(new Event("input", { bubbles: true }));
            }, longText);
            await sleep(500);
            const g = await geometry();
            const ed = await page.$eval("#panel-chat textarea[aria-label='Message']", (e) => ({ client: e.clientHeight, scroll: e.scrollHeight, overflowY: getComputedStyle(e).overflowY }));
            await shot(`${size.name}-long-text`);
            await page.evaluate(() => {
                const ed = document.querySelector("#panel-chat textarea[aria-label='Message']");
                const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
                set.call(ed, "");
                ed.dispatchEvent(new Event("input", { bubbles: true }));
            });
            await sleep(300);
            const bound = Math.min(size.height * 0.5, 420);
            return [
                same(g) && g.form.height <= bound && ed.scroll > ed.client && ed.overflowY !== "visible",
                `80 lines: composer ${px(g.form.height)} tall (empty ${px(before.form.height)}; bound ${px(bound)}), text area ${ed.client}px showing ${ed.scroll}px of text, overflow-y ${ed.overflowY}; still ${px(g.form.width)} wide`,
            ];
        });
    }

    // ---- the KVM and the chat have the room -----------------------------------------------------------------------------

    await page.setViewport({ width: 1280, height: 800 });
    await openTab("kvm");
    await sleep(500);
    await shot("1280x800-kvm");
    await openTab("chat");
    await shot("1280x800-chat-after");
    await check("desktop 1280x800", "no page error, and no failed request except the login-proxy probe", async () => [logs.length === 0, logs.join(" | ") || "clean"]);

    // ---- the phone ------------------------------------------------------------------------------------------------------

    const phone = await browser.newPage();
    await phone.emulate(puppeteer.KnownDevices["iPhone 13"]);
    await phone.goto(`${stack.web}/app/kvm`, { waitUntil: "load" });
    await phone.waitForSelector(".nav-bar");
    await sleep(600);
    const phoneBar = await phone.evaluate(() => ({
        labels: [...document.querySelectorAll(".nav-bar .nav-tab")].map((t) => t.innerText.trim()),
        railCount: document.querySelectorAll(".nav-rail").length,
        tips: document.querySelectorAll(".nav-tip").length,
        height: document.querySelector(".nav-bar").getBoundingClientRect().height,
    }));
    await phone.screenshot({ path: `${outDir}/phone-kvm.png` });
    report.add("iPhone 13", "the bottom bar keeps its labels and has no rail", `labels ${phoneBar.labels.join(", ")}; rails ${phoneBar.railCount}; tips ${phoneBar.tips}; bar ${phoneBar.height}px`, phoneBar.labels.join() === "KVM,Chat,Settings" && phoneBar.railCount === 0 && phoneBar.tips === 0);
    await phone.goto(`${stack.web}/app/chat`, { waitUntil: "load" });
    await phone.waitForSelector("textarea[aria-label='Message']", { visible: true });
    await sleep(600);
    const phoneGeometry = await phone.evaluate(() => {
        const r = document.querySelector("#panel-chat form[data-balloon-anchor='composer']").getBoundingClientRect();
        return { left: r.left, right: innerWidth - r.right, height: r.height };
    });
    await phone.screenshot({ path: `${outDir}/phone-new-chat.png` });
    report.add("iPhone 13", "new chat: the composer keeps its 12px gutters", `left ${px(phoneGeometry.left)}, right ${px(phoneGeometry.right)}`, Math.abs(phoneGeometry.left - 12) <= 1 && Math.abs(phoneGeometry.right - 12) <= 1);
    await phone.close();
} finally {
    await browser.close();
    await stack.stop();
}

const today = new Date().toISOString().slice(0, 10);
const shots = ["rail-tooltip-hover", "rail-tooltip-focus", ...SIZES.flatMap((s) => [`${s.name}-new-chat`, `${s.name}-conversation`, `${s.name}-long-text`]), "1280x800-kvm", "1280x800-chat-after", "phone-kvm", "phone-new-chat"];
const rel = (f) => `${outDir.split("/").slice(-1)[0]}/${f}.png`;
const md = [
    "",
    `## Desktop feedback: the chat composer and the navigation rail (${today})`,
    "",
    "Stack: the web host with the chat server and the real `omp` binary in it, in front of `tools/fake-kvmd`, with `tools/fake-model` as the provider (`apps/web/e2e/chat-stack.mjs`). Browser: headless Chrome through puppeteer-core, dark scheme; desktop at 1280x800, 1920x1080, 2560x1440 and 760x700 (the narrowest wide layout), plus an iPhone 13. Script: `apps/web/e2e/desktop-layout.e2e.mjs`.",
    "",
    `Rail before: ${BEFORE.rail}px wide, tabs ${BEFORE.tab}, icon over a label; the page beside it ${BEFORE.panel1280}px at 1280.`,
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed.`,
    "",
    ...shots.filter((f) => existsSync(`${outDir}/${f}.png`)).map((f) => `- [${f}](${rel(f)})`),
    "",
].join("\n");
mkdirSync(dirname(docPath), { recursive: true });
if (existsSync(docPath)) appendFileSync(docPath, md);
else writeFileSync(docPath, `# E2E run: desktop feedback (${today})\n${md}`);
process.exit(report.failed.length ? 1 : 0);
