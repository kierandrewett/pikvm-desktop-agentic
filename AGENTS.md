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
- The PiKVM address and credentials: `src/target-store.ts` (`pikvm.json` = address + user name; the password only in
  `pikvm-credentials.json`, 0600, atomic). Never put a password in pikvm.json, an API reply, a log or an error.
  Do not print pikvm.json: an older install has `user:pass` in its address.
- The agent is chat's server inside our Node process (`packages/chat-server`, mounted by `src/server/chat/`), running
  omp's standalone binary per conversation; the PiKVM tools are `packages/pikvm-mcp` on `@pikvm/kvm-engine`. The binary
  is fetched and checked by `scripts/fetch-omp.mjs` against `deploy/omp.lock` (packaging and the image both use it); a
  dev run finds it by `OMP_BIN` or PATH (`packages/chat-server/src/agent/launch.ts`). There is no Python, no Bun and no
  agent sidecar. `src/pikvm-control.ts` is only the server's link to the PiKVM: the proxy target, the kvmd event
  socket and the idle jiggler's nudge.
