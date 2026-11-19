# TODO

What is actually open. The completed web-client migration that used to live here
is in git history (`docs/web-client-migration.md`, removed with the /app cutover).

## Agent text keyboard layout

- [x] Make agent text entry use the saved target layout instead of kvmd's default keymap.
- [x] Verify UK punctuation, live layout changes and unchanged physical-key commands through MCP.
- [x] Report layout-sensitive characters from the actual text plan and compare the selected layout with kvmd metadata.
- [x] Verify automatic diagnostics through the built host without claiming target OS output is verified.

## Permission fallback verification

- [x] Connect the smart review without allowing it to clear the fixed risk rules.
- [x] Verify absent models, failed OCR, invalid answers, timeouts and denied approvals through the HTTP approval path.

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

- [x] **WebRTC behind the full PiKVM UI.** Done and seen on kvm.drewett.dev (2026-11-19, build
      9a06ac12): the video machine ends our Janus session when the Pi's UI is framed and
      starts one new attempt when it is left (V10). With the Pi's KVM page open in the
      frame, ours was `closed`, the Pi UI's own peer was `connected`, and ours came back on
      leaving. The browser check ran under a guard that dropped every `/api/ws` frame except
      ping, so no input reached the Pi.
- [x] **Playback in the framed Pi UI.** Seen in a visible tab on kvm.drewett.dev (2026-11-19):
      playback time and decoded frames advance, one frame dropped, our peer closed, the Pi UI's
      connected (run record:
      `~/.cache/pikvm-e2e/rtc-resilience/RUN-2026-11-19-full-ui-webrtc.md`).
- [ ] **Full PiKVM UI with the microphone or camera on.** The session is kept on purpose
      (`keepSession`, V10), so the duplicate stream stays then; not exercised against a real Pi.
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
