// The screen watch end to end: the real web host (with the chat server in it) in front of tools/fake-kvmd whose picture the
// run changes, tools/fake-openrouter as OpenRouter, a real Chrome as the installed iPhone app (iPhone 13 emulation, standalone)
// subscribing for real through its push service, and tools/fake-push as a second device that decrypts what it is sent. It never
// touches a real PiKVM or OpenRouter.
//
//   node apps/web/e2e/watch.e2e.mjs [--out docs/e2e/screen-watch]
//
// Needs dist/ built (yarn build, yarn workspace @pikvm/web build), PUPPETEER_CORE (a node_modules with puppeteer-core), CHROME,
// SHARP_MODULES (a node_modules with sharp); see docs/e2e/README.md. Writes docs/e2e/<date>-screen-watch.md (the run against the
// fakes; the real-model smoke adds its own section, apps/web/e2e/watch-real.e2e.mjs).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { launch, puppeteer, Report } from "./harness.mjs";
import { CANARY, drawFrames, loadMeasure, sleep, startWatchStack, until } from "./watch-stack.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e/screen-watch";
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const report = new Report("Screen watch");
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const NOTIFY = "Notify me when the screen changes";

const check = async (name, fn) => {
    try {
        const [pass, observed] = await fn();
        report.add("iPhone 13", name, observed, pass);
    } catch (error) {
        report.add("iPhone 13", name, `threw: ${error.message}`, false);
    }
};

const frames = await drawFrames();
const stack = await startWatchStack({ openrouter: "fake" });
const browser = await launch();

const shot = async (page, name) => {
    await page.screenshot({ path: join(outDir, `${name}.png`) });
};

/** An installed iPhone app: iPhone 13 emulation, and Safari's `navigator.standalone`. */
async function openApp(path, { standalone }) {
    const page = await browser.newPage();
    await page.emulate(puppeteer.KnownDevices["iPhone 13"]);
    await page.evaluateOnNewDocument((value) => Object.defineProperty(navigator, "standalone", { configurable: true, value }), standalone);
    const problems = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error" && !/janus|Failed to load resource|WebSocket/.test(m.text())) problems.push(`console: ${m.text()}`);
    });
    await page.goto(`${stack.web}${path}`, { waitUntil: "load" });
    page.problems = problems;
    return page;
}

const textOf = (page) => page.evaluate(() => document.body.innerText);
const waitText = (page, re, timeout = 15000) =>
    page.waitForFunction((source, flags) => new RegExp(source, flags).test(document.body.innerText), { timeout }, re.source, re.flags);
const clickButton = (page, label) =>
    page.evaluate((text) => {
        const button = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text || b.getAttribute("aria-label") === text);
        if (!button) throw new Error(`no button "${text}"`);
        button.click();
    }, label);
const switchState = (page) =>
    page.evaluate((label) => {
        const el = document.querySelector(`button[role="switch"][aria-label="${label}"]`);
        return el ? { checked: el.getAttribute("aria-checked") === "true", disabled: el.disabled } : null;
    }, NOTIFY);
const watchFiles = () => join(stack.data, "chat", "users", "operator", "watch");
const logLines = () => {
    const file = join(watchFiles(), "checks.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const noiseCalls = async () => (await stack.orCalls()).length;

try {
    // ---- the threshold, measured with the host's own code on these frames ---------------------------------------------------
    await check("threshold: sub-threshold noise and a caret stay under it; a new line, a dialog's text and a dialog opening are over it", async () => {
        const { createSharpImageOps, changedFraction, limits } = await loadMeasure();
        const ops = createSharpImageOps();
        const grid = (jpeg) => ops.gray(jpeg, limits.GRID_WIDTH, limits.GRID_HEIGHT);
        const sharp = (await import("node:module")).createRequire(`${process.env.SHARP_MODULES ?? `${process.env.HOME}/.cache/pikvm-e2e/sharp/node_modules`}/`)("sharp");
        const reencoded = await sharp(frames.installing).jpeg({ quality: 60 }).toBuffer();
        const raw = await sharp(frames.installing).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        for (let i = 0; i < raw.data.length; i++) raw.data[i] = Math.max(0, Math.min(255, raw.data[i] + Math.round((Math.random() - 0.5) * 6)));
        const noisy = await sharp(raw.data, { raw: raw.info }).jpeg({ quality: 80 }).toBuffer();
        const pairs = [
            ["the same frame re-encoded at JPEG quality 60", frames.installing, reencoded, false],
            ["the same frame with +-3 grey noise on every pixel", frames.installing, noisy, false],
            ["a caret blinking", frames.installing, frames.caret, false],
            ["a dialog opening", frames.installing, frames.failed, true],
            ["a dialog's text and colour changing (failed -> done)", frames.failed, frames.done, true],
        ];
        const rows = [];
        let ok = true;
        for (const [name, a, b, fires] of pairs) {
            const fraction = changedFraction(await grid(a), await grid(b));
            const over = fraction >= limits.CHANGE_FRACTION;
            ok &&= over === fires;
            rows.push(`${name}: ${(fraction * 100).toFixed(2)}% ${over ? "over" : "under"}`);
        }
        return [ok, `threshold ${(limits.CHANGE_FRACTION * 100).toFixed(1)}% of ${limits.GRID_WIDTH * limits.GRID_HEIGHT} cells, cell delta ${limits.CELL_DELTA}; ${rows.join("; ")}`];
    });

    // ---- the page without a key, and on an iPhone that has not installed the app --------------------------------------------
    await stack.show(frames.installing);

    await check("no OpenRouter key: the page says what to add, and the switch cannot be turned on", async () => {
        const page = await openApp("/app/settings/notifications", { standalone: true });
        await waitText(page, /Add an OpenRouter key in Settings, Providers/);
        const state = await switchState(page);
        await shot(page, "01-no-key");
        const view = await stack.watch();
        await page.close();
        return [state?.disabled === true && state.checked === false && view.canEnable.ok === false, `switch ${JSON.stringify(state)}; server: canEnable=${JSON.stringify(view.canEnable).slice(0, 110)}`];
    });

    await check("the server refuses to switch it on without a key (409) and nothing polls the PiKVM", async () => {
        const before = await stack.snapshots();
        const res = await stack.patchWatch({ enabled: true });
        const body = await res.json();
        await sleep(5000);
        const after = await stack.snapshots();
        return [res.status === 409 && /OpenRouter key/.test(body.error) && after === before, `${res.status} "${body.error?.slice(0, 70)}"; snapshots ${before} -> ${after} over 5 s`];
    });

    await check("an iPhone in a Safari tab (not installed) is told to add the app to the Home Screen", async () => {
        await stack.setProvider();
        const page = await openApp("/app/settings/notifications", { standalone: false });
        await waitText(page, /Add to Home Screen/);
        const state = await switchState(page);
        await shot(page, "02-not-installed");
        await page.close();
        return [state?.disabled === true, `switch ${JSON.stringify(state)}; the message names Add to Home Screen`];
    });

    // ---- switching on, as the installed app --------------------------------------------------------------------------------
    const fakeDevice = await stack.pushSubscribe();
    let page;
    await check("switching on in the installed app: permission, a real push subscription, the server told, the watch running", async () => {
        await browser.defaultBrowserContext().overridePermissions(stack.web, ["notifications"]);
        await stack.orScript({
            describe: ["A terminal on Ubuntu runs apt install for postgresql-16; the progress line reads 68%.", "A dialog titled Installation failed says: could not configure postgresql-16, disk full. A terminal is behind it."],
            noul: [0.96],
        });
        page = await openApp("/app/settings/notifications", { standalone: true });
        await waitText(page, /Notify me when the screen changes/);
        await until(async () => (await switchState(page))?.disabled === false, "the switch becomes usable", 10000);
        await shot(page, "03-ready");
        await page.click('button[role="switch"]');
        await until(async () => (await stack.watch()).enabled, "the watch is switched on (the browser asks its push service first, which can take a while)", 90000, 500);
        await waitText(page, /Watching the screen/);
        await shot(page, "04-on");
        const view = await stack.watch();
        const subscribed = await page.evaluate(async () => {
            const reg = await navigator.serviceWorker.getRegistration("/app/");
            const sub = await reg?.pushManager.getSubscription();
            return sub ? new URL(sub.endpoint).hostname : null;
        });
        return [view.enabled && view.running && view.push.subscriptions >= 1 && subscribed !== null, `enabled=${view.enabled} running=${view.running} server devices=${view.push.subscriptions}; the browser's subscription is on ${subscribed}`];
    });

    // The second device: one the run can read what was pushed to.
    await fetch(`${stack.web}/app/api/v1/watch/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-host": "kvm.example.org", "x-forwarded-proto": "https" },
        body: JSON.stringify({ subscription: { endpoint: fakeDevice.endpoint, keys: fakeDevice.keys } }),
    });

    await check("it watches with no browser page open: the page is closed and the PiKVM is still being looked at", async () => {
        await page.close();
        const before = await stack.snapshots();
        await sleep(6500);
        const after = await stack.snapshots();
        return [after - before >= 2, `${after - before} snapshots in 6.5 s with no page open (interval 2 s)`];
    });

    // ---- what must not fire ----------------------------------------------------------------------------------------------------
    await check("a blinking caret and codec-sized noise cost nothing: no model is asked", async () => {
        const calls = await noiseCalls();
        await stack.show(frames.caret);
        await sleep(9000);
        await stack.show(frames.installing);
        await sleep(5000);
        const after = await noiseCalls();
        return [after === calls && logLines().length === 0, `model calls ${calls} -> ${after}; log lines ${logLines().length}`];
    });

    await check("a screen that never settles (alternating pictures) costs nothing, and coming back to what was there is not a change", async () => {
        const calls = await noiseCalls();
        await stack.fakePost("/__fake/picture?name=flicker");
        await sleep(10000);
        await stack.show(frames.installing);
        await sleep(7000);
        const after = await noiseCalls();
        return [after === calls && logLines().length === 0, `model calls ${calls} -> ${after}; log lines ${logLines().length}`];
    });

    // ---- a settled change: one check, one push --------------------------------------------------------------------------------
    await check("the screen changes and settles: one check (the frame before, the new frame, one decision) and one push", async () => {
        await stack.show(frames.failed);
        await until(async () => (await stack.pushReceived()).length >= 1, "the push reaches the device", 30000);
        await sleep(2500);
        const calls = await stack.orCalls();
        const describes = calls.filter((c) => c.kind === "describe");
        const decides = calls.filter((c) => c.kind === "decide");
        const received = await stack.pushReceived();
        const [push] = received;
        const lines = logLines();
        const ok =
            describes.length === 2 &&
            decides.length === 1 &&
            describes[0].image.sha256 === sha(frames.installing) &&
            describes[1].image.sha256 === sha(frames.failed) &&
            received.length === 1 &&
            push.payload.title === "PiKVM" &&
            push.payload.body.startsWith("A dialog titled Installation failed") &&
            push.payload.url === "/app/" &&
            lines.length === 1 &&
            lines[0].outcome === "pushed";
        return [ok, `describe x${describes.length} (the earlier frame, then the new one, hashes match what the kvmd served), decide x${decides.length}; fake device got ${received.length} push: ${JSON.stringify(push?.payload)}; log: ${lines.map((l) => l.outcome).join(",")}`];
    });

    await check("the key and the descriptions went as stored: Bearer key from Settings, Jev's state is {previous, current, rule}", async () => {
        const calls = await stack.orCalls();
        const decide = calls.find((c) => c.kind === "decide");
        const describe = calls.find((c) => c.kind === "describe");
        const ok =
            calls.every((c) => c.authorization === `Bearer ${CANARY.key}`) &&
            decide.model === "typesafe/jev-1.14" &&
            Object.keys(decide.state).sort().join() === "current,previous,rule" &&
            decide.state.previous.startsWith("A terminal on Ubuntu") &&
            decide.state.current.startsWith("A dialog titled Installation failed") &&
            describe.model === "google/gemma-3-12b-it";
        return [ok, `image model ${describe.model}, Jev ${decide.model}, rule ${JSON.stringify(decide.state.rule)}`];
    });

    await check("the VAPID signature verifies, the payload is aes128gcm for that device, and the push names the origin it subscribed from", async () => {
        const [push] = await stack.pushReceived();
        return [push.vapid.signatureValid && push.vapid.subject === "https://kvm.example.org" && push.vapid.audience === stack.push && push.urgency === "high", `signature ${push.vapid.signatureValid}, sub ${push.vapid.subject}, aud ${push.vapid.audience}, ttl ${push.ttl}`];
    });

    await check("the check log says why: score, both descriptions, Jev's answer, the model, the cost, pushed", async () => {
        const [line] = logLines();
        const ok = line.outcome === "pushed" && line.asked === true && line.noul === 0.96 && line.score > 0.003 && line.model === "google/gemma-3-12b-it" && line.previous.startsWith("A terminal") && line.description.startsWith("A dialog") && line.costUsd > 0 && line.push.sent >= 1;
        return [ok, JSON.stringify({ ...line, previous: line.previous.slice(0, 30) + "...", description: line.description.slice(0, 30) + "..." })];
    });

    await check("the real Chrome got the notification too (its own push service delivered it to the worker)", async () => {
        page = await openApp("/app/settings/notifications", { standalone: true });
        const shown = await until(
            async () => {
                const list = await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration("/app/")).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag })));
                return list.length > 0 ? list : null;
            },
            "Chrome shows the notification",
            25000,
        ).catch(() => null);
        await waitText(page, /recent checks/i).catch(async () => {
            await shot(page, "05-debug");
            throw new Error(`the page did not show its log: ${(await textOf(page)).replace(/\s+/g, " ").slice(0, 300)}`);
        });
        await sleep(600);
        await shot(page, "05-log-after-push");
        if (!shown) return [false, "no notification appeared in Chrome within 25 s (its push service did not deliver to this headless profile)"];
        return [shown.some((n) => n.body.startsWith("A dialog titled Installation failed") && n.tag === "pikvm-screen"), JSON.stringify(shown)];
    });

    // ---- Jev says no, or not sure ---------------------------------------------------------------------------------------------
    await check("Jev not decisive (0.5): a change is checked, logged as undecided, and nothing is pushed", async () => {
        await stack.orScript({ describe: ["A terminal says Installation complete: PostgreSQL 16 is running."], noul: [0.5] });
        const pushes = (await stack.pushReceived()).length;
        await stack.show(frames.done);
        await until(() => logLines().length >= 2, "the second check is logged", 40000);
        await sleep(1500);
        const line = logLines().at(-1);
        return [line.outcome === "undecided" && (await stack.pushReceived()).length === pushes, `outcome ${line.outcome}, noul ${line.noul}, reason "${line.reason}", pushes ${pushes} -> ${(await stack.pushReceived()).length}`];
    });

    await check("Jev says no (0.03): checked, logged as no, nothing pushed", async () => {
        await stack.orScript({ describe: ["The terminal again, the install still at 68%."], noul: [0.03] });
        const pushes = (await stack.pushReceived()).length;
        await stack.show(frames.installing);
        await until(() => logLines().length >= 3, "the third check is logged", 40000);
        await sleep(1500);
        const line = logLines().at(-1);
        return [line.outcome === "no" && (await stack.pushReceived()).length === pushes, `outcome ${line.outcome}, noul ${line.noul}, pushes unchanged at ${pushes}`];
    });

    await check("two changes inside the minimum gap are not two checks: the first is replaced, the newest is checked once the gap is over", async () => {
        await stack.orScript({ describe: ["A dialog says the install failed, disk full."], noul: [0.97] });
        const calls = (await stack.orCalls()).filter((c) => c.kind === "decide").length;
        const t0 = Date.now();
        await stack.show(frames.done); // settles inside the gap of the previous check: it waits
        await sleep(7500);
        await stack.show(frames.failed); // settles inside the gap too, and replaces it
        await until(() => logLines().length >= 5, "the replaced change and the checked one are logged", 40000);
        const last = logLines().slice(-2);
        const decides = (await stack.orCalls()).filter((c) => c.kind === "decide").length;
        // The newest change is checked once. Its two descriptions are the first check's (the same frames), so Jev's answer may come from the cache and cost nothing.
        const ok = decides <= calls + 1 && last[0].outcome === "skipped" && /replaced by a newer change/.test(last[0].reason) && last[1].outcome === "pushed" && last[1].asked === true && last[1].fromCache === (decides === calls);
        return [ok, `Jev asked ${decides - calls} more time(s)${last[1].fromCache ? " (the request was the first check's: answered from the cache, free)" : ""}; log: ${last.map((l) => `${l.outcome}${l.reason ? ` (${l.reason.slice(0, 40)}...)` : ""}`).join(" then ")}; ${((Date.now() - t0) / 1000).toFixed(0)} s`];
    });

    // ---- the daily cap ------------------------------------------------------------------------------------------------------
    await check("the daily cap holds (4 here): the fifth change asks nothing and the log says so", async () => {
        const asked = logLines().filter((l) => l.asked).length;
        const calls = await noiseCalls();
        await stack.orScript({ describe: ["x"], noul: [0.97] });
        await sleep(7000);
        await stack.show(frames.done);
        await until(() => logLines().some((l) => /daily cap/.test(l.reason ?? "")), "the cap is logged", 40000);
        await sleep(2000);
        const line = logLines().at(-1);
        const view = await stack.watch();
        return [asked === 4 && line.outcome === "skipped" && /daily cap of 4/.test(line.reason) && line.asked === false && (await noiseCalls()) === calls && view.limits.askedToday === 4, `${asked} checks asked, then: ${line.outcome} "${line.reason}"; model calls ${calls} -> ${await noiseCalls()}; the page's count askedToday=${view.limits.askedToday}`];
    });

    // ---- the test notification and an expired device --------------------------------------------------------------------------
    await check("Send test notification from the page reaches the devices; an expired one (410) is removed", async () => {
        const expired = await stack.pushSubscribe();
        await fetch(`${stack.web}/app/api/v1/watch/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: { endpoint: expired.endpoint, keys: expired.keys } }) });
        await stack.pushStatus(expired.id, 410);
        const devices = (await stack.watch()).push.subscriptions;
        const received = (await stack.pushReceived()).length;
        await page.reload({ waitUntil: "load" });
        await until(async () => !(await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Send test notification")?.disabled ?? true)), "the test button is usable", 10000);
        await clickButton(page, "Send test notification");
        await waitText(page, /Sent to \d+ device/);
        await shot(page, "06-test-sent");
        const note = await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent).find((t) => /^Sent to/.test(t ?? "")));
        const view = await stack.watch();
        const got = (await stack.pushReceived()).slice(received).filter((p) => p.payload.tag === "pikvm-test");
        const lastLine = logLines().at(-1);
        return [view.push.subscriptions === devices - 1 && got.length === 1 && /removed/.test(note) && lastLine.kind === "test", `devices ${devices} -> ${view.push.subscriptions}; the fake device received ${got.length} test push; page says "${note}"; log: ${lastLine.kind} ${lastLine.outcome}`];
    });

    // ---- the key goes away, the host restarts ----------------------------------------------------------------------------------
    await check("the key removed from Settings: the watch can no longer be switched on (409), and a change while it runs is logged without a model call", async () => {
        const calls = await noiseCalls();
        await stack.removeProvider();
        const view = await stack.watch();
        await stack.show(frames.installing);
        await sleep(9000);
        const line = logLines().at(-1);
        const callsAfter = await noiseCalls();
        await stack.patchWatch({ enabled: false });
        const refused = await stack.patchWatch({ enabled: true });
        await page.reload({ waitUntil: "load" });
        await waitText(page, /Add an OpenRouter key in Settings, Providers/);
        await shot(page, "07-key-removed");
        return [view.canEnable.ok === false && line.outcome === "skipped" && /no OpenRouter key/.test(line.reason) && callsAfter === calls && refused.status === 409, `canEnable.ok=${view.canEnable.ok}; the change was logged "${line.reason}"; model calls ${calls} -> ${callsAfter}; switching on: ${refused.status}`];
    });

    await check("a restart resumes the watch with no browser open, for whoever had it on", async () => {
        await page.close();
        await stack.setProvider();
        const on = await stack.patchWatch({ enabled: true });
        await stack.restartHost();
        const view = await stack.watch();
        const before = await stack.snapshots();
        await sleep(5000);
        const after = await stack.snapshots();
        return [on.status === 200 && view.enabled && view.running && after > before, `after the restart: enabled=${view.enabled} running=${view.running}; snapshots ${before} -> ${after} in 5 s`];
    });

    await check("switching off stops it: the PiKVM is no longer asked for snapshots", async () => {
        await stack.patchWatch({ enabled: false });
        await sleep(2500);
        const before = await stack.snapshots();
        await sleep(7000);
        const after = await stack.snapshots();
        const view = await stack.watch();
        return [after === before && view.running === false, `snapshots ${before} -> ${after} over 7 s; running=${view.running}`];
    });

    await check("the files: settings and log 0600 in a 0700 directory, the VAPID key file 0600, no secret in the log, the page or the host's output", async () => {
        const mode = (path) => (statSync(path).mode & 0o777).toString(8);
        const modes = {
            watchDir: mode(watchFiles()),
            settings: mode(join(watchFiles(), "settings.json")),
            log: mode(join(watchFiles(), "checks.jsonl")),
            subscriptions: mode(join(watchFiles(), "push-subscriptions.json")),
            vapid: mode(join(stack.data, "push-vapid.json")),
        };
        const vapid = JSON.parse(readFileSync(join(stack.data, "push-vapid.json"), "utf8"));
        const texts = [stack.logs(), readFileSync(join(watchFiles(), "checks.jsonl"), "utf8"), readFileSync(join(watchFiles(), "settings.json"), "utf8"), JSON.stringify(await stack.watch())];
        const leaked = texts.some((t) => t.includes(CANARY.key) || t.includes(vapid.privateKey) || t.includes(CANARY.kvmPassword));
        const ok = modes.watchDir === "700" && modes.settings === "600" && modes.log === "600" && modes.subscriptions === "600" && modes.vapid === "600" && !leaked;
        return [ok, `${JSON.stringify(modes)}; the provider key, the VAPID private key and the PiKVM password appear in none of them (leaked=${leaked})`];
    });
} finally {
    await browser.close();
    await stack.stop();
}

const shots = readdirSync(outDir).filter((f) => f.endsWith(".png")).sort();
const section = [
    "<!-- fakes:start -->",
    "## Run against the fakes",
    "",
    "Stack (`apps/web/e2e/watch-stack.mjs`): the web host (`node dist/web-server.js`) with the chat server in it, in front of `tools/fake-kvmd`, whose picture the run changes with `POST /__fake/picture?name=custom` (two frames drawn with sharp: a terminal installing a package, and the same with a failure dialog); `tools/fake-openrouter` as OpenRouter (key stored the way Settings, Providers stores it); `tools/fake-push`, a push service that decrypts what it is sent and checks the VAPID signature. The browser is headless Chrome in the iPhone 13 profile with Safari's `navigator.standalone` set, subscribing for real through its own push service. Pace for the run: look every 2 s, settle 3 s, one check per 20 s, 4 a day (`PIKVM_WATCH_*`; the defaults are 3 s, 6 s, 60 s and 200). No real PiKVM or OpenRouter is touched.",
    "",
    "| Case | Observed | Result |",
    "| --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed.`,
    "",
    "Screenshots:",
    "",
    ...shots.map((f) => `- [${f.replace(".png", "")}](${outDir.split("/").slice(-1)[0]}/${f})`),
    "<!-- fakes:end -->",
];
const file = `${dirname(outDir)}/${today}-screen-watch.md`;
const head = "# E2E run: the screen watch (" + today + ")\n\n";
const existing = existsSync(file) ? readFileSync(file, "utf8") : head;
const block = section.join("\n");
const replaced = /<!-- fakes:start -->[\s\S]*<!-- fakes:end -->/.test(existing) ? existing.replace(/<!-- fakes:start -->[\s\S]*<!-- fakes:end -->/, () => block) : `${existing.trimEnd()}\n\n${block}\n`;
writeFileSync(file, replaced);
process.exit(report.failed.length ? 1 : 0);
