# Web client migration (reverse-proxy + shared UI)

Goal: the same frontend works on web (mobile included) and desktop. The server
proxies the PiKVM target wholesale and bolts on our agent UI. Clients point at a
configurable server; auth is simplified to one server token.

## Phase 1 - reverse proxy core
- [x] `control.proxyTarget()` exposes origin + auth headers + TLS handling
- [x] `src/proxy.ts` - HTTP proxy (HTML injection, cookie/redirect rewrite) + WS upgrade proxy
- [x] server: namespace our routes under `/_agent` (+ `/mcp` at root), proxy everything else
- [x] server: handle WebSocket upgrades via the proxy
- [x] WS/HTTP resilience for flaky mobile links: relay non-upgrade upstream
      responses (no client hang), abort upstream on client drop (no leaked Pi
      connections), 15s connect timeout, teardown on close (not just error).
      smoke:proxy covers the non-upgrade path (30/30).
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
- [x] inertial/momentum pan: a two-finger flick keeps gliding and decelerates
      (exp decay, TAU 130ms), clamped each frame; only when zoomed; never touches
      PiKVM input. Matches screen-mirror's smooth "panning a map" feel.
- [x] PWA install: web manifest + apple-* standalone meta + theme-color injected;
      icon + manifest + service worker served under /_agent. Add-to-home-screen
      launches full-screen. SW caches the agent shell (scope /_agent/), gated to
      secure contexts so plain-http LAN is silent. smoke:proxy covers it (29/29).
- [ ] on-device validation (gesture feel + PiKVM rect-relative input mapping) - user
- [ ] install validation over HTTPS (SW registration + add-to-home-screen) - user

## Phase 4 - desktop unification (opt-in toggle)
- [x] desktop agent/sidebar/MCP/copilot already run on + talk to the server
- [x] `settings.desktopUseProxy` (default OFF): KVM view loads through the proxy
- [x] `viewOrigin()` live helper routes load + nav guards + onKVM; default path
      provably unchanged (else-branch is the original code, evaluated live)
- [x] desktop shell sets `agent_shell=desktop` cookie -> proxy suppresses the
      injected FAB (native sidebar stays); covered by smoke (22/22)
- [x] Server settings toggle
- [ ] ON-path GUI validation (needs desktop restart with toggle on) - user
- note: changing the PiKVM target at runtime while in proxy mode is a known
  limitation (the proxy target is fixed at server start)

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
