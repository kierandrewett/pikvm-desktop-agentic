# Build steps

Yarn (not npm); `yarn install`, then:

```bash
yarn build                          # esbuild: dist/main.js, dist/preload.js, the web host, views
yarn workspace @pikvm/web build     # apps/web/dist, served at /app/
yarn test                           # root tests (node:test); apps/web: yarn workspace @pikvm/web test
yarn start                          # electron dist
make agent-runtime                  # agent/runtime: standalone CPython + the agent (per platform, ~800MB, gitignored)
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
- Agent runtime paths: `agentExecutablePaths()` in `src/agent-runtime.ts` (POSIX `runtime/bin/pikvm-agent`;
  Windows `runtime\pikvm-agent.exe` and `.venv\Scripts\pikvm-agent.exe`). A Windows runtime can be built and checked
  from Linux: `node scripts/build-agent-runtime.mjs --platform win32 --arch x64`, then `wine` runs its python.exe
  and `pikvm-agent.exe --help` (needs `WINEPREFIX` somewhere writable).
