// The trackpad lens (the magnifier above the cursor): on while one finger is down and moving slowly,
// off when it speeds up or lifts; one fixed size, one fixed place relative to the cursor. Phone (iPhone 13,
// portrait and landscape) with raw CDP touch events, and the desktop mouse, which has no lens.
//
//   node apps/web/e2e/lens.e2e.mjs [--out docs/e2e/phone-feedback] [--section FILE]
//
// The page records two streams on its own clock: one sample per animation frame (is the lens on, its box,
// the cursor's centre) and every pointermove. The run reads the finger's speed off the pointermoves and lines
// the two up, so the numbers are what a person's eye would have seen, not what this script meant to send.
// See docs/e2e/README.md for how to bring the two servers up.

import { mkdirSync, writeFileSync } from "node:fs";
import { WEB, Report, fakeReset, launch, line, puppeteer, sleep, touchSession } from "./harness.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const outDir = flag("--out", "docs/e2e/phone-feedback");
const sectionPath = flag("--section", "");
mkdirSync(outDir, { recursive: true });

const report = new Report("Trackpad lens");
const profile = "iPhone 13";

/** The numbers in packages/kvm-engine/src/view/lens.ts, which the page bundle does not expose. */
const SHOW = 300; // px/s under which it shows
const HIDE = 420; // px/s over which it hides
const SIZE = 96;
const OFFSET = SIZE / 2 + 24; // centre above the cursor

async function check(name, fn, as = profile) {
    try {
        const [pass, observed] = await fn();
        report.add(as, name, observed, pass);
    } catch (error) {
        report.add(as, name, `threw: ${error.message}`, false);
    }
}

async function live(page) {
    await page.waitForFunction(
        () => (document.querySelector(".kvm-status")?.textContent ?? "") === "Live" || (document.querySelector(".kvm-dot")?.getAttribute("aria-label") ?? "") === "Live",
        { timeout: 15000 },
    );
}

/** Start the in-page recorders. Everything is stamped with the page's own clock (event.timeStamp for pointers). */
async function record(page) {
    await page.evaluate(() => {
        const lens = document.querySelector(".kvm-lens");
        const cursor = document.querySelector(".kvm-cursor");
        const rec = { frames: [], touches: [], running: true };
        window.__lensRec = rec;
        const tick = () => {
            if (!rec.running) return;
            const l = lens.getBoundingClientRect();
            const c = cursor.getBoundingClientRect();
            rec.frames.push({
                t: performance.now(),
                on: lens.classList.contains("on"),
                w: l.width,
                h: l.height,
                lx: l.x + l.width / 2,
                ly: l.y + l.height / 2,
                cx: c.x + c.width / 2,
                cy: c.y + c.height / 2,
            });
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        const note = (e, start) => {
            if (e.pointerType === "touch") rec.touches.push({ t: e.timeStamp, x: e.clientX, y: e.clientY, start });
        };
        document.addEventListener("pointermove", (e) => note(e, false), { capture: true, passive: true });
        document.addEventListener("pointerdown", (e) => note(e, true), { capture: true, passive: true });
        document.addEventListener("pointerup", (e) => rec.touches.push({ t: e.timeStamp, up: true }), { capture: true, passive: true });
    });
}

const collect = (page) =>
    page.evaluate(() => {
        window.__lensRec.running = false;
        return { frames: window.__lensRec.frames, touches: window.__lensRec.touches };
    });

/**
 * Drive one finger along `legs`, each `{ dx, dy, from, to, ms }`: it travels in the (dx, dy) direction at a speed
 * that goes linearly from `from` to `to` px/s over `ms`. Position advances by the REAL time between sends.
 */
async function drive(touch, id, at, legs) {
    let [x, y] = at;
    for (const leg of legs) {
        const norm = Math.hypot(leg.dx, leg.dy);
        const t0 = performance.now();
        let last = t0;
        for (;;) {
            const now = performance.now();
            const into = now - t0;
            if (into >= leg.ms) break;
            const speed = leg.from + ((leg.to - leg.from) * into) / leg.ms;
            const step = (speed * (now - last)) / 1000;
            x += (leg.dx / norm) * step;
            y += (leg.dy / norm) * step;
            last = now;
            await touch.move(id, x, y);
            await sleep(12);
        }
    }
    return [x, y];
}

/** The finger's speed at time `t`, over the pointermoves of the 120 ms before. */
function fingerSpeed(touches, t, window = 120) {
    const recent = touches.filter((p) => !p.start && !p.up && p.t <= t && p.t > t - window);
    if (recent.length < 2) return 0;
    let path = 0;
    for (let i = 1; i < recent.length; i++) path += Math.hypot(recent[i].x - recent[i - 1].x, recent[i].y - recent[i - 1].y);
    return (path / (recent.at(-1).t - recent[0].t)) * 1000;
}

const fmt = (n, d = 1) => (n === null || n === undefined || Number.isNaN(n) ? "-" : n.toFixed(d));
const changes = (frames) => frames.slice(1).filter((f, i) => f.on !== frames[i].on).length;

async function open(browser, device) {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => {
        if (!/janus\/ws/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    await page.emulate(puppeteer.KnownDevices[device]);
    await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
    await live(page);
    await sleep(600);
    return { page, logs };
}

const paneCentre = (page) =>
    page.$eval('[data-testid="kvm-pane"]', (el) => {
        const r = el.getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, top: r.y, w: r.width, h: r.height };
    });

async function phone(browser) {
    await fakeReset();
    const { page, logs } = await open(browser, "iPhone 13");
    const touch = await touchSession(page);
    const pane = await paneCentre(page);
    const { cx, cy } = pane;
    const shot = (name) => page.screenshot({ path: `${outDir}/lens-${name}.png` });
    const lensOn = () => page.$eval(".kvm-lens", (el) => el.classList.contains("on"));

    /* ---- one long gesture: slow, speeding up, fast, slowing down, slow again, lift ---- */
    await record(page);
    const start = [cx - 100, cy - 150];
    const id = await touch.start(...start);
    await sleep(50);
    const legs = [
        { name: "slow", dx: 1, dy: 0, from: 40, to: 40, ms: 1100 },
        { name: "speeding up", dx: 0, dy: 1, from: 40, to: 560, ms: 1000 },
        { name: "fast", dx: 1, dy: 0, from: 560, to: 560, ms: 450 },
        { name: "slowing down", dx: 0, dy: -1, from: 560, to: 40, ms: 1000 },
        { name: "slow again", dx: -1, dy: 0, from: 40, to: 40, ms: 900 },
    ];
    const marks = [];
    let pos = start;
    for (const leg of legs) {
        const from = await page.evaluate(() => performance.now());
        pos = await drive(touch, id, pos, [leg]);
        marks.push({ name: leg.name, from, to: await page.evaluate(() => performance.now()) });
    }
    await touch.end(id);
    await sleep(500);
    const rec = await collect(page);
    const touchAt = rec.touches[0].t;
    const liftAt = rec.touches.find((p) => p.up).t;
    const series = rec.frames.map((f) => ({ ...f, speed: fingerSpeed(rec.touches, f.t) }));
    const during = (name) => {
        const m = marks.find((x) => x.name === name);
        return series.filter((s) => s.t >= m.from && s.t <= m.to);
    };
    const onFrames = series.filter((s) => s.on);

    await check("slow finger: the lens is there at once, no hold: within a frame or two of the finger leaving its touch point by 4 px, and not before", async () => {
        const away = rec.touches.find((p) => !p.start && !p.up && Math.hypot(p.x - start[0], p.y - start[1]) > 4);
        const firstOn = series.find((s) => s.on);
        const delay = firstOn.t - away.t;
        const before = series.filter((s) => s.on && s.t < away.t).length;
        return [delay >= 0 && delay < 70 && before === 0, `finger past 4 px at +${fmt(away.t - touchAt)} ms of the touch; lens first on ${fmt(delay)} ms later; on before that: ${before} frames`];
    });

    await check("slow finger: the lens stays on for the whole slow stretch", async () => {
        const slow = during("slow").filter((s) => s.t > marks[0].from + 250);
        return [slow.every((s) => s.on), `${slow.length} frames at ${fmt(Math.min(...slow.map((s) => s.speed)), 0)}-${fmt(Math.max(...slow.map((s) => s.speed)), 0)} px/s, on in ${slow.filter((s) => s.on).length}`];
    });

    await check("speeding up: it goes off once, between the show and the hide speed, and stays off", async () => {
        const up = during("speeding up");
        const off = up.find((s) => !s.on && s.t > up[0].t + 100);
        const stays = series.filter((s) => s.t >= off.t && s.t <= marks[3].from).every((s) => !s.on);
        return [changes(up) === 1 && stays && off.speed > SHOW - 80 && off.speed < HIDE + 80, `went off at ${fmt(off.speed, 0)} px/s of finger speed (show under ${SHOW}, hide over ${HIDE}); on/off changes ${changes(up)}; off for the rest of the fast stretch: ${stays}`];
    });

    await check("fast finger: never on, from its first fast frame", async () => {
        const fast = during("fast").filter((s) => s.speed > HIDE + 60);
        const any = fast.filter((s) => s.on);
        return [fast.length > 10 && any.length === 0, `${fast.length} frames at up to ${fmt(Math.max(...fast.map((s) => s.speed)), 0)} px/s: on in ${any.length}`];
    });

    await check("slowing down: back on once, under the show speed, and stays on", async () => {
        const down = during("slowing down");
        const on = down.find((s) => s.on);
        const stays = series.filter((s) => s.t >= on.t && s.t <= liftAt).every((s) => s.on);
        return [changes(down) === 1 && stays && on.speed < SHOW + 60, `back on at ${fmt(on.speed, 0)} px/s; on/off changes ${changes(down)}; on from there to the lift: ${stays}`];
    });

    await check("one fixed size: 96 x 96 on every frame it is on, however fast the finger", async () => {
        const sizes = new Set(onFrames.map((s) => `${Math.round(s.w)}x${Math.round(s.h)}`));
        return [sizes.size === 1 && sizes.has(`${SIZE}x${SIZE}`), `${onFrames.length} frames on, sizes ${[...sizes].join(", ")}`];
    });

    await check("one fixed place: centred on the cursor sideways and 72 px above it on every frame, and it never jumps", async () => {
        // Sideways the lens follows the cursor but is held inside the pane (SIZE / 2 from either edge).
        const dx = onFrames.map((s) => s.lx - Math.max(SIZE / 2, Math.min(pane.w - SIZE / 2, s.cx)));
        const dy = onFrames.map((s) => s.ly - s.cy);
        const worst = Math.max(...dx.map(Math.abs), ...dy.map((v) => Math.abs(v + OFFSET)));
        return [worst <= 1.5, `${onFrames.length} frames: x offset from the (pane-held) cursor ${fmt(Math.min(...dx))}..${fmt(Math.max(...dx))}, y offset ${fmt(Math.min(...dy))}..${fmt(Math.max(...dy))} (expected 0 and -${OFFSET}); worst deviation ${fmt(worst, 2)} px`];
    });

    await check("the lift hides it on the next frame: no linger", async () => {
        const after = series.filter((s) => s.t >= liftAt);
        const firstOff = after.find((s) => !s.on);
        const delay = firstOff.t - liftAt;
        return [delay < 70 && after.filter((s) => s.t > firstOff.t).every((s) => !s.on), `off ${fmt(delay)} ms after the pointerup; off for the ${fmt(series.at(-1).t - firstOff.t, 0)} ms after that`];
    });

    // The trace itself, 150 ms apart, for the record.
    const rows = [];
    for (let t = touchAt; t < liftAt + 300; t += 150) {
        const s = series.find((f) => f.t >= t);
        if (!s) break;
        const leg = marks.find((m) => s.t >= m.from && s.t <= m.to)?.name ?? (s.t > liftAt ? "lifted" : "");
        rows.push(`| ${fmt((s.t - touchAt) / 1000, 2)} | ${leg} | ${fmt(s.speed, 0)} | ${s.on ? "on" : "off"} | ${s.on ? `${fmt(s.lx - s.cx, 0)}, ${fmt(s.ly - s.cy, 0)}` : "-"} |`);
    }
    const table = ["| t (s) | leg | finger px/s | lens | lens centre vs cursor (x, y) |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");

    /* ---- hysteresis: a finger holding in the band between the two speeds keeps what it had ---- */
    const band = async (before) => {
        await record(page);
        const bid = await touch.start(cx - 60, cy - 150);
        await sleep(40);
        const first = before === "slow" ? { dx: 1, dy: 0, from: 40, to: 40, ms: 700 } : { dx: 1, dy: 0, from: 600, to: 600, ms: 350 };
        const p = await drive(touch, bid, [cx - 60, cy - 150], [first]);
        const mark = await page.evaluate(() => performance.now());
        // then down the screen at a steady 360 px/s, the band between the two speeds
        await drive(touch, bid, p, [{ dx: 0, dy: 1, from: 360, to: 360, ms: 700 }]);
        const r = await collect(page);
        await touch.end(bid);
        await sleep(300);
        const inBand = r.frames.filter((f) => f.t > mark + 250).map((f) => ({ ...f, speed: fingerSpeed(r.touches, f.t) }));
        return { inBand, speeds: inBand.map((f) => f.speed) };
    };
    await check("hysteresis: held at 360 px/s (between show and hide) after a slow stretch it stays on, after a fast one it stays off", async () => {
        const fromSlow = await band("slow");
        const fromFast = await band("fast");
        const a = fromSlow.inBand.every((f) => f.on);
        const b = fromFast.inBand.every((f) => !f.on);
        const range = (x) => `${fmt(Math.min(...x.speeds), 0)}-${fmt(Math.max(...x.speeds), 0)}`;
        return [a && b && fromSlow.inBand.length > 10 && fromFast.inBand.length > 10, `after slow, ${fromSlow.inBand.length} frames at ${range(fromSlow)} px/s: on in ${fromSlow.inBand.filter((f) => f.on).length}; after fast, ${fromFast.inBand.length} frames at ${range(fromFast)} px/s: on in ${fromFast.inBand.filter((f) => f.on).length}`];
    });

    /* ---- screenshots ---- */
    // Bring the cursor back to the middle of the picture with one quick flick, so the lens is in frame.
    const recentre = async () => {
        const at = await page.$eval(".kvm-cursor", (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        const fx = (cx - at.x) / 0.9; // the cursor travels 0.9 of the finger's distance
        const fy = (cy - at.y) / 0.9;
        const rid = await touch.start(cx - fx / 2, cy - fy / 2 + 150);
        await touch.drag(rid, line([cx - fx / 2, cy - fy / 2 + 150], [cx + fx / 2, cy + fy / 2 + 150], 8), 16);
        await touch.end(rid);
        await sleep(400);
    };
    const holdAt = async (name, leg) => {
        await recentre();
        const sid = await touch.start(cx - 100, cy - 100);
        await sleep(40);
        await drive(touch, sid, [cx - 100, cy - 100], [leg]);
        const on = await lensOn();
        await shot(name);
        await touch.end(sid);
        await sleep(400);
        return on;
    };
    const slowShot = await holdAt("1-slow", { dx: 1, dy: 0, from: 40, to: 40, ms: 900 });
    const fastShot = await holdAt("2-fast", { dx: -1, dy: 0, from: 650, to: 650, ms: 350 });
    await check("screenshots: finger held slow shows it, fast does not", async () => [slowShot && !fastShot, `slow on=${slowShot}; fast on=${fastShot} (lens-1-slow.png, lens-2-fast.png)`]);

    /* ---- a tap, and a finger resting with jitter, never show it ---- */
    await check("a tap and a resting finger with a few px of jitter never show it", async () => {
        await record(page);
        const tid = await touch.start(cx, cy + 120);
        for (let i = 0; i < 12; i++) {
            await touch.move(tid, cx + (i % 2 ? 1.5 : -1.5), cy + 120 + (i % 3) - 1);
            await sleep(40);
        }
        await sleep(700);
        await touch.end(tid);
        await sleep(300);
        const r = await collect(page);
        const on = r.frames.filter((f) => f.on).length;
        return [on === 0, `${r.frames.length} frames over a 1.5 s rest with 1.5 px jitter: on in ${on}`];
    });

    await check("two fingers (a pinch) take it away", async () => {
        const a = await touch.start(cx - 30, cy + 200);
        await sleep(30);
        await touch.drag(a, line([cx - 30, cy + 200], [cx - 10, cy + 200], 25), 16); // slow: lens on
        const wasOn = await lensOn();
        const b = await touch.start(cx + 60, cy + 200);
        await sleep(150);
        const withTwo = await lensOn();
        await touch.end(b);
        await touch.end(a);
        await sleep(300);
        return [wasOn && !withTwo, `one finger on=${wasOn}; second finger down on=${withTwo}`];
    });

    await check("no page errors", async () => [logs.filter((l) => l.startsWith("pageerror") || l.startsWith("error")).length === 0, logs.join(" | ") || "clean"]);
    await page.close();
    return table;
}

/** Landscape: the picture fills the pane's height, so the cursor can reach the top edge and the lens must go below it, once. */
async function landscape(browser) {
    const as = "iPhone 13 landscape";
    const { page } = await open(browser, "iPhone 13 landscape");
    const touch = await touchSession(page);
    const { cx, cy, top, h: paneH } = await paneCentre(page);
    await record(page);
    // Slowly up to the top of the picture, then slowly back down. 36 px/s, a cursor speed of ~32 px/s.
    const id = await touch.start(cx, cy + 60);
    await sleep(50);
    let pos = [cx, cy + 60];
    pos = await drive(touch, id, pos, [{ dx: 0, dy: -1, from: 70, to: 70, ms: 3600 }]);
    const topShot = await page.evaluate(() => performance.now());
    await page.screenshot({ path: `${outDir}/lens-3-top-edge.png` });
    pos = await drive(touch, id, pos, [{ dx: 0, dy: 1, from: 70, to: 70, ms: 3600 }]);
    await touch.end(id);
    await sleep(300);
    const r = await collect(page);
    void topShot;
    await check(
        "at the top edge of a short pane (landscape): it goes below the cursor where there is no room above, and does not hop",
        async () => {
            const on = r.frames.filter((f) => f.on);
            const side = on.map((f) => (f.ly - f.cy < 0 ? "above" : "below"));
            const flips = side.slice(1).filter((v, i) => v !== side[i]).length;
            // The lens is drawn on the move that moved the cursor, so it matches the cursor of this frame or, at worst, the one before.
            const at = (f, i, sign) => Math.min(Math.abs(f.ly - f.cy - sign * OFFSET), i > 0 ? Math.abs(f.ly - on[i - 1].cy - sign * OFFSET) : Infinity);
            const aboveOk = on.every((f, i) => side[i] !== "above" || (at(f, i, -1) <= 1.5 && (f.cy - top < 120 || f.ly - SIZE / 2 >= top - 1)));
            const belowOk = on.every((f, i) => side[i] !== "below" || at(f, i, 1) <= 1.5);
            const nearTop = Math.min(...on.map((f) => f.cy));
            return [on.length > 20 && side.includes("below") && flips <= 2 && aboveOk && belowOk, `pane ${fmt(paneH, 0)} px high; ${on.length} frames on; cursor reached ${fmt(nearTop - top, 0)} px below the pane top; side changes ${flips} (at most above to below to above); every above frame 72 px up (inside the pane wherever the cursor is 120 px or more down): ${aboveOk}; every below frame 72 px down: ${belowOk}`];
        },
        as,
    );
    await page.close();
}

async function desktop(browser) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
    await live(page);
    await sleep(600);
    await check(
        "desktop mouse: no lens, slow or fast (the lens is a trackpad aid)",
        async () => {
            await record(page);
            const b = await page.$eval('[data-testid="kvm-pane"]', (el) => {
                const r = el.getBoundingClientRect();
                return { x: r.x, y: r.y, w: r.width, h: r.height };
            });
            await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2);
            for (let i = 0; i < 40; i++) {
                await page.mouse.move(b.x + b.w / 2 + i * 1.5, b.y + b.h / 2);
                await sleep(16);
            }
            for (let i = 0; i < 15; i++) {
                await page.mouse.move(b.x + b.w / 2 + 60 + i * 30, b.y + b.h / 2 + i * 8);
                await sleep(16);
            }
            const r = await collect(page);
            const on = r.frames.filter((f) => f.on).length;
            return [on === 0, `${r.frames.length} frames over a slow then a fast mouse sweep: lens on in ${on}`];
        },
        "Desktop 1400x900",
    );
    await page.close();
}

const browser = await launch();
let table = "";
try {
    table = await phone(browser);
    await landscape(browser);
    await desktop(browser);
} finally {
    await browser.close();
}

const section = [
    "<!-- lens:begin -->",
    "## The cursor lens, made basic",
    "",
    "Feedback from a real iPhone: the zoom cursor did too much and was confusing, so it was made more basic.",
    "",
    "What it is now (`packages/kvm-engine/src/view/lens.ts`, every number in its tuning block; failure modes L1-L10 in `view/FAILURE_MODES.md`):",
    "",
    "- One fixed size (96 px) and one fixed zoom (3x total, the picture's own zoom counted), a short CSS fade in and out, nothing inside it but the magnified picture and the cursor point.",
    "- On while ONE finger is down on the trackpad and moving slowly; off when the finger speeds up, lifts, or a second finger comes down. Speed decides only that: show under 300 px/s, hide over 420 px/s, in between it keeps what it had. No continuous speed-to-zoom curve, no grow animation, no linger after the lift.",
    "- Fixed place: 24 px above the cursor (its bottom edge), following it sideways, held inside the pane. Below the cursor only where it would not fit above (in a pane too short for either side, on whichever has more room), and back above only with 40 px to spare, so it never hops.",
    "- Desktop mouse: unchanged; the lens has never applied there.",
    "",
    "Script: `apps/web/e2e/lens.e2e.mjs`; iPhone 13 (portrait, then landscape for the top edge) with raw CDP touch events, then the desktop mouse. The page records the lens box and the cursor centre on every animation frame and every pointermove on its own clock; the finger speed below is read off those pointermoves (trailing 120 ms).",
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replaceAll("|", "/")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    "One gesture, one finger: slow (40 px/s) -> speeding up to 560 px/s -> fast (560) -> slowing down to 40 -> slow again, then lift. Sampled every 150 ms:",
    "",
    table,
    "",
    "Screenshots: [finger slow](phone-feedback/lens-1-slow.png), [finger fast](phone-feedback/lens-2-fast.png), [landscape, cursor at the top edge, lens below it](phone-feedback/lens-3-top-edge.png).",
    "<!-- lens:end -->",
    "",
].join("\n");
if (sectionPath) writeFileSync(sectionPath, section);
console.log(report.failed.length ? `${report.failed.length} FAILED` : "all passed");
process.exit(report.failed.length ? 1 : 0);
