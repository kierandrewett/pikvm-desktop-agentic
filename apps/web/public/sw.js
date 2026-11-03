// Service worker for the PiKVM app as an installed app (PWA).
//
// Scope is /app/ (served from /app/sw.js): the app and its assets. The proxied PiKVM UI, stream
// and event socket at "/" never pass through it.
//
// Network first, always. This is a live remote-control surface behind a sign-in, so a cached copy
// of the page is never better than the real one: it would come up "working" with no stream and no
// input. What this worker adds is the failure case. When the KVM cannot be reached at all (no
// signal, VPN down, server restarting), the app opens on a proper "can't reach" screen that
// retries on its own, instead of the browser's error page, which in a standalone app has no
// address bar and no reload button.
//
// Registration is gated to secure contexts (src/host/service-worker.ts), so a plain-http LAN run
// simply never installs this.

"use strict";

const CACHE = "pikvm-app-v1";
// The unseen screen pushes, counted here because no page may be open to count them (see notify/app-badge.ts, which
// reads and clears the same record).
const BADGE_CACHE = "pikvm-badge-v1";
const BADGE_KEY = "/app/badge-state";

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (e) => {
    // Drops the console's cache (pikvm-console-v2) and anything else stale.
    e.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== BADGE_CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<title>PiKVM</title>
<style>
  :root { color-scheme: dark; }
  html::before { content: ""; position: fixed; top: 0; left: 0; right: 0; height: env(safe-area-inset-top, 0px); background: #000; }
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
  <h1>Cannot reach the app server</h1>
  <p>The app opens again when the connection returns. Check that this device can reach the server.</p>
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

// Live or per-session paths: never touched, not even as a fallback. version.json is one too: it says which
// build is deployed NOW (src/host/update.ts), and an old copy served while offline would read as "a newer
// build" to an app that updated since, and reload it into the offline page.
const LIVE = /^\/app\/(api|terminal|legacy|version\.json)(\/|$)/;

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

// ---- Web Push ------------------------------------------------------------------------------------
//
// The server's screen watch (src/server/watch) sends a push when the screen changes in a way the
// person asked to hear about; the payload is JSON { title, body, tag, url }, built by the server
// from the image model's description. A push the worker cannot read still shows something: iOS
// and Chrome both revoke a subscription whose pushes show nothing (userVisibleOnly).
//
// The notification is for this app only: a tap opens (or focuses) a window inside /app/.

self.addEventListener("push", (e) => {
    let data = {};
    try {
        data = e.data ? e.data.json() : {};
    } catch (_) {
        data = {};
    }
    const title = typeof data.title === "string" && data.title !== "" ? data.title : "PiKVM";
    const body = typeof data.body === "string" && data.body !== "" ? data.body : "The screen changed.";
    const tag = typeof data.tag === "string" && data.tag !== "" ? data.tag : "pikvm-screen";
    const url = typeof data.url === "string" && data.url.startsWith("/app/") ? data.url : "/app/";
    e.waitUntil(
        Promise.all([
            self.registration.showNotification(title, {
                body,
                tag,
                renotify: true,
                icon: "/app/icon-192.png",
                badge: "/app/icon-192.png",
                data: { url },
            }),
            countBadge(badgeIncrement(data.badge)),
        ]),
    );
});

// ---- The icon badge --------------------------------------------------------------------------------
//
// A push may carry `badge`: a positive integer (how many things it adds), or `true` (one). The worker puts the
// running total of unseen ones on the app icon with navigator.setAppBadge, so it is there when the app is closed, and
// tells any open page (which clears it when the person is looking at the KVM). Where the API is missing, or the cache
// is, the notification is all there is: nothing here may fail the push.

function badgeIncrement(value) {
    if (value === true) return 1;
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

async function unseenPushes() {
    try {
        const hit = await (await caches.open(BADGE_CACHE)).match(BADGE_KEY);
        const record = hit ? await hit.json() : null;
        return record && Number.isInteger(record.screen) && record.screen > 0 ? record.screen : 0;
    } catch (_) {
        return 0;
    }
}

async function countBadge(add) {
    if (add <= 0) return;
    try {
        const unseen = (await unseenPushes()) + add;
        try {
            const cache = await caches.open(BADGE_CACHE);
            await cache.put(BADGE_KEY, new Response(JSON.stringify({ screen: unseen }), { headers: { "content-type": "application/json" } }));
        } catch (_) {
            // No cache: the icon still gets this push's count.
        }
        const nav = self.navigator;
        if (nav && typeof nav.setAppBadge === "function") await nav.setAppBadge(unseen);
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const w of windows) w.postMessage({ type: "pikvm-badge", kind: "screen", count: unseen });
    } catch (_) {
        // A browser that refuses the badge (no permission, not installed) still shows the notification.
    }
}

self.addEventListener("notificationclick", (e) => {
    e.notification.close();
    const data = e.notification.data;
    const path = data && typeof data.url === "string" && data.url.startsWith("/app/") ? data.url : "/app/";
    const target = new URL(path, self.location.origin).href;
    e.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
            const open = windows.find((w) => w.url.startsWith(self.location.origin + "/app/"));
            return open && typeof open.focus === "function" ? open.focus() : self.clients.openWindow(target);
        }),
    );
});
