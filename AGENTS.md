# Build steps

Yarn (not npm); `yarn install`, then:

```bash
yarn build                          # esbuild: dist/main.js, dist/preload.js, the web host, views
yarn workspace @pikvm/web build     # apps/web/dist, served at /app/
yarn test                           # root tests (node:test); apps/web: yarn workspace @pikvm/web test
yarn start                          # electron dist
make image                          # the web host and its chat agent, one image: podman build -f deploy/Dockerfile . (IMAGE_TOOL=docker)
make package                        # build + installers for this platform -> builds/packages/<platform>-<arch>/
```

- Desktop shell: `src/main.ts` (backend, port, load/retry) and `src/desktop/` (window, the one preload,
  IPC channels, navigation policy). The page-facing bridge is `window.pikvmDesktop`, typed in
  `packages/contracts/src/desktop.ts`; add to the contract, the preload and `window.ts` together.
  There is no other preload and no settings window.
- Packaging: `scripts/package.mjs` has electron-packager write the Electron tree, then Linux goes through pkgsmith
  (`pkgsmith.star`, Linux only; built from source, `PKGSMITH=/path/to/pkgsmith`) and macOS and Windows through
  `electron-builder --prepackaged` (`packaging/electron-builder.yml`: dmg+zip, nsis+msi+zip). Never put macOS or
  Windows back into pkgsmith. `packaging/` also holds the desktop entries, launcher, metainfo and icons. CI:
  `.github/workflows/package.yml`. electron-builder's dmg needs macOS (`sips`) and its msi needs WiX (wine cannot
  make the cabinet), so those two are proven on the CI runners only.
- Running Electron under a headless sway needs `env -u ENABLE_VULKAN_RENDERDOC_CAPTURE`: the RenderDoc
  Vulkan layer deadlocks Chromium's GPU process.
- The PiKVMs and their credentials: `src/target-store.ts`. Several can be stored: `pikvms.json` = id, name, address, user
  name, which is the default and which is active; the passwords only in `pikvms-credentials.json` (keyed by id, 0600,
  atomic). The proxy, the agent and the screen watch follow the active one (the store tells the control core on a
  change). Never put a password in pikvms.json, an API reply, a log or an error. Do not print pikvm.json: an older
  install has `user:pass` in its address; it is read as one entry and migrated on the first change from Settings.
- The state server: `src/server-store.ts` keeps the saved server (at most one: a second add is refused with 409, `servers.json`: id, name, origin, last state, whether it is in use) and, apart, its access token (`server-tokens.json`, 0600, atomic). `src/server/sync/` is the rest: `remote.ts` (the probe: `GET /app/api/v1/state` with the bearer token; https or loopback http only, no redirects, fixed error sentences), `forward.ts` (while the saved server is in use, a reverse proxy: every request except the local-only paths listed in its header goes to the server, HTTP, SSE and WebSockets), `index.ts` (`/app/api/v1/servers`: add probes and saves, use makes it the server in use, useLocal gives this computer back, remove forgets; nothing is copied between servers). Local-only while in use: sign-in, PWA and icon files, `/` (unless `?native=1`), the web app's files under `/app/` (except `/app/api/*` and `/app/chat/*`), `/app/api/v1/servers*`, `/_agent`. Never put the token or a password in an API reply, a log or an error. A PiKVM password goes only to the server in use, only over https (or http to loopback), and never comes back in any reply, log or error; the forwarder pipes that body straight through and never buffers, caches, writes or logs it.
- The web host signs users in itself (`src/server/web-auth/`, wired by `src/web-server.ts`; the desktop keeps its single token gate in `src/server/auth.ts`, unchanged). Three methods, each on when its env is present, any combination: `PIKVM_ACCESS_TOKEN` (`Authorization: Bearer` for the desktop app's server link and scripts, judged by `bearerVerdict` with no cookie, no `?token=`, no foreign `Origin`, plain http from a non-loopback peer only with `PIKVM_SYNC_ALLOW_HTTP=1`; also a token field on the login page), `PIKVM_LOGIN_USER` + `PIKVM_LOGIN_PASSWORD_HASH` (scrypt; `node dist/web-server.js --hash-password`) or `PIKVM_LOGIN_PASSWORD` (login form and `Authorization: Basic`), and OIDC (`PIKVM_OIDC_*` + `PIKVM_PUBLIC_URL`; `oidc.ts` does discovery, code + PKCE + state + nonce, and verifies the id_token with `jose`; an email passes only with `email_verified === true`; groups, verified emails and `PIKVM_OIDC_ALLOWED_SUBJECTS`; all three empty refuses everyone). Form and OIDC sign-in end in a signed `__pikvm_session` cookie (`session.ts`, key `PIKVM_SESSION_SECRET` or `<data dir>/session-secret`). Keep the credentials apart: a bearer is judged only by the bearer rules and never falls through to a cookie or Basic, Basic only by the password rules, a cookie is never a bearer, and none of them makes another. There is no loopback exemption on a web host with a method configured; with none it binds loopback only and refuses another `HOST` (`bindProblem`). Password form, typed token and Basic are refused over plain http from a non-loopback peer (`403 Sign in over https.`, no override): https means `PIKVM_PUBLIC_URL` is https, or with `PIKVM_TRUST_PROXY=1` the last `X-Forwarded-Proto` is `https` (those headers and `X-Forwarded-For`, last hop, are ignored without it). Failed attempts are rate limited per client address (`limiter.ts`: three free, then doubling waits, 429 with `Retry-After`, one global ceiling). `GET /app/api/v1/session` (`SessionView` in the contract) reports method and subject from the `signedIn` the verdict carries, handed to the API in a server-set header that is stripped from clients; `signIn: false` where the host has no sign-in. Never log or echo a password, token, id_token or code. Tests: `tests/web-host-auth.test.ts`, `tests/web-oidc.test.ts` (a fake provider), `tests/web-session.test.ts`, `tests/web-bearer.test.ts`, on the rig in `tests/support/web-rig.ts`.
- The agent is chat's server inside our Node process (`packages/chat-server`, mounted by `src/server/chat/`), running
  omp's standalone binary per conversation; the PiKVM tools are `packages/pikvm-mcp` on `@pikvm/kvm-engine`. The binary
  is fetched and checked by `scripts/fetch-omp.mjs` against `deploy/omp.lock` (packaging and the image both use it); a
  dev run finds it by `OMP_BIN` or PATH (`packages/chat-server/src/agent/launch.ts`). There is no Python, no Bun and no
  agent sidecar. `src/pikvm-control.ts` is only the server's link to the PiKVM: the proxy target, the kvmd event
  socket and the idle jiggler's nudge.
- The screen watch (`src/server/watch/`): `watcher.ts` the one poller, `pipeline.ts` the whole-screen path (image model, Jev), `fast-alerts.ts` the corner pop-up path
  (zone diff in `frame-diff.ts`, local OCR in `ocr-engine.ts` / `ocr-worker.ts` / `ocr-paddle.ts`, text rules in `toast-rules.ts`), `limits.ts` every number with its measurement.
  The OCR needs `dist/ocr-worker.js` (`yarn build` makes it), onnxruntime-node and the models pinned in `deploy/ocr.lock` (`node scripts/fetch-ocr.mjs`); `yarn test` needs
  none of them (fake OCR; one real-engine test is skipped unless `PIKVM_OCR_NODE_MODULES` and `PIKVM_OCR_MODELS` are set). The fast path sends nothing to a model service unless the user sets a rule (OCR text to Jev) or the operator sets `PIKVM_WATCH_FAST_CLOUD_FALLBACK=1`; keep it so. `ORT_DISABLE_TELEMETRY=1` is forced in the OCR worker. Docs: `docs/deploy-web.md` "Screen watch".
