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

- [ ] **The two `harness_ui` bundles have drifted.** `agent/pikvm_agent/harness_ui`
      is built from `agent/frontend`; `~/dev/pikvm-agent/pikvm_agent/harness_ui`
      is a separate tracked copy, and nothing syncs them. As of 2026-08-06 this
      repo has app.js at 658KB across 21 chunks (built 08-06 13:13) and the
      standalone repo has 858KB across 15 (08-05 14:39) — so the RPM ships one
      workspace UI and a dev box running the standalone checkout serves a
      different, older one. The Python sources beside them ARE byte-identical;
      it is only the built bundle that diverges. Not synced here because that
      repo is mid-branch (`sockets-for-local-services`) and a 200KB artefact
      swap does not belong in someone else's feature branch.

- [ ] Remove the retired views: `agent.js` + `agent.html` (superseded, still
      built and served), `ui.html` and `settings.html` (legacy native UI), and
      the `preload.ts` that pairs with them. All are referenced from
      `src/main.ts`.
- [ ] Decide on `pikvm.har` (1.5 MB leftover capture) and `package-lock.json`
      (npm residue in a Yarn project). Both gitignored, so harmless, but neither
      has a reason to exist.
- [ ] Migrating `console.js` / `webrtc.js` / `key-chord.js` to TypeScript means
      introducing a build step for `src/views/`, which are currently served raw
      to the browser. That is an architecture decision, not housekeeping.
      `janus.js` and `adapter.js` are vendored and must stay as they are — see
      `src/views/VENDOR.md`.
