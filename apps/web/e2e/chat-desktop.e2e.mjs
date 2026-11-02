// The DESKTOP app's Chat tab against its embedded harness. The real Electron app (packaged layout:
// resources/app, resources/apps/web/dist, an agent runtime) runs under a headless sway; this script
// attaches to the window itself over Electron's remote-debugging port and drives it the way a
// person would. tools/fake-kvmd is the PiKVM and tools/fake-model the provider.
//
//   - there is no terminal: the shell offers KVM, Chat and Settings, the host reports no terminal
//     feature, the terminal's page and socket are refused;
//   - the embedded server says chat is available (its harness answers), and the Chat tab shows the
//     conversation;
//   - Settings -> Providers: add an API provider with its key;
//   - Chat: a run is created, its events are rendered in the conversation, and the click it plans
//     reaches the kvmd; a held action waits for the person.
//
//   env -u ENABLE_VULKAN_RENDERDOC_CAPTURE <electron app> --remote-debugging-port=9334 ...
//   KVM_FAKE=http://127.0.0.1:4592 DESKTOP_CDP=http://127.0.0.1:9334 \
//     node apps/web/e2e/chat-desktop.e2e.mjs [--out docs/e2e/chat-desktop] [--grim "<command that writes a PNG to $1>"]
//
// The agent must act on the PiKVM the app is set to and on nothing else. The daemon's own config
// file is a decoy (a closed port), the second fake kvmd (KVM_FAKE2) is where Settings moves the
// target to, and the run asserts from the OS's socket table that nothing in the app's process
// tree (DESKTOP_PID) ever talked to an address outside loopback.
//
// Evidence is the page's own screenshots plus, when --grim names a command, the compositor's
// picture of the whole window (the title bar and frame included).

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FAKE, Report, describe, puppeteer, recorder, sleep } from "./harness.mjs";

const CDP = process.env.DESKTOP_CDP ?? "http://127.0.0.1:9334";
const FAKE2 = process.env.KVM_FAKE2 ?? "http://127.0.0.1:4593";
const DESKTOP_PID = Number(process.env.DESKTOP_PID ?? 0);
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e/chat-desktop";
const grimIndex = args.indexOf("--grim");
const grim = grimIndex >= 0 ? args[grimIndex + 1] : null;
mkdirSync(outDir, { recursive: true });

const report = new Report("Desktop chat");
let page;
let failures = 0;

async function check(name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add("desktop app", name, observed, pass);
    } catch (error) {
        report.add("desktop app", name, `threw: ${error.message}`, false);
        await page?.screenshot({ path: `${outDir}/failed-${++failures}.png` }).catch(() => {});
    }
}

const shot = async (name) => {
    await page.screenshot({ path: `${outDir}/${name}.png` });
    // The whole window as the compositor draws it.
    if (grim) execFileSync("sh", ["-c", `${grim} "$0"`, `${outDir}/${name}-window.png`]);
};

/** Every pid under `root`, itself included. */
function tree(root) {
    const rows = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((l) => l.trim().split(/\s+/).map(Number));
    const found = new Set([root]);
    for (let grew = true; grew; ) {
        grew = false;
        for (const [pid, ppid] of rows) if (found.has(ppid) && !found.has(pid)) (found.add(pid), (grew = true));
    }
    return found;
}

/** Remote addresses this process tree holds sockets to right now (TCP, any state but listening). */
function remotes(root) {
    const pids = tree(root);
    const out = execFileSync("ss", ["-tnpH"], { encoding: "utf8" });
    const seen = new Set();
    for (const line of out.split("\n")) {
        const pid = /pid=(\d+)/.exec(line)?.[1];
        if (!pid || !pids.has(Number(pid))) continue;
        const fields = line.trim().split(/\s+/);
        seen.add(fields[4]);
    }
    return [...seen];
}
const loopbackOnly = (addresses) => addresses.every((a) => /^(127\.0\.0\.1|\[::1\]|\[::ffff:127\.0\.0\.1\]):/.test(a));
const fakeLog = async (base) => (await (await fetch(`${base}/__fake/requests`)).json()).requests ?? [];
const snapshots = (log) => log.filter((r) => /\/streamer\/snapshot/.test(r.path));
const outsideRemotes = new Set();

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const pages = await browser.pages();
page = pages.find((p) => /\/app\//.test(p.url()));
if (!page) throw new Error(`no app window at ${CDP}: ${pages.map((p) => p.url()).join(", ")}`);
const ORIGIN = new URL(page.url()).origin;

const seen = { logs: [], requests: [] };
page.on("console", (m) => {
    // The terminal check's refused socket is logged by the browser as an error, by design.
    if (!/janus\/ws|Failed to load resource|\/app\/terminal/.test(m.text())) seen.logs.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => seen.logs.push(`pageerror: ${e.message}`));
page.on("request", (r) => seen.requests.push({ method: r.method(), url: r.url() }));
// The terminal check asks for pages and a socket that must be refused; that is its point, not an error.
let expectRefusals = false;
page.on("response", (r) => {
    if (r.status() >= 400 && !/\/oauth2\/userinfo$/.test(r.url()) && !(expectRefusals && /\/app\/(terminal|xterm)/.test(r.url()))) seen.logs.push(`error: ${r.status()} ${r.url()}`);
});

const inPage = (fn, ...rest) => page.evaluate(fn, ...rest);
const harness = (path) => inPage((p) => fetch(`/app/harness${p}`, { headers: { "x-pikvm-workspace": "1" } }).then((r) => r.json()), path);

async function find(pick, what, ...rest) {
    const handle = await page.evaluateHandle(pick, ...rest);
    const el = handle.asElement();
    if (!el) throw new Error(`no ${what}`);
    return el;
}
async function press(name) {
    const el = await find(
        (n) => [...document.querySelectorAll("button")].find((b) => b.offsetParent !== null && (b.getAttribute("aria-label") ?? b.textContent ?? "").trim() === n) ?? null,
        `button "${name}"`,
        name,
    );
    await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await el.click();
}
const waitForText = (text, timeout = 30000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
const STOPPED = new Set(["completed", "blocked", "rejected", "aborted", "failed", "paused"]);
async function waitForRun(task, timeoutMs = 45000) {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
        const body = await harness("/api/runs");
        const runs = Array.isArray(body) ? body : (body.runs ?? []);
        last = runs.find((r) => r.task === task) ?? null;
        if (last && STOPPED.has(last.status)) return last;
        await sleep(500);
    }
    throw new Error(`run "${task}" never stopped (last status: ${last?.status ?? "none"})`);
}

await page.setBypassCSP(false);
await page.goto(`${ORIGIN}/app/kvm`, { waitUntil: "networkidle2" });
// Start from the first fake, whatever an earlier run left the app pointing at.
await inPage((origin) => fetch("/app/api/v1/target", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin, username: "admin", password: "anything" }) }), FAKE);
await sleep(6000);
// A clean record on both fakes, so every count below is this run's.
for (const base of [FAKE, FAKE2]) await fetch(`${base}/__fake/reset`, { method: "POST" });
const rec = recorder();

await check("this is the desktop shell, and it offers KVM, Chat and Settings only", async () => {
    const bridge = await inPage(() => ({ present: typeof window.pikvmDesktop === "object", platform: window.pikvmDesktop?.platform }));
    const tabs = await inPage(() => [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim()));
    await shot("01-kvm");
    return [bridge.present && JSON.stringify(tabs) === JSON.stringify(["KVM", "Chat", "Settings"]), `pikvmDesktop ${bridge.present ? `on ${bridge.platform}` : "absent"}; tabs: ${tabs.join(", ")}`];
});

await check("there is no terminal: no feature flag, no page, no socket", async () => {
    expectRefusals = true;
    const state = await inPage(() => fetch("/app/api/v1/state").then((r) => r.json()));
    const statuses = await inPage(async () => {
        const get = async (p) => (await fetch(p, { redirect: "manual" })).status;
        return { html: await get("/app/terminal.html"), js: await get("/app/terminal.js"), css: await get("/app/xterm.css") };
    });
    const socket = await inPage(
        () =>
            new Promise((resolve) => {
                const ws = new WebSocket(`ws://${location.host}/app/terminal`);
                ws.onopen = () => resolve("opened");
                ws.onmessage = () => resolve("sent data");
                ws.onerror = () => resolve("refused");
                setTimeout(() => resolve("silent"), 4000);
            }),
    );
    expectRefusals = false;
    const features = Object.keys(state.features);
    return [
        !features.includes("terminal") && statuses.html === 404 && statuses.js === 404 && statuses.css === 404 && socket === "refused",
        `features: ${features.join(", ")}; /app/terminal.html ${statuses.html}, terminal.js ${statuses.js}, xterm.css ${statuses.css}; /app/terminal socket ${socket}`,
    ];
});

await check("the embedded server offers Chat because its harness answers; the Chat tab shows the conversation", async () => {
    const state = await inPage(() => fetch("/app/api/v1/state").then((r) => r.json()));
    // The Chat tab is a link in the shell's tab list, not a button.
    await (await find(() => [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim() === "Chat") ?? null, "Chat tab")).click();
    await page.waitForSelector("[aria-label='Agent conversation']", { timeout: 30000 });
    await shot("02-chat");
    const path = new URL(page.url()).pathname;
    return [state.features.chat === true && path === "/app/chat", `features.chat=${state.features.chat}; on ${path}; the conversation rendered`];
});

const alias = `fake-desktop-${Math.random().toString(16).slice(2, 6)}`;
const model = `${alias}-model`;

await check("Settings -> Providers: add an API provider and its key", async () => {
    await page.goto(`${ORIGIN}/app/settings/providers`, { waitUntil: "networkidle2" });
    await press("Add provider");
    await sleep(400);
    await page.select("select", "openai_compatible");
    const fields = await page.$$("form[aria-label='Add a provider'] input");
    const set = async (el, value) => {
        await el.click({ clickCount: 3 });
        await el.type(value);
    };
    await set(fields[0], alias);
    await set(fields[1], model);
    await set(fields[2], "http://127.0.0.1:9000/v1");
    await page.type("input[aria-label='API key']", `sk-e2e-${Math.random().toString(16).slice(2, 14)}`);
    await press("Add provider and save key");
    await waitForText(alias);
    await shot("03-provider-added");
    const listing = await harness("/api/provider-keys");
    const entry = listing.keys.find((k) => k.alias === alias);
    return [entry?.set === true, `${alias}: key listed as set: ${entry?.set === true}`];
});

await check("Chat: a run is created, its events render in the conversation, and the click reaches the kvmd", async () => {
    const task = "Please click the centre of the screen";
    await page.goto(`${ORIGIN}/app/chat`, { waitUntil: "networkidle2" });
    await page.waitForSelector("[aria-label='Agent conversation']", { timeout: 30000 });
    const tasks = await page.$("button[aria-label='Open tasks']");
    if (tasks && (await tasks.evaluate((e) => e.offsetParent !== null))) {
        await tasks.click();
        await sleep(400);
    }
    await press("New task");
    await sleep(600);
    const picker = await find(() => [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Model:")) ?? null, "model picker");
    await picker.click();
    await sleep(400);
    const option = await find((m) => [...document.querySelectorAll("[role=option]")].find((o) => o.textContent.trim() === m) ?? null, `model ${model}`, model);
    await option.click();
    await sleep(300);
    await rec.mark();
    await (await page.$("textarea")).type(task);
    await page.keyboard.press("Enter");
    await waitForText("Click at 160");
    const run = await waitForRun(task);
    const { events } = await rec.events(800);
    const buttons = events.filter((e) => e.event_type === "mouse_button");
    const streamed = seen.requests.some((r) => /\/app\/harness\/api\/runs\/[^/]+\/stream/.test(r.url));
    await shot("04-click-run");
    return [
        STOPPED.has(run.status) && buttons.length >= 2 && streamed,
        `run "${task}" ${run.status}; event stream opened: ${streamed}; "Click at 160" rendered in the conversation; fake kvmd received ${describe(events.filter((e) => e.event_type !== "mouse_move")).join(", ")}`,
    ];
});

await check("Chat: an action the harness holds waits for the person", async () => {
    const task = "Please approve the Enter key";
    await press("New task");
    await sleep(600);
    const picker = await find(() => [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Model:")) ?? null, "model picker");
    await picker.click();
    await sleep(400);
    const option = await find((m) => [...document.querySelectorAll("[role=option]")].find((o) => o.textContent.trim() === m) ?? null, `model ${model}`, model);
    await option.click();
    await sleep(300);
    await rec.mark();
    await (await page.$("textarea")).type(task);
    await page.keyboard.press("Enter");
    await waitForText("Allow once");
    await shot("05-approval-waiting");
    const held = (await rec.events(1200)).events.filter((e) => e.event_type === "key");
    await press("Allow once");
    await waitForText("Confirm");
    await press("Confirm");
    await waitForRun(task);
    const after = (await rec.events(1500)).events.filter((e) => e.event_type === "key");
    await shot("06-approved");
    return [held.length === 0 && after.some((e) => e.event?.key === "Enter"), `while waiting the fake kvmd received ${held.length} key events; after Allow once -> Confirm it received ${describe(after).join(", ")}`];
});

await check("the agent's daemon hit the app's PiKVM (the fake) and nothing outside loopback", async () => {
    if (!DESKTOP_PID) throw new Error("set DESKTOP_PID to the app's main process id");
    const log = await fakeLog(FAKE);
    const fromDaemon = snapshots(log);
    const addresses = remotes(DESKTOP_PID);
    for (const a of addresses) if (!loopbackOnly([a])) outsideRemotes.add(a);
    return [fromDaemon.length > 0 && outsideRemotes.size === 0, `the fake kvmd answered ${fromDaemon.length} snapshot request(s); the app's process tree held sockets to ${addresses.length} address(es), outside loopback: ${[...outsideRemotes].join(", ") || "none"} (the daemon's own config pointed at a closed decoy port)`];
});

await check("Settings -> Connection: saving a new PiKVM address moves the agent onto it", async () => {
    const before = snapshots(await fakeLog(FAKE2)).length;
    const first = snapshots(await fakeLog(FAKE)).length;
    const saved = await inPage(
        (origin) =>
            fetch("/app/api/v1/target", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin, username: "admin", password: "anything" }) }).then((r) => r.status),
        FAKE2,
    );
    // The daemon restarts onto it; a run's first look at the screen is a snapshot from the NEW target.
    await sleep(6000);
    const task = "Please click the centre of the screen";
    await page.goto(`${ORIGIN}/app/chat`, { waitUntil: "networkidle2" });
    await page.waitForSelector("[aria-label='Agent conversation']", { timeout: 30000 });
    const tasks = await page.$("button[aria-label='Open tasks']");
    if (tasks && (await tasks.evaluate((e) => e.offsetParent !== null))) {
        await tasks.click();
        await sleep(400);
    }
    await press("New task");
    await sleep(600);
    const picker = await find(() => [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Model:")) ?? null, "model picker");
    await picker.click();
    await sleep(400);
    const option = await find((m) => [...document.querySelectorAll("[role=option]")].find((o) => o.textContent.trim() === m) ?? null, `model ${model}`, model);
    await option.click();
    await sleep(300);
    await (await page.$("textarea")).type(task + " again");
    await page.keyboard.press("Enter");
    await waitForText("Click at 160");
    await waitForRun(task + " again");
    const second = snapshots(await fakeLog(FAKE2)).length - before;
    const firstAfter = snapshots(await fakeLog(FAKE)).length - first;
    for (const a of remotes(DESKTOP_PID)) if (!loopbackOnly([a])) outsideRemotes.add(a);
    return [saved === 200 && second > 0 && firstAfter === 0 && outsideRemotes.size === 0, `PUT /target ${saved}; after it the new fake kvmd answered ${second} snapshot request(s) and the old one ${firstAfter}; outside loopback: ${[...outsideRemotes].join(", ") || "none"}`];
});

await check("no page errors", async () => {
    const bad = seen.logs.filter((l) => l.startsWith("pageerror") || l.startsWith("error"));
    return [bad.length === 0, bad.join(" | ") || "clean"];
});

await browser.disconnect();

const today = new Date().toISOString().slice(0, 10);
const shots = readdirSync(outDir).filter((f) => f.endsWith(".png")).sort();
const md = [
    `# E2E run: the desktop app's Chat tab on its embedded harness (${today})`,
    "",
    `The real Electron app (the packaged layout: \`resources/app\`, \`resources/apps/web/dist\`, the agent runtime from the checkout's \`agent/.venv\`) under a headless sway (\`env -u ENABLE_VULKAN_RENDERDOC_CAPTURE\`), driven through its own window over Electron's remote-debugging port, in front of \`tools/fake-kvmd\` (${FAKE}); \`tools/fake-model\` is the provider. Script: \`apps/web/e2e/chat-desktop.e2e.mjs\`.`,
    "",
    "The \`*-window.png\` pictures are the compositor's (grim): the whole window with its frame. The others are the page's own.",
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed.`,
    "",
    "## Screenshots",
    "",
    ...shots.map((f) => `- [${f.replace(".png", "")}](chat-desktop/${f})`),
    "",
];
writeFileSync(`${dirname(outDir)}/${today}-chat-desktop.md`, md.join("\n"));
process.exit(report.failed.length ? 1 : 0);
