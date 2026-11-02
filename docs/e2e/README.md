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

The profiles are the iPhone 13 device (touch, coarse pointer, 390x844) and a 1400x900 desktop
window. Touch is sent as raw CDP touch events so two-finger gestures are real. The fake has no
Janus, so the picture is MJPEG; WebRTC and the audio buttons that depend on it are covered by
component tests.

Two cases depend on the host's Caps Lock state. Headless Chrome does not track it, so the
engine's 1.4 s host/target reconcile would flip the target's LED back after a hardware CapsLock
press; that case waits it out and resets the fake before the next one.
