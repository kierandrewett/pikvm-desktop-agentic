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

`apps/web/e2e/clipboard.e2e.mjs` runs against the same two servers (the web host needs `NODE_PATH` set to a `node_modules` with `sharp`, as for the other
runs) and covers copy and paste on the KVM screen in real Chrome. Ctrl+C and Ctrl+V are sent with the browser's own `copy` and `paste` editing commands
attached, as a real key press carries them (a bare CDP key press does not run them), so the page's own handling is what decides: they reach the fake kvmd
as keys, nothing from this machine's clipboard is typed, and the hidden field gains nothing. A control case shows the same key event DOES paste into an
ordinary text box. It then types clipboards of odd text (curly quotes, CRLF, zero-width marks, emoji, a broken surrogate, tabs, a large mixed pile)
through "Type text on the target" and asserts what kvmd received. `PUPPETEER_CORE=... CHROME=... node apps/web/e2e/clipboard.e2e.mjs [--out docs/e2e]`
writes `docs/e2e/<date>-clipboard.md`.

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
(Settings -> Macros, `docs/e2e/<date>-settings-macros.md`), `apps/web/e2e/settings-style.e2e.mjs` (every Settings page on the settings kit, phone and desktop, light and dark, beside the upstream chat app; one tap on a row, the page slide and the edge swipe back; `docs/e2e/2026-11-03-settings-style.md`), `apps/web/e2e/lens.e2e.mjs` (the trackpad lens: on and off against the finger's speed over one gesture, its fixed size and place, the flip at the top edge, recorded in the page on its own clock, plus screenshots; `--section FILE` writes the report section, `docs/e2e/2026-11-03-phone-feedback.md`), `apps/web/e2e/keep-alive.e2e.mjs` (the tabs stay mounted: no new socket or stream, keys on Settings never reach the fake, `docs/e2e/<date>-keep-alive.md`), and the parity runs listed in
`docs/rebuild/parity-matrix.md`.

`apps/web/e2e/phone-chrome.e2e.mjs` (same two servers, same environment) checks the installed iPhone app's system chrome: the black status-bar
strip and the navigation bar's own home-indicator strip on every tab, light and dark, portrait and landscape, plus the meta tags and the
manifest, and that Android and the desktop (no insets) are untouched. Headless Chrome has no notch, so it emulates the insets with CDP
`Emulation.setSafeAreaInsetsOverride` and reads colours back from the screenshots. It writes its own section of
`docs/e2e/2026-11-03-phone-feedback.md` (between its markers, leaving the other sections alone) and screenshots under `docs/e2e/phone-chrome/`.

`apps/web/e2e/resume.e2e.mjs` (same two servers, same environment) drives the app being backgrounded and coming back: Chrome's own freeze
(`Page.setWebLifecycleState` frozen/active), `document.hidden` and visibilitychange, pageshow (persisted), focus, resume and online delivered as a
platform delivers them (including a page that is never told it was hidden), and the fake kvmd cutting (`/__fake/drop?what=streams|ws|all`) or
silencing (`/__fake/stall`) the stream and the event socket while the page cannot look. Each case asserts the new picture is on screen within 3 s
of return with exactly one new stream and one new socket counted on the fake, that nothing opened while hidden, and that nothing is left held on
the target. `--before` writes the rows to `docs/e2e/resume/before-<profile>.txt` instead of the report (run it against an older build); a normal run
writes its own section of `docs/e2e/2026-11-03-phone-feedback.md` between its markers.

The profiles are the iPhone 13 device (touch, coarse pointer, 390x844) and a 1400x900 desktop
window. Touch is sent as raw CDP touch events so two-finger gestures are real. The fake has no
Janus, so the picture is MJPEG; WebRTC and the audio buttons that depend on it are covered by
component tests.

A run that loads pages one after another in the same tab (`page.goto`) starts its browser with
`launch({ backForwardCache: false })` (`harness.mjs`). With Chrome's back/forward cache on, every page the tab
leaves stays parked with its connections open (the picture stream and two event streams, three per page), the host
speaks HTTP/1.1 and a tab gets six connections, so the third page's requests, a save among them, wait in the socket
pool until Chrome evicts the parked pages. `settings-macros.e2e.mjs` is such a run. It also presses a control only once
a click at its centre reaches it (the phone's page slide is a view transition, during which a click goes to `<html>`),
and waits for the server's stored list, not for a time, after every edit.

Two cases depend on the host's Caps Lock state. Headless Chrome does not track it, so the
engine's 1.4 s host/target reconcile would flip the target's LED back after a hardware CapsLock
press; that case waits it out and resets the fake before the next one.

`apps/web/e2e/watch-fast.e2e.mjs` runs the pop-up watch end to end and puts numbers on it: the real web host with its own OCR worker in front of `tools/fake-kvmd` (whose picture the run changes), `tools/fake-push` (a push service that decrypts what it is sent) and `tools/fake-chat-model` (the chat model that reads and judges each pop-up, scripted per step: READ, then JUDGE). It starts its own stack with `apps/web/e2e/watch-stack.mjs`, prints the toast-to-notification latency over a number of toasts and writes `docs/e2e/<date>-fast-alerts.md`; `node apps/web/e2e/watch-fast.e2e.mjs [--runs 10]` (`PIKVM_E2E_DIST=<dir>` runs a private build of the host instead of `dist/`). The real small models the two prompts were measured on are in `docs/e2e/2026-11-05-notification-judge.md`. The OCR benchmark that chose the engine is `watch-ocr-bench.mjs` (`docs/e2e/2026-11-05-fast-alerts-ocr.md`).

`apps/web/e2e/desktop-layout.e2e.mjs` drives the desktop layout against the same stack as the chat run (`chat-stack.mjs`):
the composer is the conversation's column (same width and centre, within 1px) on the new-chat screen and in a conversation
at 1280x800, 1920x1080, 2560x1440 and 760x700, and stays bounded with a long text; the navigation rail has no visible text
but an accessible name and a tooltip per item; the phone bar keeps its labels. It appends to
`docs/e2e/2026-11-03-desktop-feedback.md`: `node apps/web/e2e/desktop-layout.e2e.mjs [--out docs/e2e/desktop-feedback] [--doc ...]`.

`apps/web/e2e/cursor-sync.e2e.mjs` (same two servers, same environment; the Chrome binary is started twice so neither page is a background tab of the other) drives a desktop page and an iPhone 13 page on one host and checks that they share one cursor: the phone's blob follows the desktop's mouse (within 2 px, within 200 ms), the desktop's marker follows the phone's trackpad, both moving at once do not fight, and a reload re-syncs. It writes `docs/e2e/<date>-cursor-sync.md` and screenshots under `docs/e2e/cursor-sync/`.

`apps/web/e2e/native-feel.e2e.mjs` (starts its own stack with `chat-stack.mjs` on ports 18620/14620/14627; needs `dist/` and `apps/web/dist` built and `OMP_BIN` or `builds/omp`) checks the phone's native feel twice, as the installed iPhone app and as a browser tab with a Firefox-on-iOS user agent: no tap highlight, pressed style, no root overscroll, controls' touch-action, no :hover on touch, every launch-image link, every text field >= 16px, the composer's keyboard attributes, the service worker's icon badge (stubbed `setAppBadge`), and a Dynamic Type layout sweep (`--dt` on `<body>` at 17, 23 and capped 53 px) over the nav bar, KVM toolbar and keys, Settings and Chat. It writes `docs/e2e/2026-11-03-native-feel.md`. `node apps/web/e2e/native-feel.e2e.mjs [app|tab]`.

`apps/web/e2e/pip.e2e.mjs` runs against the two servers above (no chat needed) and covers the live screen window over Chat and Settings: a window on a wide screen and a round bubble on a phone (real CDP touch events), its canvas against the picture, a throw that keeps inside the area and comes to rest, a tap that opens the KVM and a throw whose closing click does not. `PUPPETEER_CORE=... CHROME=... node apps/web/e2e/pip.e2e.mjs` writes `docs/e2e/<date>-pip.md`.

`apps/web/e2e/agent-notify.e2e.mjs` starts its own stack (`chat-stack.mjs`: the web host with the chat server and a real omp binary, `tools/fake-kvmd`, `tools/fake-model`) and `tools/fake-push` as the push service, and covers the notification when the agent waits for the person: nothing with no device or while the person uses the app, one generic notification (signed, decrypted, with no word about what the agent wants to do) with the person away, none for the same wait twice, none when switched off. It needs `OMP_BIN` and `SHARP_MODULES` as the chat run does, and Node's type stripping: `OMP_BIN=... PUPPETEER_CORE=... CHROME=... node --experimental-strip-types --disable-warning=ExperimentalWarning apps/web/e2e/agent-notify.e2e.mjs` writes `docs/e2e/<date>-agent-notify.md`.
