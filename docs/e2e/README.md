# Browser end-to-end runs

`apps/web/e2e/kvm.e2e.mjs` drives the KVM screen in headless Chrome against a real web host in
front of `tools/fake-kvmd`, and asserts what the fake received. It never touches a real PiKVM.
Each run writes `docs/e2e/<date>-kvm-screen.md` and screenshots under `docs/e2e/kvm-screen/`.

```sh
# 1. the fake kvmd
node --experimental-strip-types --disable-warning=ExperimentalWarning tools/fake-kvmd/server.ts --port 4510

# 2. build, then the web host in front of it (a scratch data dir keeps macros out of your own)
yarn workspace @pikvm/web build && yarn build
PIKVM_URL=http://127.0.0.1:4510 PIKVM_PASSWORD=anything PORT=8099 PIKVM_DATA_DIR=$(mktemp -d) node dist/web-server.js

# 3. the run: both profiles, or one of `phone` / `desktop`
PUPPETEER_CORE=/path/to/node_modules CHROME=/path/to/chrome node apps/web/e2e/kvm.e2e.mjs [phone|desktop]
```

Puppeteer is not a dependency of the repo, so the run takes its locations from the environment:

- `PUPPETEER_CORE`: a `node_modules` directory that has `puppeteer-core`.
- `CHROME`: a Chrome binary.
- `KVM_WEB`, `KVM_FAKE`: the two origins, if they are not the defaults above.

The run exits non-zero if any case fails.

`apps/web/e2e/chat-sidecar.e2e.mjs` is different: it drives the HOSTED deployment, the two images this
repo builds (the web host and the agent sidecar) with a fake kvmd and a scripted model, brought up with
`podman compose -f deploy/e2e/compose.yml up -d` after `make web-bundle agent-bundle` and a `podman build`
of each (the header of that compose file has the commands). It listens on 127.0.0.1:18080 with the fake
kvmd on 127.0.0.1:14510, so run it with `KVM_WEB=http://127.0.0.1:18080 KVM_FAKE=http://127.0.0.1:14510`.
It writes `docs/e2e/<date>-chat-sidecar.md`. The two CLI sign-in cases start the real `codex` and `claude`
sign-in inside the sidecar and need outbound internet; nothing is submitted and each is cancelled.

`apps/web/e2e/chat-desktop.e2e.mjs` drives the real Electron app (not a browser) under a headless sway: the packaged
layout, its embedded harness, the fake kvmd and the fake model. Start the app with
`env -u ENABLE_VULKAN_RENDERDOC_CAPTURE ... --remote-debugging-port=9334`, with its output going to a FILE (a pipe that
closes, as `| head` does, makes the app's next log line an uncaught EPIPE and Electron's error dialog freezes the
whole main process), and with `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `PIKVM_AGENT_CONFIG` pointing at a scratch
config whose PiKVM is a decoy: the agent must act on the app's own target, and the run asserts it never opened a
socket outside loopback. It writes `docs/e2e/<date>-chat-desktop.md`.

Other runs share the same two servers and the same environment: `apps/web/e2e/icons.e2e.mjs` (Phosphor icons on the nav, Settings, the KVM dock and toolbar and the macro picker, light and dark, `docs/e2e/<date>-icons.md`), `apps/web/e2e/settings-macros.e2e.mjs`
(Settings -> Macros, `docs/e2e/<date>-settings-macros.md`), `apps/web/e2e/keep-alive.e2e.mjs` (the tabs stay mounted: no new socket or stream, keys on Settings never reach the fake, `docs/e2e/<date>-keep-alive.md`), and the parity runs listed in
`docs/rebuild/parity-matrix.md`.

The profiles are the iPhone 13 device (touch, coarse pointer, 390x844) and a 1400x900 desktop
window. Touch is sent as raw CDP touch events so two-finger gestures are real. The fake has no
Janus, so the picture is MJPEG; WebRTC and the audio buttons that depend on it are covered by
component tests.

Two cases depend on the host's Caps Lock state. Headless Chrome does not track it, so the
engine's 1.4 s host/target reconcile would flip the target's LED back after a hardware CapsLock
press; that case waits it out and resets the fake before the next one.
