// A notification when the agent waits for the person, end to end: the real web host with the chat server in it and the real
// omp binary (apps/web/e2e/chat-stack.mjs) in front of tools/fake-kvmd, with tools/fake-model as the provider and
// tools/fake-push as the browser vendor's push service. A device is subscribed to the fake push service, the agent is sent the
// scripted "pikvm:approve" (it looks at the screen, then asks to press alt+F4), and what the device would have shown is read.
//
//   node --experimental-strip-types --disable-warning=ExperimentalWarning apps/web/e2e/agent-notify.e2e.mjs [--out docs/e2e]
//
// Needs dist/ built, PUPPETEER_CORE, CHROME, OMP_BIN (an omp binary) and SHARP_MODULES (see docs/e2e/README.md). It starts and stops its
// own stack and the fake push service.
//
// Shown: while the person is using the app nothing is sent (the card is in front of them); with the person away the push arrives with
// fixed generic words that say nothing about alt+F4; the push is signed and its payload decrypts; the same wait does not notify twice;
// switching the setting off stops it; with no device nothing is sent.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { startFakePush } from "../../../tools/fake-push/server.ts";
import { CANARY, startStack } from "./chat-stack.mjs";
import { Report, launch, sleep } from "./harness.mjs";

process.env.PIKVM_PUSH_ALLOW_LOCAL = "1";
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e";
mkdirSync(`${outDir}/agent-notify`, { recursive: true });
const report = new Report("Agent notifications");
const check = (name, pass, observed) => report.add("desktop", name, observed, pass);

const stack = await startStack({ web: 18399, kvmd: 14710, model: 14717 });
const push = await startFakePush({ port: 14720 });
const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

const api = (path, init = {}) =>
    fetch(`${stack.web}/app/api/v1${path}`, { ...init, headers: { "content-type": "application/json", ...init.headers }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
const patchWatch = (body) => api("/watch", { method: "PATCH", body });
const received = () => push.received.filter((r) => r.payload && typeof r.payload === "object");

async function press(name, scope = "") {
    const el = (
        await page.evaluateHandle(
            (n, s) => {
                const all = [...document.querySelectorAll(`${s} button, ${s} a`)].filter((b) => b.offsetParent !== null);
                const label = (b) => b.getAttribute("aria-label") ?? "";
                const text = (b) => (b.textContent ?? "").trim();
                return all.find((b) => label(b) === n || text(b) === n) ?? all.find((b) => text(b).startsWith(n)) ?? null;
            },
            name,
            scope,
        )
    ).asElement();
    if (!el) throw new Error(`no "${name}"`);
    await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await el.click();
}
const waitButton = (name, scope = "#panel-chat", timeout = 60000) =>
    page.waitForFunction((n, s) => [...document.querySelectorAll(`${s} button`)].some((b) => b.offsetParent && b.textContent.trim() === n), { timeout }, name, scope);
async function send(text) {
    const box = await page.waitForSelector("textarea[aria-label='Message']", { visible: true });
    await box.click();
    await box.type(text);
    await sleep(150);
    await press("Send message");
}
/** The composer's model: the fake provider's model, which a new chat does not start with. */
async function pickModel(target = page) {
    const current = await target.$eval("button[aria-label^='Model:']", (b) => b.getAttribute("aria-label"));
    if (current === "Model: fake-1") return;
    await target.click("button[aria-label^='Model:']");
    await sleep(500);
    const option = await target.waitForSelector("[aria-label^='fake-1'][aria-label$='via fake-notify']", { visible: true, timeout: 15000 });
    await option.click();
    await sleep(400);
}
async function newChatOn(target) {
    await target.evaluate(() => document.getElementById("tab-chat")?.click());
    await sleep(500);
    await target.evaluate(() => document.querySelector("#panel-chat button[aria-label='New chat']")?.click());
    await sleep(600);
    await pickModel(target);
}
const newChat = async () => {
    await page.click("#tab-chat");
    await page.waitForFunction(() => document.getElementById("panel-chat")?.dataset.active === "true");
    await press("New chat", "#panel-chat");
    await sleep(500);
    await pickModel();
};

try {
    // The provider: a custom endpoint that points at the fake model.
    await page.goto(`${stack.web}/app/settings/providers`, { waitUntil: "load" });
    await page.waitForFunction(() => document.body.innerText.includes("Custom endpoint"), { timeout: 30000 });
    await press("Custom endpoint");
    await sleep(600);
    const fields = [];
    for (const h of await page.$$("#panel-settings input")) if (await h.evaluate((e) => e.offsetParent !== null && e.type !== "hidden" && e.type !== "search")) fields.push(h);
    await fields[0].type("fake-notify");
    await fields[1].type(stack.model);
    await fields[2].type(CANARY.providerKey);
    await press("Test and connect");
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => (b.getAttribute("aria-label") ?? "").startsWith("fake-1")), { timeout: 30000 });

    // A device that asked for notifications (what the browser's own subscription would be).
    const none = await patchWatch({ notifyAgent: true });
    const noneView = await none.json();
    check("on by default, with no device set up", noneView.notifyAgent === true && noneView.push.subscriptions === 0, `notifyAgent ${noneView.notifyAgent}, devices ${noneView.push.subscriptions}`);

    await page.goto(`${stack.web}/app/chat`, { waitUntil: "load" });
    await page.waitForSelector("textarea[aria-label='Message']", { visible: true });
    await newChat();
    await send("pikvm:approve");
    await waitButton("Deny");
    await sleep(1500);
    check("no device: the card waits and nothing is sent", received().length === 0, `${received().length} pushes`);
    await press("Deny", "#panel-chat");
    await sleep(2500);

    const device = push.subscribe();
    const subscribed = await api("/watch/subscribe", { method: "POST", body: { subscription: { endpoint: device.endpoint, keys: device.keys } } });
    check("the device is subscribed", subscribed.status === 200, `HTTP ${subscribed.status}`);

    // The person is using the app: typing in the page is real input, so the card is in front of them.
    await newChat();
    await send("pikvm:approve");
    await waitButton("Deny");
    await sleep(2000);
    check("while the person is using the app nothing is sent", received().length === 0, `${received().length} pushes`);
    await press("Deny", "#panel-chat");
    await sleep(2500);

    // The person goes away: the page they used is closed, so what it last said about them expires (12 s). The page that starts the next
    // run does not count as the person: the text is put in by a script, which is not real input (presence.ts counts trusted events only).
    await page.close();
    const idle = await browser.newPage();
    await idle.setViewport({ width: 1400, height: 900 });
    await idle.goto(`${stack.web}/app/chat`, { waitUntil: "load" });
    await idle.waitForSelector("textarea[aria-label='Message']", { visible: true });
    await newChatOn(idle);
    await sleep(500);
    await sleep(13000);
    await idle.evaluate(() => {
        const box = document.querySelector("textarea[aria-label='Message']");
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(box, "pikvm:approve");
        box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(200);
    await idle.evaluate(() => document.querySelector("button[aria-label='Send message']")?.click());
    await idle.waitForFunction(() => [...document.querySelectorAll("#panel-chat button")].some((b) => b.offsetParent && b.textContent.trim() === "Deny"), { timeout: 60000 });
    for (let i = 0; i < 40 && received().length === 0; i++) await sleep(250);
    const got = received();
    check("with the person away one push arrives", got.length === 1, `${got.length} pushes`);
    const note = got[0]?.payload ?? {};
    check("it says that the agent needs approval, in fixed words", note.body === "The agent needs your approval." && note.title === "PiKVM", JSON.stringify({ title: note.title, body: note.body }));
    check("it does not say what the agent wants to do", !/alt|f4|key|screenshot|click/i.test(JSON.stringify(note)), JSON.stringify(note));
    check("a tap opens Chat, and it is marked as urgent and short-lived", note.url === "/app/chat" && got[0]?.urgency === "high" && (got[0]?.ttl ?? 0) > 0 && got[0].ttl <= 900, `url ${note.url}, urgency ${got[0]?.urgency}, ttl ${got[0]?.ttl}`);
    check("the push is signed and the payload decrypted", got[0]?.vapid.signatureValid === true, `signatureValid ${got[0]?.vapid.signatureValid}`);
    await idle.screenshot({ path: `${outDir}/agent-notify/approval-waiting.png` });

    await sleep(3000);
    check("the same wait does not notify again", received().length === 1, `${received().length} pushes`);
    await idle.evaluate(() => [...document.querySelectorAll("#panel-chat button")].find((b) => b.textContent.trim() === "Deny")?.click());
    await sleep(3000);

    // Switched off.
    const off = await (await patchWatch({ notifyAgent: false })).json();
    check("it can be switched off", off.notifyAgent === false, `notifyAgent ${off.notifyAgent}`);
    const before = received().length;
    await idle.evaluate(() => {
        document.querySelector("button[aria-label='New chat']")?.click();
    });
    await sleep(800);
    await idle.evaluate(() => {
        const box = document.querySelector("textarea[aria-label='Message']");
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(box, "pikvm:approve");
        box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(200);
    await idle.evaluate(() => document.querySelector("button[aria-label='Send message']")?.click());
    await idle.waitForFunction(() => [...document.querySelectorAll("#panel-chat button")].some((b) => b.offsetParent && b.textContent.trim() === "Deny"), { timeout: 60000 });
    await sleep(2500);
    check("switched off, a waiting approval sends nothing", received().length === before, `${received().length - before} new pushes`);
} catch (error) {
    check("the run finished", false, `threw: ${error.stack ?? error.message}`);
} finally {
    await browser.close().catch(() => undefined);
    await push.close().catch(() => undefined);
    await stack.stop().catch(() => undefined);
}

const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
const today = new Date().toISOString().slice(0, 10);
const md = [
    "# The agent needs the person: a notification (end to end)",
    "",
    `Result: ${report.rows.length - report.failed.length} of ${report.rows.length} checks passed.`,
    "",
    "| Check | Result | Observed |",
    "| --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.name} | ${r.pass ? "pass" : "FAIL"} | ${String(r.observed).replace(/\|/g, "/").replace(/\n/g, " ")} |`),
    "",
    "## How this run was made",
    "",
    "```sh",
    `PUPPETEER_CORE=${process.env.PUPPETEER_CORE ?? "(default)"} CHROME=${process.env.CHROME ?? "(default)"} OMP_BIN=${process.env.OMP_BIN ?? "(default)"} \\`,
    "  node --experimental-strip-types --disable-warning=ExperimentalWarning apps/web/e2e/agent-notify.e2e.mjs",
    "```",
    "",
    `- Repository commit: \`${commit}\`. The stack is \`apps/web/e2e/chat-stack.mjs\`: the web host with the chat server in it and the real \`omp\` binary, \`tools/fake-kvmd\`, \`tools/fake-model\` (scenario \`pikvm:approve\`) and \`tools/fake-push\` as the push service (it checks the VAPID signature and decrypts the payload).`,
    `- Node ${process.version}. No real PiKVM, push service or phone was used.`,
    "",
];
writeFileSync(`${outDir}/${today}-agent-notify.md`, md.join("\n"));
process.exit(report.failed.length ? 1 : 0);
