// Chat and Settings -> Providers on the HOSTED deployment: the web host and its agent sidecar
// (deploy/agent) in front of tools/fake-kvmd, with tools/fake-model standing in for a provider.
// iPhone 13 and a 1400x900 window, each driving the real pages the way a person would:
//
//   - the operator token never reaches the browser, and the proxy refuses a bare request;
//   - Settings -> Providers: add an API provider with its key, then check the key is write-only and
//     stored 0600 outside the config;
//   - Settings -> Providers: CLI sign-in shows the verification URL and code (Codex) or URL and code
//     box (Claude), and can be cancelled (these two start the CLIs' real sign-in, so they need
//     outbound internet; nothing is submitted);
//   - Chat: a run streams its events, a plain click reaches the fake kvmd;
//   - Chat: an action the harness holds is NOT delivered until the person allows it, then is;
//   - Chat: denying an action stops the run and delivers nothing;
//   - a host whose agent is down does not offer Chat, and says so (a second host on port 18081 is
//     started from dist/web-server.js for this, pointed at nothing).
//
//   node apps/web/e2e/chat-sidecar.e2e.mjs [phone|desktop] [--out docs/e2e/chat-sidecar]
//
// Bring the stack up with `podman compose -f deploy/e2e/compose.yml up -d` (see that file). It
// listens on 127.0.0.1:18080, with the fake kvmd on 127.0.0.1:14510:
//
//   KVM_WEB=http://127.0.0.1:18080 KVM_FAKE=http://127.0.0.1:14510 PUPPETEER_CORE=... CHROME=... \
//     node apps/web/e2e/chat-sidecar.e2e.mjs

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { WEB, FAKE, Report, describe, launch, puppeteer, recorder, sleep } from "./harness.mjs";

const OPERATOR = process.env.KVM_HARNESS_TOKEN ?? "e2e-operator-capability-0123456789abcdef";
const AGENT_CONTAINER = process.env.KVM_AGENT_CONTAINER ?? "e2e-kvm-agent-1";
const MODEL_CONTAINER = process.env.KVM_MODEL_CONTAINER ?? "e2e-fake-model-1";
const ENGINE = process.env.CONTAINER_ENGINE ?? "podman";

const args = process.argv.slice(2);
const only = args.find((a) => a === "phone" || a === "desktop");
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e/chat-sidecar";
mkdirSync(outDir, { recursive: true });

const report = new Report("Chat on the hosted deployment");

let current = null;
let failures = 0;

async function check(profile, name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add(profile, name, observed, pass);
    } catch (error) {
        report.add(profile, name, `threw: ${error.message}`, false);
        // What the page looked like when it went wrong.
        await current?.screenshot({ path: `${outDir}/${profile}-failed-${++failures}.png` }).catch(() => {});
    }
}

const shot = (page, name) => page.screenshot({ path: `${outDir}/${name}.png` });

/** Run a command inside a container; null when the engine or the container is not there. */
function inside(container, ...command) {
    try {
        return execFileSync(ENGINE, ["exec", container, ...command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
        return null;
    }
}
function logs(container) {
    try {
        return execFileSync(ENGINE, ["logs", container], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
        return null;
    }
}

const harness = (path, init = {}) =>
    fetch(`${WEB}/app/harness${path}`, { ...init, headers: { "x-pikvm-workspace": "1", ...(init.headers ?? {}) } });

async function launchPage(browser, tag) {
    const page = await browser.newPage();
    const seen = { logs: [], requests: [], bodies: [], approvals: [] };
    page.on("console", (m) => {
        if (!/janus\/ws|Failed to load resource/.test(m.text())) seen.logs.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => seen.logs.push(`pageerror: ${e.message}`));
    page.on("request", (r) => seen.requests.push({ method: r.method(), url: r.url(), headers: r.headers() }));
    page.on("response", async (r) => {
        const url = r.url();
        if (r.status() >= 400 && !/\/oauth2\/userinfo$/.test(url)) seen.logs.push(`error: ${r.status()} ${r.request().method()} ${url}`);
        if (/\/approvals\//.test(url) && r.request().method() === "POST") seen.approvals.push({ status: r.status(), url });
        // Everything the harness proxy sent the browser, for the secret scans below. A stream has no end.
        if (url.includes("/app/harness/") && !/\/stream/.test(url)) {
            try {
                seen.bodies.push({ url, text: await r.text() });
            } catch {
                /* a body that went away with the page */
            }
        }
    });
    if (tag === "phone") await page.emulate(puppeteer.KnownDevices["iPhone 13"]);
    else await page.setViewport({ width: 1400, height: 900 });
    return { page, seen };
}

const visible = (el) => el !== null && el.offsetParent !== null;

/** The handle of the first visible element matching `pick`, or throws. */
async function find(page, pick, what, ...rest) {
    const handle = await page.evaluateHandle(pick, ...rest);
    const el = handle.asElement();
    if (!el) throw new Error(`no ${what}`);
    return el;
}

async function press(page, name) {
    const el = await find(
        page,
        (n) =>
            [...document.querySelectorAll("button")].find(
                (b) => b.offsetParent !== null && (b.getAttribute("aria-label") ?? b.textContent ?? "").trim() === n,
            ) ?? null,
        `button "${name}"`,
        name,
    );
    await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await el.click();
}

async function waitForText(page, text, timeout = 30000) {
    await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

/** Wait until `fn` (run in the page) is truthy. */
async function waitFor(page, fn, timeout, ...rest) {
    await page.waitForFunction(fn, { timeout }, ...rest);
}

async function openChat(page) {
    await page.goto(`${WEB}/app/chat`, { waitUntil: "networkidle2" });
    await page.waitForSelector("[aria-label='Agent conversation']", { timeout: 20000 });
}

/** A fresh task with `model` chosen, ready for text. The workspace restores the last run on load. */
async function newTask(page, model) {
    const tasks = await page.$("button[aria-label='Open tasks']");
    if (tasks && (await tasks.evaluate(visible))) {
        await tasks.click();
        await sleep(400);
    }
    await press(page, "New task");
    await sleep(600);
    const picker = await find(
        page,
        () => [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Model:")) ?? null,
        "model picker",
    );
    await picker.click();
    await sleep(400);
    const option = await find(
        page,
        (m) => [...document.querySelectorAll("[role=option]")].find((o) => o.textContent.trim() === m) ?? null,
        `model option ${model}`,
        model,
    );
    await option.click();
    await sleep(300);
}

async function send(page, text) {
    const box = await page.$("textarea");
    await box.type(text);
    await page.keyboard.press("Enter");
}

/** The run the harness holds for a task, newest first. */
async function runFor(task) {
    const body = await (await harness("/api/runs")).json();
    const runs = Array.isArray(body) ? body : (body.runs ?? []);
    return runs.find((r) => r.task === task) ?? null;
}

async function waitForRun(task, predicate, timeoutMs = 45000) {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
        last = await runFor(task);
        if (last && predicate(last)) return last;
        await sleep(500);
    }
    throw new Error(`run "${task}" never got there (last status: ${last?.status ?? "none"})`);
}

// A run that has stopped for any reason; needs_approval is a wait, not an end.
const STOPPED = new Set(["completed", "blocked", "rejected", "aborted", "failed", "paused"]);

const hasEnter = (events) => events.some((e) => e.event_type === "key" && e.event?.key === "Enter");

async function run(browser, label, tag) {
    const { page, seen } = await launchPage(browser, tag);
    current = page;
    // An earlier run's unfinished sign-in would put its panel where the button should be.
    for (const cli of ["codex", "claude"]) await harness(`/api/cli-auth/${cli}/sign-in`, { method: "DELETE" });
    const key = `sk-e2e-${randomBytes(12).toString("hex")}`;
    // The harness keeps providers across runs, so each run adds its own.
    const alias = `fake-${tag}-${randomBytes(2).toString("hex")}`;
    const model = `${alias}-model`;
    const rec = recorder();
    const everything = () => [JSON.stringify(seen.requests), seen.bodies.map((b) => b.text).join("\n")].join("\n");

    await check(tag, "the host offers Chat because the agent answers", async () => {
        const state = await (await fetch(`${WEB}/app/api/v1/state`)).json();
        await openChat(page);
        await shot(page, `${tag}-01-chat`);
        return [state.features.chat === true, `features.chat=${state.features.chat}; the workspace rendered`];
    });

    await check(tag, "the operator token is held by the host, not the browser", async () => {
        const bare = await fetch(`${WEB}/app/harness/api/runs`);
        const authorizations = new Set(seen.requests.filter((r) => r.url.includes("/app/harness")).map((r) => r.headers.authorization ?? "(none)"));
        const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]) + document.documentElement.outerHTML);
        const leaked = everything().includes(OPERATOR) || storage.includes(OPERATOR);
        return [
            bare.status === 403 && !leaked && [...authorizations].every((a) => a === "Bearer desktop-managed"),
            `bare request ${bare.status}; browser sent ${[...authorizations].join(", ")}; token ${leaked ? "LEAKED" : "absent from requests, responses, storage and page"}`,
        ];
    });

    await check(tag, "Settings -> Providers: add an API provider and its key", async () => {
        await page.goto(`${WEB}/app/settings/providers`, { waitUntil: "networkidle2" });
        await press(page, "Add provider");
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
        await page.type("input[aria-label='API key']", key);
        await shot(page, `${tag}-02-add-provider`);
        await press(page, "Add provider and save key");
        await waitForText(page, alias);
        await shot(page, `${tag}-03-provider-added`);

        const listing = await (await harness("/api/provider-keys")).text();
        const entry = JSON.parse(listing).keys.find((k) => k.alias === alias);
        const config = inside(AGENT_CONTAINER, "cat", "/data/config/harness.yaml");
        const mode = inside(AGENT_CONTAINER, "stat", "-c", "%a", "/data/config/provider-keys.json")?.trim();
        const elsewhere = inside(AGENT_CONTAINER, "sh", "-c", `grep -rl '${key}' /data --exclude=provider-keys.json || true`);
        const checks = [
            ["the key is listed as set", entry?.set === true],
            ["no response carries it", !everything().includes(key) && !listing.includes(key)],
            ["the config does not hold it", config === null || !config.includes(key)],
            ["the store is 0600", mode === undefined || mode === "600"],
            ["no other file on the volume holds it", elsewhere === null || elsewhere.trim() === ""],
        ];
        return [checks.every(([, ok]) => ok), `${alias}: ${checks.map(([n, ok]) => `${n}: ${ok ? "yes" : "NO"}`).join("; ")}; store mode ${mode ?? "n/a"}`];
    });

    await check(tag, "Settings -> Providers: Codex sign-in shows the URL and one-time code, and can be cancelled", async () => {
        await page.goto(`${WEB}/app/settings/providers`, { waitUntil: "networkidle2" });
        await press(page, "Sign in to Codex (ChatGPT)");
        await page.waitForSelector("[data-testid='cli-codex'] [data-testid='user-code']", { timeout: 30000 });
        const panel = await page.$eval("[data-testid='cli-codex']", (el) => ({
            code: el.querySelector("[data-testid='user-code']").textContent.trim(),
            links: [...el.querySelectorAll("a")].map((a) => a.href),
            shown: el.querySelector("code").textContent.trim(),
        }));
        await shot(page, `${tag}-04-codex-sign-in`);
        const code = panel.code;
        await press(page, "Cancel sign-in");
        await sleep(1500);
        const after = await (await harness("/api/cli-auth/codex/sign-in")).json();
        return [
            /^[A-Z0-9]{3,8}-[A-Z0-9]{3,10}$/.test(code) && panel.links.some((l) => l.startsWith("https://auth.openai.com/")) && after.state === "cancelled",
            `link ${panel.links.find((l) => l.startsWith("http")) ?? "none"}; code ${code}; after Cancel sign-in: ${after.state}`,
        ];
    });

    await check(tag, "Settings -> Providers: Claude sign-in shows the URL and a box for the code, and can be cancelled", async () => {
        await page.goto(`${WEB}/app/settings/providers`, { waitUntil: "networkidle2" });
        await press(page, "Sign in to Claude Code");
        await waitFor(page, () => [...document.querySelectorAll("[data-testid='cli-claude'] a")].some((a) => a.href.startsWith("http")), 30000);
        const panel = await page.$eval("[data-testid='cli-claude']", (el) => ({
            links: [...el.querySelectorAll("a")].map((a) => a.href),
            inputs: el.querySelectorAll("input,textarea").length,
        }));
        await shot(page, `${tag}-05-claude-sign-in`);
        await press(page, "Cancel sign-in");
        await sleep(1500);
        const after = await (await harness("/api/cli-auth/claude/sign-in")).json();
        return [
            panel.inputs > 0 && panel.links.some((l) => l.startsWith("https://claude.")) && after.state === "cancelled",
            `link ${panel.links.find((l) => l.startsWith("http"))?.slice(0, 60) ?? "none"}...; ${panel.inputs} code field; after Cancel sign-in: ${after.state}`,
        ];
    });

    await check(tag, "Chat: a run streams its events and a click reaches the kvmd", async () => {
        const task = "Please click the centre of the screen";
        await openChat(page);
        await newTask(page, model);
        await rec.mark();
        await send(page, task);
        await waitForText(page, "Click at 160");
        await waitForRun(task, (r) => STOPPED.has(r.status));
        const { events } = await rec.events(800);
        const buttons = events.filter((e) => e.event_type === "mouse_button");
        const streamed = seen.requests.some((r) => /\/app\/harness\/api\/runs\/[^/]+\/stream/.test(r.url));
        await shot(page, `${tag}-06-click-run`);
        const keyTail = [...(logs(MODEL_CONTAINER) ?? "").matchAll(/"key_tail": "([^"]*)"/g)].at(-1)?.[1];
        return [
            buttons.length >= 2 && streamed && (keyTail === undefined || keyTail === key.slice(-4)),
            `event stream opened: ${streamed}; fake kvmd received ${describe(events.filter((e) => e.event_type !== "mouse_move")).join(", ")}; the model was called with the stored key (…${keyTail ?? "n/a"})`,
        ];
    });

    await check(tag, "Chat: an action the harness holds is not delivered until the person allows it", async () => {
        const task = "Please approve the Enter key";
        await openChat(page);
        await newTask(page, model);
        await rec.mark();
        await send(page, task);
        await waitForText(page, "Allow once");
        await shot(page, `${tag}-07-approval-waiting`);
        const held = (await rec.events(1200)).events;
        const heldOk = !hasEnter(held);
        await press(page, "Allow once");
        await waitForText(page, "Confirm");
        await shot(page, `${tag}-08-approval-confirm`);
        await press(page, "Confirm");
        await waitForRun(task, (r) => STOPPED.has(r.status), 45000);
        const { events } = await rec.events(1500);
        const delivered = hasEnter(events);
        await shot(page, `${tag}-09-approved`);
        const accepted = seen.approvals.filter((a) => a.status === 200).length;
        return [
            heldOk && delivered && accepted >= 1,
            `while waiting the fake kvmd received ${held.filter((e) => e.event_type === "key").length} key events; after Allow once -> Confirm it received ${describe(events.filter((e) => e.event_type === "key")).join(", ")}; approval POST ${seen.approvals.map((a) => a.status).join(",")}`,
        ];
    });

    await check(tag, "Chat: denying a held action delivers nothing", async () => {
        const task = "Please approve the second Enter key";
        await openChat(page);
        await newTask(page, model);
        await rec.mark();
        await send(page, task);
        await waitForText(page, "Allow once");
        await press(page, "Deny & stop");
        const stopped = await waitForRun(task, (r) => STOPPED.has(r.status), 45000);
        const { events } = await rec.events(1200);
        await shot(page, `${tag}-10-denied`);
        return [!hasEnter(events), `run status ${stopped.status}; the fake kvmd received ${events.filter((e) => e.event_type === "key").length} key events`];
    });

    await check(tag, "a host whose agent is down does not offer Chat, and says so", async () => {
        const port = 18081;
        const down = spawn(process.execPath, ["dist/web-server.js"], {
            env: {
                ...process.env,
                PIKVM_URL: FAKE,
                PIKVM_PASSWORD: "anything",
                PIKVM_AUTH: "proxy",
                HOST: "127.0.0.1",
                PORT: String(port),
                PIKVM_DATA_DIR: mkdtempSync(`${tmpdir()}/pikvm-down-host-`),
                PIKVM_HARNESS_URL: "http://127.0.0.1:1",
                PIKVM_HARNESS_TOKEN: OPERATOR,
            },
            stdio: "ignore",
        });
        try {
            const base = `http://127.0.0.1:${port}`;
            for (let i = 0; i < 40; i++) {
                if (await fetch(`${base}/app/api/v1/state`).then((r) => r.ok, () => false)) break;
                await sleep(250);
            }
            const state = await (await fetch(`${base}/app/api/v1/state`)).json();
            await page.goto(`${base}/app/chat`, { waitUntil: "networkidle2" });
            await waitForText(page, "Chat is not available");
            await shot(page, `${tag}-11-agent-down`);
            const offered = (await page.$("[aria-label='Agent conversation']")) !== null;
            return [state.features.chat === false && !offered, `features.chat=${state.features.chat}; the Chat page says "Chat is not available" and shows no workspace`];
        } finally {
            down.kill();
        }
    });

    await check(tag, "no page errors", async () => {
        const bad = seen.logs.filter((l) => l.startsWith("pageerror") || l.startsWith("error"));
        return [bad.length === 0, bad.join(" | ") || "clean"];
    });
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
    `# E2E run: Chat and Providers on the hosted deployment (${today})`,
    "",
    `Host under test: the web image (${WEB}) with its agent sidecar image behind \`/app/harness\`, in front of \`tools/fake-kvmd\` (${FAKE}); \`tools/fake-model\` is the provider. Stack: \`deploy/e2e/compose.yml\`.`,
    "",
    "Browser: headless Chrome through puppeteer-core. Profiles: iPhone 13 (390x844, touch, coarse pointer) and desktop 1400x900. Script: `apps/web/e2e/chat-sidecar.e2e.mjs`; how to run it: `docs/e2e/README.md`.",
    "",
    "The two CLI sign-in cases start the real `codex` and `claude` sign-in inside the sidecar (they need outbound internet); nothing is submitted and each attempt is cancelled.",
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed.`,
    "",
    "## Screenshots",
    "",
    ...shots.map((f) => `- [${f.replace(".png", "")}](chat-sidecar/${f})`),
    "",
];
writeFileSync(`${dirname(outDir)}/${today}-chat-sidecar${only ? `-${only}` : ""}.md`, md.join("\n"));
process.exit(report.failed.length ? 1 : 0);
