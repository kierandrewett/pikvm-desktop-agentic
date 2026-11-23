// K111 against the REAL PiKVM through the loopback host: a microphone that is on comes back on with the session that
// replaces a dropped one. The drop is made by closing the page's Janus socket; the Pi, the media path and the retry are
// real. No HID input can leave the page (guard). The mic source must be silent (Chrome: a silent fake file, Firefox: the
// `pikvm_silence` null sink monitor); the run refuses before turning it on otherwise. Results: docs/e2e/2026-11-23-kvm-real-mic.md.
//   BROWSER=chrome|firefox node apps/web/e2e/kvm-real-mic-reconnect.mjs
//   GONE=1: before the drop the mic is pinned to a device that does not exist, as if it was unplugged; the replacement
//   must turn the mic off with the reason and bring the picture back without it (onMicFailed).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const puppeteer = require(`${process.env.PUPPETEER_CORE ?? `${process.env.HOME}/dev/sidekick/node_modules`}/puppeteer-core`);

const WEB = process.env.KVM_REAL_WEB ?? "http://127.0.0.1:8098";
const which = process.env.BROWSER ?? "firefox";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const GUARD = `(() => {
    const g = { wsBlocked: [], httpBlocked: [] };
    Object.defineProperty(window, "__guard", { value: g });
    const isEvents = (url) => /\\/api\\/ws(\\?|$)/.test(String(url));
    const janusSockets = [];
    Object.defineProperty(window, "__janus", { value: janusSockets });
    const WS = window.WebSocket;
    window.WebSocket = function (url, protocols) { const ws = protocols === undefined ? new WS(url) : new WS(url, protocols); if (/\\/janus\\/ws/.test(String(url))) janusSockets.push(ws); return ws; };
    window.WebSocket.prototype = WS.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
        if (isEvents(this.url)) {
            let type = "unparseable";
            try { type = JSON.parse(data).event_type; } catch {}
            if (type !== "ping") { g.wsBlocked.push(type); return; }
        }
        return origSend.call(this, data);
    };
    const path = (u) => { try { return new URL(String(u && u.url ? u.url : u), location.href).pathname; } catch { return String(u); } };
    const forbidden = (m, u) => String(m || "GET").toUpperCase() !== "GET" && path(u).startsWith("/api/");
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const m = (init && init.method) || (input && input.method) || "GET";
        if (forbidden(m, input)) { g.httpBlocked.push(m + " " + path(input)); return Promise.reject(new TypeError("blocked")); }
        return origFetch.apply(this, arguments);
    };
    const pcs = [];
    Object.defineProperty(window, "__pcs", { value: pcs });
    const PC = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...args) { const pc = new PC(...args); pcs.push(pc); return pc; };
    window.RTCPeerConnection.prototype = PC.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, PC);
    window.__audioContexts = 0;
    const AC = window.AudioContext;
    if (AC) { window.AudioContext = class extends AC { constructor(...a) { super(...a); window.__audioContexts++; } }; }
})();`;

const browser =
    which === "firefox"
        ? await puppeteer.launch({
              browser: "firefox",
              executablePath: "/usr/bin/firefox",
              headless: true,
              env: { ...process.env, PULSE_SOURCE: "pikvm_silence.monitor" },
              extraPrefsFirefox: { "media.navigator.permission.disabled": true, "media.autoplay.default": 0, "media.navigator.streams.fake": false, "media.audio_loopback_dev": "Monitor of pikvm_silence" },
          })
        : await puppeteer.launch({
              executablePath: "/usr/bin/google-chrome",
              headless: true,
              args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${process.env.HOME}/.cache/pikvm-wip/silence.wav`],
          });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.evaluateOnNewDocument(GUARD);
page.on("console", (m) => { const t = m.text(); if (/governor|janus|mic|Microphone|error/i.test(t)) log("console:", t.slice(0, 200)); });

const result = { browser: which };
try {
    await page.goto(`${WEB}/app/kvm`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => { const v = document.querySelector(".kvm-video"); return v && !v.classList.contains("hidden") && v.videoWidth > 0; }, { timeout: 45000 });
    log("WebRTC playing");
    // The source the browser would give: it must be the silent sink (Firefox) or the fake file (Chrome).
    const label = await page.evaluate(async () => { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); const l = s.getAudioTracks()[0]?.label; s.getTracks().forEach((t) => t.stop()); return l; });
    log("mic source label:", label);
    result.label = label;
    if (which === "firefox" && !/pikvm_silence/i.test(label ?? "")) throw new Error(`refusing: mic source is "${label}", not the silent sink`);
    if (which === "chrome" && !/fake/i.test(label ?? "")) throw new Error(`refusing: mic source is "${label}"`);

    const playing = () => page.waitForFunction(() => { const v = document.querySelector(".kvm-video"); return v && !v.classList.contains("hidden") && v.videoWidth > 0; }, { timeout: 45000 });
    const sent = () =>
        page.evaluate(async () => {
            const pc = window.__pcs.filter((p) => p.connectionState !== "closed").at(-1);
            let packets = null;
            if (pc) (await pc.getStats()).forEach((s) => { if (s.type === "outbound-rtp" && (s.kind === "audio" || s.mediaType === "audio")) packets = s.packetsSent; });
            return { pcs: window.__pcs.length, packets, mic: document.querySelector('[data-tb="mic"]')?.getAttribute("aria-pressed") ?? "absent" };
        });
    await page.click('[data-tb="mic"]');
    await sleep(3000);
    await playing();
    const before = await sent();
    log("mic on", JSON.stringify(before));
    result.dropAt = new Date().toISOString();
    const gone = process.env.GONE === "1";
    result.gone = gone;
    if (gone) await page.evaluate(() => localStorage.setItem("pikvm-console-mic-device", JSON.stringify({ id: "unplugged-e2e-device", label: "Unplugged" })));
    await page.evaluate(() => { for (const ws of window.__janus) ws.close(); });
    log("janus socket closed");
    await sleep(2000);
    await playing();
    await sleep(3000);
    const a = await sent();
    await sleep(3000);
    const b = await sent();
    result.before = before;
    result.after = [a, b];
    result.notices = await page.evaluate(() => document.body.innerText.match(/Microphone[^\n]*/g) ?? []);
    log("after reconnect", JSON.stringify(a), JSON.stringify(b));
    result.micTitle = await page.evaluate(() => document.querySelector('[data-tb="mic"]')?.getAttribute("title"));
    result.pass = gone
        ? before.mic === "true" && b.mic === "false" && b.pcs > before.pcs && (result.notices.some((n) => /could not open/.test(n)) || /gone|No mic|Denied/i.test(result.micTitle ?? ""))
        : before.mic === "true" && b.mic === "true" && b.pcs > before.pcs && b.packets > a.packets;
    if (gone) await page.evaluate(() => localStorage.removeItem("pikvm-console-mic-device"));
    if (b.mic === "true") await page.click('[data-tb="mic"]');
    await sleep(1500);
    result.guard = await page.evaluate(() => window.__guard);
} catch (e) {
    result.error = String(e);
    log("ERROR", e);
} finally {
    await browser.close();
}
console.log(JSON.stringify(result, null, 1));
