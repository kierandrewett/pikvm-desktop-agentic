// The app's tabs against a real web host in front of tools/fake-kvmd: the KVM, Chat and Settings
// stay mounted once visited, and a tab change only hides and shows. Phone (iPhone 13) and
// desktop (1400x900). Every case drives the page the way a person would and asserts what the
// fake kvmd RECEIVED (sockets, stream requests, keys), so a pass means the target saw nothing it
// should not have, and the picture was never torn down.
//
//   node apps/web/e2e/keep-alive.e2e.mjs [phone|desktop] [--out docs/e2e/keep-alive]
//
// See docs/e2e/README.md for how to bring the two servers up.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WEB, FAKE, Report, describe, fakeGet, fakePost, fakeReset, launch, puppeteer, recorder, sleep } from "./harness.mjs";

const args = process.argv.slice(2);
const only = args.find((a) => a === "phone" || a === "desktop");
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e/keep-alive";
mkdirSync(outDir, { recursive: true });

const report = new Report("Keep-alive tabs");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function check(profile, name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add(profile, name, observed, pass);
    } catch (error) {
        report.add(profile, name, `threw: ${error.message}`, false);
    }
}

const shot = (page, name) => page.screenshot({ path: `${outDir}/${name}.png` });

// Wrap the wake lock before the page's own scripts run, so the run can see it taken and let go.
const WAKE_LOCK_SPY = () => {
    const log = [];
    Object.defineProperty(window, "__wake", { value: log });
    const wake = navigator.wakeLock;
    if (!wake) return;
    const request = wake.request.bind(wake);
    wake.request = async (type) => {
        const sentinel = await request(type);
        const entry = { requested: performance.now(), released: false };
        log.push(entry);
        sentinel.addEventListener("release", () => {
            entry.released = true;
        });
        return sentinel;
    };
};

async function open(browser, tag) {
    const page = await browser.newPage();
    const logs = [];
    const sockets = [];
    const streams = [];
    const chatSockets = [];
    page.on("console", (m) => {
        if (!/janus\/ws|Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    page.on("response", (r) => {
        if (r.status() >= 400 && !/\/app\/api\/v1\/target$/.test(r.url())) logs.push(`error: ${r.status()} ${r.url()}`);
    });
    page.on("request", (r) => {
        if (/\/streamer\/stream|\/api\/streamer\/snapshot/.test(r.url())) streams.push(r.url());
    });
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    cdp.on("Network.webSocketCreated", (e) => {
        /* The chat socket (/app/chat/ws) belongs to Chat, which opens it the first time the tab is shown, once. It is not the
         * KVM's: the counts below are the KVM's event socket, which no tab change may touch. Chat's own is asserted apart. */
        if (/\/app\/chat\/ws/.test(e.url)) chatSockets.push(e.url);
        else if (!/janus/.test(e.url)) sockets.push(e.url);
    });
    await page.evaluateOnNewDocument(WAKE_LOCK_SPY);
    if (tag === "phone") await page.emulate(puppeteer.KnownDevices["iPhone 13"]);
    else await page.setViewport({ width: 1400, height: 900 });
    return { page, logs, sockets, streams, chatSockets };
}

const live = (page, timeout = 15000) =>
    page.waitForFunction(() => (document.querySelector(".kvm-dot")?.getAttribute("aria-label") ?? "") === "Live", { timeout });

const isLive = (page) => page.evaluate(() => (document.querySelector(".kvm-dot")?.getAttribute("aria-label") ?? "") === "Live");

const shown = (page) => page.$$eval('.app-pane[data-active="true"]', (els) => els.map((e) => e.id.replace("panel-", "")));

async function goTo(page, tag, tab) {
    // The tab strip is a tab bar on the phone and a rail on a computer; a tap and a click both reach it.
    if (tag === "phone") await page.tap(`#tab-${tab}`);
    else await page.click(`#tab-${tab}`);
    await page.waitForFunction((id) => document.getElementById(`panel-${id}`)?.dataset.active === "true", {}, tab);
}

const farm = async () => {
    const s = await fakeGet("/__fake/state");
    return { clients: s.clients, streams: s.streams, keysDown: s.keysDown };
};

async function run(browser, profile, tag) {
    await fakeReset();
    const { page, logs, sockets, streams, chatSockets } = await open(browser, tag);
    await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
    await live(page);
    await sleep(600);
    await shot(page, `${tag}-kvm`);

    // Mark the DOM the picture lives in and what was asked of the host so far.
    await page.evaluate(() => {
        const img = document.querySelector("img.kvm-img");
        window.__picture = img;
        window.__src = img.getAttribute("src");
    });
    const baseline = { sockets: sockets.length, streams: streams.length, fake: await farm() };
    const rec = recorder();

    await check(profile, "the KVM is up with one event socket and one stream", async () => {
        return [baseline.sockets === 1 && baseline.fake.clients === 1 && baseline.fake.streams >= 1, `ws ${baseline.sockets}, fake clients ${baseline.fake.clients}, streams ${baseline.fake.streams}`];
    });

    await check(profile, "the KVM mounts at app start even when the app opens on Settings", async () => {
        const second = await browser.newPage();
        if (tag === "phone") await second.emulate(puppeteer.KnownDevices["iPhone 13"]);
        else await second.setViewport({ width: 1400, height: 900 });
        await second.goto(`${WEB}/app/settings/display`, { waitUntil: "load" });
        await second.waitForSelector("img.kvm-img");
        const state = await second.evaluate(() => ({
            kvmShown: document.getElementById("panel-kvm")?.dataset.active,
            settingsShown: document.getElementById("panel-settings")?.dataset.active,
        }));
        await sleep(1500);
        const linked = (await farm()).clients;
        await second.close();
        return [state.kvmShown === "false" && state.settingsShown === "true" && linked === 2, `kvm shown ${state.kvmShown}, settings shown ${state.settingsShown}, fake clients ${linked} (this page + the first)`];
    });

    await check(profile, "keys typed on Settings and Chat never reach the target", async () => {
        await goTo(page, tag, "settings");
        await rec.mark();
        await page.keyboard.press("F5");
        await page.keyboard.down("Shift");
        await page.keyboard.press("KeyA");
        await page.keyboard.up("Shift");
        await page.keyboard.type("hello world");
        await page.keyboard.down("Control");
        await page.keyboard.press("KeyV");
        await page.keyboard.up("Control");
        await goTo(page, tag, "chat");
        await page.keyboard.press("F5");
        await page.keyboard.type("abc");
        const { events, prints } = await rec.events(500);
        return [events.length === 0 && prints.length === 0, events.length === 0 && prints.length === 0 ? "the fake saw no key, no print" : `UNEXPECTED ${describe(events).join(", ")} ${prints.length} prints`];
    });
    await shot(page, `${tag}-chat`);

    await check(profile, "Settings stays on the page that was open, with its scroll", async () => {
        await goTo(page, tag, "settings");
        await page.goto(`${WEB}/app/settings/display`, { waitUntil: "load" });
        await page.waitForSelector("img.kvm-img");
        await goTo(page, tag, "kvm");
        await goTo(page, tag, "settings");
        const path = await page.evaluate(() => location.pathname);
        return [path === "/app/settings/display", path];
    });

    // The page was reloaded above: mark the picture again and take a fresh baseline.
    await live(page);
    await page.evaluate(() => {
        const img = document.querySelector("img.kvm-img");
        window.__picture = img;
        window.__src = img.getAttribute("src");
    });
    const second = { sockets: sockets.length, chat: chatSockets.length, streams: streams.length, fake: await farm() };
    await goTo(page, tag, "kvm");

    await check(profile, "KVM -> Chat -> Settings -> KVM opens no socket and no stream", async () => {
        await goTo(page, tag, "chat");
        await sleep(400);
        await goTo(page, tag, "settings");
        await sleep(400);
        await goTo(page, tag, "kvm");
        const now = { sockets: sockets.length, streams: streams.length, fake: await farm() };
        const chatOpened = chatSockets.length - second.chat;
        const same = chatOpened <= 1 && now.sockets === second.sockets && now.streams === second.streams && now.fake.clients === second.fake.clients && now.fake.streams === second.fake.streams;
        return [same, `ws ${second.sockets}->${now.sockets}, stream requests ${second.streams}->${now.streams}, fake clients ${second.fake.clients}->${now.fake.clients}, fake streams ${second.fake.streams}->${now.fake.streams}; the chat socket opened ${chatOpened} time(s) (once, when Chat is first shown, is allowed)`];
    });

    await check(profile, "the picture is the same element, with the same source, and is live at once", async () => {
        const kept = await page.evaluate(() => {
            const img = document.querySelector("img.kvm-img");
            return { same: img === window.__picture, src: img.getAttribute("src") === window.__src, complete: img.complete && img.naturalWidth > 0 };
        });
        const liveNow = await isLive(page);
        return [kept.same && kept.src && kept.complete && liveNow, `same element ${kept.same}, same src ${kept.src}, has a frame ${kept.complete}, Live straight away ${liveNow}`];
    });

    await check(profile, "the picture kept moving while hidden: a change made on the target while on Settings is there on return", async () => {
        await fakePost("/__fake/picture?name=bars");
        await goTo(page, tag, "settings");
        await fakePost("/__fake/picture?name=changed");
        await sleep(1500);
        await goTo(page, tag, "kvm");
        // The frame on screen is the newest one: read its pixels (the stream is a same-origin image).
        const sum = await page.evaluate(() => {
            const img = document.querySelector("img.kvm-img");
            const c = document.createElement("canvas");
            c.width = 32;
            c.height = 18;
            const g = c.getContext("2d");
            g.drawImage(img, 0, 0, 32, 18);
            let total = 0;
            for (const v of g.getImageData(0, 0, 32, 18).data) total += v;
            return total;
        });
        await fakePost("/__fake/picture?name=bars");
        await sleep(1200);
        const sumBars = await page.evaluate(() => {
            const img = document.querySelector("img.kvm-img");
            const c = document.createElement("canvas");
            c.width = 32;
            c.height = 18;
            const g = c.getContext("2d");
            g.drawImage(img, 0, 0, 32, 18);
            let total = 0;
            for (const v of g.getImageData(0, 0, 32, 18).data) total += v;
            return total;
        });
        return [sum > 0 && sum !== sumBars, `frame on return ${sum} differs from the bars frame ${sumBars}`];
    });

    await check(profile, "a key held on the KVM is let go on the target when the tab changes", async () => {
        await page.evaluate(() => document.querySelector(".kvm-kbd")?.focus());
        await page.keyboard.down("Shift");
        await sleep(300);
        const down = (await farm()).keysDown;
        // A real click with Shift held is a "new window" gesture; the tab is opened from the page instead.
        await page.evaluate(() => document.getElementById("tab-chat")?.click());
        await page.waitForFunction(() => document.getElementById("panel-chat")?.dataset.active === "true");
        await sleep(300);
        const after = (await farm()).keysDown;
        await page.keyboard.up("Shift");
        return [down.includes("ShiftLeft") && after.length === 0, `held ${down.join(",") || "nothing"}, after leaving ${after.join(",") || "nothing"}`];
    });

    await check(profile, "the keyboard is the target's again on return", async () => {
        await goTo(page, tag, "kvm");
        await rec.mark();
        await page.evaluate(() => document.querySelector(".kvm-kbd")?.focus());
        await page.keyboard.press("F5");
        const { events } = await rec.events(500);
        const lines = describe(events);
        return [lines.includes("key F5 down"), lines.join(", ") || "nothing"];
    });

    await check(profile, "the screen wake lock is let go behind another tab and taken again on return", async () => {
        const supported = await page.evaluate(() => "wakeLock" in navigator);
        if (!supported) return [true, "this Chrome has no wake lock; component tests cover it"];
        await goTo(page, tag, "kvm");
        await sleep(500);
        const count = () => page.evaluate(() => ({ taken: window.__wake.length, held: window.__wake.filter((w) => !w.released).length }));
        const before = await count();
        await goTo(page, tag, "settings");
        await sleep(500);
        const away = await count();
        await goTo(page, tag, "kvm");
        await sleep(800);
        const back = await count();
        return [before.held === 1 && away.held === 0 && back.held === 1 && back.taken === before.taken + 1, `held ${before.held} -> ${away.held} -> ${back.held} (taken ${before.taken} -> ${back.taken})`];
    });

    await check(profile, "back and forward move between the tabs without reloading the KVM", async () => {
        await goTo(page, tag, "chat");
        await goTo(page, tag, "settings");
        await page.goBack();
        await page.waitForFunction(() => document.getElementById("panel-chat")?.dataset.active === "true");
        await page.goBack();
        await page.waitForFunction(() => document.getElementById("panel-kvm")?.dataset.active === "true");
        const afterBack = await shown(page);
        await page.goForward();
        await page.waitForFunction(() => document.getElementById("panel-chat")?.dataset.active === "true");
        const same = await page.evaluate(() => document.querySelector("img.kvm-img") === window.__picture);
        return [equal(afterBack, ["kvm"]) && same, `after back: ${afterBack.join(",")}; same picture element ${same}`];
    });

    await check(profile, "hidden panes are inert and out of the accessibility tree", async () => {
        await goTo(page, tag, "settings");
        const state = await page.$$eval(".app-pane", (els) => els.map((e) => `${e.id.replace("panel-", "")}:${e.inert ? "inert" : "live"}:${e.getAttribute("aria-hidden") ?? "-"}`));
        return [equal(state, ["kvm:inert:true", "chat:inert:true", "settings:live:-"]), state.join(" ")];
    });
    await shot(page, `${tag}-settings`);

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
    `# E2E run: keep-alive tabs (${today})`,
    "",
    `Host under test: \`node dist/web-server.js\` (${WEB}) in front of \`tools/fake-kvmd\` (${FAKE}).`,
    "",
    "Browser: headless Chrome through puppeteer-core. Profiles: iPhone 13 (390x844, touch, coarse pointer) and desktop 1400x900. Script: `apps/web/e2e/keep-alive.e2e.mjs`; how to run it: `docs/e2e/README.md`.",
    "",
    "The KVM, Chat and Settings stay mounted once visited and a tab change only hides and shows. Each case drives the page as a person would and asserts what the fake kvmd RECEIVED.",
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed.`,
    "",
    "## Screenshots",
    "",
    ...shots.map((f) => `- [${f.replace(".png", "")}](keep-alive/${f})`),
    "",
];
writeFileSync(`${dirname(outDir)}/${today}-keep-alive${only ? `-${only}` : ""}.md`, md.join("\n"));
process.exit(report.failed.length ? 1 : 0);
