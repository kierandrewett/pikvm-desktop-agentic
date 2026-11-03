// Platform parity, end to end: the pieces that used to exist on one platform only. iPhone 13 and a
// 1400x900 window against a real web host in front of tools/fake-kvmd.
//
//   - the app is installable (manifest, service worker) and opens on a retrying page when the KVM
//     cannot be reached;
//   - the health indicator is on the phone dock as it is on the desktop toolbar;
//   - Task Manager and the Windows key can be sent from a phone;
//   - the screen-change alert works in a browser (title marker, notification, badge) and is
//     honestly absent on a phone;
//   - Save screenshot downloads a real JPEG.
//
//   node apps/web/e2e/parity.e2e.mjs [phone|desktop] [--out docs/e2e/parity]
//
// See docs/e2e/README.md for how to bring the two servers up.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WEB, FAKE, Report, describe, fakePost, fakeReset, launch, puppeteer, recorder, sleep } from "./harness.mjs";

const args = process.argv.slice(2);
const only = args.find((a) => a === "phone" || a === "desktop");
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e/parity";
mkdirSync(outDir, { recursive: true });

const report = new Report("Platform parity");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const shot = (page, name) => page.screenshot({ path: `${outDir}/${name}.png` });

async function check(profile, name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add(profile, name, observed, pass);
    } catch (error) {
        report.add(profile, name, `threw: ${error.message}`, false);
    }
}

async function live(page, timeout = 15000) {
    await page.waitForFunction(
        () => (document.querySelector(".kvm-dot")?.getAttribute("aria-label") ?? "") === "Live" || (document.querySelector(".kvm-status")?.textContent ?? "") === "Live",
        { timeout },
    );
}

async function newPage(browser, tag, init) {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => {
        // The fake has no Janus (the designed fallback to MJPEG); the offline case cuts the network on purpose.
        if (!/janus\/ws|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    page.on("response", (r) => {
        // The worker's own "can't reach the KVM" page is a 503 by design, and Settings' proxy check 404s on a host with no proxy.
        if (r.status() >= 400 && !/\/oauth2\/userinfo$/.test(r.url()) && !(r.status() === 503 && r.fromServiceWorker())) logs.push(`error: ${r.status()} ${r.url()}`);
    });
    if (tag === "phone") await page.emulate(puppeteer.KnownDevices["iPhone 13"]);
    else await page.setViewport({ width: 1400, height: 900 });
    if (init) await page.evaluateOnNewDocument(init);
    return { page, logs };
}

/** Press (tap on the phone) a visible control found by its accessible name or text. */
async function press(page, tag, name, scope = "button") {
    const handle = await page.evaluateHandle(
        (n, s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null).find((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").trim() === n) ?? null,
        name,
        scope,
    );
    const el = handle.asElement();
    if (!el) throw new Error(`no control "${name}"`);
    await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
    if (tag === "phone") await el.tap();
    else await el.click();
}

const menuLabels = (page, selector) => page.$$eval(selector, (els) => els.map((e) => e.textContent.trim()));

async function run(browser, profile, tag) {
    await fakeReset();
    const downloads = mkdtempSync(join(tmpdir(), "pikvm-parity-"));
    const context = browser.defaultBrowserContext();
    await context.overridePermissions(WEB, ["notifications"]);
    // Record what the page asks the browser to show: headless Chrome has no notification centre or app badge to look at.
    const spy = () => {
        window.__notes = [];
        window.__badges = [];
        const Original = window.Notification;
        window.Notification = new Proxy(Original, {
            construct(target, args) {
                window.__notes.push({ title: args[0], body: args[1]?.body, tag: args[1]?.tag });
                return Reflect.construct(target, args);
            },
        });
        navigator.setAppBadge = async () => void window.__badges.push("set");
        navigator.clearAppBadge = async () => void window.__badges.push("clear");
    };
    const { page, logs } = await newPage(browser, tag, spy);
    const cdp = await page.createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: false }).catch(() => cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads }));
    const rec = recorder();

    await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
    await live(page);

    await check(profile, "installable: manifest linked and valid, worker registered with the /app/ scope, no installability errors", async () => {
        const manifestHref = await page.$eval('link[rel="manifest"]', (l) => l.href);
        const manifest = await (await fetch(manifestHref)).json();
        const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
        await page.reload({ waitUntil: "load" });
        const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
        const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
        const errors = installabilityErrors.map((e) => e.errorId);
        await live(page);
        const pass = manifest.display === "standalone" && manifest.scope === "/app/" && manifest.icons.length >= 3 && scope.endsWith("/app/") && controlled && errors.length === 0;
        return [pass, `manifest ${manifest.name}, ${manifest.display}, scope ${manifest.scope}; worker scope ${scope}; controlling this page ${controlled}; installability errors: ${errors.join(", ") || "none"}`];
    });

    await check(profile, "the KVM unreachable: the app opens on the retrying page, and recovers on its own", async () => {
        // DevTools' offline switch is per target, and the worker fetches for navigations: cut both.
        const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/app/sw.js"), { timeout: 5000 });
        const worker = await target.createCDPSession();
        await worker.send("Network.enable");
        const cut = (offline) => worker.send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await cut(true);
        await page.setOfflineMode(true);
        await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" }).catch(() => {});
        const heading = await page.$eval("h1", (h) => h.textContent).catch(() => "(none)");
        const retry = (await page.$("#retry")) !== null;
        await shot(page, `${tag}-offline`);
        await cut(false);
        await page.setOfflineMode(false);
        // The page reloads itself on the browser's online event, or by its five-second poll.
        await page.waitForSelector(".kvm-screen", { timeout: 15000 });
        await live(page);
        return [heading === "Can't reach the KVM" && retry, `page said ${JSON.stringify(heading)}, retry button ${retry}; back on the KVM screen afterwards`];
    });

    await check(profile, "health indicator: appears when the target loses signal, goes when it returns", async () => {
        await fakePost("/__fake/source?online=0");
        await page.waitForSelector('[data-testid="health"]', { timeout: 8000 });
        const where = await page.$eval('[data-testid="health"]', (b) => (b.closest(".kvm-bar") ? "dock" : b.closest(".kvm-toolbar") ? "toolbar" : "elsewhere"));
        const label = await page.$eval('[data-testid="health"]', (b) => b.getAttribute("aria-label"));
        await shot(page, `${tag}-health`);
        await fakePost("/__fake/source?online=1");
        await page.waitForFunction(() => !document.querySelector('[data-testid="health"]'), { timeout: 8000 });
        return [where === (tag === "phone" ? "dock" : "toolbar"), `${where}: ${label}`];
    });

    await check(profile, "Save screenshot downloads a real JPEG", async () => {
        if (tag === "phone") await press(page, tag, "More");
        else await page.click('[data-testid="more"]');
        await page.waitForFunction(() => [...document.querySelectorAll(".kvm-item")].some((e) => e.textContent.trim() === "Save screenshot"));
        await press(page, tag, "Save screenshot", ".kvm-item");
        let file;
        for (let i = 0; i < 40 && !file; i++) {
            await sleep(250);
            file = readdirSync(downloads).find((f) => f.endsWith(".jpg"));
        }
        if (!file) throw new Error("no file arrived");
        const bytes = readFileSync(join(downloads, file));
        const toast = await page.evaluate(() => document.querySelector(".kvm-toast")?.textContent ?? "");
        return [bytes[0] === 0xff && bytes[1] === 0xd8 && statSync(join(downloads, file)).size > 500, `${file}, ${bytes.length} bytes, JPEG header ${bytes[0].toString(16)}${bytes[1].toString(16)}; toast ${JSON.stringify(toast)}`];
    });

    if (tag === "phone") {
        await page.reload({ waitUntil: "load" });
        await live(page);
        await check(profile, "More keys: Task Manager and the Windows key reach the target", async () => {
            await page.tap('[data-toggle="more"]');
            await rec.mark();
            await press(page, tag, "Ctrl+Shift+Esc, Task Manager");
            const task = describe((await rec.events(500)).events);
            await rec.mark();
            await press(page, tag, "Windows key on its own");
            const win = describe((await rec.events(500)).events);
            await shot(page, `${tag}-more-keys`);
            const pass = equal(task, ["key ControlLeft down", "key ShiftLeft down", "key Escape down", "key Escape up", "key ShiftLeft up", "key ControlLeft up"]) && equal(win, ["key MetaLeft down", "key MetaLeft up"]);
            return [pass, `Task Manager: ${task.join(", ")}; Windows key: ${win.join(", ")}`];
        });

        await check(profile, "screen-change alert: not offered on a phone, and Settings says why", async () => {
            await press(page, tag, "More");
            const items = await menuLabels(page, "#kvm-sheet .kvm-item");
            await page.goto(`${WEB}/app/settings/display`, { waitUntil: "load" });
            await page.waitForSelector("[data-settings-page]");
            const text = await page.evaluate(() => document.body.innerText);
            const switchPresent = (await page.$('[role="switch"][aria-label="Alert me when the screen changes"]')) !== null;
            await shot(page, `${tag}-alerts-settings`);
            return [!items.some((l) => /Alert me/.test(l)) && /Not available on a phone/.test(text) && !switchPresent, `sheet items: ${items.join(" | ")}; settings: ${/Not available on a phone[^.]*\./.exec(text)?.[0] ?? "(no note)"}`];
        });
    } else {
        await check(profile, "screen-change alert: on in Settings, then a change while the window is behind shows the marker, the badge and a notification, and looking again clears them", async () => {
            await page.goto(`${WEB}/app/settings/display`, { waitUntil: "load" });
            await page.waitForSelector('[role="switch"][aria-label="Alert me when the screen changes"]');
            const before = await page.$eval('[role="switch"][aria-label="Alert me when the screen changes"]', (s) => s.getAttribute("aria-checked"));
            await press(page, tag, "Alert me when the screen changes", '[role="switch"]');
            await sleep(200);
            const stored = await page.evaluate(() => localStorage.getItem("pikvm-console-screen-alerts"));
            await shot(page, `${tag}-alerts-settings`);

            await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
            await live(page);
            // Another window comes in front: this one is hidden, as a tab behind another is.
            const other = await browser.newPage();
            try {
                await other.goto("about:blank");
                await other.bringToFront();
                // rAF is paused in a hidden page, so every wait here polls on a timer.
                await page.waitForFunction(() => document.hidden || !document.hasFocus(), { timeout: 5000, polling: 200 });
                const state = await page.evaluate(() => ({ hidden: document.hidden, focus: document.hasFocus() }));
                await sleep(4000); // the watcher's first samples only set the baseline
                await fakePost("/__fake/picture?name=changed");
                let during;
                try {
                    await page.waitForFunction(() => document.title.startsWith("\u25cf "), { timeout: 12000, polling: 200 });
                    during = await page.evaluate(() => ({ title: document.title, notes: window.__notes, badges: window.__badges.slice() }));
                } catch (error) {
                    const seen = await page.evaluate(() => ({ title: document.title, hidden: document.hidden, stored: localStorage.getItem("pikvm-console-screen-alerts") }));
                    throw new Error(`no marker: ${JSON.stringify(seen)}`);
                }
                await page.bringToFront();
                await page.waitForFunction(() => !document.title.startsWith("\u25cf "), { timeout: 5000, polling: 200 });
                const after = await page.evaluate(() => ({ title: document.title, badges: window.__badges.slice() }));
                const pass =
                    before === "false" &&
                    stored === "on" &&
                    during.title === "\u25cf PiKVM" &&
                    during.notes.length >= 1 &&
                    during.notes[0].tag === "pikvm-screen" &&
                    during.badges[0] === "set" &&
                    after.title === "PiKVM" &&
                    after.badges.at(-1) === "clear";
                return [pass, `switch ${before} -> stored ${stored}; window ${JSON.stringify(state)}; during: ${JSON.stringify(during.title)}, ${during.notes.length} notification(s) "${during.notes[0]?.title}: ${during.notes[0]?.body}", badge ${during.badges.join(",")}; after: ${JSON.stringify(after.title)}, badge ${after.badges.join(",")}`];
            } finally {
                await other.close();
                await fakePost("/__fake/picture?name=bars");
                await page.bringToFront();
            }
        });

        await check(profile, "the same switch is in the KVM's More menu", async () => {
            await page.click('[data-testid="more"]');
            const items = await menuLabels(page, ".kvm-menu .kvm-item");
            await page.keyboard.press("Escape");
            return [items.includes("Alert me when the screen changes"), items.filter((l) => /Alert|Full screen|screenshot/i.test(l)).join(" | ")];
        });
    }

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
    `# E2E run: platform parity (${today})`,
    "",
    `Host under test: \`node dist/web-server.js\` (${WEB}) in front of \`tools/fake-kvmd\` (${FAKE}).`,
    "",
    "Browser: headless Chrome through puppeteer-core. Profiles: iPhone 13 (390x844, touch, coarse pointer) and desktop 1400x900. Script: `apps/web/e2e/parity.e2e.mjs`; how to run it: `docs/e2e/README.md`.",
    "",
    "Each case drives the page as a person would and asserts what the browser showed or what the fake kvmd RECEIVED. Headless Chrome has no notification centre, app badge or install dialog, so those are recorded at the API the page calls (`Notification`, `setAppBadge`) and by Chrome's own installability check.",
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed.`,
    "",
    "## Screenshots",
    "",
    ...shots.map((f) => `- [${f.replace(".png", "")}](parity/${f})`),
    "",
];
writeFileSync(`${dirname(outDir)}/${today}-parity${only ? `-${only}` : ""}.md`, md.join("\n"));
process.exit(report.failed.length ? 1 : 0);
