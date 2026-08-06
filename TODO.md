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

- [ ] **The tree is the source of truth now, but the venv still is not — so
      this box runs the retired checkout.** `~/dev/pikvm-agent` is no longer
      used; `agent/` here is the project. Two earlier items lived here — syncing
      `agent/frontend` to that repo, and deciding how much of the Python project
      to vendor — and both are answered by that: nothing gets synced outward, and
      the mirror is complete because it is not a mirror any more.

      What is left is the one thing the decision does not settle on its own.
      `main.ts`'s `agentExecutables()` tries `agent/.venv/bin/pikvm-agent`
      first and `~/dev/pikvm-agent/.venv/bin/pikvm-agent` second. **Only the
      second exists**, and it is an editable install — its
      `_editable_impl_pikvm_agent.pth` reads `/home/kieran/dev/pikvm-agent` —
      so the daemon on this box imports the retired checkout's source, not
      `agent/pikvm_agent`.

      That is survivable only by luck: `pikvm_agent` is byte-identical across
      both, so the Python behaves the same. `harness_ui` is NOT — 658KB across
      21 chunks in tree against 858KB across 15 there — so the harness UI being
      served is the old build. The in-tree bundle is current with in-tree
      source (nothing under `agent/frontend/src` is newer than it); it just is
      not the one running.

      The fix is to create `agent/.venv` and install `agent/` into it editable,
      after which `inRepo` wins and the tree really is what runs. Not done here
      because it pulls the full dependency set and that is not a change to make
      inside a docs commit.

      **Do not drop the standalone fallback from `agentExecutables()` until
      `agent/.venv` exists.** It looks like dead code now that the checkout is
      retired, and removing it today would leave this box with no daemon at all.

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
