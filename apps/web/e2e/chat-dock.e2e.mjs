// The chat composer on a phone, end to end in a real browser (the web host with the chat server in it, the real omp binary,
// tools/fake-kvmd, tools/fake-model: apps/web/e2e/chat-stack.mjs):
//
//   - the new-chat screen docks the composer at the bottom of the pane, directly above the navigation bar, at the same
//     place a conversation's composer sits (bottom within 1px), with the greeting centred in the room above it;
//   - the same with the soft keyboard up (the installed app: the page reports a short visual viewport, the keyboard takes
//     more away): the composer sits right above the keyboard, in both screens;
//   - the wide layout centres the composer vertically in the pane, and its + menu floats.
//
//   PUPPETEER_CORE=<node_modules with puppeteer-core> CHROME=<chrome> SHARP_MODULES=<node_modules with sharp> OMP_BIN=<omp> \
//     node apps/web/e2e/chat-dock.e2e.mjs [--out docs/e2e/chat-dock] [--doc docs/e2e/2026-11-03-phone-feedback.md]
//
// Needs dist/ built (`yarn build`, and `vite build` in apps/web). It starts and stops its own stack.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CANARY, startStack } from "./chat-stack.mjs";
import { Report, launch, puppeteer, sleep } from "./harness.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const outDir = flag("--out", "docs/e2e/chat-dock");
const docPath = flag("--doc", "docs/e2e/2026-11-03-phone-feedback.md");
mkdirSync(outDir, { recursive: true });

const report = new Report("Chat dock");
const stack = await startStack({ web: 18499, kvmd: 14910, model: 14917 });
const browser = await launch();
const logs = [];

async function check(profile, name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add(profile, name, observed, pass);
    } catch (error) {
        report.add(profile, name, `threw: ${error.message}`, false);
    }
}

const px = (n) => `${Math.round(n * 10) / 10}`;
const wait = (page, fn, ...a) => page.waitForFunction(fn, { timeout: 30000 }, ...a);

// ---- a model to chat with (set up once, on a desktop page) ---------------------------------------------------------------

const setup = await browser.newPage();
await setup.setViewport({ width: 1280, height: 800 });
const clickByText = async (text) => {
    const handle = await setup.evaluateHandle((t) => {
        const all = [...document.querySelectorAll("#panel-settings button, #panel-settings a, #panel-chat button")].filter((b) => b.offsetParent !== null);
        return all.find((b) => (b.getAttribute("aria-label") ?? "") === t || (b.textContent ?? "").trim() === t) ?? all.find((b) => (b.textContent ?? "").trim().startsWith(t)) ?? null;
    }, text);
    const el = handle.asElement();
    if (!el) throw new Error(`no "${text}" button`);
    await el.click();
};
await setup.goto(`${stack.web}/app/settings/providers`, { waitUntil: "load" });
await setup.waitForSelector("#panel-settings", { visible: true });
await wait(setup, () => (document.querySelector("#panel-settings")?.innerText ?? "").includes("Custom endpoint"));
await clickByText("Custom endpoint");
await sleep(600);
const fields = [];
for (const h of await setup.$$("#panel-settings input")) {
    if (await h.evaluate((e) => e.offsetParent !== null && e.type !== "hidden" && e.type !== "search")) fields.push(h);
}
await fields[0].type("fake-dock");
await fields[1].type(stack.model);
await fields[2].type(CANARY.providerKey);
await clickByText("Test and connect");
await wait(setup, () => [...document.querySelectorAll("button")].some((b) => (b.getAttribute("aria-label") ?? "").startsWith("fake-1")));
await setup.close();

// ---- measuring -----------------------------------------------------------------------------------------------------------

/** The composer (with its option row), the navigation bar, the shell and the greeting, in CSS px. */
const geometry = (page) =>
    page.evaluate(() => {
        const rect = (el) => (el ? (({ left, top, right, bottom, width, height }) => ({ left, top, right, bottom, width, height }))(el.getBoundingClientRect()) : null);
        const composer = document.querySelector("#panel-chat [data-composer]");
        const form = document.querySelector("#panel-chat form[data-balloon-anchor='composer']");
        const heading = document.querySelector("#panel-chat [data-new-chat] h2");
        const header = document.querySelector("#panel-chat header");
        const col = composer?.closest(".thread-col");
        return {
            composer: rect(composer),
            form: rect(form),
            nav: rect(document.querySelector(".nav-bar, .nav-rail")),
            shell: rect(document.querySelector(".app-shell")),
            heading: rect(heading),
            header: rect(header),
            column: rect(col),
            keyboard: document.documentElement.getAttribute("data-keyboard"),
            padBottom: composer ? getComputedStyle(composer).paddingBottom : null,
        };
    });

async function openPhone(label, insets, injected) {
    const page = await browser.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource|janus/.test(m.text())) logs.push(`${label} console: ${m.text()}`);
    });
    page.on("pageerror", (e) => logs.push(`${label} pageerror: ${e.message}`));
    // The installed app below a black status bar: 390 x 797, no top inset, the home indicator at the bottom.
    await page.setViewport({ width: 390, height: 797, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const cdp = await page.createCDPSession();
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
    await page.evaluateOnNewDocument(
        (lie) => {
            Object.defineProperty(navigator, "standalone", { configurable: true, get: () => true });
            localStorage.setItem("pikvm-console-theme", "light");
            if (!lie) return;
            let keys = 0;
            const inner = Object.getOwnPropertyDescriptor(window, "innerHeight")?.get;
            const visual = Object.getOwnPropertyDescriptor(VisualViewport.prototype, "height")?.get;
            Object.defineProperty(window, "innerHeight", { configurable: true, get: () => inner.call(window) - lie - keys });
            Object.defineProperty(window.visualViewport, "height", { configurable: true, get: () => visual.call(window.visualViewport) - lie - keys });
            window.__keyboard = (n) => {
                keys = n;
                window.visualViewport.dispatchEvent(new Event("resize"));
            };
        },
        injected,
    );
    await page.goto(`${stack.web}/app/chat`, { waitUntil: "load" });
    await page.waitForSelector("textarea[aria-label='Message']", { visible: true });
    await sleep(900);
    return page;
}

const shot = (page, name) => page.screenshot({ path: `${outDir}/${name}.png` });

try {
    const insets = { top: 0, bottom: 34, left: 0, right: 0 };
    const page = await openPhone("phone", insets, 62);
    const profile = "iPhone 13, installed app (390x797, viewport reports 62px short)";

    // New chat.
    const fresh = await geometry(page);
    await shot(page, "phone-new-chat");
    await check(profile, "new chat: the composer is docked 12px above the navigation bar, and the page has no dead gap under it", async () => {
        const gap = fresh.nav.top - fresh.composer.bottom;
        return [
            Math.abs(gap - 12) <= 1 && fresh.nav.bottom === 797 && fresh.padBottom === "0px",
            `composer (with its options) ends ${px(fresh.composer.bottom)}, the bar starts ${px(fresh.nav.top)}: ${px(gap)}px between; composer padding-bottom ${fresh.padBottom}`,
        ];
    });
    await check(profile, "new chat: the greeting is centred in the room between the header and the composer", async () => {
        const room = { top: fresh.header.bottom, bottom: fresh.composer.top };
        const middle = (room.top + room.bottom) / 2;
        const h = (fresh.heading.top + fresh.heading.bottom) / 2;
        return [Math.abs(h - middle) <= 2 && fresh.heading.bottom <= fresh.composer.top, `greeting centre ${px(h)}; room ${px(room.top)}..${px(room.bottom)}, centre ${px(middle)}`];
    });
    await check(profile, "new chat: the composer is 12px in from each side and as wide as a conversation's column", async () => {
        return [Math.abs(fresh.form.left - 12) <= 1 && Math.abs(390 - fresh.form.right - 12) <= 1, `composer ${px(fresh.form.left)}..${px(fresh.form.right)} of 390`];
    });

    // The keyboard on the new-chat screen.
    await page.tap("textarea[aria-label='Message']");
    await page.evaluate(() => window.__keyboard(350));
    await wait(page, () => !document.querySelector(".nav-bar"));
    await sleep(500);
    const typing = await geometry(page);
    await shot(page, "phone-new-chat-keyboard");
    await check(profile, "new chat, keyboard up: the composer sits 12px above the keyboard and the greeting stays above it", async () => {
        const keys = 797 - 62 - 350; // where the visual viewport now ends
        const gap = keys - typing.composer.bottom;
        return [Math.abs(gap - 12) <= 1 && typing.nav === null && typing.keyboard === "open" && typing.heading.bottom <= typing.composer.top, `keyboard top ${keys}, composer ends ${px(typing.composer.bottom)}: ${px(gap)}px; bar ${typing.nav ? "still there" : "hidden"}; greeting ends ${px(typing.heading.bottom)}, composer starts ${px(typing.composer.top)}`];
    });
    await page.evaluate(() => window.__keyboard(0));
    await wait(page, () => !!document.querySelector(".nav-bar"));
    await sleep(400);

    // A conversation.
    await page.type("textarea[aria-label='Message']", "hello there");
    await page.tap("button[aria-label='Send message']");
    await wait(page, () => (document.querySelector("#panel-chat")?.innerText ?? "").includes("You said: hello there"));
    await sleep(900);
    const convo = await geometry(page);
    await shot(page, "phone-conversation");
    await check(profile, "conversation: the composer's bottom is the new-chat screen's (within 1px), above the bar", async () => {
        const gap = convo.nav.top - convo.composer.bottom;
        return [Math.abs(convo.composer.bottom - fresh.composer.bottom) <= 1 && Math.abs(gap - 12) <= 1, `conversation composer ends ${px(convo.composer.bottom)} (new chat ${px(fresh.composer.bottom)}); ${px(gap)}px above the bar`];
    });
    // Not asserted equal: the conversation's column keeps the thread's 16px gutters and the new-chat screen the phone's 12px
    // (the desktop-layout suite asserts that 12px). Recorded so a change shows.
    await check(profile, "conversation: the composer stays inside the screen with the thread's gutters (recorded against the new-chat screen's 12px)", async () => {
        return [convo.form.left >= 12 && 390 - convo.form.right >= 12, `conversation form ${px(convo.form.left)}..${px(convo.form.right)} of 390; new chat ${px(fresh.form.left)}..${px(fresh.form.right)}`];
    });

    await page.tap("textarea[aria-label='Message']");
    await page.evaluate(() => window.__keyboard(350));
    await wait(page, () => !document.querySelector(".nav-bar"));
    await sleep(500);
    const convoTyping = await geometry(page);
    await shot(page, "phone-conversation-keyboard");
    await check(profile, "conversation, keyboard up: the composer sits 12px above the keyboard, as on the new-chat screen", async () => {
        const keys = 797 - 62 - 350;
        const gap = keys - convoTyping.composer.bottom;
        return [Math.abs(gap - 12) <= 1 && Math.abs(convoTyping.composer.bottom - typing.composer.bottom) <= 1, `composer ends ${px(convoTyping.composer.bottom)}: ${px(gap)}px above the keyboard (new chat ${px(typing.composer.bottom)})`];
    });
    await page.evaluate(() => window.__keyboard(0));
    await sleep(400);
    await page.close();

    // The wide layout, as it was.
    const wide = await browser.newPage();
    await wide.setViewport({ width: 1280, height: 800 });
    await wide.goto(`${stack.web}/app/chat`, { waitUntil: "load" });
    await wide.waitForSelector("textarea[aria-label='Message']", { visible: true });
    await sleep(700);
    const desktop = await geometry(wide);
    await shot(wide, "desktop-new-chat");
    await check("desktop 1280x800", "new chat: the composer is the column's box, vertically centred in the pane below the header", async () => {
        const widthOk = Math.abs(desktop.form.width - 768) <= 20 && Math.abs((desktop.form.left + desktop.form.right) / 2 - (desktop.column.left + desktop.column.right) / 2) <= 1;
        const paneTop = desktop.header.bottom;
        const paneBottom = desktop.shell ? desktop.shell.bottom : 800;
        const off = (desktop.form.top + desktop.form.bottom) / 2 - (paneTop + paneBottom) / 2;
        return [widthOk && Math.abs(off) <= 24 && desktop.heading === null, `composer ${px(desktop.form.width)} wide, centred on the column; its centre is ${px(off)}px from the centre of the pane (${px(paneTop)}..${px(paneBottom)}); phone-only greeting wrapper absent: ${desktop.heading === null}`];
    });
    await check("desktop 1280x800", "new chat: the + menu floats (fixed, portalled) over the page without moving the composer", async () => {
        const before = await geometry(wide);
        await wide.click("#panel-chat button[aria-label='Add files and more'], #panel-chat [data-plus-button]");
        await sleep(300);
        const m = await wide.evaluate(() => {
            const el = document.querySelector("[data-suggest-menu]");
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { position: getComputedStyle(el).position, parent: el.parentElement?.tagName, top: r.top, bottom: r.bottom, height: r.height };
        });
        const after = await geometry(wide);
        const moved = Math.abs(after.form.top - before.form.top) + Math.abs(after.form.bottom - before.form.bottom);
        await shot(wide, "desktop-plus-menu");
        await wide.keyboard.press("Escape");
        await sleep(200);
        const closed = (await wide.$("[data-suggest-menu]")) === null;
        return [!!m && m.position === "fixed" && m.parent === "BODY" && moved <= 0.5 && closed, `menu ${m ? `${m.position} in ${m.parent}, ${px(m.top)}..${px(m.bottom)}` : "missing"}; composer moved ${px(moved)}px; Escape closes: ${closed}`];
    });
    await wide.close();

    await check("all", "no page error", async () => [logs.length === 0, logs.join(" | ") || "clean"]);
} finally {
    await browser.close();
    await stack.stop();
}

const today = new Date().toISOString().slice(0, 10);
const START = "<!-- chat-dock:start -->";
const END = "<!-- chat-dock:end -->";
const section = [
    START,
    "## Chat composer on the phone: docked above the bar, greeting centred (PhoneChrome)",
    "",
    `Run ${today}. A real host with the chat server and the real omp binary, \`tools/fake-kvmd\`, \`tools/fake-model\` (\`apps/web/e2e/chat-stack.mjs\`); headless Chrome, the installed-app geometry of the other section (390x797 below a black bar, \`navigator.standalone\` true, the page reporting 62px short, \`window.__keyboard(px)\` for the soft keyboard). Script: \`apps/web/e2e/chat-dock.e2e.mjs\`.`,
    "",
    "**Cause.** On the phone the new-chat screen padded the bottom inset twice (the pane's own padding, \`max(12px, --safe-bottom)\`, and the composer's \`pb-safe\`), and the navigation bar below already owns that inset, so about 75 pt of dead space sat under the composer. A conversation's docked footer padded it once. The shell now tells the chat its docks inside the pane pad nothing for the inset (\`--host-dock-safe-bottom: 0\` on \`.app-main\`, read as \`--dock-safe-bottom\`), so both screens end 12px above the bar, and above the keyboard when it is up (it was 34px, the inset, there too). On a phone the new-chat screen is now a column: the greeting centred in the room above, the composer docked below. The wide layout is unchanged.",
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed. Screenshots: \`docs/e2e/chat-dock/\`.`,
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
