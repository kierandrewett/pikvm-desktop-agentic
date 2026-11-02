// Service worker for the PiKVM console as an installed app (PWA).
//
// Scope is /app/ (served from /app/sw.js), which holds the console and
// its assets; the proxied PiKVM UI, stream and HID socket at "/" never pass
// through it.
//
// Network first, always. This is a live remote-control surface behind a
// sign-in, so a cached copy of the page is never better than the real one: it
// would come up "working" with no stream and no input. What this worker adds is
// the failure case. When the KVM cannot be reached at all (no signal, tailnet
// down, server restarting), the app opens on a proper "can't reach" screen that
// retries on its own, instead of the browser's error page, which in a
// standalone app has no address bar and no reload button.
//
// Registration is gated to secure contexts in console.js, so a plain-http LAN
// run simply never installs this.

"use strict";

const CACHE = "pikvm-console-v2";

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (e) => {
    // Drops the old shell cache (pikvm-agent-v1) along with anything else stale.
    e.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0a0c">
<title>PiKVM Console</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #0a0a0c; color: #ededf1;
    font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; padding: max(24px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom)); box-sizing: border-box; text-align: center; }
  h1 { margin: 0; font-size: 17px; font-weight: 600; }
  p { margin: 0; color: #8a8a95; max-width: 30em; }
  button { margin-top: 8px; min-height: 44px; padding: 0 20px; border: 0; border-radius: 8px;
    background: #1a1a20; color: #ededf1; font: inherit; font-weight: 550; }
  button:focus-visible { outline: 2px solid #5b8cff; outline-offset: 2px; }
</style></head>
<body><main>
  <h1>Can't reach the KVM</h1>
  <p>The console will open again as soon as the connection is back. Check that this device is on the tailnet.</p>
  <button type="button" id="retry">Try again</button>
</main>
<script>
  var go = function () { location.reload(); };
  document.getElementById("retry").addEventListener("click", go);
  window.addEventListener("online", go);
  setInterval(function () {
    fetch(location.href, { cache: "no-store", redirect: "manual" }).then(go, function () {});
  }, 5000);
</script>
</body></html>`;

function offlinePage() {
    return new Response(OFFLINE_HTML, {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
}

// Live or per-session paths: never touched, not even as a fallback.
const LIVE = /^\/app\/(api|daemon|harness|terminal)(\/|$)/;

self.addEventListener("fetch", (e) => {
    const req = e.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    if (req.mode === "navigate") {
        // A redirect to the sign-in page comes back as-is and the browser follows it.
        e.respondWith(fetch(req).catch(offlinePage));
        return;
    }
    if (!url.pathname.startsWith("/app/") || LIVE.test(url.pathname)) return;

    // Static assets: the network's answer, kept as a fallback for a flaky link.
    e.respondWith(
        fetch(req)
            .then((res) => {
                if (res && res.ok && res.type === "basic") {
                    const copy = res.clone();
                    e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
                }
                return res;
            })
            .catch(() => caches.match(req).then((hit) => hit || Response.error())),
    );
});
