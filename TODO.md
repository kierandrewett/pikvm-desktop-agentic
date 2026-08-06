# TODO

What is actually open. The completed web-client migration that used to live here
is in `docs/web-client-migration.md`.

## Needs hardware — cannot be settled from a dev box

- [ ] **Microphone pinning, end to end.** The device now reaches the capture via
      `webrtc.js`'s `setMicDevice(id)` → janus.js → `constraints.audio` →
      `getUserMedia`. Each link was verified separately; the whole chain has
      never run, because there is no Janus server here and the harness swaps
      `webrtc.js` for a stub. If a pinned mic still drifts, this is where to
      look.
- [ ] Gesture feel on a real touch device (the trackpad now scales with zoom,
      which changes how it feels at 3x).
- [ ] Install over HTTPS: service-worker registration and add-to-home-screen.
- [ ] **Terminal copy/paste in the packaged app.** `src/preload-terminal.ts`
      exposed a `termClipboard` bridge for a terminal that ran in its own
      WebContentsView. The terminal is an iframe now, an iframe cannot carry a
      preload, and no window ever loaded it — so it has been deleted and the
      only live path is `navigator.clipboard`. That preload's own comment said
      `readText()` is unreliable behind Electron's permission model, so paste in
      particular wants trying on a real desktop build.

## Known and deliberately not done

- [ ] **WebRTC keeps streaming behind the full PiKVM UI.** The MJPEG path is
      released when the picture is not on screen; an active Janus session is
      not. Tearing one down and re-establishing it is materially more delicate
      than dropping an `<img>` src, and the reconnect logic around it is
      hard-won. Wants to be its own piece of work rather than folded into a
      sweep.
- [ ] **The mass-storage status line during an upload** still reads "Ready to
      mount …" rather than describing the upload. That text is driven by `msd`
      events from the Pi, and the harness sends none while it holds the request
      open, so "the UI does not report it" and "nothing reported it" cannot be
      told apart from here. Worth one look against a real Pi.

## Housekeeping still queued

- [ ] **The workspace has drifted between the two repos — source, not just the
      build.** `agent/frontend` here and `frontend` in `~/dev/pikvm-agent` are
      two copies of the same tree and nothing syncs them. As of 2026-08-06:
      21 files differ, 8 exist only in this repo, none only in the other, and the
      last frontend commit here is 08-06 against 08-05 there. The drift is
      strictly one-directional — this repo is ahead.

      The built `harness_ui` bundles differ for the same reason (658KB/21 chunks
      here, 858KB/15 there). An earlier note in this file said only the bundle
      had drifted and the sources were identical; that was true of
      `pikvm_agent`, which IS still byte-identical, but `frontend` was never
      checked. The bundles differ because the sources do.

      What it means in practice: the RPM ships the newer workspace, and a daemon
      resolved from the standalone checkout — which is what happens on this box —
      serves one built from day-old source.

      Not synced here. That repo is on an unmerged branch
      (`sockets-for-local-services`), and copying 29 files of someone else's
      source tree into their feature branch is not a housekeeping decision.
      Merge first, then sync in one deliberate step, then rebuild the bundle.

- [ ] **Decide the fate of the `PIKVM_NATIVE_UI=1` path.** `main.ts` keeps it
      deliberately ("the legacy composition is kept behind PIKVM_NATIVE_UI=1"),
      so this is a product call, not housekeeping. It is bigger than it looks —
      1,344 lines across seven files, all reachable only with that env var set:

          src/preload.ts        705    src/static/index.css   199
          src/views/style.css   212    src/views/ui.html      109
          src/views/settings.html 72   src/static/kvm.css      36
          src/preload-ui.ts      11

      `src/static/` exists solely for it: the CSS injection sits after an
      `if (useConsole) { … return; }` in the did-navigate handler, so nothing in
      that directory is read in normal operation. If the flag goes, the whole
      directory goes with it.
- [ ] Decide on `pikvm.har` (1.5 MB leftover capture) and `package-lock.json`
      (npm residue in a Yarn project). Both gitignored, so harmless, but neither
      has a reason to exist.
- [ ] Migrating `console.js` / `webrtc.js` / `key-chord.js` to TypeScript means
      introducing a build step for `src/views/`, which are currently served raw
      to the browser. That is an architecture decision, not housekeeping.
      `janus.js` and `adapter.js` are vendored and must stay as they are — see
      `src/views/VENDOR.md`.
