// Service worker for the PiKVM Agent web client.
//
// Scope is /_agent/ (it is served from /_agent/sw.js), so it ONLY governs our
// own shell — the heavy React sidebar bundle — never the live proxied PiKVM
// stream at "/", which must always hit the network. Cache-first for our static
// assets makes the agent panel open instantly and survive flaky links; the
// network is the source of truth for everything else.
//
// Registration is gated to secure contexts (see the injected loader), so over a
// plain-http LAN this file is simply never installed — no errors, and it lights
// up automatically once the server is reached over HTTPS.

"use strict";

const CACHE = "pikvm-agent-v1";
const ASSETS = ["/_agent/sidebar.html", "/_agent/sidebar.js", "/_agent/sidebar.css", "/_agent/touch.js", "/_agent/manifest.webmanifest", "/_agent/icon.png"];

self.addEventListener("install", (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener("fetch", (e) => {
    const req = e.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    // Only ever handle our own shell; defer everything else to the network.
    if (url.origin !== self.location.origin || !url.pathname.startsWith("/_agent/")) return;
    // The agent API is dynamic — never cache it.
    if (url.pathname.startsWith("/_agent/api/") || url.pathname.startsWith("/_agent/mcp")) return;

    e.respondWith(
        caches.match(req).then((hit) => {
            if (hit) {
                // Refresh in the background so the next open is current.
                e.waitUntil(
                    fetch(req)
                        .then((res) => res && res.ok && caches.open(CACHE).then((c) => c.put(req, res.clone())))
                        .catch(() => {}),
                );
                return hit;
            }
            return fetch(req)
                .then((res) => {
                    if (res && res.ok) {
                        const copy = res.clone();
                        caches.open(CACHE).then((c) => c.put(req, copy));
                    }
                    return res;
                })
                .catch(() => caches.match("/_agent/sidebar.html"));
        }),
    );
});
