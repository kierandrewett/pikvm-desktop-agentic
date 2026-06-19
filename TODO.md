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
- [x] serve `sidebar.html/js/css` under `/_agent`
- [x] inject FAB + slide-in iframe panel (CSS-isolated) into proxied pages
- [x] graceful no-Electron degradation (window.ui already guarded with ?.)
- [x] smoke test (yarn smoke:proxy) - 9/9 pass

## Phase 3 - mobile touch
- [x] viewport meta (Phase 1)
- [x] pinch-zoom + 2-finger pan over the proxied stream; 1-finger passes through
      to PiKVM as input; double-tap reset; ctrl/cmd+wheel zoom on desktop
- [ ] on-device validation (gesture feel + PiKVM rect-relative input mapping) - user

## Phase 4 - desktop unification (deferred, by decision)
- [x] desktop agent/sidebar/MCP/copilot already run on + talk to the server
- decision: the desktop renders the Pi directly for its own view rather than
  self-proxying localhost->localhost->Pi. Remote clients use the proxy (the actual
  "web app"). A "desktop-via-proxy" toggle is possible but unenabled - it would
  touch the desktop's navigation guards, autofill and onKVM detection (all
  origin-keyed) and cannot be GUI-validated here, so it is left as an opt-in to
  add when it can be tested. No functional gain for the host today.

## Phase 5 - auth
- [x] single server access token (settings.accessToken); gates HTTP + WS
- [x] login page + cookie session (derived from token, survives restarts)
- [x] loopback exempt (desktop app trusted); LAN clients gated
- [x] PiKVM creds stay server-side (proxy injects them) - clients only need our token
- [x] smoke test covers gate/login/cookie (20/20)
- [x] settings UI: Server tab (LAN toggle + access token)

## Notes / decisions
- Breaking: agent API moved from `/api/*` to `/_agent/api/*` because PiKVM owns
  `/api/*` and we now proxy it. Moved atomically with the frontend update.
- `/mcp` kept at the root too, so existing external MCP clients keep working.
- Validation: `yarn smoke:proxy` (20/20) covers proxy injection, passthrough,
  cookie/redirect rewrite, asset serving and the auth gate. The desktop sidebar
  and the live Pi proxying still need a desktop restart to smoke on real hardware.
