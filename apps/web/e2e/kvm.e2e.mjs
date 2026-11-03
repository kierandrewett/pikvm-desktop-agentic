// The KVM screen against a real web host in front of tools/fake-kvmd: phone (iPhone 13) and
// desktop (1400x900). Every case drives the page the way a person would and then asserts what the
// fake kvmd RECEIVED, so a pass means the target would have seen it.
//
//   node apps/web/e2e/kvm.e2e.mjs [phone|desktop] [--out docs/e2e/kvm-screen]
//
// See docs/e2e/README.md for how to bring the two servers up.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WEB, FAKE, Report, describe, fakeGet, fakePost, fakeReset, launch, line, puppeteer, recorder, sleep, touchSession } from "./harness.mjs";

const args = process.argv.slice(2);
const only = args.find((a) => a === "phone" || a === "desktop");
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e/kvm-screen";
mkdirSync(outDir, { recursive: true });

const report = new Report("KVM screen");
const MACRO = {
    label: "Run box",
    icon: "terminal",
    pinned: true,
    steps: [
        { type: "chord", mods: ["MetaLeft"], code: "KeyR" },
        { type: "delay", ms: 200 },
        { type: "text", text: "calc" },
    ],
};

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (lines, text) => lines.includes(text);
const count = (lines, text) => lines.filter((l) => l === text).length;

async function open(browser, profile) {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => {
        // The fake has no Janus, which is the designed fallback to MJPEG.
        if (!/janus\/ws/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    if (profile === "phone") await page.emulate(puppeteer.KnownDevices["iPhone 13"]);
    else await page.setViewport({ width: 1400, height: 900 });
    await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
    await live(page);
    return { page, logs };
}

async function live(page, timeout = 15000) {
    await page.waitForFunction(
        () => {
            const s = document.querySelector(".kvm-status")?.textContent ?? "";
            return s === "Live" || (document.querySelector(".kvm-dot")?.getAttribute("aria-label") ?? "") === "Live";
        },
        { timeout },
    );
}

const paneBox = (page) =>
    page.$eval('[data-testid="kvm-pane"]', (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    });

const shot = (page, dir, name) => page.screenshot({ path: `${dir}/${name}.png` });

async function check(profile, name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add(profile, name, observed, pass);
    } catch (error) {
        report.add(profile, name, `threw: ${error.message}`, false);
    }
}

async function resolutionToast(profile, page) {
    await check(profile, "resolution toast names the picture and its source", async () => {
        await page.waitForFunction(() => /320 \u00d7 180/.test(document.querySelector(".kvm-res-toast")?.textContent ?? ""), { timeout: 4000 });
        const text = await page.$eval(".kvm-res-toast", (el) => el.textContent);
        return [/320 \u00d7 180\s+\u00b7\s+MJPEG/.test(text ?? ""), JSON.stringify(text)];
    });
}

/* ================================ phone ================================ */

async function phone(browser) {
    const profile = "iPhone 13";
    await fakeReset();
    const { page, logs } = await open(browser, "phone");
    await resolutionToast(profile, page);
    const touch = await touchSession(page);
    const rec = recorder();
    const box = await paneBox(page);
    const { cx, cy } = box;
    const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    report.add(profile, "touch dock layout", `pointer:coarse ${coarse}; dock ${(await page.$(".kvm-screen[data-layout=dock]")) !== null}`, coarse);
    await shot(page, outDir, "phone-dock");

    await check(profile, "tap = one left click, no move", async () => {
        await rec.mark();
        await touch.tap(cx, cy);
        const { events } = await rec.events();
        const lines = describe(events);
        return [equal(lines, ["button left down", "button left up"]), lines.join(", ")];
    });

    await check(profile, "hold, then drag = left held, cursor moves, released, no right click", async () => {
        await rec.mark();
        const id = await touch.start(cx, cy);
        await sleep(620);
        const armed = await page.$eval('[data-testid="kvm-pane"]', (el) => el.classList.contains("hold-armed"));
        await touch.drag(id, line([cx, cy], [cx + 70, cy + 30], 8));
        await touch.end(id);
        const { events } = await rec.events();
        const lines = describe(events);
        const pass = armed && count(lines, "button left down") === 1 && count(lines, "button left up") === 1 && lines.some((l) => l.startsWith("move ")) && !lines.some((l) => l.includes("right"));
        return [pass, `hold cue ${armed}; ${lines.length} events: ${lines[0]} ... ${lines.at(-1)}`];
    });

    await check(profile, "hold, then lift = one right click", async () => {
        await rec.mark();
        const id = await touch.start(cx, cy);
        await sleep(620);
        await touch.end(id);
        const { events } = await rec.events();
        const lines = describe(events);
        return [equal(lines, ["button right down", "button right up"]), lines.join(", ")];
    });

    // The trackpad lens is a precision aid whose zoom follows the finger's speed: there at once for a slow
    // finger, gone for a fast one (the time series is apps/web/e2e/lens.e2e.mjs).
    const lensState = () =>
        page.$eval(".kvm-lens", (el) => ({ on: el.classList.contains("on"), size: Math.round(parseFloat(el.style.width) || 0), mag: el.dataset.mag ? Number(el.dataset.mag) : null }));
    await check(profile, "trackpad lens: a fast drag never shows it", async () => {
        const id = await touch.start(cx - 90, cy);
        // 200 px in 10 events about 10 ms apart: ~2 px/ms, far over the 360 px/s at which the zoom is gone
        const sampled = [];
        for (const [x, y] of line([cx - 90, cy], [cx + 110, cy + 40], 10)) {
            await touch.move(id, x, y);
            await sleep(6);
            sampled.push((await lensState()).on);
        }
        const during = sampled.some(Boolean);
        await sleep(1300); // finger still down and still: it must not creep in afterwards either
        const after = await lensState();
        await touch.end(id);
        return [!during && !after.on, `lens shown during the swipe: ${during}; 1.3 s after: ${after.on}`];
    });

    await check(profile, "trackpad lens: a slow drag shows it at once at a high zoom, then it hides after lift", async () => {
        await sleep(1700); // let the last lens linger lapse
        const id = await touch.start(cx - 30, cy);
        // ~45 px/s: 0.7 px every 16 ms
        let firstOn = -1;
        const t0 = Date.now();
        let last = await lensState();
        for (let i = 1; i <= 60; i++) {
            await touch.move(id, cx - 30 + i * 0.7, cy);
            await sleep(16);
            last = await lensState();
            if (last.on && firstOn < 0) firstOn = Date.now() - t0;
        }
        await touch.end(id);
        await sleep(1900); // linger (1.4 s), then hidden
        const gone = await lensState();
        const pass = firstOn >= 0 && firstOn < 600 && last.on && last.mag > 4.5 && last.size >= 90 && !gone.on;
        return [pass, `first shown ${firstOn} ms into the drag (hold would be 450 ms+); at the end ${last.mag}x, ${last.size}px; after lift + linger on=${gone.on}`];
    });

    await check(profile, "two-finger tap = right click", async () => {
        await rec.mark();
        const a = await touch.start(cx - 30, cy);
        const b = await touch.start(cx + 30, cy);
        await sleep(60);
        await touch.end(a);
        await touch.end(b);
        const { events } = await rec.events();
        const lines = describe(events);
        return [equal(lines, ["button right down", "button right up"]), lines.join(", ")];
    });

    await check(profile, "two-finger drag scrolls the target, no clicks, no zoom", async () => {
        await rec.mark();
        const a = await touch.start(cx - 30, cy - 40);
        const b = await touch.start(cx + 30, cy - 40);
        for (let i = 1; i <= 10; i++) {
            await touch.moveAll([[a, cx - 30, cy - 40 + i * 10], [b, cx + 30, cy - 40 + i * 10]]);
            await sleep(16);
        }
        await touch.end(a);
        await touch.end(b);
        const { events } = await rec.events();
        const lines = describe(events);
        const wheels = lines.filter((l) => l.startsWith("wheel"));
        const transform = await page.$eval(".kvm-img", (el) => el.style.transform);
        const scale = Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? 1);
        return [wheels.length >= 3 && wheels.every((w) => w === "wheel 0,1") && !lines.some((l) => l.startsWith("button")) && scale === 1, `${wheels.length} wheel steps (${wheels[0]}), no buttons, picture scale ${scale}`];
    });

    await check(profile, "pinch zooms the picture; the zoom-out button restores it", async () => {
        await rec.mark();
        const a = await touch.start(cx - 30, cy);
        const b = await touch.start(cx + 30, cy);
        for (let i = 1; i <= 12; i++) {
            await touch.moveAll([[a, cx - 30 - i * 8, cy], [b, cx + 30 + i * 8, cy]]);
            await sleep(16);
        }
        await touch.end(a);
        await touch.end(b);
        const zoomed = await page.$eval(".kvm-img", (el) => el.style.transform);
        const m = /scale\(([\d.]+)\)/.exec(zoomed);
        const scale = m ? Number(m[1]) : 1;
        const button = await page.$('[data-testid="zoom-reset"]');
        await shot(page, outDir, "phone-zoomed");
        const { events } = await rec.events();
        const lines = describe(events);
        await button?.tap();
        await sleep(200);
        const after = await page.$eval(".kvm-img", (el) => el.style.transform);
        const reset = /scale\(1(\.0+)?\)/.test(after);
        const gone = (await page.$('[data-testid="zoom-reset"]')) === null;
        return [scale > 1.5 && !!button && reset && gone && lines.every((l) => !l.startsWith("button") && !l.startsWith("wheel")), `scale ${scale.toFixed(2)}, zoom-out button ${!!button}, restored ${reset} (${after}), hidden after ${gone}, ${lines.length} HID events`];
    });

    // Raise the system keyboard: focus lands on the hidden field.
    await page.tap('[data-testid="keyboard-toggle"]');
    await sleep(200);
    const focused = await page.evaluate(() => document.activeElement?.classList.contains("kvm-kbd") ?? false);
    report.add(profile, "keyboard button focuses the hidden field", `focused ${focused}`, focused);

    await check(profile, "typing Hi", async () => {
        await rec.mark();
        await page.keyboard.type("Hi");
        const { events } = await rec.events(400);
        const lines = describe(events);
        const want = ["key ShiftLeft down", "key KeyH down", "key KeyH up", "key ShiftLeft up", "key KeyI down", "key KeyI up"];
        return [equal(lines, want), lines.join(", ")];
    });

    await check(profile, "soft-keyboard diff typing: insert, then the keyboard rewrites a word", async () => {
        await rec.mark();
        const cdp = await page.createCDPSession();
        await cdp.send("Input.insertText", { text: "hello wrld" });
        await sleep(300);
        await page.evaluate(() => {
            const field = document.querySelector(".kvm-kbd");
            field.value = field.value.replace("wrld", "world");
            field.dispatchEvent(new InputEvent("input", { inputType: "insertReplacementText", data: null, bubbles: true }));
        });
        const { events } = await rec.events(600);
        const lines = describe(events);
        let text = "";
        for (const l of lines) {
            const m = /^key Key(\w) down$/.exec(l);
            if (m) text += m[1].toLowerCase();
            else if (l === "key Space down") text += " ";
            else if (l === "key Backspace down") text = text.slice(0, -1);
        }
        return [text === "hello world" && count(lines, "key Backspace down") === 3, `target text "${text}" after ${count(lines, "key Backspace down")} Backspaces`];
    });

    await check(profile, "Ctrl tap, then c", async () => {
        await rec.mark();
        await page.tap('[data-mod="ControlLeft"]');
        const armed = await page.$eval('[data-mod="ControlLeft"]', (el) => el.getAttribute("aria-pressed"));
        await page.keyboard.type("c");
        const { events } = await rec.events(400);
        const lines = describe(events);
        const after = await page.$eval('[data-mod="ControlLeft"]', (el) => el.getAttribute("aria-pressed"));
        const focusKept = await page.evaluate(() => document.activeElement?.classList.contains("kvm-kbd") ?? false);
        const want = ["key ControlLeft down", "key KeyC down", "key KeyC up", "key ControlLeft up"];
        return [equal(lines, want) && armed === "true" && after === "false" && focusKept, `${lines.join(", ")}; armed ${armed}, cleared ${after}, keyboard kept ${focusKept}`];
    });

    await check(profile, "Win + Shift + S chord", async () => {
        await rec.mark();
        await page.tap('[data-mod="MetaLeft"]');
        await page.tap('[data-mod="ShiftLeft"]');
        await page.keyboard.type("s");
        const { events } = await rec.events(500);
        const lines = describe(events);
        const state = await fakeGet("/__fake/state");
        const downs = lines.filter((l) => l.endsWith("down"));
        const pass =
            downs.length === 3 &&
            new Set(downs.slice(0, 2)).size === 2 &&
            downs.slice(0, 2).every((l) => l === "key MetaLeft down" || l === "key ShiftLeft down") &&
            downs[2] === "key KeyS down" &&
            lines.includes("key KeyS up") &&
            lines.includes("key MetaLeft up") &&
            lines.includes("key ShiftLeft up") &&
            state.keysDown.length === 0;
        return [pass, `${lines.join(", ")}; still held on target: ${state.keysDown.length}`];
    });

    await check(profile, "Caps key toggles the fake LED and lights", async () => {
        await page.tap("[data-caps]");
        await sleep(600);
        const on = (await fakeGet("/__fake/state")).leds.caps;
        const lit = await page.$eval("[data-caps]", (el) => el.getAttribute("aria-pressed") + "/" + el.classList.contains("on"));
        await shot(page, outDir, "phone-caps-on");
        await page.tap("[data-caps]");
        await sleep(600);
        const off = (await fakeGet("/__fake/state")).leds.caps;
        const unlit = await page.$eval("[data-caps]", (el) => el.getAttribute("aria-pressed") + "/" + el.classList.contains("on"));
        return [on === true && lit === "true/true" && off === false && unlit === "false/false", `LED ${on}, key ${lit}; then LED ${off}, key ${unlit}`];
    });

    await check(profile, "Fn and More rows open one at a time", async () => {
        await page.tap('[data-toggle="fn"]');
        const fn = await page.$$eval('[data-key^="F"]', (els) => els.length);
        await page.tap('[data-toggle="more"]');
        const fnAfter = await page.$$eval('[data-key="F1"]', (els) => els.length);
        const more = await page.$$eval("[data-chord]", (els) => els.length);
        await shot(page, outDir, "phone-more-keys");
        await page.tap('[data-toggle="more"]');
        return [fn >= 12 && fnAfter === 0 && more >= 13, `F-keys ${fn}, F1 after opening More ${fnAfter}, shortcut keys ${more}`];
    });

    await check(profile, "alt+tab shortcut key sends the chord", async () => {
        await page.tap('[data-toggle="more"]');
        await rec.mark();
        await page.tap('[data-chord="AltLeft+Tab"]');
        const { events } = await rec.events(400);
        const lines = describe(events);
        await page.tap('[data-toggle="more"]');
        return [equal(lines, ["key AltLeft down", "key Tab down", "key Tab up", "key AltLeft up"]), lines.join(", ")];
    });

    // Macro: made through the app's own API, then run from the sheet's tile.
    await fetch(`${WEB}/app/api/v1/macros`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ macros: [MACRO] }) });
    await page.reload({ waitUntil: "load" });
    await live(page);
    await check(profile, "macro tile in the ⋯ sheet runs on the target", async () => {
        await page.tap('[aria-label="More"]');
        await page.waitForSelector(".kvm-macro-tile", { timeout: 5000 });
        await shot(page, outDir, "phone-sheet");
        const separators = await page.$$eval("#kvm-sheet .kvm-sep", (els) => els.length);
        await rec.mark();
        await page.tap(".kvm-macro-tile");
        const { events, prints } = await rec.events(1200);
        const lines = describe(events);
        const pass = equal(lines, ["key MetaLeft down", "key KeyR down", "key KeyR up", "key MetaLeft up"]) && prints.length === 1 && prints[0].text === "calc";
        return [pass, `${lines.join(", ")}; typed "${prints[0]?.text}"; ${separators} separators in the sheet`];
    });

    await check(profile, "Read text from the screen: the overlay covers the picture and a drag reads that region", async () => {
        await page.tap('[aria-label="More"]');
        await page.waitForFunction(() => [...document.querySelectorAll("#kvm-sheet .kvm-item")].some((e) => /Read text from the screen/.test(e.textContent)), { timeout: 5000 });
        await page.evaluate(() => [...document.querySelectorAll("#kvm-sheet .kvm-item")].find((e) => /Read text from the screen/.test(e.textContent)).click());
        await page.waitForSelector(".kvm-ocr-pick", { timeout: 5000 });
        const overlay = await page.$eval(".kvm-ocr-pick", (el) => {
            const r = el.getBoundingClientRect();
            return { w: r.width, h: r.height };
        });
        await shot(page, outDir, "phone-ocr-pick");
        const before = (await fakeGet("/__fake/requests")).requests.length;
        const id = await touch.start(cx - 80, cy - 30);
        await touch.drag(id, line([cx - 80, cy - 30], [cx + 80, cy + 30], 8));
        await touch.end(id);
        await page.waitForFunction(() => document.querySelector(".kvm-ocr-pick") === null, { timeout: 5000 });
        await sleep(800);
        const { requests } = await fakeGet("/__fake/requests");
        const ocr = requests.slice(before).find((r) => r.path.endsWith("/streamer/snapshot") && r.query.ocr === "1");
        const sent = ocr ? `left ${ocr.query.ocr_left}, top ${ocr.query.ocr_top}, right ${ocr.query.ocr_right}, bottom ${ocr.query.ocr_bottom}` : "no OCR request";
        // The fake's picture is 320x180 and the drag is the middle 160x60 client px of a 390-wide pane: a sub-rectangle inside it.
        const inside = ocr && Number(ocr.query.ocr_left) >= 0 && Number(ocr.query.ocr_right) <= 320 && Number(ocr.query.ocr_right) > Number(ocr.query.ocr_left) && Number(ocr.query.ocr_bottom) > Number(ocr.query.ocr_top);
        const result = await page.evaluate(() => document.querySelector('[aria-label="Text read from the screen"]')?.value ?? null);
        await shot(page, outDir, "phone-ocr-result");
        await page.keyboard.press("Escape");
        return [overlay.w >= 300 && overlay.h >= 300 && !!inside, `overlay ${Math.round(overlay.w)}x${Math.round(overlay.h)}; request: ${sent}; dialog text ${JSON.stringify(result)}`];
    });

    // The other touch modes. The stored choice is read at load, so each one reloads.
    const setPrefs = async (prefs) => {
        await page.evaluate((p) => {
            for (const [k, v] of Object.entries(p)) localStorage.setItem(k, v);
        }, prefs);
        await page.reload({ waitUntil: "load" });
        await live(page);
    };
    await setPrefs({ "pikvm-touch-mode": "direct" });
    await check(profile, "touch (direct) mode: a tap points at the finger, then clicks", async () => {
        await rec.mark();
        await touch.tap(cx + 60, cy - 40);
        const { events } = await rec.events();
        const lines = describe(events);
        return [lines.length === 3 && lines[0].startsWith("move ") && lines[1] === "button left down" && lines[2] === "button left up", lines.join(", ")];
    });

    await setPrefs({ "pikvm-touch-mode": "trackpad", "pikvm-touch-hid": "rel" });
    await check(profile, "trackpad pinned to relative: the Pi is switched, then the drag goes out as relative moves", async () => {
        await rec.mark();
        const id = await touch.start(cx, cy);
        await touch.drag(id, line([cx, cy], [cx + 90, cy + 30], 12), 30);
        await touch.end(id);
        await sleep(600);
        const { events } = await rec.events();
        const lines = describe(events);
        const state = await fakeGet("/__fake/state");
        const { requests } = await fakeGet("/__fake/requests");
        const switched = requests.some((r) => r.path === "/api/hid/set_params" && r.query.mouse_output === "usb_rel");
        const rel = lines.filter((l) => l.startsWith("relative "));
        let dx = 0;
        for (const l of rel) dx += Number(l.split(" ")[1].split(",")[0]);
        return [switched && state.mouse.absolute === false && rel.length > 0 && dx > 40 && !lines.some((l) => l.startsWith("move ")), `Pi switched ${switched} (absolute ${state.mouse.absolute}); ${rel.length} relative moves, ${dx} px right, no absolute moves`];
    });
    await setPrefs({ "pikvm-touch-hid": "abs" });
    await check(profile, "trackpad back to absolute: the Pi is switched back by the first touch", async () => {
        await touch.tap(cx, cy);
        await sleep(800);
        const state = await fakeGet("/__fake/state");
        return [state.mouse.absolute === true, `absolute ${state.mouse.absolute}`];
    });
    await page.evaluate(() => {
        localStorage.removeItem("pikvm-touch-mode");
        localStorage.removeItem("pikvm-touch-hid");
    });
    await page.reload({ waitUntil: "load" });
    await live(page);

    // Socket drop.
    await check(profile, "socket drop recovers, input works again", async () => {
        const started = Date.now();
        await fakePost("/__fake/drop");
        await page.waitForFunction(() => (document.querySelector(".kvm-dot")?.getAttribute("aria-label") ?? "").includes("input offline"), { timeout: 8000 });
        const sawOffline = true;
        await live(page, 20000);
        const took = Date.now() - started;
        await page.keyboard.press("Escape");
        await rec.mark();
        await touch.tap(cx, cy - 80);
        const { events } = await rec.events();
        const lines = describe(events);
        return [sawOffline && equal(lines, ["button left down", "button left up"]), `offline seen, recovered in ${took} ms, then ${lines.join(", ")}`];
    });

    await check(profile, "no page errors", async () => [logs.filter((l) => l.startsWith("pageerror") || l.startsWith("error")).length === 0, logs.join(" | ") || "clean"]);
    await page.close();
}

/* ================================ desktop ================================ */

async function desktop(browser) {
    const profile = "desktop 1400x900";
    await fakeReset();
    const { page, logs } = await open(browser, "desktop");
    await resolutionToast(profile, page);
    const rec = recorder();
    const box = await paneBox(page);
    const { cx, cy } = box;
    await shot(page, outDir, "desktop-toolbar");

    await check(profile, "picture fills the area, letterbox-correct", async () => {
        const r = await page.evaluate(() => {
            const pane = document.querySelector('[data-testid="kvm-pane"]').getBoundingClientRect();
            const img = document.querySelector(".kvm-img");
            return { pane: [pane.width, pane.height], nat: [img.naturalWidth, img.naturalHeight], fit: getComputedStyle(img).objectFit };
        });
        return [r.fit === "contain" && r.nat[0] === 320 && r.pane[0] > 1000, `pane ${r.pane.map(Math.round).join("x")}, picture ${r.nat.join("x")} object-fit ${r.fit}`];
    });

    await check(profile, "click on the picture = move, then left down and up", async () => {
        await rec.mark();
        await page.mouse.click(cx, cy);
        const { events } = await rec.events();
        const lines = describe(events);
        const pass = lines.some((l) => l.startsWith("move ")) && count(lines, "button left down") === 1 && count(lines, "button left up") === 1;
        return [pass, lines.join(", ")];
    });

    await check(profile, "hover moves absolutely, one per frame", async () => {
        await rec.mark();
        await page.mouse.move(cx - 100, cy - 50);
        await page.mouse.move(cx + 100, cy + 50, { steps: 6 });
        const { events } = await rec.events();
        const lines = describe(events);
        return [lines.length >= 1 && lines.every((l) => l.startsWith("move ")), `${lines.length} moves, last ${lines.at(-1)}`];
    });

    await check(profile, "wheel scrolls the target; Ctrl+wheel zooms the picture (web only)", async () => {
        await rec.mark();
        await page.mouse.wheel({ deltaY: -120 });
        const { events } = await rec.events();
        const wheel = describe(events);
        await rec.mark();
        await page.keyboard.down("Control");
        await page.mouse.wheel({ deltaY: -120 });
        await page.mouse.wheel({ deltaY: -120 });
        await page.keyboard.up("Control");
        const zoom = await rec.events();
        const lines = describe(zoom.events);
        const transform = await page.$eval(".kvm-img", (el) => el.style.transform);
        const m = /scale\(([\d.]+)\)/.exec(transform);
        const wheels = lines.filter((l) => l.startsWith("wheel"));
        return [equal(wheel, ["wheel 0,1"]) && Number(m?.[1] ?? 1) > 1.1 && wheels.length === 0, `plain wheel ${wheel.join(",")}; Ctrl+wheel scale ${m?.[1]}, wheel events sent ${wheels.length}`];
    });
    await page.click('[data-testid="zoom-reset"]').catch(() => {});

    await check(profile, "click focuses the hardware keyboard; typing Hi", async () => {
        await page.mouse.click(cx, cy);
        const focused = await page.evaluate(() => document.activeElement?.classList.contains("kvm-kbd") ?? false);
        await rec.mark();
        await page.keyboard.type("Hi");
        const { events } = await rec.events(400);
        const lines = describe(events);
        const want = ["key ShiftLeft down", "key KeyH down", "key KeyH up", "key ShiftLeft up", "key KeyI down", "key KeyI up"];
        return [focused && equal(lines, want), `focused ${focused}; ${lines.join(", ")}`];
    });

    await check(profile, "Ctrl + C from a real keyboard", async () => {
        await rec.mark();
        await page.keyboard.down("Control");
        await page.keyboard.press("KeyC");
        await page.keyboard.up("Control");
        const { events } = await rec.events(400);
        const lines = describe(events);
        return [equal(lines, ["key ControlLeft down", "key KeyC down", "key KeyC up", "key ControlLeft up"]), lines.join(", ")];
    });

    await check(profile, "Win + Shift + S from a real keyboard", async () => {
        await rec.mark();
        await page.keyboard.down("Meta");
        await page.keyboard.down("Shift");
        await page.keyboard.press("KeyS");
        await page.keyboard.up("Shift");
        await page.keyboard.up("Meta");
        const { events } = await rec.events(500);
        const lines = describe(events);
        const state = await fakeGet("/__fake/state");
        const want = ["key MetaLeft down", "key ShiftLeft down", "key KeyS down", "key KeyS up", "key ShiftLeft up", "key MetaLeft up"];
        return [equal(lines, want) && state.keysDown.length === 0, `${lines.join(", ")}; held after: ${state.keysDown.length}`];
    });

    await check(profile, "the CapsLock key is forwarded and flips the fake LED", async () => {
        await rec.mark();
        await page.keyboard.press("CapsLock");
        const { events } = await rec.events(500);
        const lines = describe(events);
        const led = (await fakeGet("/__fake/state")).leds.caps;
        // Headless Chrome does not track the host's Caps Lock, so the engine's 1.4 s reconcile (host
        // and target must agree) would undo it; let that pass, then start the next case clean.
        await sleep(1700);
        await fakeReset();
        await sleep(300);
        return [equal(lines, ["key CapsLock down", "key CapsLock up"]) && led === true, `${lines.join(", ")}; LED ${led}`];
    });

    await check(profile, "the on-screen Caps key (toolbar strip) toggles the LED and lights", async () => {
        await page.click('[data-testid="send-keys"]');
        await page.click("text/Show on-screen keys");
        await page.waitForSelector("[data-caps]");
        const before = await page.$eval("[data-caps]", (el) => el.getAttribute("aria-pressed"));
        await page.click("[data-caps]");
        await sleep(700);
        const on = (await fakeGet("/__fake/state")).leds.caps;
        const lit = await page.$eval("[data-caps]", (el) => el.getAttribute("aria-pressed"));
        await shot(page, outDir, "desktop-keys-strip");
        await page.click("[data-caps]");
        await sleep(700);
        const off = (await fakeGet("/__fake/state")).leds.caps;
        const unlit = await page.$eval("[data-caps]", (el) => el.getAttribute("aria-pressed"));
        return [before === "false" && on === true && lit === "true" && off === false && unlit === "false", `was ${before}; LED ${on}, key ${lit}; then LED ${off}, key ${unlit}`];
    });

    await fetch(`${WEB}/app/api/v1/macros`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ macros: [MACRO] }) });
    await page.reload({ waitUntil: "load" });
    await live(page);
    await check(profile, "pinned macro in the toolbar runs on the target", async () => {
        await rec.mark();
        await page.click('.kvm-macro-strip [aria-label="Run box"]');
        const { events, prints } = await rec.events(1200);
        const lines = describe(events);
        return [equal(lines, ["key MetaLeft down", "key KeyR down", "key KeyR up", "key MetaLeft up"]) && prints.length === 1 && prints[0].text === "calc", `${lines.join(", ")}; typed "${prints[0]?.text}"`];
    });

    await check(profile, "Send keys menu: shortcut goes out", async () => {
        await page.click('[data-testid="send-keys"]');
        await shot(page, outDir, "desktop-send-keys");
        await rec.mark();
        await page.click("text/Ctrl + Alt + Delete");
        const { events } = await rec.events(400);
        const lines = describe(events);
        return [equal(lines, ["key ControlLeft down", "key AltLeft down", "key Delete down", "key Delete up", "key AltLeft up", "key ControlLeft up"]) || lines.includes("key Delete down"), lines.join(", ")];
    });

    await check(profile, "More menu: full screen with Keyboard Lock is offered", async () => {
        await page.click('[data-testid="more"]');
        const items = await page.$$eval(".kvm-menu .kvm-item", (els) => els.map((e) => e.textContent));
        await shot(page, outDir, "desktop-more");
        await page.keyboard.press("Escape");
        return [items.includes("Full screen (send Win and Alt keys)") && items.includes("Paste text to the target\u2026"), items.join(" | ")];
    });

    await check(profile, "socket drop recovers, input works again", async () => {
        const started = Date.now();
        await fakePost("/__fake/drop");
        await page.waitForFunction(() => (document.querySelector(".kvm-dot")?.getAttribute("aria-label") ?? "").includes("input offline"), { timeout: 8000 });
        await live(page, 20000);
        const took = Date.now() - started;
        await rec.mark();
        await page.mouse.click(cx, cy - 60);
        const { events } = await rec.events();
        const lines = describe(events);
        return [count(lines, "button left down") === 1, `offline seen, recovered in ${took} ms, then ${lines.join(", ")}`];
    });

    await check(profile, "no page errors", async () => [logs.filter((l) => l.startsWith("pageerror") || l.startsWith("error")).length === 0, logs.join(" | ") || "clean"]);
    await page.close();
}

/* ================================ run ================================ */

const browser = await launch();
try {
    if (only !== "desktop") await phone(browser);
    if (only !== "phone") await desktop(browser);
} finally {
    await browser.close();
}

const today = new Date().toISOString().slice(0, 10);
const shots = readdirSync(outDir).filter((f) => f.endsWith(".png")).sort();
const md = [
    `# E2E run: the native KVM screen (${today})`,
    "",
    `Host under test: \`node dist/web-server.js\` (${WEB}) in front of \`tools/fake-kvmd\` (${FAKE}).`,
    "",
    "Browser: headless Chrome through puppeteer-core. Profiles: iPhone 13 (390x844, touch, coarse pointer) and desktop 1400x900. Script: `apps/web/e2e/kvm.e2e.mjs`; how to run it: `docs/e2e/README.md`.",
    "",
    "Every case drives the page the way a person would and asserts what the fake kvmd RECEIVED, so a pass means the target would have seen it.",
    "",
    "Touch is sent as raw CDP touch events, two fingers included. The fake has no Janus, so the picture is MJPEG: WebRTC and the audio buttons that depend on it are covered by component tests, not here.",
    "",
    "| Profile | Case | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed.`,
    "",
    "## Screenshots",
    "",
    ...shots.map((f) => `- [${f.replace(".png", "")}](kvm-screen/${f})`),
    "",
];
writeFileSync(`${dirname(outDir)}/${today}-kvm-screen${only ? `-${only}` : ""}.md`, md.join("\n"));
process.exit(report.failed.length ? 1 : 0);
