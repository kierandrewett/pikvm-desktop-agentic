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

`deploy/e2e/chat.e2e.mjs` drives the HOSTED deployment over HTTP and the chat socket: the one image this repo builds
(`make image`) with a fake kvmd and a scripted model, brought up with
`podman compose -f deploy/e2e/compose.yml up -d` (set `KVM_IMAGE` if the image has another name). It listens on
127.0.0.1:18080 with the fake kvmd on 127.0.0.1:14510 and needs no browser: `node deploy/e2e/chat.e2e.mjs`.

`apps/web/e2e/chat.e2e.mjs` drives Chat inside the PiKVM app in headless Chrome (iPhone 13 and 1400x900, light and
dark): it starts its own stack per profile with `apps/web/e2e/chat-stack.mjs` (the web host with the chat server in it,
`tools/fake-kvmd`, `tools/fake-model` and the real omp binary), adds the provider in Settings, and records
`docs/e2e/<date>-chat-integrated.md`. It needs `dist/` built (`yarn build`, and `vite build` in `apps/web`), `OMP_BIN` (or
`builds/omp/...`, see `scripts/fetch-omp.mjs`) and `SHARP_MODULES`, a `node_modules` directory that has `sharp` (the web
image installs it; the repo does not): `SHARP_MODULES=... node apps/web/e2e/chat.e2e.mjs [phone|desktop]`.

It also drives the PiKVM cards in the thread: the screenshot the agent took as a thumbnail (compared with the fake kvmd's
test pattern), the click point drawn on it, a tap opening it full size (a sheet on the phone, a dialog on the desktop), the
same cards after a reload, and another conversation's frame id refused.

The browser suites can also be pointed at the IMAGE instead of a host they start themselves. `deploy/e2e/up-inspectable.sh up` runs the
image (read-only, tmpfs `/tmp`, no capability, its own uid 10001 mapped to yours so the suite can read the agent's process and
files) beside `tools/fake-kvmd` and `tools/fake-model` and prints the variables; export them and run the suite:

```sh
KVM_IMAGE=pikvm-kvm:local deploy/e2e/up-inspectable.sh up | tee env.txt   # E2E_WEB, E2E_KVMD, E2E_MODEL, E2E_MODEL_URL, E2E_HOST_PID, E2E_DATA
set -a; . ./env.txt; set +a
PUPPETEER_CORE=... node apps/web/e2e/chat.e2e.mjs phone         # one profile per fresh container (it keeps state between profiles)
KVM_WEB=$E2E_WEB KVM_FAKE=$E2E_KVMD PUPPETEER_CORE=... node apps/web/e2e/kvm.e2e.mjs
KVM_WEB=$E2E_WEB KVM_FAKE=$E2E_KVMD PUPPETEER_CORE=... node apps/web/e2e/keep-alive.e2e.mjs
deploy/e2e/up-inspectable.sh down
```

With `E2E_WEB` set, `chat-stack.mjs` starts nothing and `chat.e2e.mjs` uses those origins. It is podman only (`--userns=keep-id`).

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
