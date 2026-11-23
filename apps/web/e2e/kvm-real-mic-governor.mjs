// K126 against the REAL PiKVM through the loopback host: with the mic on, a weak-link verdict must not hold WebRTC.
// The weak link is injected (getStats reports a 1 s round trip); the media path itself is real. MIC=off is the control:
// the same evidence must hold WebRTC there. No HID input can leave the page (guard). The mic source must be silent
// (Chrome: a silent fake file, Firefox: the `pikvm_silence` null sink monitor); the run refuses before turning it on
// otherwise. Prerequisites and results: docs/e2e/2026-11-23-kvm-real-mic.md.
//   BROWSER=chrome MIC=on|off node apps/web/e2e/kvm-real-mic-governor.mjs
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
    const origGetStats = PC.prototype.getStats;
    window.__bad = false;
    PC.prototype.getStats = async function (...a) {
        const report = await origGetStats.apply(this, a);
        if (!window.__bad) return report;
        const copy = new Map();
        report.forEach((v, k) => copy.set(k, v.type === "candidate-pair" ? { ...v, currentRoundTripTime: 1.0 } : v));
        return copy;
    };
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
page.on("console", (m) => { const t = m.text(); if (/governor|Weak|Microphone/i.test(t)) { log("console:", t.slice(0, 200)); (globalThis.__con ??= []).push(t.slice(0,200)); } });

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

    const micOn = process.env.MIC === "on";
    const playing = () => page.evaluate(() => { const v = document.querySelector(".kvm-video"); return !!v && !v.classList.contains("hidden") && v.videoWidth > 0; });
    if (micOn) {
        await page.click('[data-tb="mic"]');
        await sleep(3000);
        await page.waitForFunction(() => { const v = document.querySelector(".kvm-video"); return v && !v.classList.contains("hidden") && v.videoWidth > 0; }, { timeout: 30000 });
        log("mic on, WebRTC back");
    }
    result.mic = micOn;
    await page.evaluate(() => { window.__bad = true; });
    log("bad RTT injected");
    const timeline = [];
    for (let i = 0; i < 20; i++) {
        await sleep(1000);
        timeline.push(await page.evaluate(() => ({ video: (() => { const v = document.querySelector(".kvm-video"); return !!v && !v.classList.contains("hidden") && v.videoWidth > 0; })(), mic: document.querySelector('[data-tb="mic"]')?.getAttribute("aria-pressed") ?? "absent" })));
    }
    result.timeline = timeline.map((t) => `${t.video ? "V" : "-"}${t.mic === "true" ? "M" : t.mic === "absent" ? "x" : "m"}`).join(" ");
    result.finalPlaying = await playing();
    result.notices = await page.evaluate(() => [...document.querySelectorAll("[role=status], .notice, .toast")].map((n) => n.textContent.trim()).filter(Boolean).slice(-4));
    await page.evaluate(() => { window.__bad = false; });
    if (micOn && (await page.$('[data-tb="mic"][aria-pressed="true"]'))) await page.click('[data-tb="mic"]');
    await sleep(1500);
    result.guard = await page.evaluate(() => window.__guard);
} catch (e) {
    result.error = String(e);
    log("ERROR", e);
} finally {
    await browser.close();
}
result.console = globalThis.__con ?? []; console.log(JSON.stringify(result));
