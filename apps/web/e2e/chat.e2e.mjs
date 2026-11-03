// Chat inside the PiKVM app, end to end in a real browser: the web host with the chat server in it and the real omp
// binary behind that (apps/web/e2e/chat-stack.mjs), in front of tools/fake-kvmd, with tools/fake-model as the provider.
// iPhone 13 and a 1400x900 window, light and dark, driving the pages the way a person does:
//
//   - Settings -> Providers: add a custom endpoint pointing at the fake model; its models show up in Chat;
//   - Chat: a conversation in which the agent looks at the screen and clicks (the fake kvmd records it);
//   - a risky action waits for approval: Deny delivers nothing, Allow delivers it;
//   - a person's tap on the KVM takes control back; Hand back gives it again; Stop ends the run;
//   - Chat, KVM and Settings stay mounted (same elements, no new socket or stream);
//   - the KVM and Settings panes' computed styles and the app's root variables are the same before and after Chat
//     has loaded (chat.css reaches only .chat-scope);
//   - Settings pages carry one title each, and no request fails;
//   - the phone layout with the soft keyboard up;
//   - nothing secret reaches the browser or the agent: the provider key and the PiKVM password are not in any response, page,
//     storage, socket frame, the agent process's environment or command line, or the agent's files.
//
//   PUPPETEER_CORE=<node_modules with puppeteer-core> CHROME=<chrome> \
//   SHARP_MODULES=<node_modules with sharp> OMP_BIN=<omp> node apps/web/e2e/chat.e2e.mjs [phone|desktop] [--out docs/e2e/chat-integrated]
//
// Needs dist/ built (`yarn build`, and `vite build` in apps/web). It starts and stops its own stack per profile.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { WebSocket } from "ws";
import { CANARY, startStack } from "./chat-stack.mjs";
import { Report, launch, puppeteer, sleep, touchSession } from "./harness.mjs";

const args = process.argv.slice(2);
const only = args.find((a) => a === "phone" || a === "desktop");
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e/chat-integrated";
mkdirSync(outDir, { recursive: true });

const report = new Report("Chat integrated in the PiKVM app");
const today = new Date().toISOString().slice(0, 10);

const json = async (url) => (await fetch(url)).json();
const post = (url) => fetch(url, { method: "POST" });

/** What the fake kvmd received since `since`. */
async function hid(stack, since = 0) {
    return (await json(`${stack.fake}/__fake/hid?since=${since}`)).events;
}
const lastSeq = async (stack) => Math.max(0, ...(await hid(stack)).map((e) => e.seq));
const kinds = (events) => events.map((e) => (e.event_type === "key" ? `key ${e.event.key} ${e.event.state ? "down" : "up"}` : e.event_type === "mouse_button" ? `button ${e.event.button} ${e.event.state ? "down" : "up"}` : e.event_type));

/** The process ids under the host: the agent and anything it started. */
function descendants(rootPid) {
    const parent = new Map();
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            parent.set(Number(pid), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
        } catch {
            /* gone */
        }
    }
    const found = [];
    const walk = (pid) => {
        for (const [child, ppid] of parent) if (ppid === pid) (found.push(child), walk(child));
    };
    walk(rootPid);
    return found;
}

function* walkFiles(dir) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        let info;
        try {
            info = statSync(path);
        } catch {
            continue;
        }
        if (info.isDirectory()) yield* walkFiles(path);
        else if (info.isFile() && info.size < 64 * 1024 * 1024) yield path;
    }
}

/* ---- the page ---- */

async function openPage(browser, tag, stack) {
    const page = await browser.newPage();
    const seen = {
        logs: [],
        failed: [],
        responses: [],
        requests: [],
        frames: [],
        sockets: [],
        streams: [],
    };
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource|janus/.test(m.text())) seen.logs.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => seen.logs.push(`pageerror: ${e.message}`));
    page.on("request", (r) => {
        seen.requests.push({ method: r.method(), url: r.url(), headers: JSON.stringify(r.headers()), body: r.postData() ?? "" });
        if (/\/streamer\/stream|\/api\/streamer\/snapshot/.test(r.url())) seen.streams.push(r.url());
    });
    page.on("response", async (r) => {
        const url = r.url();
        if (r.status() >= 400 && !/\/oauth2\/userinfo$/.test(url)) seen.failed.push(`${r.status()} ${r.request().method()} ${url}`);
        const type = r.headers()["content-type"] ?? "";
        if (/event-stream|video|multipart/.test(type) || /\/streamer\/|\/janus\//.test(url)) return;
        try {
            seen.responses.push({ url, body: await r.buffer() });
        } catch {
            /* a body that went away with the page */
        }
    });
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    cdp.on("Network.webSocketCreated", (e) => {
        if (!/janus/.test(e.url)) seen.sockets.push(e.url);
    });
    cdp.on("Network.webSocketFrameReceived", (e) => seen.frames.push(e.response.payloadData));
    cdp.on("Network.webSocketFrameSent", (e) => seen.frames.push(e.response.payloadData));
    cdp.on("Network.eventSourceMessageReceived", (e) => seen.frames.push(e.data));
    if (tag === "phone") await page.emulate(puppeteer.KnownDevices["iPhone 13"]);
    else await page.setViewport({ width: 1400, height: 900 });
    return { page, seen, cdp, touch: tag === "phone" ? await touchSession(page) : null };
}

const scheme = (page, value) => page.emulateMediaFeatures([{ name: "prefers-color-scheme", value }]);

async function goTo(page, tag, tab) {
    if (tag === "phone") await page.tap(`#tab-${tab}`);
    else await page.click(`#tab-${tab}`);
    await page.waitForFunction((id) => document.getElementById(`panel-${id}`)?.dataset.active === "true", { timeout: 10000 }, tab);
    await sleep(300);
}

/** The first visible element matching `pick`, or throws. */
async function find(page, pick, what, ...rest) {
    const el = (await page.evaluateHandle(pick, ...rest)).asElement();
    if (!el) throw new Error(`no ${what}`);
    return el;
}

async function press(page, tag, name, scope = "") {
    const el = await find(
        page,
        (n, s) => {
            const onScreen = (b) => {
                const r = b.getBoundingClientRect();
                return b.offsetParent !== null && r.width > 0 && r.right > 0 && r.left < innerWidth;
            };
            const all = [...document.querySelectorAll(`${s} button, ${s} a`)].filter(onScreen);
            const label = (b) => b.getAttribute("aria-label") ?? "";
            const text = (b) => (b.textContent ?? "").trim();
            // A row such as "Custom endpoint" carries its description in the same button, so it can only be matched by its start.
            return all.find((b) => label(b) === n || text(b) === n) ?? all.find((b) => text(b).startsWith(n)) ?? null;
        },
        `"${name}"`,
        name,
        scope,
    );
    await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
    if (tag === "phone") await el.tap();
    else await el.click();
}

const waitText = (page, text, scope = "body", timeout = 30000) =>
    page.waitForFunction((t, s) => (document.querySelector(s)?.innerText ?? "").includes(t), { timeout }, text, scope);

const banner = (page) => page.evaluate(() => document.querySelector(".kvm-agent strong")?.textContent ?? null);
const waitBanner = (page, title, timeout = 20000) =>
    page.waitForFunction((t) => document.querySelector(".kvm-agent strong")?.textContent === t, { timeout }, title);

/** One screenshot in the colour scheme the page is in now, and (when `both`) the other one too. */
async function shot(page, tag, name, both = true) {
    await page.screenshot({ path: `${outDir}/${tag}-light-${name}.png` });
    if (!both) return;
    await scheme(page, "dark");
    await sleep(500);
    await page.screenshot({ path: `${outDir}/${tag}-dark-${name}.png` });
    await scheme(page, "light");
    await sleep(300);
}

async function newChat(page, tag) {
    await goTo(page, tag, "chat");
    await press(page, tag, "New chat", "#panel-chat");
    await sleep(500);
}

async function send(page, tag, text) {
    const box = await page.waitForSelector("textarea[aria-label='Message']", { visible: true });
    await box.click();
    await box.type(text);
    await sleep(150);
    await press(page, tag, "Send message");
}

/** Open the model picker and choose the fake model of `alias`. */
async function pickModel(page, tag, alias) {
    const current = await page.$eval("button[aria-label^='Model:']", (b) => b.getAttribute("aria-label"));
    if (current === "Model: fake-1") return;
    await press(page, tag, current);
    await sleep(500);
    const option = await find(page, (a) => document.querySelector(`[aria-label^='fake-1'][aria-label$='via ${a}']`), "model option", alias);
    await option.click();
    await sleep(400);
}

/** Computed styles of probe elements in the KVM and Settings panes, and the app's root variables. */
const probe = (page) =>
    page.evaluate(() => {
        const props = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "color", "backgroundColor"];
        const style = (el) => (el ? Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]])) : null);
        const names = new Set();
        for (const sheet of document.styleSheets) {
            let rules;
            try {
                rules = sheet.cssRules;
            } catch {
                continue;
            }
            for (const rule of rules) {
                if (rule.selectorText && /^(:root|html|\[data-theme)/.test(rule.selectorText)) {
                    for (const p of rule.style) if (p.startsWith("--")) names.add(p);
                }
            }
        }
        const root = getComputedStyle(document.documentElement);
        return {
            theme: document.documentElement.getAttribute("data-theme"),
            body: style(document.body),
            kvmButton: style(document.querySelector("#panel-kvm button")),
            settingsHeading: style(document.querySelector("#panel-settings h1")),
            settingsLink: style(document.querySelector("#panel-settings a")),
            navTab: style(document.querySelector("#tab-settings")),
            variables: Object.fromEntries([...names].sort().map((n) => [n, root.getPropertyValue(n).trim()]).filter(([, v]) => v !== "")),
        };
    });

/* ---- the run ---- */

async function run(browser, label, tag, index) {
    const stack = await startStack({ web: 18099 + index * 100, kvmd: 14510 + index * 100, model: 14517 + index * 100 });
    const { page, seen, touch } = await openPage(browser, tag, stack);
    const alias = `fake-${tag}`;
    let current = page;

    async function check(title, fn) {
        try {
            const [pass, observed] = await fn();
            report.add(label, title, observed, pass);
        } catch (error) {
            report.add(label, title, `threw: ${error.message}`, false);
            await current.screenshot({ path: `${outDir}/${tag}-failed-${report.failed.length}.png` }).catch(() => {});
        }
    }

    try {
        await page.goto(`${stack.web}/app/kvm`, { waitUntil: "load" });
        await page.waitForSelector("img.kvm-img");
        await sleep(1000);
        await scheme(page, "light");

        // ---- Settings -> Providers -----------------------------------------------------------------------------------------

        await check("Settings -> Providers: add a custom endpoint that points at the fake model", async () => {
            await goTo(page, tag, "settings");
            await page.goto(`${stack.web}/app/settings/providers`, { waitUntil: "load" });
            await page.waitForSelector("#panel-settings", { visible: true });
            await waitText(page, "Custom endpoint");
            await shot(page, tag, "01-providers");
            await press(page, tag, "Custom endpoint");
            await sleep(600);
            const fields = [];
            for (const h of await page.$$("#panel-settings main input, #panel-settings input")) {
                if (await h.evaluate((e) => e.offsetParent !== null && e.type !== "hidden" && e.type !== "search")) fields.push(h);
            }
            if (fields.length < 3) throw new Error(`${fields.length} visible fields`);
            await fields[0].type(alias);
            await fields[1].type(stack.model);
            await fields[2].type(CANARY.providerKey);
            await shot(page, tag, "02-custom-endpoint", false);
            await press(page, tag, "Test and connect");
            await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => (b.getAttribute("aria-label") ?? "").startsWith("fake-1")), { timeout: 30000 });
            await shot(page, tag, "03-provider-added");
            const listed = await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? "").filter((l) => l.startsWith("fake-")));
            return [listed.length >= 2, `${alias} saved; its models listed: ${listed.join(", ")}`];
        });

        await check("Settings pages carry one title each (Providers, Models, Agent)", async () => {
            const rows = [];
            for (const [path, title] of [["providers", "Providers"], ["models", "Models"], ["agent", "Agent"]]) {
                await page.goto(`${stack.web}/app/settings/${path}`, { waitUntil: "load" });
                await page.waitForSelector("#panel-settings h1", { visible: true });
                await sleep(1200);
                const titles = await page.$$eval("#panel-settings h1", (hs) => hs.filter((h) => h.offsetParent !== null).map((h) => h.textContent.trim()));
                rows.push({ path, titles });
                await shot(page, tag, `04-settings-${path}`);
            }
            const ok = rows.every((r) => r.titles.filter((t) => t === "Settings").length <= 1 && new Set(r.titles).size === r.titles.length && r.titles.length <= 2);
            const providers = rows[0].titles;
            return [ok && !providers.includes("Model providers"), rows.map((r) => `${r.path}: ${r.titles.join(" / ")}`).join("; ")];
        });

        // ---- Chat: the agent looks and clicks -----------------------------------------------------------------------------

        await check("Chat: the agent looks at the screen and clicks, and the fake kvmd records the click", async () => {
            await goTo(page, tag, "chat");
            await page.waitForSelector("textarea[aria-label='Message']", { visible: true });
            await pickModel(page, tag, alias);
            const since = await lastSeq(stack);
            const snapshots = (await json(`${stack.fake}/__fake/requests`)).requests.filter((r) => /snapshot/.test(r.path ?? r.url ?? "")).length;
            await send(page, tag, "pikvm:click");
            await waitText(page, "I clicked the centre of the screen.", "#panel-chat", 60000);
            await sleep(400);
            const events = await hid(stack, since);
            const taken = (await json(`${stack.fake}/__fake/requests`)).requests.filter((r) => /snapshot/.test(r.path ?? r.url ?? "")).length;
            await shot(page, tag, "05-agent-click");
            const buttons = events.filter((e) => e.event_type === "mouse_button");
            return [buttons.length >= 2 && taken > snapshots, `the fake kvmd received ${kinds(events.filter((e) => e.event_type !== "mouse_move")).join(", ")}; screenshots taken ${taken - snapshots}`];
        });

        // ---- approvals ---------------------------------------------------------------------------------------------------

        await check("a risky action waits for approval; Deny delivers nothing", async () => {
            await newChat(page, tag);
            const since = await lastSeq(stack);
            await send(page, tag, "pikvm:approve");
            await page.waitForFunction(() => [...document.querySelectorAll("#panel-chat button")].some((b) => b.offsetParent && b.textContent.trim() === "Deny"), { timeout: 60000 });
            await goTo(page, tag, "kvm");
            await sleep(500);
            const attention = await page.evaluate(() => document.querySelector("#tab-chat")?.getAttribute("data-attention"));
            const kvmBanner = await banner(page);
            await shot(page, tag, "06a-approval-waiting-on-kvm");
            await goTo(page, tag, "chat");
            await sleep(1200);
            const held = (await hid(stack, since)).filter((e) => e.event_type === "key");
            await shot(page, tag, "06-approval-waiting");
            await press(page, tag, "Deny", "#panel-chat");
            await sleep(3000);
            const after = (await hid(stack, since)).filter((e) => e.event_type === "key");
            await shot(page, tag, "07-denied");
            return [held.length === 0 && after.length === 0 && attention === "true" && kvmBanner === "Needs your approval", `keys while waiting ${held.length}; after Deny ${after.length}; from the KVM tab the Chat tab was marked (data-attention=${attention}) and the banner said "${kvmBanner}"`];
        });

        await check("a risky action waits for approval; Allow delivers it", async () => {
            await newChat(page, tag);
            const since = await lastSeq(stack);
            await send(page, tag, "pikvm:approve");
            await page.waitForFunction(() => [...document.querySelectorAll("#panel-chat button")].some((b) => b.offsetParent && b.textContent.trim() === "Allow"), { timeout: 60000 });
            await sleep(800);
            const held = (await hid(stack, since)).filter((e) => e.event_type === "key");
            await press(page, tag, "Allow", "#panel-chat");
            await waitText(page, "I pressed Alt+F4.", "#panel-chat", 60000);
            await sleep(500);
            const delivered = (await hid(stack, since)).filter((e) => e.event_type === "key");
            await shot(page, tag, "08-allowed");
            return [held.length === 0 && delivered.some((e) => e.event.key === "F4"), `keys while waiting ${held.length}; after Allow ${kinds(delivered).join(", ")}`];
        });

        // ---- control: a person's tap, Hand back, Stop ------------------------------------------------------------------------

        let agentProcesses = [];
        await check("a person's tap on the KVM takes control back, and Hand back gives it again", async () => {
            await newChat(page, tag);
            await send(page, tag, "pikvm:hold");
            await goTo(page, tag, "kvm");
            await waitBanner(page, "Agent is working", 60000);
            agentProcesses = descendants(stack.host.child.pid);
            const chip = await page.$eval(".kvm-agent", (el) => ({ w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), screen: innerWidth }));
            await shot(page, tag, "09-agent-working");
            const since = await lastSeq(stack);
            const box = await (await page.$("img.kvm-img")).boundingBox();
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            if (touch) await touch.tap(x, y);
            else await page.mouse.click(x, y);
            await waitBanner(page, "You have control", 15000);
            await sleep(500);
            const person = (await hid(stack, since)).filter((e) => e.event_type === "mouse_button");
            await shot(page, tag, "10-you-have-control");
            const reason = await page.$eval(".kvm-agent", (el) => el.dataset.reason);
            await press(page, tag, "Hand back", ".kvm-agent");
            await waitBanner(page, "Agent is working", 15000);
            await shot(page, tag, "11-handed-back");
            return [person.length >= 2 && reason === "operator" && chip.h <= 56, `the banner chip is ${chip.w}x${chip.h}px on a ${chip.screen}px screen (one line of text); the person's tap reached the fake kvmd as ${kinds(person).join(", ")}; banner "You have control" (reason ${reason}); after Hand back: "${await banner(page)}"`];
        });

        await check("Stop on the KVM tab banner ends the agent's control and cancels its response", async () => {
            const before = await banner(page);
            await press(page, tag, "Stop", ".kvm-agent");
            // Stop releases control and cancels the running response; the run's end puts the banner back to idle.
            await page.waitForFunction(() => {
                const title = document.querySelector(".kvm-agent strong")?.textContent ?? null;
                return title === null || title === "Agent stopped";
            }, { timeout: 15000 });
            await sleep(800);
            await shot(page, tag, "12-stopped");
            const activity = await fetch(`${stack.web}/app/api/v1/agent/activity`, { signal: AbortSignal.timeout(3000) }).then(async (res) => {
                const reader = res.body.getReader();
                const text = new TextDecoder().decode((await reader.read()).value);
                await reader.cancel();
                return text.match(/"state":"(\w+)"/)?.[1] ?? text.slice(0, 80);
            });
            await goTo(page, tag, "chat");
            await sleep(500);
            const responding = await page.evaluate(() => [...document.querySelectorAll("#panel-chat button")].some((b) => b.offsetParent && b.getAttribute("aria-label") === "Stop response"));
            await shot(page, tag, "12b-chat-after-stop");
            return [activity === "idle" && !responding, `banner "${before}" -> ${await banner(page) ?? "gone"}; activity state ${activity}; Chat still responding: ${responding}`];
        });

        // ---- tabs stay mounted ----------------------------------------------------------------------------------------------

        await check("Chat, KVM and Settings stay mounted: the same elements and no new socket or stream", async () => {
            await goTo(page, tag, "chat");
            const box = await page.waitForSelector("textarea[aria-label='Message']", { visible: true });
            await box.type("a draft that must survive");
            const ring = await box.evaluate((t) => getComputedStyle(t).boxShadow);
            await page.evaluate(() => {
                window.__kept = {
                    composer: document.querySelector("textarea[aria-label='Message']"),
                    picture: document.querySelector("img.kvm-img"),
                    settings: document.querySelector("#panel-settings main, #panel-settings"),
                };
            });
            const base = { sockets: seen.sockets.length, streams: seen.streams.length };
            const shown = [];
            for (const tab of ["kvm", "settings", "chat", "kvm", "chat", "settings", "chat"]) {
                await goTo(page, tag, tab);
                shown.push(await page.$$eval('.app-pane[data-active="true"]', (els) => els.map((e) => e.id.replace("panel-", "")).join("+")));
            }
            const state = await page.evaluate(() => ({
                composer: document.querySelector("textarea[aria-label='Message']") === window.__kept.composer,
                picture: document.querySelector("img.kvm-img") === window.__kept.picture,
                settings: document.querySelector("#panel-settings main, #panel-settings") === window.__kept.settings,
                draft: document.querySelector("textarea[aria-label='Message']")?.value,
            }));
            const newSockets = seen.sockets.length - base.sockets;
            const newStreams = seen.streams.length - base.streams;
            const ok = state.composer && state.picture && state.settings && state.draft === "a draft that must survive" && ring === "none" && newSockets === 0 && newStreams === 0 && shown.every((s, i) => s === ["kvm", "settings", "chat", "kvm", "chat", "settings", "chat"][i]);
            return [ok, `panes shown in turn: ${shown.join(", ")}; same composer ${state.composer}, picture ${state.picture}, settings ${state.settings}; draft kept "${state.draft}"; the focused composer has no app focus ring (box-shadow ${ring}); new sockets ${newSockets}, new streams ${newStreams}`];
        });

        await check("a streaming reply survives switching to KVM and Settings and back", async () => {
            await newChat(page, tag);
            await send(page, tag, "slow:The quick brown fox jumps over the lazy dog again and again and again until the reply is long enough to outlast the tab switches. END");
            await waitText(page, "The quick", "#panel-chat", 30000);
            await goTo(page, tag, "kvm");
            await sleep(900);
            await goTo(page, tag, "settings");
            await sleep(900);
            await goTo(page, tag, "chat");
            await waitText(page, "tab switches. END", "#panel-chat", 30000);
            await shot(page, tag, "14-stream-survived");
            const text = await page.evaluate(() => document.querySelector("#panel-chat")?.innerText ?? "");
            return [text.includes("The quick brown fox jumps over the lazy dog again and again and again until the reply is long enough to outlast the tab switches. END"), "the whole reply is in the thread after the switches"];
        });

        await check("the chat socket refuses a foreign Origin and accepts the app's own", async () => {
            const url = `${stack.web.replace("http", "ws")}/app/chat/ws`;
            const attempt = (origin) =>
                new Promise((done) => {
                    const ws = new WebSocket(url, { origin });
                    ws.on("open", () => (ws.close(), done("open")));
                    ws.on("unexpected-response", (_, res) => done(`refused ${res.statusCode}`));
                    ws.on("error", (e) => done(`error ${e.message}`));
                });
            const foreign = await attempt("http://evil.example");
            const own = await attempt(stack.web);
            return [/refused 403/.test(foreign) && own === "open", `Origin http://evil.example: ${foreign}; the app's own Origin: ${own}`];
        });

        // ---- computed styles unaffected by chat.css ------------------------------------------------------------------

        await check("computed styles in the KVM and Settings panes, and the app's root variables, are the same before and after Chat has loaded", async () => {
            const fresh = await browser.newPage();
            current = fresh;
            if (tag === "phone") await fresh.emulate(puppeteer.KnownDevices["iPhone 13"]);
            else await fresh.setViewport({ width: 1400, height: 900 });
            const sheets = (p) => p.evaluate(() => document.styleSheets.length);
            const hasChatCss = (p) =>
                p.evaluate(() => [...document.styleSheets].some((sheet) => {
                    try {
                        return [...sheet.cssRules].some((r) => r.selectorText?.includes(".chat-scope"));
                    } catch {
                        return false;
                    }
                }));
            const grab = async (p) => {
                const out = {};
                for (const theme of ["light", "dark"]) {
                    await scheme(p, theme);
                    await sleep(300);
                    for (const tab of ["kvm", "settings"]) {
                        await goTo(p, tag, tab);
                        out[`${theme}/${tab}`] = await probe(p);
                    }
                }
                await scheme(p, "light");
                return out;
            };
            await fresh.goto(`${stack.web}/app/settings/connection`, { waitUntil: "load" });
            await fresh.waitForSelector("#panel-settings h1", { visible: true });
            await sleep(1500);
            const chatBefore = await hasChatCss(fresh);
            const sheetsBefore = await sheets(fresh);
            const before = await grab(fresh);
            await goTo(fresh, tag, "chat");
            await fresh.waitForSelector("textarea[aria-label='Message']", { visible: true });
            await sleep(1000);
            const chatAfter = await hasChatCss(fresh);
            const sheetsAfter = await sheets(fresh);
            const after = await grab(fresh);
            // The detector must be able to see a leak: a rule like the one chat.css once had changes the font at once.
            await fresh.addStyleTag({ content: ":root{--font-sans:Courier;} body{font-family:Courier}" });
            const leaked = await probe(fresh);
            const detects = leaked.body.fontFamily !== after["light/settings"].body.fontFamily && leaked.variables["--font-sans"] !== after["light/settings"].variables["--font-sans"];
            await fresh.close();
            current = page;
            const diffs = [];
            for (const key of Object.keys(before)) {
                for (const part of Object.keys(before[key])) {
                    const a = before[key][part];
                    const b = after[key][part];
                    if (JSON.stringify(a) === JSON.stringify(b)) continue;
                    if (part === "variables") {
                        for (const n of Object.keys({ ...a, ...b })) if (a[n] !== b[n]) diffs.push(`${key} ${n}: ${a[n]} -> ${b[n]}`);
                    } else diffs.push(`${key}.${part}`);
                }
            }
            const family = before["light/settings"].body.fontFamily.split(",")[0];
            const variables = Object.keys(before["light/settings"].variables).length;
            const themes = before["light/kvm"].theme !== before["dark/kvm"].theme && before["light/kvm"].variables["--background"] !== before["dark/kvm"].variables["--background"];
            return [
                diffs.length === 0 && variables > 5 && themes && detects && sheetsAfter > sheetsBefore && chatAfter,
                `(the probe sees a planted :root font rule: ${detects}) Opening Chat loaded its stylesheets (${sheetsBefore} -> ${sheetsAfter}; the .chat-scope rules are ${chatBefore ? "there from the start" : "absent"} before and ${chatAfter ? "there" : "ABSENT"} after); compared ${variables} root variables, body, a KVM button, the Settings heading and link, and the nav tab in KVM and Settings, light and dark: ${diffs.length ? `DIFFER: ${diffs.join("; ")}` : "identical"}; app font ${family}; data-theme ${before["light/kvm"].theme}/${before["dark/kvm"].theme}, --background ${before["light/kvm"].variables["--background"]} / ${before["dark/kvm"].variables["--background"]}: ${themes ? "light and dark differ" : "NO DIFFERENCE"}`,
            ];
        });

        // ---- phone: the keyboard up --------------------------------------------------------------------------------------

        if (tag === "phone") {
            await check("phone: with the soft keyboard up the composer stays in view and the bottom bar steps aside", async () => {
                await goTo(page, tag, "chat");
                const box = await page.waitForSelector("textarea[aria-label='Message']", { visible: true });
                await box.tap();
                const full = await page.evaluate(() => visualViewport.height);
                const bar = () => page.evaluate(() => {
                    const nav = document.querySelector("nav[aria-label], [role=tablist]");
                    const r = nav?.getBoundingClientRect();
                    return r ? { top: Math.round(r.top), height: Math.round(r.height), visible: r.height > 0 && r.top < visualViewport.height } : null;
                });
                const barBefore = await bar();
                // The keyboard: the visual viewport loses its height (the shell tracks visualViewport, not focus).
                await page.setViewport({ ...puppeteer.KnownDevices["iPhone 13"].viewport, height: full - 336 });
                await sleep(700);
                const rect = await page.$eval("textarea[aria-label='Message']", (t) => {
                    const r = t.getBoundingClientRect();
                    return { top: r.top, bottom: r.bottom, vh: visualViewport.height, shell: document.querySelector("#panel-chat")?.getBoundingClientRect().bottom };
                });
                await page.screenshot({ path: `${outDir}/${tag}-light-13-keyboard-up.png` });
                await scheme(page, "dark");
                await sleep(400);
                await page.screenshot({ path: `${outDir}/${tag}-dark-13-keyboard-up.png` });
                await scheme(page, "light");
                const barAfter = await bar();
                await page.setViewport(puppeteer.KnownDevices["iPhone 13"].viewport);
                await sleep(500);
                const inView = rect.top >= 0 && rect.bottom <= rect.vh + 1;
                return [inView && rect.shell <= rect.vh + 1, `viewport ${full}px -> ${rect.vh}px; composer ${Math.round(rect.top)}-${Math.round(rect.bottom)}; chat pane ends at ${Math.round(rect.shell)}; bottom bar before ${JSON.stringify(barBefore)}, after ${JSON.stringify(barAfter)}`];
            });
        }

        // ---- the agent in a hold again, for the secret scan of its process -----------------------------------------------

        await check("secrets: the provider key and the PiKVM password are in no response, page, storage, frame, agent process or agent file", async () => {
            const secrets = { "provider key": CANARY.providerKey, "PiKVM password": CANARY.kvmPassword };
            const findings = [];
            const note = (where, what) => findings.push(`${what} in ${where}`);

            // Responses the browser got, and the page it holds.
            for (const [what, secret] of Object.entries(secrets)) {
                const needle = Buffer.from(secret);
                for (const r of seen.responses) if (r.body.includes(needle)) note(`response ${r.url}`, what);
                for (const frame of seen.frames) if (typeof frame === "string" && frame.includes(secret)) note("a socket or event frame", what);
                for (const r of seen.requests) if (r.url.includes(secret) || r.headers.includes(secret)) note(`request ${r.method} ${r.url} (URL or headers)`, what);
            }
            // The one request that carries the key out is the provider save to the chat server.
            const carriers = seen.requests.filter((r) => r.body.includes(CANARY.providerKey)).map((r) => `${r.method} ${new URL(r.url).pathname}`);
            const page$ = await page.evaluate(async () => {
                const caches$ = [];
                for (const name of await caches.keys()) {
                    const cache = await caches.open(name);
                    for (const req of await cache.keys()) caches$.push(`${req.url}\n${await (await cache.match(req)).text()}`);
                }
                const dbs = (await indexedDB.databases?.()) ?? [];
                return {
                    html: document.documentElement.outerHTML,
                    storage: JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
                    cookie: document.cookie,
                    caches: caches$.join("\n"),
                    databases: dbs.map((d) => d.name),
                };
            });
            const cookies = JSON.stringify(await page.cookies());
            for (const [what, secret] of Object.entries(secrets)) {
                for (const [where, text] of Object.entries({ "the page": page$.html, "local or session storage": page$.storage, "cookies": page$.cookie + cookies, "the cache storage": page$.caches })) {
                    if (text.includes(secret)) note(where, what);
                }
            }
            // The activity stream, read like the page reads it.
            const stream = await fetch(`${stack.web}/app/api/v1/agent/activity`, { signal: AbortSignal.timeout(2000) }).then(async (res) => {
                const reader = res.body.getReader();
                const text = new TextDecoder().decode((await reader.read()).value);
                await reader.cancel();
                return text;
            }).catch(() => "");
            for (const [what, secret] of Object.entries(secrets)) if (stream.includes(secret)) note("the activity stream", what);

            // The agent's process: the host's descendants while it held the PiKVM.
            const inspected = [];
            for (const pid of agentProcesses) {
                for (const file of ["environ", "cmdline"]) {
                    try {
                        const raw = readFileSync(`/proc/${pid}/${file}`);
                        inspected.push(`${pid}/${file}`);
                        for (const [what, secret] of Object.entries(secrets)) if (raw.includes(Buffer.from(secret))) note(`process ${pid} ${file}`, what);
                    } catch {
                        /* the process ended */
                    }
                }
            }
            // What the agent's own home and workspace hold, against what the server keeps for itself.
            const holders = { key: [], password: [] };
            for (const file of walkFiles(stack.data)) {
                const raw = readFileSync(file);
                const rel = relative(stack.data, file);
                if (raw.includes(Buffer.from(CANARY.providerKey))) holders.key.push(rel);
                if (raw.includes(Buffer.from(CANARY.kvmPassword))) holders.password.push(rel);
            }
            for (const rel of [...holders.key, ...holders.password]) {
                if (/(^|\/)(home|workspace|workspaces)\//.test(rel) || /config\.ya?ml$/.test(rel)) note(`agent file ${rel}`, "a secret");
            }
            // What the fake model got upstream: the real key, from the server, never the gateway's stand-in.
            const upstream = await json(new URL("/__fake/requests", stack.modelControl ?? stack.model));
            const upstreamKeys = [...new Set(upstream.auth.map((a) => a.authorization))];
            const usedKey = upstream.auth.some((a) => a.authorization === `Bearer ${CANARY.providerKey}`);
            if (!usedKey) findings.push("the model never received the stored key");
            return [
                findings.length === 0 && inspected.length > 0,
                `${seen.responses.length} responses, ${seen.frames.length} frames, ${seen.requests.length} requests, page, storage, cookies, caches and ${inspected.length} files of process ${agentProcesses.join("/")} checked: ${findings.length ? findings.join("; ") : "none found"}; the key left the browser in: ${carriers.join(", ") || "nothing"}; a plaintext copy of the key is on disk in ${holders.key.join(", ") || "no file"} (the settings store seals it); of the password in ${holders.password.join(", ") || "no file"}; the model received ${usedKey ? "the stored key" : "something else"} upstream (${upstreamKeys.length} distinct credential)`,
            ];
        });

        await check("no page error, and no failed request except the login-proxy probe", async () => {
            const bad = [...seen.logs, ...seen.failed];
            return [bad.length === 0, bad.join(" | ") || "clean"];
        });
    } finally {
        await page.close();
        await stack.stop();
    }
}

const browser = await launch();
try {
    if (only !== "desktop") await run(browser, "iPhone 13", "phone", 0);
    if (only !== "phone") await run(browser, "Desktop 1400x900", "desktop", 1);
} finally {
    await browser.close();
}

const shots = readdirSync(outDir).filter((f) => f.endsWith(".png")).sort();
const md = [
    `# E2E run: Chat inside the PiKVM app (${today})`,
    "",
    "Stack under test (`apps/web/e2e/chat-stack.mjs`, one per profile): the web host (`node dist/web-server.js`) with the chat server in it and the real `omp` binary behind that, in front of `tools/fake-kvmd`; `tools/fake-model` is the provider the test adds in Settings. Nothing is mocked between the browser and the agent, and no real PiKVM is touched.",
    "",
    "Browser: headless Chrome through puppeteer-core. Profiles: iPhone 13 (390x844, touch) and desktop 1400x900, each in light and dark (`prefers-color-scheme`). Script: `apps/web/e2e/chat.e2e.mjs`; how to run it: `docs/e2e/README.md`.",
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed.`,
    "",
    "## Screenshots",
    "",
    ...shots.map((f) => `- [${f.replace(".png", "")}](${outDir.split("/").slice(-1)[0]}/${f})`),
    "",
];
writeFileSync(`${dirname(outDir)}/${today}-chat-integrated${only ? `-${only}` : ""}.md`, md.join("\n"));
process.exit(report.failed.length ? 1 : 0);
