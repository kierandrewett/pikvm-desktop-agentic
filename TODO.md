# Web client migration (reverse-proxy + shared UI)

Goal: the same frontend works on web (mobile included) and desktop. The server
proxies the PiKVM target wholesale and bolts on our agent UI. Clients point at a
configurable server; auth is simplified to one server token.

## Phase 1 - reverse proxy core
- [x] `control.proxyTarget()` exposes origin + auth headers + TLS handling
- [x] `src/proxy.ts` - HTTP proxy (HTML injection, cookie/redirect rewrite) + WS upgrade proxy
- [x] server: namespace our routes under `/_agent` (+ `/mcp` at root), proxy everything else
- [x] server: handle WebSocket upgrades via the proxy
- [x] server: configurable bind host (LAN access) via `settings.bindHost`
- [x] frontend `BASE` -> `<origin>/_agent`, configurable per shell (preload sets origin)
- [x] build green
- [ ] live smoke test (needs desktop restart — user)

## Phase 2 - inject the agent UI into proxied HTML
- [ ] serve `app.js` / `app.css` under `/_agent`
- [ ] inject the sidebar bundle + mount container into proxied pages
- [ ] graceful no-Electron degradation (window.ui optional)

## Phase 3 - mobile touch
- [ ] viewport meta, touch CSS
- [ ] pinch-zoom + drag-pan over the proxied stream (screen-mirror feel)

## Phase 4 - desktop unification
- [ ] Electron loads the proxy origin instead of the Pi directly
- [ ] reconcile the existing WebContentsView sidebar with the injected one

## Phase 5 - auth
- [ ] single server access token; gate `/_agent/*` and the proxy
- [ ] store PiKVM creds server-side only

## Notes / decisions
- Breaking: agent API moved from `/api/*` to `/_agent/api/*` because PiKVM owns
  `/api/*` and we now proxy it. Moved atomically with the frontend update.
- Old desktop split-view kept as reference until the proxy reaches parity.
