// Coming back to the console after it was backgrounded: the iPhone home-screen app switched away from
// or closed, a desktop tab switched back to, a page restored from the back/forward cache. Phone
// (iPhone 13) and desktop (1400x900), a real web host in front of tools/fake-kvmd.
//
// "Backgrounded" is built from what the platforms really do: CDP Page.setWebLifecycleState frozen /
// active (Chrome's own freeze: no timer, no event handler runs), `document.hidden` and
// visibilitychange / pageshow / focus / resume / online dispatched the way the page sees them, and the
// fake kvmd killing or silencing the stream and the event socket while the page cannot look. A case
// passes when the new picture is on screen within 3 s of coming back with exactly one new stream and
// one new event socket, nothing opened while hidden, and nothing left held on the target.
//
//   node apps/web/e2e/resume.e2e.mjs [phone|desktop] [--out docs/e2e/resume] [--before]
//
// See docs/e2e/README.md for how to bring the two servers up. The run writes its own section of
// docs/e2e/<date>-phone-feedback.md between the `resume` markers and leaves the other sections alone.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { WEB, FAKE, Report, fakeGet, fakePost, fakeReset, launch, puppeteer, sleep, touchSession } from "./harness.mjs";

const args = process.argv.slice(2);
const only = args.find((a) => a === "phone" || a === "desktop");
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e/resume";
mkdirSync(outDir, { recursive: true });

const report = new Report("Resume from the background");
const BACK_WITHIN_MS = 3000;

/* ---- the page: a controllable document.hidden, and the events a platform sends ---- */

const SPOOF = () => {
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    window.__vis = (h) => {
        hidden = h;
        document.dispatchEvent(new Event("visibilitychange"));
    };
    window.__events = (names) => {
        for (const name of names) {
            if (name === "visible") window.__vis(false);
            else if (name === "pageshow") window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
            else if (name === "focus") window.dispatchEvent(new Event("focus"));
            else if (name === "resume") document.dispatchEvent(new Event("resume"));
            else if (name === "online") window.dispatchEvent(new Event("online"));
        }
    };
};

async function open(browser, tag) {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => {
        if (!/janus\/ws|Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    await page.evaluateOnNewDocument(SPOOF);
    if (tag === "phone") await page.emulate(puppeteer.KnownDevices["iPhone 13"]);
    else await page.setViewport({ width: 1400, height: 900 });
    const cdp = await page.createCDPSession();
    await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
    await live(page);
    await sleep(800);
    return { page, cdp, logs };
}

const isLive = (page) =>
    page.evaluate(() => (document.querySelector(".kvm-dot")?.getAttribute("aria-label") ?? "") === "Live" || (document.querySelector(".kvm-status")?.textContent ?? "") === "Live");

const live = (page, timeout = 15000) =>
    page.waitForFunction(
        () => (document.querySelector(".kvm-dot")?.getAttribute("aria-label") ?? "") === "Live" || (document.querySelector(".kvm-status")?.textContent ?? "") === "Live",
        { timeout },
    );

/** The picture's pixels (the stream is a same-origin image), as one number. */
const frameSum = (page) =>
    page.evaluate(() => {
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

/* ---- what the fake kvmd saw ---- */

const streamOpens = async () => (await fakeGet("/__fake/requests")).requests.filter((r) => r.path === "/streamer/stream").length;
const socketOpens = async () => (await fakeGet("/__fake/state")).wsAuthUsers.length;
const census = async () => {
    const s = await fakeGet("/__fake/state");
    return { streams: s.streams, clients: s.clients, wsOpens: s.wsAuthUsers.length, streamOpens: await streamOpens(), keys: s.keysDown, buttons: s.buttonsDown };
};

/* ---- one trip to the background and back ---- */

/**
 * @param {object} o
 * @param {boolean} o.announceHidden  the page is told it is hidden before it is frozen (iOS often does not manage it)
 * @param {boolean} o.freeze          Chrome really freezes the page for the away time
 * @param {number} o.away             how long
 * @param {string[]} o.damage         what happens to the connections meanwhile: "streams", "ws", "stall"
 * @param {string[]} o.back           what the page is told on return, in order
 */
async function tripAndBack(page, cdp, o) {
    await fakePost("/__fake/picture?name=bars");
    await sleep(500);
    const before = await frameSum(page);
    const base = await census();
    if (o.announceHidden) await page.evaluate(() => window.__vis(true));
    if (o.freeze) await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    const damaged = [];
    for (const what of o.damage) {
        if (what === "stall") await fakePost("/__fake/stall");
        else await fakePost(`/__fake/drop?what=${what}`);
        damaged.push(what);
    }
    await fakePost("/__fake/picture?name=changed");
    // What opened while the page was away and could not have been told to.
    await sleep(o.away);
    const whileAway = await census();
    if (o.freeze) await cdp.send("Page.setWebLifecycleState", { state: "active" });
    const t0 = Date.now();
    await page.evaluate((names) => window.__events(names), o.back);
    let framesAfter = null;
    let sum = before;
    while (Date.now() - t0 < 8000) {
        sum = await frameSum(page).catch(() => before);
        if (sum !== before && sum > 0 && (await isLive(page))) {
            framesAfter = Date.now() - t0;
            break;
        }
        await sleep(100);
    }
    await sleep(1800); // anything that is going to open a second connection has done so by now
    const after = await census();
    return {
        before,
        sum,
        framesAfter,
        openedWhileAway: { streams: whileAway.streamOpens - base.streamOpens, sockets: whileAway.wsOpens - base.wsOpens },
        newStreams: after.streamOpens - whileAway.streamOpens,
        newSockets: after.wsOpens - whileAway.wsOpens,
        alive: { streams: after.streams, clients: after.clients },
        damaged,
    };
}

const fmt = (r) =>
    `frames ${r.framesAfter === null ? "never" : `${r.framesAfter} ms`} after return; new streams ${r.newStreams}, new sockets ${r.newSockets}; alive streams ${r.alive.streams}, sockets ${r.alive.clients}; opened while away ${r.openedWhileAway.streams}/${r.openedWhileAway.sockets}`;
const clean = (r) => r.framesAfter !== null && r.framesAfter <= BACK_WITHIN_MS && r.newStreams === 1 && r.newSockets === 1 && r.alive.streams === 1 && r.alive.clients === 1 && r.openedWhileAway.streams === 0 && r.openedWhileAway.sockets === 0;

async function check(profile, name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add(profile, name, observed, pass);
    } catch (error) {
        report.add(profile, name, `threw: ${error.message}`, false);
    }
}

const shot = (page, name) => page.screenshot({ path: `${outDir}/${name}.png` });

async function run(browser, profile, tag) {
    await fakeReset();
    const { page, cdp, logs } = await open(browser, tag);
    const first = await census();
    report.add(profile, "one stream and one event socket to begin with", `streams ${first.streams}, sockets ${first.clients}, opened ${first.streamOpens}/${first.wsOpens}`, first.streams === 1 && first.clients === 1);
    await shot(page, `${tag}-before`);
    await heldInput(page, profile, tag);

    // The platform said so, the page was frozen, everything on the wire was cut, five seconds later it is back.
    await check(profile, "app switched away 5 s: stream and socket cut meanwhile, screen back within 3 s", async () => {
        const r = await tripAndBack(page, cdp, { announceHidden: true, freeze: true, away: 5000, damage: ["all"], back: ["visible", "focus"] });
        await shot(page, `${tag}-back-5s`);
        return [clean(r), fmt(r)];
    });

    // iOS freezes the page first and the hidden event never comes: only the return is seen, and the
    // stream is a connection that reads open and carries nothing.
    await check(profile, "the hidden event never came: only the return, stream silent, socket cut, screen back within 3 s", async () => {
        const r = await tripAndBack(page, cdp, { announceHidden: false, freeze: true, away: 6000, damage: ["stall", "ws"], back: ["visible"] });
        return [clean(r), fmt(r)];
    });

    await check(profile, "back after only 1.5 s with the stream silent: screen back within 3 s", async () => {
        const r = await tripAndBack(page, cdp, { announceHidden: true, freeze: true, away: 1500, damage: ["stall"], back: ["visible"] });
        return [r.framesAfter !== null && r.framesAfter <= BACK_WITHIN_MS && r.newStreams === 1 && r.alive.streams === 1, fmt(r)];
    });

    await check(profile, "restored from the back/forward cache (pageshow, persisted): screen back within 3 s", async () => {
        const r = await tripAndBack(page, cdp, { announceHidden: false, freeze: true, away: 4000, damage: ["stall", "ws"], back: ["pageshow"] });
        return [clean(r), fmt(r)];
    });

    await check(profile, "only the window gaining focus after a freeze: screen back within 3 s", async () => {
        const r = await tripAndBack(page, cdp, { announceHidden: false, freeze: true, away: 4000, damage: ["stall", "ws"], back: ["focus"] });
        return [clean(r), fmt(r)];
    });

    await check(profile, "the page's resume event after a freeze: screen back within 3 s", async () => {
        const r = await tripAndBack(page, cdp, { announceHidden: false, freeze: true, away: 4000, damage: ["stall", "ws"], back: ["resume"] });
        return [clean(r), fmt(r)];
    });

    await check(profile, "network back (online) after a freeze: screen back within 3 s", async () => {
        const r = await tripAndBack(page, cdp, { announceHidden: false, freeze: true, away: 4000, damage: ["streams", "ws"], back: ["online"] });
        return [r.framesAfter !== null && r.framesAfter <= BACK_WITHIN_MS && r.newStreams >= 1 && r.alive.streams === 1 && r.alive.clients === 1, fmt(r)];
    });

    await check(profile, "visible, pageshow, focus and online at once make ONE new stream and ONE new socket", async () => {
        const r = await tripAndBack(page, cdp, { announceHidden: true, freeze: true, away: 4000, damage: ["all"], back: ["visible", "pageshow", "focus", "resume", "online"] });
        return [r.framesAfter !== null && r.framesAfter <= BACK_WITHIN_MS && r.newStreams === 1 && r.newSockets === 1 && r.alive.streams === 1 && r.alive.clients === 1, fmt(r)];
    });

    // A desktop tab switched away from keeps running (no freeze): its timers fire, and with the
    // connections cut it would reconnect over and over for nobody to see.
    await check(profile, "hidden and NOT frozen for 12 s with everything cut: nothing reconnects until it is shown again", async () => {
        const r = await tripAndBack(page, cdp, { announceHidden: true, freeze: false, away: 12000, damage: ["all"], back: ["visible"] });
        return [clean(r), fmt(r)];
    });

    // The screen is only ever the same picture when nothing was really wrong: a healthy short
    // switch must not tear down what works.
    await check(profile, "a short, healthy switch away and back (0.4 s) keeps the same stream", async () => {
        await fakePost("/__fake/picture?name=bars");
        await sleep(400);
        const base = await census();
        await page.evaluate(() => window.__vis(true));
        await sleep(400);
        await page.evaluate(() => window.__events(["visible", "focus"]));
        await sleep(2000);
        const after = await census();
        const ok = after.streamOpens === base.streamOpens && after.wsOpens === base.wsOpens && after.streams === 1 && (await isLive(page));
        return [ok, `stream opens ${base.streamOpens} -> ${after.streamOpens}, socket opens ${base.wsOpens} -> ${after.wsOpens}, alive ${after.streams}/${after.clients}, live ${await isLive(page)}`];
    });

    await heldThroughFreeze(page, profile, tag);

    // Chrome's freeze closes the event socket and says so on the console ("Page entered Back-Forward Cache"); that is the platform, not a page error.
    await check(profile, "no page errors", async () => {
        const errors = logs.filter((l) => l.startsWith("pageerror"));
        const other = [...new Set(logs.filter((l) => !l.startsWith("pageerror")).map((l) => l.replace(/^\w+: /, "").replace(/:\d+\//g, "/")))];
        return [errors.length === 0, `${errors.length} page errors; console: ${other.join(" | ") || "clean"}`];
    });
    await page.close();
}

/** Whatever is held on the target is let go when the page goes away, and the new socket is usable. */
async function heldInput(page, profile, tag) {
    await fakePost("/__fake/picture?name=bars");
    if (tag === "desktop") {
        await check(profile, "a key held when the page is hidden is let go on the target, and typing works after return", async () => {
            await page.evaluate(() => document.querySelector(".kvm-kbd")?.focus());
            await page.keyboard.down("Shift");
            await sleep(300);
            const held = (await fakeGet("/__fake/state")).keysDown;
            await page.evaluate(() => window.__vis(true));
            await sleep(500);
            const after = (await fakeGet("/__fake/state")).keysDown;
            await page.keyboard.up("Shift");
            await page.evaluate(() => window.__events(["visible"]));
            await live(page);
            await sleep(1500);
            await page.evaluate(() => document.querySelector(".kvm-kbd")?.focus());
            const mark = Math.max(0, ...(await fakeGet("/__fake/hid")).events.map((e) => e.seq));
            await page.keyboard.press("F7");
            await sleep(500);
            const typed = (await fakeGet(`/__fake/hid?since=${mark}`)).events.map((e) => `${e.event.key} ${e.event.state ? "down" : "up"}`);
            return [held.includes("ShiftLeft") && after.length === 0 && typed.includes("F7 down") && typed.includes("F7 up"), `held ${held.join(",") || "nothing"}; after hide ${after.join(",") || "nothing"}; typed after return ${typed.join(", ")}`];
        });
        await check(profile, "a mouse button held when the page is hidden is let go on the target", async () => {
            const box = await page.$eval('[data-testid="kvm-pane"]', (el) => {
                const r = el.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            });
            await page.mouse.move(box.x, box.y);
            await page.mouse.down();
            await sleep(300);
            const held = (await fakeGet("/__fake/state")).buttonsDown;
            await page.evaluate(() => window.__vis(true));
            await sleep(500);
            const after = (await fakeGet("/__fake/state")).buttonsDown;
            await page.mouse.up();
            await page.evaluate(() => window.__events(["visible"]));
            await sleep(800);
            return [held.includes("left") && after.length === 0, `held ${held.join(",") || "nothing"}; after hide ${after.join(",") || "nothing"}`];
        });
    } else {
        await check(profile, "a touch drag holding a button when the page is hidden is let go on the target", async () => {
            const touch = await touchSession(page);
            const box = await page.$eval('[data-testid="kvm-pane"]', (el) => {
                const r = el.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            });
            const id = await touch.start(box.x, box.y);
            await sleep(620);
            await touch.drag(id, [[box.x + 20, box.y + 6], [box.x + 40, box.y + 12]]);
            await sleep(200);
            const held = (await fakeGet("/__fake/state")).buttonsDown;
            await page.evaluate(() => window.__vis(true));
            await sleep(500);
            const after = (await fakeGet("/__fake/state")).buttonsDown;
            await touch.end(id);
            await page.evaluate(() => window.__events(["visible"]));
            await sleep(800);
            return [held.includes("left") && after.length === 0, `held ${held.join(",") || "nothing"}; after hide ${after.join(",") || "nothing"}`];
        });
    }
}

/** The release has to reach the target through a NEW socket when the one the page had was already dead as it left (the keyboard is the desktop's; the phone's dock keys are the same keyboard object). */
async function heldThroughFreeze(page, profile, tag) {
    if (tag !== "desktop") return;
    await check(profile, "a key held while the socket is down, page hidden meanwhile: released on the new socket after return", async () => {
        await page.evaluate(() => document.querySelector(".kvm-kbd")?.focus());
        await page.keyboard.down("Shift");
        await sleep(300);
        const held = (await fakeGet("/__fake/state")).keysDown;
        // The socket dies and the kvmd refuses new ones for 3 s; the page is hidden with the release unable to go anywhere.
        await fakePost("/__fake/drop?what=ws&refuse_ms=3000");
        await sleep(300);
        await page.evaluate(() => window.__vis(true));
        await sleep(3500);
        const meanwhile = (await fakeGet("/__fake/state")).keysDown;
        await page.evaluate(() => window.__events(["visible"]));
        await sleep(2500);
        const after = (await fakeGet("/__fake/state")).keysDown;
        await page.keyboard.up("Shift");
        return [held.includes("ShiftLeft") && meanwhile.includes("ShiftLeft") && after.length === 0, `held ${held.join(",") || "nothing"}; while the socket was down ${meanwhile.join(",") || "nothing"}; after return ${after.join(",") || "nothing"}`];
    });
}

const browser = await launch();
try {
    if (only !== "desktop") await run(browser, "iPhone 13", "phone");
    if (only !== "phone") await run(browser, "Desktop 1400x900", "desktop");
} finally {
    await browser.close();
}

// A run against the build from before the fix is evidence, not the report: its rows go beside it, the shared file is left alone.
if (args.includes("--before")) {
    const lines = report.rows.map((r) => `${r.pass ? "PASS" : "FAIL"} [${r.profile}] ${r.name}: ${r.observed}`);
    writeFileSync(`docs/e2e/resume/before-${only ?? "all"}.txt`, `${lines.join("\n")}\n`);
    process.exit(0);
}
if (args.includes("--dry")) process.exit(report.failed.length ? 1 : 0); // iterating on the script: no report written

/* ---- the report: this run's section of the shared phone-feedback file ---- */

/** The same script run against the build from before the fix (`--before`): what failed there, row by row. */
function beforeSection() {
    const out = [];
    for (const name of ["phone", "desktop"]) {
        const path = `docs/e2e/resume/before-${name}.txt`;
        if (!existsSync(path)) continue;
        const rows = readFileSync(path, "utf8").split("\n").filter((l) => /^(PASS|FAIL) /.test(l));
        const failing = rows.filter((l) => l.startsWith("FAIL "));
        out.push(`**Before the fix, ${name}** (\`before-${name}.txt\`, the same script against the build from 69ca5dd1): ${rows.length - failing.length} of ${rows.length} passed; the failing rows:`, "");
        for (const l of failing) out.push(`- ${l.replace(/^FAIL /, "").replace(/\|/g, "\\|").slice(0, 330)}`);
        out.push("");
    }
    return out;
}

const today = new Date().toISOString().slice(0, 10);
const file = `docs/e2e/${today}-phone-feedback.md`;
const BEGIN = "<!-- resume:begin -->";
const END = "<!-- resume:end -->";
const section = [
    BEGIN,
    "## Stream and socket resume after the app was backgrounded",
    "",
    `Host under test: \`node dist/web-server.js\` (${WEB}) in front of \`tools/fake-kvmd\` (${FAKE}). Script: \`apps/web/e2e/resume.e2e.mjs\`; how to run it: \`docs/e2e/README.md\`.`,
    "",
    "Headless Chrome, iPhone 13 and desktop 1400x900. \"Away\" is Chrome's own freeze (`Page.setWebLifecycleState` frozen/active: no timer or handler runs) with `document.hidden`, visibilitychange, pageshow, focus, resume and online delivered as a platform delivers them, and the fake kvmd cutting or silencing (`/__fake/drop?what=`, `/__fake/stall`) the stream and the event socket meanwhile. A pass is the new picture on screen within 3 s of return, exactly one new stream and one new socket (counted on the fake), nothing opened while hidden.",
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed.`,
    "",
    ...beforeSection(),
    END,
    "",
].join("\n");
const header = `# Phone feedback: E2E evidence (${today})\n\nOne section per change; each run rewrites only its own.\n\n`;
let doc = existsSync(file) ? readFileSync(file, "utf8") : header;
const from = doc.indexOf(BEGIN);
const to = doc.indexOf(END);
if (from >= 0 && to > from) doc = doc.slice(0, from) + section + doc.slice(to + END.length).replace(/^\n/, "");
else doc = `${doc.replace(/\n*$/, "\n\n")}${section}`;
writeFileSync(file, doc);
process.exit(report.failed.length ? 1 : 0);
