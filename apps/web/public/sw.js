// Service worker for the PiKVM app as an installed app (PWA).
//
// Scope is /app/ (served from /app/sw.js): the app and its assets. The proxied PiKVM UI, stream
// and event socket at "/" never pass through it.
//
// The app shell is cached. Each build has its own worker (the build id is written into this file when the app is built,
// see shell-worker.ts) and its own cache, `pikvm-shell-<build>`, filled when the worker installs with everything the
// build is made of. An app page opens from that cache at once, so the UI is there on a bad link and with no link at all.
// That is safe now because the app says what it cannot reach: the connection banner (src/app/connection) names a host
// that does not answer, and the KVM, Chat and Recordings views say what they cannot do. What is live is never cached:
// the API, the chat, the legacy console, version.json, the sign-in pages, recordings and event streams (see LIVE below).
//
// A page and its worker are always one build. This worker does not take over by itself: it never calls skipWaiting()
// when it installs and never claims pages when it activates, so a new worker installs beside the old one and waits.
// A page keeps the build it loaded with and is served from that build's cache. The page asks the waiting worker to
// take over (`pikvm-apply`) at a moment that is safe for it, and reloads into the new build; when no page is left the
// browser activates the waiting worker by itself. Whichever worker is active, a hashed file is looked up in every
// build's cache, so a page on an older build still finds its lazy chunks. A cache is deleted only when no page runs
// that build (cleanUp).
//
// Registration is gated to secure contexts (src/host/service-worker.ts), so a plain-http LAN run
// simply never installs this.

"use strict";

// Replaced by the build (shell-worker.ts) with this build's id and the files it is made of. Unbuilt, the worker has no
// files: it keeps the page only.
const SHELL = { build: "dev", files: [] }; // @shell
const BUILD = SHELL.build;
const SHELL_PREFIX = "pikvm-shell-";
const CACHE = SHELL_PREFIX + BUILD;
// The app's own page, as the server answers it for every client route.
const INDEX = "/app/";
// Whether the person is known to be signed out (see navigation()).
const SIGN_IN_CACHE = "pikvm-signin-v1";
const SIGNED_OUT_KEY = "/app/signed-out";
// The unseen screen pushes, counted here because no page may be open to count them (see notify/app-badge.ts, which
// reads and clears the same record).
const BADGE_CACHE = "pikvm-badge-v1";
const BADGE_KEY = "/app/badge-state";
// How long a page has to say which build it runs before it counts as not having answered.
const ASK_MS = 1500;
const INSTALL_PARALLEL = 4;
// One attempt at one file, headers and body together: a connection that goes quiet fails the install instead of holding it (K114).
const FETCH_MS = 60_000;

// ---- Install: fill this build's own cache -----------------------------------------------------------

// One file of the build. It goes to the host, not through any cache but the browser's own for a hashed file, and is
// kept only when it is what it should be (storable below): a half-filled or poisoned cache fails the install instead.
// The host answered, and it said no (a redirect to sign-in, a 401, a 404, an HTML page for a script): an answer, so it is
// not retried, and its body is dropped so the connection is freed (K115).
class Refused extends Error {}

async function fetchShellFile(url, stop) {
    const hashed = url.startsWith("/app/assets/");
    const request = new Request(url, {
        credentials: "same-origin",
        cache: hashed ? "default" : "reload",
        redirect: "manual",
        headers: url === INDEX ? { accept: "text/html" } : {},
    });
    for (let attempt = 0; ; attempt++) {
        try {
            const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(FETCH_MS)]);
            const res = await fetch(new Request(request, { signal }));
            if (!storable(url, res)) {
                await res.body?.cancel().catch(() => undefined);
                throw new Refused(`${url}: ${res.status} ${res.type}`);
            }
            if (url === INDEX && !(await res.clone().text()).includes('id="root"')) throw new Refused("the page is not the app");
            return { request, res };
        } catch (err) {
            if (err instanceof Refused || stop.signal.aborted || attempt >= 1) throw err;
            await new Promise((resolve) => setTimeout(resolve, 400));
        }
    }
}

async function precache() {
    // A cache left by an install of this build that did not finish is never reused.
    await caches.delete(CACHE);
    const cache = await caches.open(CACHE);
    // One failed file ends the install: the other lanes stop at their next file (or their fetch) instead of running on.
    const stop = new AbortController();
    try {
        const queue = [INDEX, ...SHELL.files.filter((file) => file !== INDEX)];
        let next = 0;
        const lane = async () => {
            while (next < queue.length && !stop.signal.aborted) {
                const { request, res } = await fetchShellFile(queue[next++], stop);
                await cache.put(request, res);
            }
        };
        await Promise.all(Array.from({ length: INSTALL_PARALLEL }, lane));
    } catch (err) {
        stop.abort();
        await caches.delete(CACHE);
        throw err;
    }
}

// Tells the pages that are open that a build is ready to take over; each one decides when (src/host/update.ts).
async function announce() {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of windows) w.postMessage({ type: "pikvm-update-ready", build: BUILD });
}

self.addEventListener("install", (e) => {
    // No skipWaiting: see the header.
    e.waitUntil(precache().then(announce));
});

// ---- Activate: delete what no page uses -------------------------------------------------------------

// The build one page runs, from the page itself; null when it does not say (frozen, still loading, an older app).
function askBuild(client) {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(null), ASK_MS);
        channel.port1.onmessage = (event) => {
            clearTimeout(timer);
            resolve(event.data && typeof event.data.build === "string" ? event.data.build : null);
        };
        client.postMessage({ type: "pikvm-which-build" }, [channel.port2]);
    });
}

// The builds the open app pages run, or null when any page did not answer: then nothing is deleted this time.
async function buildsInUse() {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const pages = windows.filter((w) => APP_PAGE.test(new URL(w.url).pathname));
    const answers = await Promise.all(pages.map(askBuild));
    return answers.includes(null) ? null : new Set(answers);
}

async function cleanUp() {
    const names = await caches.keys();
    // The old runtime cache (pikvm-app-v1), the console's cache (pikvm-console-v2) and anything else that is not the shell's.
    const stray = names.filter((n) => !n.startsWith(SHELL_PREFIX) && n !== BADGE_CACHE && n !== SIGN_IN_CACHE);
    await Promise.all(stray.map((n) => caches.delete(n)));
    // A worker that is waiting or installing has a cache this one cannot tell from an old build's (a deploy or a rollback may
    // be newer or older than this worker): while there is one, no build's cache is deleted. Its own activation does it.
    if (self.registration.waiting || self.registration.installing) return;
    const older = names.filter((n) => n.startsWith(SHELL_PREFIX) && n !== CACHE);
    if (older.length === 0) return;
    const inUse = await buildsInUse();
    if (!inUse) return;
    await Promise.all(older.filter((n) => !inUse.has(n.slice(SHELL_PREFIX.length))).map((n) => caches.delete(n)));
}

self.addEventListener("activate", (e) => {
    // No clients.claim: a page that was loaded under no worker, or under an older one, is not moved onto this one.
    e.waitUntil(cleanUp());
});

// ---- Messages from the pages ------------------------------------------------------------------------

self.addEventListener("message", (e) => {
    const data = e.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "pikvm-apply") {
        // From a page that is ready to move to this build (a waiting worker is meant; for an active one this does nothing).
        self.skipWaiting();
    } else if (data.type === "pikvm-query") {
        // "Which build are you?", asked of a waiting worker, with a port to answer on.
        if (e.ports && e.ports[0]) e.ports[0].postMessage({ build: BUILD });
    } else if (data.type === "pikvm-hello") {
        // A page has started: a good time to delete the caches of builds that no page runs any more.
        e.waitUntil(cleanUp());
    } else if (data.type === "pikvm-signed-out") {
        e.waitUntil(setSignedOut(true));
    }
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

// ---- What the worker answers -----------------------------------------------------------------------
//
// An allow-list, not a block-list: the worker answers a request from a cache only for the files the build
// listed (SHELL.files) and for hashed files under /app/assets/ (their name is their content, so a copy can
// never be stale). Everything else is left alone, so a route added later (an API, a stream, a recording's
// media, the sign-in pages, version.json) is never cached by accident. LIVE is the same rule written the
// other way round as a second guard: version.json says which build is deployed NOW (src/host/update.ts), and an
// old copy would read as "a newer build" to an app that updated since.
const LIVE = /^\/app\/(?:api|chat|terminal|legacy|login|logout|auth|oauth|mcp|version\.json)(?:\/|$)/;
const HASHED = /^\/app\/assets\/[^/]+$/;
// The page itself is answered by navigation() only: a fetch() of the same address is the host's.
const SHELL_FILES = new Set(SHELL.files.filter((file) => file !== INDEX));
// The pages the server answers with index.html (src/server/routes.ts isAppPage), and only those.
const APP_PAGE = /^\/app\/(?:(?:kvm|chat)|(?:recordings|settings)(?:\/.*)?)?$/;
// Where a person who is signed out ends up.
const SIGN_IN_PAGE = /^\/app\/(?:login|logout)$/;
// How long a navigation waits for the host before the cached shell is used, while the person is known to be signed out.
const SIGNED_OUT_WAIT_MS = 3000;

async function cachedShell() {
    return (await caches.match(INDEX, { cacheName: CACHE })) || null;
}

// A cache entry is kept only when it is what it should be: not a redirect (a sign-in is one), not an error and not a
// page standing in for a file (an expired session or a proxy answers a script's address with HTML).
function storable(url, res) {
    if (!res || !res.ok || res.type !== "basic" || res.redirected) return false;
    const html = /^text\/html/i.test(res.headers.get("content-type") || "");
    return url === INDEX ? html : !html;
}

async function keepOwn(request, res) {
    // Not caches.open: a cache that was evicted is not made again here empty, without its completion mark.
    if (await caches.has(CACHE)) await (await caches.open(CACHE)).put(request, res);
}

// Signed out: remembered across the worker being stopped, so the next page navigation asks the host first.
async function isSignedOut() {
    try {
        return Boolean(await caches.match(SIGNED_OUT_KEY, { cacheName: SIGN_IN_CACHE }));
    } catch (_) {
        return false;
    }
}

async function setSignedOut(on) {
    try {
        const cache = await caches.open(SIGN_IN_CACHE);
        if (on) await cache.put(SIGNED_OUT_KEY, new Response("1"));
        else await cache.delete(SIGNED_OUT_KEY);
    } catch (_) {
        // Nothing remembered: the page itself still goes to the sign-in page when the host says 401.
    }
}

// What the host's own answer to a page navigation says about the sign-in.
function noteSignIn(e, res) {
    if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) e.waitUntil(setSignedOut(true));
    else if (res.ok) e.waitUntil(setSignedOut(false));
}

async function navigation(e, url) {
    if (!APP_PAGE.test(url.pathname)) {
        // The sign-in and sign-out pages, and anything else that is not the app (the KVM tab frames /app/legacy/), come from the
        // host. A redirect to the sign-in page comes back as-is and the browser follows it.
        if (SIGN_IN_PAGE.test(url.pathname)) e.waitUntil(setSignedOut(true));
        return fetch(e.request).catch(offlinePage);
    }
    if (await isSignedOut()) {
        // Whoever is signed out must not be shown the app while the host can say so: ask it first, and use the cached
        // shell only when it cannot be reached.
        const wait = new Promise((resolve) => setTimeout(() => resolve(null), SIGNED_OUT_WAIT_MS));
        try {
            const res = await Promise.race([fetch(e.request), wait]);
            if (res) {
                noteSignIn(e, res);
                return res;
            }
        } catch (_) {
            // Unreachable: the shell below.
        }
        return (await cachedShell()) || offlinePage();
    }
    const shell = await cachedShell();
    if (shell) {
        // Stale while revalidate: the shell opens at once, and the worker asks sw.js again, which is how a deployed build
        // is noticed (it installs beside this one and waits, see the header).
        e.waitUntil(self.registration.update().catch(() => undefined));
        return shell;
    }
    try {
        const res = await fetch(e.request);
        noteSignIn(e, res);
        return res;
    } catch (_) {
        return offlinePage();
    }
}

async function asset(e, url) {
    // This build's copy first (the icon and the manifest keep their names from build to build), then any build's: a page
    // that runs an older build than this worker still finds its own lazy chunks, which only that build's cache has.
    const hit = (await caches.match(e.request, { cacheName: CACHE })) || (await caches.match(e.request));
    if (hit) return hit;
    const res = await fetch(e.request);
    if (HASHED.test(url.pathname) && storable(url.pathname, res)) e.waitUntil(keepOwn(e.request, res.clone()).catch(() => undefined));
    return res;
}

self.addEventListener("fetch", (e) => {
    const req = e.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    if (req.mode === "navigate") {
        e.respondWith(navigation(e, url));
        return;
    }
    if (!url.pathname.startsWith("/app/") || LIVE.test(url.pathname) || req.headers.has("range")) return;
    if (!SHELL_FILES.has(url.pathname) && !HASHED.test(url.pathname)) return;
    e.respondWith(asset(e, url));
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
