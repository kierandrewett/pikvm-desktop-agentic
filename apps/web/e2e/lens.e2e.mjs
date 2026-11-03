// The trackpad lens (the magnifier round the cursor): its zoom follows how fast the finger moves, and it
// is there as soon as the finger moves slowly. Phone (iPhone 13) with raw CDP touch events, and the
// desktop mouse, which has no lens.
//
//   node apps/web/e2e/lens.e2e.mjs [--out docs/e2e/phone-feedback] [--section /tmp/lens-section.md]
//
// The page records two streams on its own clock: one sample per animation frame of the lens (is it on,
// its magnification from `data-mag`, its size) and every pointermove. The run then reads the finger's speed
// off the moves and lines the two up, so the numbers are what a person's eye would have seen, not
// what this script intended to send. See docs/e2e/README.md for how to bring the two servers up.

import { mkdirSync, writeFileSync } from "node:fs";
import { WEB, Report, fakeReset, launch, line, puppeteer, sleep, touchSession } from "./harness.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const outDir = flag("--out", "docs/e2e/phone-feedback");
const sectionPath = flag("--section", "");
mkdirSync(outDir, { recursive: true });

const report = new Report("Trackpad lens");
const profile = "iPhone 13";

/** The tuning in packages/kvm-engine/src/view/lens.ts, which the page bundle does not expose: the run checks the behaviour against these. */
const SLOW = 60; // px/s at or under which the zoom is at its maximum
const FAST = 360; // px/s at or over which there is no lens
const ZOOM_MAX = 5;

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

/** Start the in-page recorders. Everything is stamped with the page's own performance.now(). */
async function record(page) {
    await page.evaluate(() => {
        const lens = document.querySelector(".kvm-lens");
        const rec = { frames: [], touches: [], running: true };
        window.__lensRec = rec;
        const tick = () => {
            if (!rec.running) return;
            rec.frames.push({
                t: performance.now(),
                on: lens.classList.contains("on"),
                mag: lens.dataset.mag ? Number(lens.dataset.mag) : null,
                size: Math.round(parseFloat(lens.style.width) || 0),
            });
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        // pointermove is what the app itself listens to (Chrome withholds touchmove until the finger leaves its own slop).
        const note = (e, start) => {
            if (e.pointerType === "touch") rec.touches.push({ t: e.timeStamp, x: e.clientX, y: e.clientY, start });
        };
        document.addEventListener("pointermove", (e) => note(e, false), { capture: true, passive: true });
        document.addEventListener("pointerdown", (e) => note(e, true), { capture: true, passive: true });
    });
}

const collect = (page) =>
    page.evaluate(() => {
        window.__lensRec.running = false;
        return { frames: window.__lensRec.frames, touches: window.__lensRec.touches };
    });

/**
 * Drive one finger along `legs`, each `{ dx, dy, from, to, ms }`: it travels in the (dx, dy) direction at a
 * speed that goes linearly from `from` to `to` px/s over `ms`. Position is advanced by the REAL time between
 * sends, so the speed is what it says whatever the tick does.
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
    const recent = touches.filter((p) => !p.start && p.t <= t && p.t > t - window);
    if (recent.length < 2) return 0;
    let path = 0;
    for (let i = 1; i < recent.length; i++) path += Math.hypot(recent[i].x - recent[i - 1].x, recent[i].y - recent[i - 1].y);
    return (path / (recent.at(-1).t - recent[0].t)) * 1000;
}

/** The largest frame-to-frame change in zoom among consecutive on-frames, and the longest gap between pointer events just before it. */
function biggestStep(frames, touches) {
    let best = { jump: 0, gap: 0 };
    for (let i = 1; i < frames.length; i++) {
        if (!frames[i].on || !frames[i - 1].on) continue;
        const jump = Math.abs(frames[i].mag - frames[i - 1].mag);
        if (jump <= best.jump) continue;
        const near = touches.filter((p) => p.t > frames[i].t - 100 && p.t <= frames[i].t);
        let gap = 0;
        for (let k = 1; k < near.length; k++) gap = Math.max(gap, near[k].t - near[k - 1].t);
        best = { jump, gap };
    }
    return best;
}

/** Zoom sampled every `every` ms across on-frames, to see the trend through the finger's own unevenness. */
function trend(frames, every = 200) {
    const out = [];
    for (let t = frames[0].t; t <= frames.at(-1).t; t += every) {
        const f = frames.find((x) => x.t >= t && x.on);
        if (f) out.push(f.mag);
    }
    return out;
}

const fmt = (n, d = 1) => (n === null || n === undefined ? "-" : n.toFixed(d));

async function phone(browser) {
    await fakeReset();
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => {
        if (!/janus\/ws/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    await page.emulate(puppeteer.KnownDevices["iPhone 13"]);
    await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
    await live(page);
    const touch = await touchSession(page);
    const box = await page.$eval('[data-testid="kvm-pane"]', (el) => {
        const r = el.getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    });
    const { cx, cy } = box;
    const lensNow = () => page.$eval(".kvm-lens", (el) => ({ on: el.classList.contains("on"), mag: el.dataset.mag ? Number(el.dataset.mag) : null, size: Math.round(parseFloat(el.style.width) || 0) }));
    const shot = (name) => page.screenshot({ path: `${outDir}/lens-${name}.png` });
    await sleep(600);

    /* ---- one long gesture: slow, speeding up, fast, slowing down, slow ---- */
    await record(page);
    const start = [cx - 100, cy - 150];
    const id = await touch.start(...start);
    await sleep(50);
    const legs = [
        { name: "slow", dx: 1, dy: 0, from: 40, to: 40, ms: 1100 },
        { name: "speeding up", dx: 0, dy: 1, from: 40, to: 520, ms: 1000 },
        { name: "fast", dx: 1, dy: 0, from: 520, to: 520, ms: 450 },
        { name: "slowing down", dx: 0, dy: -1, from: 520, to: 40, ms: 1000 },
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
    const lastLift = await page.evaluate(() => performance.now());
    await sleep(1800); // the linger
    const rec = await collect(page);
    const firstMove = rec.touches.find((p) => !p.start).t;
    const touchAt = rec.touches[0].t;

    // The merged series: every frame with the finger's speed beside it.
    const series = rec.frames.map((f) => ({ ...f, speed: fingerSpeed(rec.touches, f.t) }));
    const during = (name) => {
        const m = marks.find((x) => x.name === name);
        return series.filter((s) => s.t >= m.from && s.t <= m.to);
    };

    await check("trackpad lens: a slow finger shows it at once, with no hold: within a frame or two of leaving its touch point by 4 px, and not before", async () => {
        const away = rec.touches.find((p) => !p.start && Math.hypot(p.x - start[0], p.y - start[1]) > 4);
        const firstOn = series.find((s) => s.on);
        const delay = firstOn.t - away.t;
        return [delay >= 0 && delay < 60, `finger past 4 px at +${fmt(away.t - touchAt)} ms of the touch (${fmt(Math.hypot(away.x - start[0], away.y - start[1]))} px away); lens first on ${fmt(delay)} ms later at ${fmt(firstOn.mag, 2)}x and ${firstOn.size}px; on before that: ${series.filter((s) => s.on && s.t < away.t).length} frames`];
    });

    await check("trackpad lens: slow movement is at the full zoom", async () => {
        const slow = during("slow").filter((s) => s.t > marks[0].from + 300);
        const worst = Math.min(...slow.map((s) => s.mag ?? 0));
        const speeds = slow.map((s) => s.speed);
        return [slow.every((s) => s.on) && worst >= ZOOM_MAX - 0.3, `${slow.length} frames at ${fmt(Math.min(...speeds), 0)}-${fmt(Math.max(...speeds), 0)} px/s: lens always on, zoom >= ${fmt(worst, 2)}x (max ${ZOOM_MAX})`];
    });

    await check("trackpad lens: speeding up zooms out continuously, to nothing by the fast speed, with no jump", async () => {
        const up = during("speeding up");
        const { jump: biggestJump, gap } = biggestStep(up, rec.touches);
        const steps = trend(up);
        const falling = steps.every((m, i) => i === 0 || m <= steps[i - 1] + 0.05);
        const onFrames = up.filter((s) => s.on);
        const firstOff = up.find((s) => !s.on && s.t > up[0].t + 100);
        const offAt = firstOff ? firstOff.speed : NaN;
        const flips = up.slice(1).filter((s, i) => s.on !== up[i].on).length;
        const pass = onFrames.length >= 10 && biggestJump < 0.9 && falling && firstOff !== undefined && flips === 1 && offAt < FAST + 120;
        return [pass, `${onFrames.length} frames on; largest frame-to-frame zoom change ${fmt(biggestJump, 2)}x (longest pointer gap just before it ${fmt(gap, 0)} ms); zoom every 200 ms ${steps.map((m) => fmt(m, 1)).join(" > ")}; on/off changes ${flips}; went off at ${fmt(offAt, 0)} px/s of finger speed (fast = ${FAST})`];
    });

    await check("trackpad lens: fast movement never has it, from the first fast frame", async () => {
        const fast = during("fast").filter((s) => s.speed > FAST + 60);
        const anyOn = fast.filter((s) => s.on);
        const peak = Math.max(...fast.map((s) => s.speed));
        return [fast.length > 10 && anyOn.length === 0, `${fast.length} frames at up to ${fmt(peak, 0)} px/s: lens on in ${anyOn.length}`];
    });

    await check("trackpad lens: slowing down zooms back in continuously, with no jump", async () => {
        const down = during("slowing down");
        const { jump: biggestJump, gap } = biggestStep(down, rec.touches);
        const steps = trend(down);
        const rising = steps.every((m, i) => i === 0 || m >= steps[i - 1] - 0.05);
        const firstOn = down.find((s) => s.on);
        const flips = down.slice(1).filter((s, i) => s.on !== down[i].on).length;
        const end = down.filter((s) => s.on).at(-1);
        return [Boolean(firstOn) && biggestJump < 0.9 && rising && flips === 1 && end.mag > ZOOM_MAX - 1.2, `back on at ${fmt(firstOn?.speed, 0)} px/s (lens needs the finger under ${FAST}); largest frame-to-frame zoom change ${fmt(biggestJump, 2)}x (longest pointer gap just before it ${fmt(gap, 0)} ms); zoom every 200 ms ${steps.map((m) => fmt(m, 1)).join(" < ")}; on/off changes ${flips}; ended at ${fmt(end?.mag, 2)}x`];
    });

    await check("trackpad lens: slow again is back to the full zoom", async () => {
        const slow = during("slow again").filter((s) => s.t > marks[4].from + 500);
        const worst = Math.min(...slow.map((s) => s.mag ?? 0));
        return [slow.every((s) => s.on) && worst >= ZOOM_MAX - 0.3, `${slow.length} frames, zoom >= ${fmt(worst, 2)}x`];
    });

    await check("trackpad lens: the zoom is tied to the speed: the slower the finger, the higher the zoom, across the whole gesture", async () => {
        const on = series.filter((s) => s.on && s.speed > 0);
        const bins = [[0, 90], [90, 150], [150, 220], [220, 300], [300, 420]].map(([lo, hi]) => {
            const m = on.filter((s) => s.speed >= lo && s.speed < hi).map((s) => s.mag);
            return { lo, hi, n: m.length, mean: m.length ? m.reduce((a, b) => a + b, 0) / m.length : null };
        });
        const filled = bins.filter((b) => b.n >= 3);
        const monotonic = filled.every((b, i) => i === 0 || b.mean <= filled[i - 1].mean + 0.15);
        return [filled.length >= 4 && monotonic, bins.map((b) => `${b.lo}-${b.hi} px/s: ${fmt(b.mean, 2)}x (n=${b.n})`).join("; ")];
    });

    await check("trackpad lens: it grows from small to full size inside 200 ms, then lingers after the lift and goes", async () => {
        const first = series.find((s) => s.on);
        const full = series.find((s) => s.on && s.size >= 96);
        const after = (ms) => series.find((s) => s.t >= lastLift + ms);
        const at1 = after(1000);
        const at1700 = after(1700);
        return [first.size < 96 && full.t - first.t <= 220 && at1.on && !at1700.on, `first ${first.size}px, full 96px ${fmt(full.t - first.t, 0)} ms later; 1.0 s after lift on=${at1.on}; 1.7 s after on=${at1700.on}`];
    });

    // The trace itself, 150 ms apart, for the record.
    const t0 = rec.touches[0].t;
    const rows = [];
    for (let t = t0; t < series.at(-1).t - 1000; t += 150) {
        const s = series.find((f) => f.t >= t);
        const leg = marks.find((m) => s.t >= m.from && s.t <= m.to)?.name ?? (s.t > lastLift ? "lifted" : "");
        rows.push(`| ${fmt((s.t - t0) / 1000, 2)} | ${leg} | ${fmt(s.speed, 0)} | ${s.on ? "on" : "off"} | ${fmt(s.mag, 2)} | ${s.on ? s.size : "-"} |`);
    }
    const table = ["| t (s) | leg | finger px/s | lens | zoom | size px |", "| --- | --- | --- | --- | --- | --- |", ...rows].join("\n");

    /* ---- screenshots: the finger held at three speeds ---- */
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
        await sleep(1700);
    };
    const holdAt = async (name, leg, settle) => {
        await recentre();
        const sid = await touch.start(cx - 100, cy - 100);
        await sleep(40);
        await drive(touch, sid, [cx - 100, cy - 100], [leg]);
        await sleep(settle);
        const now = await lensNow();
        await shot(name);
        await touch.end(sid);
        await sleep(1700);
        return now;
    };
    const slowShot = await holdAt("1-slow", { dx: 1, dy: 0, from: 40, to: 40, ms: 900 }, 0);
    const midShot = await holdAt("2-medium", { dx: 1, dy: 0, from: 200, to: 200, ms: 500 }, 0);
    const fastShot = await holdAt("3-fast", { dx: -1, dy: 0, from: 650, to: 650, ms: 350 }, 0);
    await check("trackpad lens: screenshots slow / medium / fast", async () => [
        slowShot.on && !fastShot.on && midShot.on && slowShot.mag > midShot.mag && midShot.mag > 1.3,
        `slow on=${slowShot.on} ${fmt(slowShot.mag, 2)}x; medium on=${midShot.on} ${fmt(midShot.mag, 2)}x; fast on=${fastShot.on} ${fmt(fastShot.mag, 2)}x (lens-1-slow.png, lens-2-medium.png, lens-3-fast.png)`,
    ]);

    /* ---- a tap, and a finger resting with jitter, never show it ---- */
    await check("trackpad lens: a tap and a resting finger with a few px of jitter never show it", async () => {
        await record(page);
        const tid = await touch.start(cx, cy + 120);
        for (let i = 0; i < 12; i++) {
            await touch.move(tid, cx + (i % 2 ? 1.5 : -1.5), cy + 120 + (i % 3) - 1);
            await sleep(40);
        }
        const during = await lensNow();
        await sleep(700);
        await touch.end(tid);
        await sleep(300);
        const r = await collect(page);
        const on = r.frames.filter((f) => f.on).length;
        return [on === 0 && !during.on, `${r.frames.length} frames over a 1.5 s rest with 1.5 px jitter: lens on in ${on}`];
    });

    await check("no page errors", async () => [logs.filter((l) => l.startsWith("pageerror") || l.startsWith("error")).length === 0, logs.join(" | ") || "clean"]);
    await page.close();
    return table;
}

async function desktop(browser) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
    await live(page);
    await sleep(600);
    await check("desktop mouse: no lens, slow or fast (the lens is a trackpad aid)", async () => {
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
    }, "Desktop 1400x900");
    await page.close();
}

const browser = await launch();
let table = "";
try {
    table = await phone(browser);
    await desktop(browser);
} finally {
    await browser.close();
}

const section = [
    "<!-- lens:begin -->",
    "## Zoom-in cursor lens: trigger and speed-tied zoom",
    "",
    "Kieran: \"the zoom in cursor thing I need you to make it easier to trigger, and you gotta tie it directly to the movement speed\".",
    "",
    "What changed (`packages/kvm-engine/src/view/lens.ts`, every number in its tuning block; failure modes L1-L15 in `view/FAILURE_MODES.md`, P17 in `pointer/FAILURE_MODES.md`):",
    "",
    "- Trigger: no hold. The lens used to need about a second of sustained fine movement (and a 160 px path cap) before it appeared and 450 ms to grow. It now appears on the first frame after the finger has moved more than 4 px from where it touched in trackpad mode (before the cursor itself starts moving at the 16 px tap slop), and opens in 160 ms. A tap, a hold or a resting finger (jitter under 4 px) never shows it.",
    "- Zoom is a function of finger speed: the finger's px/s, averaged over about 70 ms (decayed distance / decayed time, using each event's own timestamp), goes through a smoothstep from 5x total at <= 60 px/s to 1x (no lens) at >= 360 px/s. Continuous and monotonic, flat at both ends.",
    "- Hysteresis: the lens appears at 1.3x and goes away only below 1.12x, so a finger hovering on the threshold does not flicker.",
    "- The speed is held while the finger rests (a swipe that ends still never lets the lens creep in; a nudge that ends still keeps its zoom). The picture's own zoom still counts towards the total (lens mag = max(1, zoom / picture scale)).",
    "- Desktop mouse: unchanged, the lens has never applied there (it needs the trackpad's virtual cursor); the desktop case below confirms none appears.",
    "",
    "Found by the run: the painter proxy in `picture-controller.ts` dropped the event timestamp, so the first version timed moves by when the browser handed them over (a frame's worth together) and the zoom jumped by up to 1.2x a frame. With the proxy forwarding it the largest frame-to-frame change in these runs is 0.2-0.35x.",
    "",
    `Script: \`apps/web/e2e/lens.e2e.mjs\`; iPhone 13 profile with raw CDP touch events, then the desktop mouse. The page records the lens (on, \`data-mag\`, size) on every animation frame and every pointermove on its own clock; the finger speed in the table is read off those pointermoves (trailing 120 ms).`,
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replaceAll("|", "/")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    "One gesture, one finger: slow (40 px/s) -> speeding up to 520 px/s -> fast (520) -> slowing down to 40 -> slow again, then lift. Sampled every 150 ms:",
    "",
    table,
    "",
    "Screenshots (finger held at 40, 200 and 650 px/s, cursor recentred first): [slow](phone-feedback/lens-1-slow.png), [medium](phone-feedback/lens-2-medium.png), [fast](phone-feedback/lens-3-fast.png).",
    "<!-- lens:end -->",
    "",
].join("\n");
if (sectionPath) writeFileSync(sectionPath, section);
console.log(report.failed.length ? `${report.failed.length} FAILED` : "all passed");
process.exit(report.failed.length ? 1 : 0);
