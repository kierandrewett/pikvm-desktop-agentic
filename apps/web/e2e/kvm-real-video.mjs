// WebRTC and audio evidence from the REAL PiKVM, VIDEO ONLY, never input.
//
// The target is somebody's working machine, so this run is built so that it cannot send input
// even if the app has a bug:
//   - an init script, installed before any page script runs, wraps WebSocket.prototype.send and
//     drops every frame on the kvmd event socket (/api/ws) except `ping`;
//   - the same script rejects any fetch, XHR or beacon that is not a GET to /api/ (hid, atx, msd,
//     gpio, streamer params, print);
//   - the run performs no pointer or keyboard action at all: it loads the page and watches.
// Everything the guard saw is logged and written to the report. No screenshot of the target is
// kept in the repository.
//
//   node apps/web/e2e/kvm-real-video.mjs        (host on KVM_REAL_WEB, default http://127.0.0.1:8098)

import { writeFileSync } from "node:fs";
import { launch, sleep } from "./harness.mjs";

const WEB = process.env.KVM_REAL_WEB ?? "http://127.0.0.1:8098";

const GUARD = `(() => {
    const log = { wsSent: [], wsBlocked: [], httpBlocked: [], httpGets: 0 };
    Object.defineProperty(window, "__guard", { value: log });
    const isEvents = (url) => /\\/api\\/ws(\\?|$)/.test(String(url));
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
        if (isEvents(this.url)) {
            let type = "unparseable";
            try { type = JSON.parse(data).event_type; } catch {}
            if (type !== "ping") { log.wsBlocked.push(type); return; }
            log.wsSent.push("ping");
        }
        return origSend.call(this, data);
    };
    const path = (u) => { try { return new URL(String(u && u.url ? u.url : u), location.href).pathname; } catch { return String(u); } };
    const forbidden = (method, u) => String(method || "GET").toUpperCase() !== "GET" && path(u).startsWith("/api/");
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const method = (init && init.method) || (input && input.method) || "GET";
        if (forbidden(method, input)) {
            log.httpBlocked.push(method + " " + path(input));
            return Promise.reject(new TypeError("blocked by the video-only guard"));
        }
        log.httpGets++;
        return origFetch.apply(this, arguments);
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) { this.__g = forbidden(method, url) ? method + " " + path(url) : null; return open.apply(this, arguments); };
    const xsend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
        if (this.__g) { log.httpBlocked.push(this.__g); this.abort(); return; }
        return xsend.apply(this, arguments);
    };
    const beacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
    if (beacon) navigator.sendBeacon = (u, d) => (path(u).startsWith("/api/") ? (log.httpBlocked.push("BEACON " + path(u)), false) : beacon(u, d));
})();`;

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.evaluateOnNewDocument(GUARD);
const pageLog = [];
page.on("console", (m) => pageLog.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => pageLog.push(`pageerror: ${e.message}`));

const rows = [];
const add = (name, observed, pass) => {
    rows.push({ name, observed, pass });
    console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};

await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });

// The resolution toast is on screen only 2.6 s: watch for it from inside the page.
await page.evaluate(() => {
    window.__toasts = new Set();
    new MutationObserver(() => {
        const text = document.querySelector(".kvm-res-toast")?.textContent?.trim();
        if (text) window.__toasts.add(text);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
});

let swapped = true;
try {
    await page.waitForFunction(
        () => {
            const v = document.querySelector(".kvm-video");
            return v && !v.classList.contains("hidden") && !v.classList.contains("warming") && v.videoWidth > 0;
        },
        { timeout: 45000 },
    );
} catch {
    swapped = false;
}
add("WebRTC video took over from MJPEG", swapped ? "the <video> is shown, playing, with a size" : "never swapped within 45 s", swapped);

const snap = () =>
    page.evaluate(async () => {
        const v = document.querySelector(".kvm-video");
        const q = v.getVideoPlaybackQuality?.();
        const stream = v.srcObject instanceof MediaStream ? v.srcObject : null;
        return {
            width: v.videoWidth,
            height: v.videoHeight,
            time: v.currentTime,
            frames: q ? q.totalVideoFrames : null,
            dropped: q ? q.droppedVideoFrames : null,
            paused: v.paused,
            muted: v.muted,
            videoTracks: stream ? stream.getVideoTracks().map((t) => ({ state: t.readyState, enabled: t.enabled })) : [],
            audioTracks: stream ? stream.getAudioTracks().map((t) => ({ state: t.readyState, enabled: t.enabled, muted: t.muted })) : [],
        };
    });

const a = await snap();
await sleep(3000);
const b = await snap();
const advanced = b.frames !== null && a.frames !== null && b.frames - a.frames > 10 && b.time > a.time;
add("video frames advance", `${a.frames} then ${b.frames} frames in 3 s (${((b.frames - a.frames) / 3).toFixed(1)} fps); currentTime ${a.time.toFixed(2)} to ${b.time.toFixed(2)}; dropped ${b.dropped}`, advanced);
add("audio track present", `${b.audioTracks.length} audio track(s) ${JSON.stringify(b.audioTracks)}; ${b.videoTracks.length} video track(s)`, b.audioTracks.length > 0);

const ui = await page.evaluate(() => ({
    status: document.querySelector(".kvm-status")?.textContent,
    audioButton: !!document.querySelector('[data-tb="audio"]'),
    micButton: !!document.querySelector('[data-tb="mic"]'),
    audioPressed: document.querySelector('[data-tb="audio"]')?.getAttribute("aria-pressed"),
    toasts: [...window.__toasts],
}));
const label = ui.toasts.find((t) => /WebRTC/.test(t)) ?? "";
const m = /^(\d+) \u00d7 (\d+)\s+\u00b7\s+HD \u00b7 WebRTC/.exec(label);
const labelOk = !!m && Number(m[1]) === b.width && Number(m[2]) === b.height;
add("resolution label correct", `${JSON.stringify(ui.toasts)}; <video> is ${b.width}x${b.height}`, labelOk);
add("status chip and audio buttons", `chip "${ui.status}"; speaker ${ui.audioButton} (pressed ${ui.audioPressed}), mic ${ui.micButton}`, ui.status === "Live" && ui.audioButton && ui.micButton);

const guard = await page.evaluate(() => window.__guard);
add(
    "guard: zero HID frames and zero non-GET /api/ requests left the page",
    `event-socket frames sent: ${JSON.stringify(guard.wsSent.reduce((n, t) => ({ ...n, [t]: (n[t] ?? 0) + 1 }), {}))}; blocked frames: ${JSON.stringify(guard.wsBlocked)}; blocked requests: ${JSON.stringify(guard.httpBlocked)}; GETs: ${guard.httpGets}`,
    guard.wsBlocked.length === 0 && guard.httpBlocked.length === 0 && guard.wsSent.every((t) => t === "ping"),
);
const errors = pageLog.filter((l) => l.startsWith("pageerror") || (l.startsWith("error") && !/favicon/.test(l)));
add("no page errors", errors.join(" | ") || "clean", errors.length === 0);

// The guard itself must work: what a bug would send is stopped here, with nothing on the network
// (the wrapper is called on a stand-in socket, and the fetch is rejected before it is issued).
const selfTest = await page.evaluate(async () => {
    const before = { ws: window.__guard.wsBlocked.length, http: window.__guard.httpBlocked.length };
    const standIn = { url: "ws://127.0.0.1/api/ws" };
    WebSocket.prototype.send.call(standIn, JSON.stringify({ event_type: "key", event: { key: "KeyA", state: true } }));
    WebSocket.prototype.send.call(standIn, JSON.stringify({ event_type: "mouse_button", event: { button: "left", state: true } }));
    let rejected = 0;
    for (const [url, method] of [["/api/hid/print", "POST"], ["/api/atx/click?button=power", "POST"], ["/api/msd/set_params", "POST"], ["/api/gpio/switch", "POST"], ["/api/streamer/set_params", "POST"]]) {
        await fetch(url, { method, body: "x" }).catch(() => rejected++);
    }
    const x = new XMLHttpRequest();
    x.open("POST", "/api/hid/reset");
    x.send();
    return { ws: window.__guard.wsBlocked.length - before.ws, http: window.__guard.httpBlocked.length - before.http, rejected };
});
add("guard self-test: injected HID frames and POSTs are stopped before the network", `2 injected frames blocked: ${selfTest.ws}; 5 fetch POSTs rejected: ${selfTest.rejected}; blocked requests logged: ${selfTest.http} of 6 (5 fetch + 1 XHR)`, selfTest.ws === 2 && selfTest.rejected === 5 && selfTest.http === 6);

await page.screenshot({ path: `${process.env.HOME}/.cache/kvm-e2e/real-video.png` });
await browser.close();

const today = new Date().toISOString().slice(0, 10);
const md = [
    `# E2E run: WebRTC and audio against the real PiKVM, video only (${today})`,
    "",
    "Host: `node dist/web-server.js` on loopback, pointed at the real PiKVM from the desktop app's config (credentials from the config, never printed). Browser: headless Chrome through puppeteer-core. Script: `apps/web/e2e/kvm-real-video.mjs`.",
    "",
    "Input was impossible by construction. An init script, installed before the page's own scripts, dropped every frame on the kvmd event socket except `ping` and rejected every non-GET request to `/api/`. The run performed no pointer or keyboard action. No screenshot of the target is kept.",
    "",
    "| Case | Observed | Result |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${rows.filter((r) => r.pass).length} of ${rows.length} passed.`,
    "",
];
writeFileSync(`docs/e2e/${today}-kvm-real-pikvm-video.md`, md.join("\n"));
process.exit(rows.every((r) => r.pass) ? 0 : 1);
