# Build steps

Yarn (not npm); `yarn install`, then:

```bash
yarn build                          # esbuild: dist/main.js, dist/preload.js, the web host, views
yarn workspace @pikvm/web build     # apps/web/dist, served at /app/
yarn test                           # root tests (node:test); apps/web: yarn workspace @pikvm/web test
yarn start                          # electron dist
make agent-runtime                  # agent/runtime: standalone CPython + the agent (per platform, ~800MB, gitignored)
make package                        # build + pkgsmith packages for this platform -> builds/packages/<platform>-<arch>/
```

- Desktop shell: `src/main.ts` (backend, port, load/retry) and `src/desktop/` (window, the one preload,
  IPC channels, navigation policy). The page-facing bridge is `window.pikvmDesktop`, typed in
  `packages/contracts/src/desktop.ts`; add to the contract, the preload and `window.ts` together.
  There is no other preload and no settings window.
- Packaging: `scripts/package.mjs` drives electron-packager and pkgsmith; `pkgsmith.star` is the manifest;
  `packaging/` holds the desktop entries, launcher, metainfo and icons. CI: `.github/workflows/package.yml`.
  pkgsmith is built from source (`PKGSMITH=/path/to/pkgsmith`).
- Running Electron under a headless sway needs `env -u ENABLE_VULKAN_RENDERDOC_CAPTURE`: the RenderDoc
  Vulkan layer deadlocks Chromium's GPU process.
- The PiKVM address and credentials: `src/target-store.ts` (`pikvm.json` = address + user name; the password only in
  `pikvm-credentials.json`, 0600, atomic). Never put a password in pikvm.json, an API reply, a log or an error.
  Do not print pikvm.json: an older install has `user:pass` in its address.
