// Fast alerts end to end, and how long they take: the real web host (node dist/web-server.js) with its own OCR worker, in front of
// tools/fake-kvmd (whose picture the run changes), with tools/fake-push as the push service (it decrypts what it is sent and
// records when it arrived) and tools/fake-chat-model as the chat model, which with none configured must be called zero times.
//
//   node apps/web/e2e/watch-fast.e2e.mjs [--runs 10] [--out docs/e2e/2026-11-05-fast-alerts.md]
//
// Needs dist/ built (yarn build), SHARP_MODULES (a node_modules with sharp) and OCR_NODE_MODULES (one with onnxruntime-node), and
// OCR_MODELS (the PP-OCRv4 models: `node scripts/fetch-ocr.mjs`). Writes the report under docs/e2e/.
//
// What is measured: for each of --runs toasts, shown on the fake PiKVM at a random moment, the time until the fake push service
// received the notification, and the host's own timestamps (checks.jsonl: frame captured, seen, held, read, decided, pushed). What
// is NOT measured, and the report says so: the model and the push service on a real network (there is no model in the fast path;
// the push service here is loopback), a real Pi's snapshot and the real Xeon.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { drawFastFrames, drawToastFrame, TOAST_DEFS } from "./watch-fast-frames.mjs";
import { CANARY, loadMeasure, sleep, startWatchStack, until } from "./watch-stack.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const runs = Number(arg("runs", "10"));
const reportPath = arg("out", `docs/e2e/${new Date().toISOString().slice(0, 10)}-fast-alerts.md`);
const home = process.env.HOME;
const sharpModules = process.env.SHARP_MODULES ?? join(home, ".cache/pikvm-e2e/sharp/node_modules");
const ocrModules = process.env.OCR_NODE_MODULES ?? join(home, ".cache/pikvm-e2e/ocr-bench/node_modules");
const ocrModels = process.env.OCR_MODELS ?? join(import.meta.dirname, "../../../builds/ocr/models");
if (!existsSync(join(ocrModels, "ch_PP-OCRv4_rec_infer.onnx"))) throw new Error(`no OCR models in ${ocrModels}: run node scripts/fetch-ocr.mjs, or set OCR_MODELS`);

const checks = [];
const check = (name, pass, observed) => {
    checks.push({ name, pass, observed });
    console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const ms = (n) => `${Math.round(n)} ms`;
const sharp = (await import("node:module")).createRequire(`${sharpModules}/`)("sharp");
const frames = await drawFastFrames(sharpModules);
const measure = await loadMeasure();
const { limits } = measure;

// ---- the threshold, measured on the run's own frames -------------------------------------------------------------------------
const ops = measure.createSharpImageOps();
const grid = (jpeg) => ops.gray(jpeg, limits.GRID_WIDTH, limits.GRID_HEIGHT);
const cells = measure.zoneCells({ x0: 0.62, y0: 0.55, x1: 1, y1: 1 });
const zoneCellCount = (cells.x1 - cells.x0) * (cells.y1 - cells.y0);
const pct = (a, b) => measure.zoneChangedFraction(a, b, cells) * 100;
const thresholdRows = [];
{
    const noiseNames = { caret: "a blinking caret in a text box", clock: "the taskbar clock's minute digit", clockAndDate: "the clock and the date at midnight", tray: "a tray icon changing colour and gaining a badge", pointer: "the mouse pointer moving into the zone" };
    let worstNoise = 0;
    let weakestToast = 100;
    for (const background of ["dark", "bright"]) {
        const idle = await grid(frames[background].idle);
        for (const [name, label] of Object.entries(noiseNames)) {
            const value = pct(idle, await grid(frames[background][name]));
            worstNoise = Math.max(worstNoise, value);
            thresholdRows.push(`| ${label} | ${background} | ${value.toFixed(2)}% | no |`);
        }
        const spinner = pct(await grid(frames[background].spinnerA), await grid(frames[background].spinnerB));
        worstNoise = Math.max(worstNoise, spinner);
        thresholdRows.push(`| a 40 px spinner turning a quarter | ${background} | ${spinner.toFixed(2)}% | no |`);
        for (const name of Object.keys(TOAST_DEFS)) {
            const value = pct(idle, await grid(frames[background][name]));
            weakestToast = Math.min(weakestToast, value);
            thresholdRows.push(`| toast: ${name} | ${background} | ${value.toFixed(2)}% | yes |`);
        }
    }
    const raw = await sharp(frames.dark.idle).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const noisy = Buffer.from(raw.data);
    for (let i = 0; i < noisy.length; i++) noisy[i] = Math.max(0, Math.min(255, noisy[i] + Math.round((Math.random() - 0.5) * 6)));
    const reencoded = await sharp(frames.dark.idle).jpeg({ quality: 60 }).toBuffer();
    const codec = await sharp(noisy, { raw: raw.info }).jpeg({ quality: 80 }).toBuffer();
    const idle = await grid(frames.dark.idle);
    for (const [label, jpeg] of [["the same frame re-encoded at JPEG quality 60", reencoded], ["the same frame with +-3 grey noise on every pixel", codec]]) {
        const value = pct(idle, await grid(jpeg));
        worstNoise = Math.max(worstNoise, value);
        thresholdRows.push(`| ${label} | dark | ${value.toFixed(2)}% | no |`);
    }
    const line = limits.ZONE_CHANGE_FRACTION * 100;
    check("threshold: every kind of noise is under the zone line and every toast is over it", worstNoise < line && weakestToast > line, `line ${line}% of ${zoneCellCount} cells; worst noise ${worstNoise.toFixed(2)}% (${(line / worstNoise).toFixed(1)}x under the line); weakest toast ${weakestToast.toFixed(2)}% (${(weakestToast / line).toFixed(1)}x over it)`);
}

// ---- the host cost of a look: the grey grid of a 1920 x 1080 snapshot ---------------------------------------------------------
const lookCost = [];
for (let i = 0; i < 40; i++) {
    const start = performance.now();
    await ops.gray(frames.dark.email, limits.GRID_WIDTH, limits.GRID_HEIGHT);
    lookCost.push(performance.now() - start);
}
const jpegBytes = frames.dark.idle.length;

// ---- the stack -----------------------------------------------------------------------------------------------------------
const stack = await startWatchStack({
    env: {
        // The production pace is the default (1 s, 1.2 s, 4 s, 500 a day); these say so.
        PIKVM_WATCH_INTERVAL_MS: "1000",
        PIKVM_WATCH_SETTLE_MS: "1200",
        PIKVM_WATCH_MIN_GAP_SEC: "4",
        PIKVM_WATCH_DAILY_CAP: "500",
        NODE_PATH: `${sharpModules}:${ocrModules}`,
        PIKVM_OCR_MODELS: ocrModels,
        PIKVM_OCR_WORKER: join(import.meta.dirname, "../../../dist/ocr-worker.js"),
    },
});
const watchDir = () => join(stack.data, "chat", "users", "operator", "watch");
const log = () => {
    const file = join(watchDir(), "checks.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const cpuSeconds = (pid) => {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ");
    return (Number(stat[11]) + Number(stat[12])) / 100;
};
const childrenOf = (pid) => {
    try {
        return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
    } catch {
        return [];
    }
};

const rows = [];
const summaryRows = [];
let report = "";
try {
    await stack.show(frames.dark.idle);
    const device = await stack.pushSubscribe();
    await fetch(`${stack.web}/app/api/v1/watch/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: { endpoint: device.endpoint, keys: device.keys } }) });
    const hostPid = stack.host().child.pid;

    // The watch with no chat model configured: how often the PiKVM is asked, and what the host spends on it.
    const reply = await stack.patchWatch({ enabled: true });
    check("the watch switches on with no chat model and no key", reply.status === 200 && (await reply.json()).chatModel === false, `status ${reply.status}`);
    await sleep(4000);
    const fastBefore = await stack.snapshots();
    const fastCpu0 = cpuSeconds(hostPid);
    const workers0 = childrenOf(hostPid);
    await sleep(30_000);
    const fastSnapshots = (await stack.snapshots()) - fastBefore;
    const fastCpu = cpuSeconds(hostPid) - fastCpu0;
    check("it looks every second", fastSnapshots >= 27 && fastSnapshots <= 33, `${fastSnapshots} snapshots in 30 s; host CPU ${(fastCpu / 30 * 100).toFixed(1)}% (one core = 100%, this machine)`);
    check("the OCR worker is a process of its own and is warm before the first toast", workers0.length >= 1, `host pid ${hostPid}, child processes ${workers0.join(", ") || "none"}`);

    // ---- the toasts ------------------------------------------------------------------------------------------------------
    const NAMES = ["Anna Berg", "Ben Carter", "Priya Shah", "Dana Ruiz", "Omar Haddad", "Lena Voss", "Tomas Novak", "Yuki Tanaka", "Sara Lindqvist", "Marco Rossi", "Ines Duarte", "Paul Weber"];
    const SUBJECTS = ["Lunch on Thursday?", "Invoice 4471 is overdue", "Agenda for Monday", "Server maintenance tonight", "Your leave request", "Contract draft v3"];
    const kinds = ["email", "teams", "call"];
    const toastFor = (i) => {
        const kind = kinds[i % 3];
        const name = NAMES[i % NAMES.length];
        if (kind === "email") return { kind, name, def: { ...TOAST_DEFS.email, lines: [name, SUBJECTS[i % SUBJECTS.length], "Please let me know when you have a moment"] } };
        if (kind === "teams") return { kind, name, def: { ...TOAST_DEFS.teams, lines: [name, `Can you look at ticket ${4000 + i} when you are back?`] } };
        return { kind, name, def: { ...TOAST_DEFS.call, lines: [`${name} is calling you`] } };
    };
    let chatRequests = 0;
    let i = 0;
    for (const background of ["dark", "bright"]) {
        const count = background === "dark" ? Math.ceil(runs / 2) : Math.floor(runs / 2);
        if (count === 0) continue;
        // Changing the whole desktop is the whole-screen path's business (the corner changing as a whole is not a pop-up): let it settle before the toasts.
        await stack.show(frames[background].idle);
        await sleep(background === "dark" ? 2000 : 14_000);
        const orBefore = (await stack.orCalls()).length;
        for (let k = 0; k < count; k++, i++) {
            const { kind, name, def } = toastFor(i);
            const toast = await drawToastFrame(sharp, background, def);
            await sleep(2500 + Math.random() * 1000); // a random phase against the 1 s look cycle
            const receivedBefore = (await stack.pushReceived()).length;
            const logBefore = log().length;
            const shownAt = Date.now();
            await stack.show(toast);
            const got = await until(async () => {
                const list = await stack.pushReceived();
                return list.length > receivedBefore ? list[receivedBefore] : null;
            }, `the notification for toast ${i + 1}`, 15_000, 20);
            const entry = await until(() => log().slice(logBefore).find((each) => each.kind === "alert" && each.outcome === "pushed"), `the log line for toast ${i + 1}`, 5000, 50);
            const l = entry.latency;
            rows.push({
                i: i + 1,
                kind,
                background,
                name,
                appearToPush: got.at - shownAt,
                firstSeenToPush: l.sinceFirstSeenMs,
                captureToPush: l.totalMs,
                wait: l.firstSeenAt - shownAt,
                settle: l.detectedAt - l.firstSeenAt,
                ocrAndCrop: l.readAt - l.detectedAt,
                ocr: entry.read.ms,
                    push: l.pushedAt - l.readAt,
                payload: got.payload,
                urgency: got.urgency,
                ttl: got.ttl,
                entry,
            });
            console.log(`  toast ${i + 1} (${kind}, ${background}): ${ms(got.at - shownAt)} from the toast to the notification; ocr ${ms(entry.read.ms)}`);
            await sleep(call(kind) ? 4000 : 2500);
            await stack.show(frames[background].idle);
            await sleep(6000);
        }
        chatRequests += (await stack.orCalls()).length - orBefore;
    }
    function call(kind) {
        return kind === "call";
    }

    // ---- what each notification said --------------------------------------------------------------------------------------
    const wrong = rows.filter((row) => {
        const payload = row.payload ?? {};
        if (row.kind === "call") return !(payload.title === `Incoming call: ${row.name}` && row.urgency === "high" && row.ttl === 60 && /^pikvm-call-/.test(payload.tag));
        const title = row.kind === "email" ? "Outlook" : "Teams";
        return !(payload.title === title && String(payload.body).includes(row.name) && row.urgency === "normal" && row.ttl === 300);
    });
    check("each notification says what the toast said: a call is 'Incoming call: <who>' with urgency high and a 60 s TTL, mail and chat carry the sender and the message with urgency normal", wrong.length === 0, wrong.length === 0 ? `${rows.length} of ${rows.length} as expected` : `wrong: ${wrong.map((row) => `${row.i} ${JSON.stringify(row.payload)} ${row.urgency}/${row.ttl}`).join("; ")}`);
    check("with no chat model configured nothing is asked of any model", chatRequests === 0, `${chatRequests} requests to the fake chat model while ${rows.length} toasts were shown`);
    const entries = log();
    const words = ["Berg", "Carter", "Shah", "Lunch", "Invoice", "ticket", "calling"];
    const loud = words.filter((word) => JSON.stringify(entries).includes(word) || stack.logs().includes(word));
    check("the screen's words are in neither the check log nor the host's output", loud.length === 0, loud.length === 0 ? `none of ${words.join(", ")} found in ${entries.length} log lines or ${stack.logs().split("\n").length} output lines` : `found: ${loud.join(", ")}`);
    check("every toast was noticed once: no repeat", (await stack.pushReceived()).length === rows.length && entries.filter((entry) => entry.kind === "alert" && entry.outcome === "pushed").length === rows.length, `${(await stack.pushReceived()).length} notifications for ${rows.length} toasts`);

    // ---- a toast that is gone before the confirming look -------------------------------------------------------------------
    {
        const { name, def } = { name: "Gone Quickly", def: { ...TOAST_DEFS.teams, lines: ["Gone Quickly", "Back in five minutes, please call me"] } };
        const toast = await drawToastFrame(sharp, "bright", def);
        const before = (await stack.pushReceived()).length;
        await stack.show(frames.bright.idle);
        await sleep(2000);
        await stack.show(toast);
        await sleep(2000); // seen at one or two looks, and gone at or before the look that confirms it
        await stack.show(frames.bright.idle);
        const arrived = await until(async () => (await stack.pushReceived()).length > before, "a notification for the toast that was gone", 10_000, 50).catch(() => false);
        const last = (await stack.pushReceived()).at(-1);
        check("a toast that is up for only 2 s (gone at, or just before, the look that confirms it) is still notified", arrived && String(last?.payload?.body).includes(name), arrived ? `notified: ${JSON.stringify(last.payload).replace(/"[^"]*Gone Quickly[^"]*"/, '"…"')}` : "no notification");
        await sleep(6000);
    }

    // ---- with a chat model configured (the fake answers after a scripted delay) ---------------------------------------------------------
    {
        const SENTENCES = ["Zed Quinn asks if you can review ticket 5001", "Mara Lund asks you to look at ticket 5002 when you are back"];
        const DELAY = 350;
        await stack.setChatModel();
        await stack.orScript({ answers: SENTENCES, delayMs: DELAY });
        const view = await stack.watch();
        check("with a chat model set the page's view says so", view.chatModel === true, `chatModel ${view.chatModel}`);
        await stack.show(frames.bright.idle);
        await sleep(6000);
        const callsBefore = (await stack.orCalls()).length;
        const plan = [
            { kind: "email", name: "Zed Quinn", def: { ...TOAST_DEFS.email, lines: ["Zed Quinn", "Ticket 5001", "Could you review it today"] } },
            { kind: "teams", name: "Mara Lund", def: { ...TOAST_DEFS.teams, lines: ["Mara Lund", "Can you look at ticket 5002 when you are back?"] } },
            { kind: "call", name: "Kit Moreno", def: { ...TOAST_DEFS.call, lines: ["Kit Moreno is calling you"] } },
        ];
        for (const [k, item] of plan.entries()) {
            const toast = await drawToastFrame(sharp, "bright", item.def);
            await sleep(2500 + Math.random() * 1000);
            const receivedBefore = (await stack.pushReceived()).length;
            const logBefore = log().length;
            const shownAt = Date.now();
            await stack.show(toast);
            const got = await until(async () => {
                const list = await stack.pushReceived();
                return list.length > receivedBefore ? list[receivedBefore] : null;
            }, `the notification for toast ${k + 1} with a chat model`, 15_000, 20);
            const entry = await until(() => log().slice(logBefore).find((each) => each.kind === "alert" && each.outcome === "pushed"), "the log line", 5000, 50);
            summaryRows.push({ kind: item.kind, name: item.name, appearToPush: got.at - shownAt, captureToPush: entry.latency.totalMs, summaryMs: entry.summary?.ms, payload: got.payload, entry });
            console.log(`  toast with a chat model ${k + 1} (${item.kind}): ${ms(got.at - shownAt)} from the toast to the notification; model ${entry.summary ? ms(entry.summary.ms) : "not asked"}`);
            await sleep(item.kind === "call" ? 4000 : 2500);
            await stack.show(frames.bright.idle);
            await sleep(6000);
        }
        const asked = (await stack.orCalls()).slice(callsBefore);
        const [first, second, third] = summaryRows;
        check("with a chat model, each pop-up's body is the model's sentence and a call's is not asked about", first.payload.body === SENTENCES[0] && second.payload.body === SENTENCES[1] && third.payload.title === "Incoming call: Kit Moreno" && third.entry.summary === undefined, `bodies ${JSON.stringify(summaryRows.map((row) => row.payload.body.length))} characters; call title ${third.payload.title}`);
        check("the request carries the text and no image, and is made for two pop-ups out of three", asked.length === 2 && asked.every((request) => request.hasImage === false && request.model === "small" && request.authorization !== null), `${asked.length} requests to the fake chat model, image in ${asked.filter((request) => request.hasImage).length}; model ${asked[0]?.model}`);
        check("the log says the model's sentence was used, with its time, and holds no text", summaryRows.slice(0, 2).every((row) => row.entry.summary?.used === true && row.entry.summary.ms >= DELAY - 20) && !JSON.stringify(log()).includes("Zed Quinn"), `model ms ${summaryRows.slice(0, 2).map((row) => row.summaryMs).join(", ")} (the fake answers after ${DELAY} ms)`);
    }

    // ---- the report ------------------------------------------------------------------------------------------------------------
    const stat = (key) => rows.map((row) => row[key]);
    const summary = (key) => `${ms(Math.min(...stat(key)))} | ${ms(median(stat(key)))} | ${ms(Math.max(...stat(key)))}`;
    const cpu = os.cpus();
    const gitHead = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    report = [
        `# E2E run: the pop-up watch (${new Date().toISOString().slice(0, 10)})`,
        "",
        "A pop-up in the corner of the screen, from the moment it appears on the (fake) PiKVM to the notification arriving at the (fake) push service. The stack is the real web host with its own local OCR; the PiKVM, the push service and the chat model are the fakes in `tools/`.",
        "",
        "## Command and environment",
        "",
        "```sh",
        "yarn build",
        "node scripts/fetch-ocr.mjs                 # the PP-OCRv4 models, pinned in deploy/ocr.lock",
        `SHARP_MODULES=${sharpModules.replace(home, "~")} OCR_NODE_MODULES=${ocrModules.replace(home, "~")} OCR_MODELS=builds/ocr/models \\`,
        `  node apps/web/e2e/watch-fast.e2e.mjs --runs ${runs}`,
        "```",
        "",
        `- Machine: ${cpu[0].model} x${cpu.length}, load average at the start ${os.loadavg().map((n) => n.toFixed(2)).join(" ")}; Node ${process.version}; commit ${gitHead} plus the working tree; onnxruntime-node ${JSON.parse(readFileSync(join(ocrModules, "onnxruntime-node/package.json"), "utf8")).version}, 2 threads in the OCR worker.`,
        `- Frames: 1920 x 1080 JPEG (quality 85, ${(jpegBytes / 1024).toFixed(0)} KB for the idle desktop) drawn with sharp: a Windows-like desktop, a taskbar with a clock, and Outlook, Teams and Teams-call toasts at 100% scale in Open Sans (dark and white desktops alternating). Each toast has its own name and text.`,
        "- Pace: the production defaults: a look every 1 s, a pop-up held 1.2 s, a 4 s gap between checks, 500 a day. The toast is shown at a random moment against the 1 s look cycle, stays 2.5 s (a call 4 s), then the desktop is back for 6 s.",
        "- Rule: none; chat model: none for the main run (so no request is made to any model), the fake one for the last three toasts.",
        "",
        "## What was NOT measured",
        "",
        "- The push service on a real network. The fake push service is on loopback; a real FCM or Apple push adds its own delay (tens to hundreds of ms, sometimes seconds for a device that is asleep) after the host's send. Nothing here says how long a phone takes to show the notification.",
        "- A real chat model. With none configured (the main run) nothing is asked of any model; with the fake one the model's time is the fake's. A real model on the real network answered in 0.1 to 3 s when tried by hand (docs/deploy-web.md, \"The notification's words\"), and the host gives up on it after 2.5 s.",
        "- A real Pi. The fake kvmd answers a snapshot from memory; a real Pi's snapshot was measured by hand at 75 to 140 ms for a 123 KB JPEG (reported by the main agent, not by this run). The time to capture and encode is inside it and is not part of these numbers beyond the fake's.",
        "- The Xeon the image runs on: this is a workstation. The OCR benchmark on that Xeon is in `2026-11-05-fast-alerts-ocr.md`.",
        "",
        "## Latency, toast to notification",
        "",
        `${rows.length} toasts. "Toast to push" is measured outside the host, from the moment the fake PiKVM started serving the toast to the fake push service receiving it; the other columns are the host's own timestamps for the same toast (\`checks.jsonl\`).`,
        "",
        "| | min | median | max |",
        "| --- | --- | --- | --- |",
        `| **Toast to notification at the push service** | ${summary("appearToPush")} |`,
        `| Toast to the first look that saw it (waiting for the next 1 s look, and the snapshot) | ${summary("wait")} |`,
        `| First look to confirming look (the 1.2 s hold) | ${summary("settle")} |`,
        `| Frame captured to notification sent (what the log calls totalMs) | ${summary("captureToPush")} |`,
        `| First look to notification sent | ${summary("firstSeenToPush")} |`,
        `| Crop and OCR (confirming look to text ready) | ${summary("ocrAndCrop")} |`,
        `| of which the OCR read itself | ${summary("ocr")} |`,
        `| Push send (text ready to the fake push service answering; no chat model) | ${summary("push")} |`,
        "",
        "| # | kind | desktop | toast to push | first look to push | capture to push | wait for look | hold | crop + OCR | OCR | push | urgency / TTL |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...rows.map((row) => `| ${row.i} | ${row.kind} | ${row.background} | ${row.appearToPush} ms | ${row.firstSeenToPush} ms | ${row.captureToPush} ms | ${row.wait} ms | ${row.settle} ms | ${row.ocrAndCrop} ms | ${row.ocr} ms | ${row.push} ms | ${row.urgency} / ${row.ttl} s |`),
        "",
        "## With a chat model configured",
        "",
        "Two pop-ups are written up by the fake chat model (it answers after a scripted 350 ms) and a call is not asked about. **The fake model's latency is not a real model's**: the number to read is how much the model step adds to the host's own path.",
        "",
        "| kind | toast to push | capture to push | model |",
        "| --- | --- | --- | --- |",
        ...summaryRows.map((row) => `| ${row.kind} | ${row.appearToPush} ms | ${row.captureToPush} ms | ${row.summaryMs === undefined ? "not asked (calls never wait)" : `${row.summaryMs} ms`} |`),
        "",
        "## Cost of looking every second",
        "",
        `- Snapshots in 30 s: ${fastSnapshots} (every 1 s, plus one extra look per pending pop-up).`,
        `- The host's CPU over that 30 s idle window (utime + stime of the host process, one core = 100%): ${(fastCpu / 30 * 100).toFixed(1)}%, on this workstation. The whole of a look on the host is the fake kvmd round trip, decoding the 1920 x 1080 JPEG and reducing it to the 128 x 72 grey grid.`,
        `- The grey grid alone, sharp on this machine, 40 reads of a 1920 x 1080 JPEG: median ${median(lookCost).toFixed(1)} ms, max ${Math.max(...lookCost).toFixed(1)} ms.`,
        `- Bytes: one snapshot of this frame is ${(jpegBytes / 1024).toFixed(0)} KB, so a look a second is about ${((jpegBytes / 1024) * 1).toFixed(0)} KB/s from the Pi to the host (the real Pi's frame is 123 KB).`,
        "- What the Pi spends serving a snapshot a second was not measured here (see above); the main agent measured 75 to 140 ms per snapshot on the real one, which a look a second keeps busy for at most about 14% of a core.",
        "",
        "## Threshold: the zone's change fraction",
        "",
        `The default zone (bottom right, x 0.62 to 1, y 0.55 to 1) is ${cells.x1 - cells.x0} x ${cells.y1 - cells.y0} = ${zoneCellCount} cells of the 128 x 72 grid. The zone has changed when ${(limits.ZONE_CHANGE_FRACTION * 100).toFixed(1)}% of them did (${Math.ceil(limits.ZONE_CHANGE_FRACTION * zoneCellCount)} cells), a cell having changed when its grey level moved by ${limits.CELL_DELTA} of 255. Measured on this run's frames:`,
        "",
        "| what changed in the zone | desktop | fraction of the zone's cells | must fire |",
        "| --- | --- | --- | --- |",
        ...thresholdRows,
        "",
        "## Checks",
        "",
        "| Check | Observed | Result |",
        "| --- | --- | --- |",
        ...checks.map((c) => `| ${c.name} | ${String(c.observed).replace(/\|/g, "\\|")} | ${c.pass ? "pass" : "FAIL"} |`),
        "",
        `${checks.filter((c) => c.pass).length} of ${checks.length} passed.`,
        "",
    ].join("\n");
} finally {
    await stack.stop();
}
writeFileSync(reportPath, report);
console.log(`report: ${reportPath}`);
process.exit(checks.every((c) => c.pass) ? 0 : 1);
