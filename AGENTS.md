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
- The web host as a server: `PIKVM_ACCESS_TOKEN` (`src/web-server.ts`, judged by `bearerVerdict` in `src/server/auth.ts`) accepts `Authorization: Bearer <token>` on every route the console reaches, with no cookie, no `?token=` and no foreign browser `Origin`. Without a bearer nothing changes. An authenticating proxy in front of the host MUST pass `Authorization` through.
- The agent is chat's server inside our Node process (`packages/chat-server`, mounted by `src/server/chat/`), running
  omp's standalone binary per conversation; the PiKVM tools are `packages/pikvm-mcp` on `@pikvm/kvm-engine`. The binary
  is fetched and checked by `scripts/fetch-omp.mjs` against `deploy/omp.lock` (packaging and the image both use it); a
  dev run finds it by `OMP_BIN` or PATH (`packages/chat-server/src/agent/launch.ts`). There is no Python, no Bun and no
  agent sidecar. `src/pikvm-control.ts` is only the server's link to the PiKVM: the proxy target, the kvmd event
  socket and the idle jiggler's nudge.
