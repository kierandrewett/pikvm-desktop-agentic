# TODO

What is actually open. The completed web-client migration that used to live here
is in git history (`docs/web-client-migration.md`, removed with the /app cutover).

## Needs hardware — cannot be settled from a dev box

- [ ] **Microphone pinning, end to end.** The device now reaches the capture via
      `webrtc.js`'s `setMicDevice(id)` → janus.js → `constraints.audio` →
      `getUserMedia`. Each link was verified separately; the whole chain has
      never run, because there is no Janus server here and the e2e swaps
      `webrtc.js` for a stub. If a pinned mic still drifts, this is where to
      look.
- [ ] Gesture feel on a real touch device (the trackpad now scales with zoom,
      which changes how it feels at 3x).
- [ ] Install over HTTPS: service-worker registration and add-to-home-screen.
- [ ] **Confirm the taskbar groups the window with its launcher icon.**
      `build/desktop.ejs` hardcodes `StartupWMClass=pikvm-desktop-agentic` (the
      package.json name), but the packaged binary is `pikvm-desktop` and
      `main.ts` calls `app.setName("PiKVM Desktop")` — three candidate names, and
      Electron's Linux WM_CLASS could be any of them. If it does not match, the
      window appears in the taskbar as its own unnamed entry instead of under the
      app icon. One command with the app running:

          xprop WM_CLASS   (then click the window)

      Whatever it prints must equal the StartupWMClass line. Not changed blind:
      scripts/make-rpm.mjs exists purely to inject that value, so it was almost
      certainly observed once and is probably right.

## Known and deliberately not done

- [ ] **WebRTC keeps streaming behind the full PiKVM UI.** The MJPEG path is
      released when the picture is not on screen; an active Janus session is
      not. Tearing one down and re-establishing it is materially more delicate
      than dropping an `<img>` src, and the reconnect logic around it is
      hard-won. Wants to be its own piece of work rather than folded into a
      sweep.
- [ ] **The mass-storage status line during an upload** still reads "Ready to
      mount …" rather than describing the upload. That text is driven by `msd`
      events from the Pi, and the fake kvmd sends none while it holds the request
      open, so "the UI does not report it" and "nothing reported it" cannot be
      told apart from here. Worth one look against a real Pi.

## Worth deciding, not urgent

- [ ] Decide on `pikvm.har` (1.5 MB leftover capture) and `package-lock.json`
      (npm residue in a Yarn project). Both gitignored, so harmless, but neither
      has a reason to exist.
- [ ] Migrating `console.js` / `webrtc.js` / `key-chord.js` to TypeScript means
      introducing a build step for `src/views/`, which are currently served raw
      to the browser. That is an architecture decision, not housekeeping.
      `janus.js` and `adapter.js` are vendored and must stay as they are — see
      `src/views/VENDOR.md`.
