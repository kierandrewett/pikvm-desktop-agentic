// The microphone against the REAL PiKVM through the loopback host: turning it on restarts the session, WebRTC comes
// back, mic RTP is sent, and the meters are read (Firefox has no `audioLevel` in its stats). No HID input can leave the
// page (guard). The mic source must be silent (Chrome: a silent fake file, Firefox: the `pikvm_silence` null sink
// monitor); the run refuses before turning it on otherwise. Prerequisites and results: docs/e2e/2026-11-23-kvm-real-mic.md.
//   BROWSER=firefox|chrome node apps/web/e2e/kvm-real-mic.mjs
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

    const t0 = new Date().toISOString();
    result.micOnAt = t0;
    await page.click('[data-tb="mic"]');
    log("mic clicked");
    await sleep(3000);
    await page.waitForFunction(() => { const v = document.querySelector(".kvm-video"); return v && !v.classList.contains("hidden") && v.videoWidth > 0; }, { timeout: 30000 });
    log("WebRTC back after mic restart");
    const stats = async () =>
        page.evaluate(async () => {
            const pc = window.__pcs.filter((p) => p.connectionState !== "closed").at(-1);
            if (!pc) return { pc: false };
            const out = { pc: true, state: pc.connectionState, senders: pc.getSenders().map((s) => s.track && { kind: s.track.kind, state: s.track.readyState, muted: s.track.muted, enabled: s.track.enabled, label: s.track.label }), outbound: null, mediaSource: null };
            (await pc.getStats()).forEach((s) => {
                if (s.type === "outbound-rtp" && (s.kind === "audio" || s.mediaType === "audio")) out.outbound = { packetsSent: s.packetsSent, bytesSent: s.bytesSent, audioLevel: s.audioLevel ?? null };
                if (s.type === "media-source" && s.kind === "audio") out.mediaSource = { audioLevel: s.audioLevel ?? null, totalAudioEnergy: s.totalAudioEnergy ?? null };
            });
            const btn = document.querySelector('[data-tb="mic"]');
            out.button = { pressed: btn?.getAttribute("aria-pressed"), title: btn?.getAttribute("title"), vol: btn?.style.getPropertyValue("--vol") };
            return out;
        });
    const a = await stats();
    const samples = [];
    for (let i = 0; i < 16; i++) {
        samples.push(await page.evaluate(() => ({ mic: Number(document.querySelector('[data-tb="mic"]')?.style.getPropertyValue("--vol") || 0), speaker: Number(document.querySelector('[data-tb="audio"]')?.style.getPropertyValue("--vol") || 0) })));
        await sleep(250);
    }
    result.meterMax = { mic: Math.max(...samples.map((s) => s.mic)), speaker: Math.max(...samples.map((s) => s.speaker)) };
    result.audioContexts = await page.evaluate(() => window.__audioContexts);
    log("meter max", JSON.stringify(result.meterMax), "AudioContexts made", result.audioContexts);
    const b = await stats();
    result.a = a;
    result.b = b;
    log("stats A", JSON.stringify(a));
    log("stats B", JSON.stringify(b));
    await page.click('[data-tb="mic"]');
    result.micOffAt = new Date().toISOString();
    log("mic off");
    await sleep(2000);
    result.guard = await page.evaluate(() => window.__guard);
} catch (e) {
    result.error = String(e);
    log("ERROR", e);
} finally {
    await browser.close();
}
console.log(JSON.stringify(result, null, 1));
