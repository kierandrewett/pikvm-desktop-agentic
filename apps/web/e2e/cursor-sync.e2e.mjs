// The shared cursor: a desktop page and a phone page open on the same host, one remote pointer for both.
//
//   node apps/web/e2e/cursor-sync.e2e.mjs [--out docs/e2e/cursor-sync] [--report docs/e2e/2026-11-03-cursor-sync.md]
//
// Two real Chrome pages on one web host in front of tools/fake-kvmd: a 1400x900 desktop page driven with the mouse, and
// an iPhone 13 page driven with raw CDP touch events on the trackpad. Each page records its own drawn cursor (the
// trackpad blob, and the marker for somebody else's pointer) on its own clock as it changes, so the numbers are what
// a person looking at the screen would have seen. The truth is what the fake kvmd received. See docs/e2e/README.md
// for how to bring the two servers up.

import { mkdirSync, writeFileSync } from "node:fs";
import { WEB, Report, fakeGet, fakeReset, launch, puppeteer, sleep, touchSession } from "./harness.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const outDir = flag("--out", "docs/e2e/cursor-sync");
const reportPath = flag("--report", "docs/e2e/2026-11-03-cursor-sync.md");
mkdirSync(outDir, { recursive: true });

const report = new Report("Shared cursor");
const DESK = "Desktop 1400x900";
const PHONE = "iPhone 13";
const TOLERANCE = 2; // px
const BUDGET = 200; // ms from the mover's last event to the other page's cursor being there

const normToFrac = (n) => (n + 32767) / 65534;
const fracToNorm = (f) => Math.max(-32768, Math.min(32767, Math.round(f * 65534) - 32767));

async function check(profile, name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add(profile, name, observed, pass);
    } catch (error) {
        report.add(profile, name, `threw: ${error.message}`, false);
    }
}

async function live(page) {
    await page.waitForFunction(
        () => (document.querySelector(".kvm-status")?.textContent ?? "") === "Live" || (document.querySelector(".kvm-dot")?.getAttribute("aria-label") ?? "") === "Live",
        { timeout: 15000 },
    );
    // The picture has to have a size before a point of it means anything.
    await page.waitForFunction(() => (document.querySelector(".kvm-img")?.naturalWidth ?? 0) > 0, { timeout: 15000 });
}

/** The picture's box in client pixels, letterboxed the way the page draws it, and the pane's origin. */
const geometry = (page) =>
    page.evaluate(() => {
        const pane = document.querySelector(".kvm-pane").getBoundingClientRect();
        const img = document.querySelector(".kvm-img");
        const r = img.getBoundingClientRect();
        const aspect = (img.naturalWidth || 16) / (img.naturalHeight || 9);
        let w;
        let h;
        let ox = 0;
        let oy = 0;
        if (r.width / r.height > aspect) {
            h = r.height;
            w = h * aspect;
            ox = (r.width - w) / 2;
        } else {
            w = r.width;
            h = w / aspect;
            oy = (r.height - h) / 2;
        }
        return { pane: { left: pane.left, top: pane.top }, box: { left: r.left + ox, top: r.top + oy, w, h } };
    });

/** Record every change to the two drawn cursors, stamped with the clock the runner shares. */
const record = (page) =>
    page.evaluate(() => {
        const pane = () => document.querySelector(".kvm-pane").getBoundingClientRect();
        const rec = { blob: [], marker: [] };
        window.__cursorRec = rec;
        const watch = (sel, into) => {
            const el = document.querySelector(sel);
            const note = () => {
                const p = pane();
                into.push({
                    t: Date.now(),
                    shown: getComputedStyle(el).display !== "none",
                    x: parseFloat(el.style.left) + p.left,
                    y: parseFloat(el.style.top) + p.top,
                });
            };
            new MutationObserver(note).observe(el, { attributes: true, attributeFilter: ["style"] });
        };
        watch(".kvm-cursor", rec.blob);
        watch(".kvm-remote-cursor", rec.marker);
    });

const samples = (page) => page.evaluate(() => ({ blob: window.__cursorRec.blob, marker: window.__cursorRec.marker }));
const now = (page, sel) =>
    page.evaluate((s) => {
        const el = document.querySelector(s);
        const p = document.querySelector(".kvm-pane").getBoundingClientRect();
        return { shown: getComputedStyle(el).display !== "none", x: parseFloat(el.style.left) + p.left, y: parseFloat(el.style.top) + p.top };
    }, sel);

const near = (s, ex, ey) => s.shown && Math.abs(s.x - ex) <= TOLERANCE && Math.abs(s.y - ey) <= TOLERANCE;

/** The last absolute move the fake received, and from which of its sockets. */
async function lastMove(from) {
    const { events } = await fakeGet("/__fake/hid");
    const moves = events.filter((e) => e.event_type === "mouse_move" && (from === undefined || from(e)));
    return moves.at(-1);
}
const allMoves = async () => (await fakeGet("/__fake/hid")).events.filter((e) => e.event_type === "mouse_move");

/** Wait for `sel`'s cursor to be at (ex, ey) on `page`, and say how long after `since` it first was. */
async function arrival(page, kind, ex, ey, since, timeout = 1500) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const s = (await samples(page))[kind];
        const hit = s.find((p) => p.t >= since && near(p, ex, ey));
        if (hit) return hit.t - since;
        if (Date.now() > deadline) return null;
        await sleep(10);
    }
}

const fmt = (n, d = 0) => (n === null ? "never" : n.toFixed(d));

// Two Chrome processes, so neither page is a background tab of the other (a hidden page holds no streams).
const browser = await launch();
const phoneBrowser = await launch();
try {
    const desk = await browser.newPage();
    await desk.setViewport({ width: 1400, height: 900 });
    await desk.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
    const phone = await phoneBrowser.newPage();
    await phone.emulate(puppeteer.KnownDevices["iPhone 13"]);
    await phone.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
    const errors = [];
    for (const [name, page] of [["desktop", desk], ["phone", phone]]) {
        page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
        page.on("console", (m) => m.type() === "error" && !/favicon|Failed to load resource|janus/.test(m.text()) && errors.push(`${name}: ${m.text()}`));
    }
    await fakeReset();
    await Promise.all([live(desk), live(phone)]);
    await sleep(400);
    await Promise.all([record(desk), record(phone)]);
    const touch = await touchSession(phone);

    let dg = await geometry(desk);
    let pg = await geometry(phone);
    const deskAt = (fx, fy) => [dg.box.left + fx * dg.box.w, dg.box.top + fy * dg.box.h];
    const phoneAtNorm = (nx, ny) => [pg.box.left + normToFrac(nx) * pg.box.w, pg.box.top + normToFrac(ny) * pg.box.h];
    const deskAtNorm = (nx, ny) => [dg.box.left + normToFrac(nx) * dg.box.w, dg.box.top + normToFrac(ny) * dg.box.h];

    /* ---- nothing known yet ---- */
    await check(PHONE, "before anything has moved the pointer the host knows of, the phone draws no pointer of somebody else's", async () => {
        const blob = await now(phone, ".kvm-cursor");
        const marker = await now(phone, ".kvm-remote-cursor");
        return [!marker.shown, `marker shown ${marker.shown} (the phone's own blob is its own: shown ${blob.shown})`];
    });

    /* ---- desktop mouse -> phone blob ---- */
    let deskClient;
    await check(PHONE, `the desktop's mouse moves over the picture: the phone's blob is at the matching point (within ${TOLERANCE} px) within ${BUDGET} ms`, async () => {
        const [x0, y0] = deskAt(0.1, 0.1);
        await desk.mouse.move(x0, y0);
        await sleep(150);
        const [x, y] = deskAt(0.3, 0.6);
        const t = Date.now();
        await desk.mouse.move(x, y, { steps: 8 });
        const move = await lastMove();
        deskClient = move.client;
        const [ex, ey] = phoneAtNorm(move.event.to.x, move.event.to.y);
        const ms = await arrival(phone, "blob", ex, ey, t);
        return [ms !== null && ms <= BUDGET, `kvmd got ${move.event.to.x},${move.event.to.y}; phone blob at ${fmt(ex, 1)},${fmt(ey, 1)} ${fmt(ms)} ms after the last mouse event`];
    });
    await check(PHONE, "it was the desktop that sent the moves: the phone sent none (nothing is echoed back to kvmd)", async () => {
        const fromOthers = (await allMoves()).filter((e) => e.client !== deskClient);
        return [fromOthers.length === 0, `${(await allMoves()).length} moves, ${fromOthers.length} from any other socket`];
    });
    await check(DESK, "the desktop does not draw a pointer of somebody else's for its own moves", async () => {
        const marker = await now(desk, ".kvm-remote-cursor");
        return [!marker.shown, `marker shown ${marker.shown}`];
    });
    await phone.screenshot({ path: `${outDir}/phone-follows-desktop.png` });

    /* ---- a burst: fast mouse, one cursor per frame ---- */
    await check(PHONE, "a fast mouse (90 moves at 8 ms) ends with the phone on the last point, within the budget, and about one update per frame", async () => {
        await sleep(600);
        const before = (await samples(phone)).blob.length;
        const path = Array.from({ length: 90 }, (_, i) => deskAt(0.2 + (0.6 * i) / 89, 0.25 + 0.5 * Math.abs(Math.sin(i / 14))));
        for (const [x, y] of path.slice(0, -1)) {
            await desk.mouse.move(x, y);
            await sleep(8);
        }
        const t = Date.now();
        await desk.mouse.move(...path.at(-1));
        const move = await lastMove();
        const [ex, ey] = phoneAtNorm(move.event.to.x, move.event.to.y);
        const ms = await arrival(phone, "blob", ex, ey, t);
        await sleep(100);
        const drawn = (await samples(phone)).blob.length - before;
        return [ms !== null && ms <= BUDGET && drawn <= 90 * 2, `last point ${fmt(ms)} ms after the last event; the blob was redrawn ${drawn} times for 90 moves over ${fmt(90 * 8 + 90 * 2)}+ ms`];
    });

    /* ---- phone trackpad -> desktop marker ---- */
    await sleep(700); // the desktop has been still for longer than the hold
    let phoneMove;
    await check(DESK, `a trackpad drag on the phone: the desktop's marker for somebody else's pointer is at the matching point (within ${TOLERANCE} px) within ${BUDGET} ms`, async () => {
        const start = [pg.box.left + pg.box.w * 0.5, pg.box.top + pg.box.h * 0.5];
        const id = await touch.start(...start);
        let last = start;
        for (let i = 1; i <= 24; i += 1) {
            last = [start[0] - i * 4, start[1] - i * 2];
            await touch.move(id, ...last);
            await sleep(16);
        }
        const t = Date.now();
        await touch.move(id, last[0] - 4, last[1] - 2);
        await touch.end(id);
        phoneMove = await lastMove((e) => e.client !== deskClient);
        const [ex, ey] = deskAtNorm(phoneMove.event.to.x, phoneMove.event.to.y);
        const ms = await arrival(desk, "marker", ex, ey, t);
        return [ms !== null && ms <= BUDGET, `kvmd got ${phoneMove.event.to.x},${phoneMove.event.to.y} from the phone; desktop marker at ${fmt(ex, 1)},${fmt(ey, 1)} ${fmt(ms)} ms after the last touch move`];
    });
    await desk.screenshot({ path: `${outDir}/desktop-shows-phone.png` });
    await check(DESK, "when the desktop's mouse moves again the marker goes, and the desktop is the one cursor", async () => {
        const [x, y] = deskAt(0.5, 0.5);
        await desk.mouse.move(x, y, { steps: 3 });
        await sleep(100);
        const marker = await now(desk, ".kvm-remote-cursor");
        return [!marker.shown, `marker shown ${marker.shown}`];
    });
    await check(PHONE, "and the phone's blob has followed the desktop back", async () => {
        const move = await lastMove();
        const [ex, ey] = phoneAtNorm(move.event.to.x, move.event.to.y);
        const ms = await arrival(phone, "blob", ex, ey, Date.now() - 400);
        return [ms !== null, `blob at ${fmt(ex, 1)},${fmt(ey, 1)}`];
    });
    await phone.screenshot({ path: `${outDir}/phone-follows-desktop-again.png` });

    /* ---- both at once ---- */
    await sleep(700);
    await check(`${DESK} + ${PHONE}`, "both moving at once: neither cursor jumps to the other's, and when both stop they agree", async () => {
        const before = { d: (await samples(desk)).marker.length, p: (await samples(phone)).blob.length };
        const startAt = Date.now();
        const start = [pg.box.left + pg.box.w * 0.3, pg.box.top + pg.box.h * 0.4];
        const id = await touch.start(...start);
        const finger = async () => {
            for (let i = 1; i <= 90; i += 1) {
                await touch.move(id, start[0] + i * 2.5, start[1] + Math.sin(i / 9) * 30);
                await sleep(16);
            }
        };
        let mouseEnd = 0;
        const mouse = async () => {
            for (let i = 0; i < 90; i += 1) {
                const [x, y] = deskAt(0.15 + 0.1 * Math.sin(i / 7), 0.2 + (0.6 * i) / 90);
                await desk.mouse.move(x, y);
                await sleep(16);
            }
        };
        await Promise.all([
            finger(),
            mouse().then(() => {
                mouseEnd = Date.now();
            }),
        ]);
        const endedAt = Date.now();
        await touch.end(id);
        await sleep(1300);
        const s = { d: await samples(desk), p: await samples(phone) };
        // While the desktop's mouse was at work its marker never showed; while the finger was down the phone's blob only
        // moved by the finger's own steps (a step is 2.5 px along, up to 30 px * 1/9 across: under 5 px).
        // The hold after the mouse's last move (500 ms) is still the mouse's: the phone's pointer waits for it.
        const markerOn = s.d.marker.filter((m) => m.t >= startAt && m.t <= mouseEnd + 450 && m.shown);
        const blob = s.p.blob.filter((b) => b.t >= startAt && b.t <= endedAt && b.shown);
        let biggest = 0;
        let reversals = 0;
        for (let i = 1; i < blob.length; i += 1) biggest = Math.max(biggest, Math.hypot(blob[i].x - blob[i - 1].x, blob[i].y - blob[i - 1].y));
        for (let i = 2; i < blob.length; i += 1) {
            const a = blob[i - 1].y - blob[i - 2].y;
            const b = blob[i].y - blob[i - 1].y;
            if (Math.abs(a) > 25 && Math.abs(b) > 25 && Math.sign(a) !== Math.sign(b)) reversals += 1;
        }
        const truth = await lastMove();
        const [px, py] = phoneAtNorm(truth.event.to.x, truth.event.to.y);
        const [dx, dy] = deskAtNorm(truth.event.to.x, truth.event.to.y);
        const fromDesk = truth.client === deskClient;
        const blobEnd = await now(phone, ".kvm-cursor");
        const markerEnd = await now(desk, ".kvm-remote-cursor");
        // Whoever wrote last owns the target's cursor: the other page shows it there; the writer shows its own.
        const agree = fromDesk ? near(blobEnd, px, py) && !markerEnd.shown : near(markerEnd, dx, dy) && near(blobEnd, px, py);
        return [
            markerOn.length === 0 && biggest < 40 && reversals === 0 && agree,
            `desktop marker shown in ${markerOn.length} of ${s.d.marker.length - before.d} changes while its mouse moved; the phone's blob moved at most ${fmt(biggest, 1)} px between two redraws with ${reversals} large reversals over ${blob.length} redraws; last write came from the ${fromDesk ? "desktop" : "phone"}; phone blob at ${fmt(blobEnd.x, 1)},${fmt(blobEnd.y, 1)} (truth ${fmt(px, 1)},${fmt(py, 1)}); desktop marker shown ${markerEnd.shown}${markerEnd.shown ? ` at ${fmt(markerEnd.x, 1)},${fmt(markerEnd.y, 1)} (truth ${fmt(dx, 1)},${fmt(dy, 1)})` : ""}`,
        ];
    });
    await check(`${DESK} + ${PHONE}`, "after a second more, the page that did not write last shows the cursor at the target's point and the other page is not moving", async () => {
        await sleep(900);
        const truth = await lastMove();
        const fromDesk = truth.client === deskClient;
        const [px, py] = phoneAtNorm(truth.event.to.x, truth.event.to.y);
        const [dx, dy] = deskAtNorm(truth.event.to.x, truth.event.to.y);
        const phoneBlob = await now(phone, ".kvm-cursor");
        const deskMarker = await now(desk, ".kvm-remote-cursor");
        const ok = fromDesk ? near(phoneBlob, px, py) : near(deskMarker, dx, dy) && near(phoneBlob, px, py);
        return [ok, `last writer: ${fromDesk ? "desktop" : "phone"}; phone blob ${fmt(phoneBlob.x, 1)},${fmt(phoneBlob.y, 1)} vs ${fmt(px, 1)},${fmt(py, 1)}; desktop marker shown ${deskMarker.shown}${deskMarker.shown ? ` at ${fmt(deskMarker.x, 1)},${fmt(deskMarker.y, 1)} vs ${fmt(dx, 1)},${fmt(dy, 1)}` : ""}`];
    });
    await phone.screenshot({ path: `${outDir}/phone-after-both.png` });
    await desk.screenshot({ path: `${outDir}/desktop-after-both.png` });

    /* ---- reload re-syncs ---- */
    await check(PHONE, "a reloaded phone draws the host's current position within 2 s of its picture being live", async () => {
        const [x, y] = deskAt(0.7, 0.35);
        await desk.mouse.move(x, y, { steps: 4 });
        await sleep(200);
        const truth = await lastMove();
        await phone.reload({ waitUntil: "load" });
        const t = Date.now();
        await live(phone);
        await record(phone);
        pg = await geometry(phone);
        const [ex, ey] = phoneAtNorm(truth.event.to.x, truth.event.to.y);
        // The record starts after the first draw can have happened: read the element itself too.
        const deadline = Date.now() + 2000;
        for (;;) {
            const b = await now(phone, ".kvm-cursor");
            if (near(b, ex, ey)) return [true, `blob at ${fmt(b.x, 1)},${fmt(b.y, 1)} (truth ${fmt(ex, 1)},${fmt(ey, 1)}) ${Date.now() - t} ms after the reload`];
            if (Date.now() > deadline) return [false, `blob ${JSON.stringify(b)} (truth ${fmt(ex, 1)},${fmt(ey, 1)})`];
            await sleep(25);
        }
    });
    await check(DESK, "a reloaded desktop draws the host's current position (it was put there by another client) as the marker", async () => {
        const start = [pg.box.left + pg.box.w * 0.5, pg.box.top + pg.box.h * 0.5];
        const t2 = await touchSession(phone);
        const id = await t2.start(...start);
        for (let i = 1; i <= 12; i += 1) {
            await t2.move(id, start[0] + i * 6, start[1] + i * 2);
            await sleep(16);
        }
        await t2.end(id);
        await sleep(300);
        const truth = await lastMove();
        await desk.reload({ waitUntil: "load" });
        await live(desk);
        await record(desk);
        dg = await geometry(desk);
        const [ex, ey] = deskAtNorm(truth.event.to.x, truth.event.to.y);
        const deadline = Date.now() + 2000;
        for (;;) {
            const m = await now(desk, ".kvm-remote-cursor");
            if (near(m, ex, ey)) return [true, `marker at ${fmt(m.x, 1)},${fmt(m.y, 1)} (truth ${fmt(ex, 1)},${fmt(ey, 1)})`];
            if (Date.now() > deadline) return [false, `marker ${JSON.stringify(m)} (truth ${fmt(ex, 1)},${fmt(ey, 1)})`];
            await sleep(25);
        }
    });
    await desk.screenshot({ path: `${outDir}/desktop-after-reload.png` });

    await check(`${DESK} + ${PHONE}`, "no page error or console error in either page", async () => [errors.length === 0, errors.length ? errors.join("; ") : "clean"]);
} finally {
    await browser.close();
    await phoneBrowser.close();
}

const stamp = new Date().toISOString().slice(0, 10);
const md = [
    `# E2E: the shared cursor (${stamp})`,
    "",
    `Host under test: \`node dist/web-server.js\` (${WEB}) in front of \`tools/fake-kvmd\`. Two real Chrome pages on it at once: a 1400x900 desktop page driven with the mouse, and an iPhone 13 page (touch, coarse pointer) driven with raw CDP touch events on the trackpad. Script: \`apps/web/e2e/cursor-sync.e2e.mjs\`; how to run it: \`docs/e2e/README.md\`.`,
    "",
    `Each page records every change to its drawn cursor (the trackpad blob, and the marker for somebody else's pointer) on the clock the runner shares; the truth is what the fake kvmd received. A point is "there" when the drawn hotspot is within ${TOLERANCE} px of the point the fake's last \`mouse_move\` names, mapped onto that page's own picture box. Latency is from the moving page's last input event to the first redraw of the other page at the point (an upper bound: the input is counted from just before it is sent).`,
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replaceAll("|", "/")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    "Screenshots: [the phone follows the desktop](cursor-sync/phone-follows-desktop.png), [the desktop shows the phone's pointer](cursor-sync/desktop-shows-phone.png), [the phone again after the desktop moves](cursor-sync/phone-follows-desktop-again.png), [both pages after both moved](cursor-sync/phone-after-both.png) and [desktop](cursor-sync/desktop-after-both.png), [the desktop after a reload](cursor-sync/desktop-after-reload.png).",
    "",
].join("\n");
writeFileSync(reportPath, md);
console.log(report.failed.length ? `${report.failed.length} FAILED` : "all passed");
process.exit(report.failed.length ? 1 : 0);
