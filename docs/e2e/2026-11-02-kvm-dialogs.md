# E2E run: KVM dialogs against the fake kvmd (2026-11-02)

Covers the dialogs in `apps/web/src/kvm/dialogs/` (`docs/rebuild/kvm-dialogs-parity.md`). Nothing here
touches a real PiKVM: the target is `tools/fake-kvmd`, whose `/__fake/*` control API is what the checks
read back.

## Environment

- Web app: `vite build` of `apps/web` into a scratch directory, served at `/app/` by the headless web
  host (`dist/web-server.js`, copied beside it) with `PIKVM_URL` pointing at the fake.
  `PIKVM_DATA_DIR` was a fresh directory, so the only stored macro at the start was the built-in
  "Capture region".
- Fake kvmd: `node --experimental-strip-types tools/fake-kvmd/server.ts --port 4571`, reset
  (`POST /__fake/reset`) before each case.
- Browser: headless Google Chrome (`--headless=new`) through the omp `browser` helper.
  - **Phone**: `emulate({device: "iPhone 13"})` (390x844, touch, coarse pointer, iPhone user agent), then
    `goto`. (Reloading after `emulate` left that tab wedged on "Connecting"; opening, emulating and
    navigating did not. The tool, not the app.)
  - **Desktop**: 1400x900, no touch, Chrome user agent.
- Dialogs were opened from the screen's own controls: the dock's paste button and the ⋯ sheet on the phone,
  the ⋯ menu on desktop. Values that a pointer drag would set (a range input's release) were set with the
  input's own `input` and `change` events; the OCR region was a real drag on the picture.

## Acceptance cases

| Case | Phone (iPhone 13) | Desktop (1400x900) |
|---|---|---|
| **Paste "Hi" reaches `/api/hid/print` with the chosen keymap**: type `Hi`, choose `en-gb`, Type on target | fake `prints`: `{text: "Hi", keymap: "en-gb", limit: "0", delay: "0.02"}`; dialog closed | same |
| **A created macro persists and runs**: New macro, name, Ctrl, key, (desktop: Alt, then an added text step "hello"), Run | `GET /app/api/v1/macros` holds "Say hi" `[chord ControlLeft+KeyH]`; fake keys `ControlLeft:down KeyH:down KeyH:up ControlLeft:up`; dialog closed | "Desktop hello" `[chord ControlLeft+AltLeft+KeyK, text hello]` persisted; keys `ControlLeft:down AltLeft:down KeyK:down KeyK:up AltLeft:up ControlLeft:up` and `prints: ["hello"]` |
| **ATX reset asks first, then calls the fake**: System dialog, Reset | before Confirm the fake had no `/api/atx` request; after Confirm: `/api/atx/click {"button":"reset"}` | same |
| **GPIO switch toggles**: System dialog, `relay0` switch | confirm "Turn "relay0" on?" first; fake `gpio.relay0.state` false then true | same |
| **Stream setting reaches the fake's streamer params**: Stream settings, Quality | `set_params {quality: "55"}`; fake `streamer.quality` 55 | same |

## Further cases

| Case | Result |
|---|---|
| Macro draft: New macro, named, no key yet | server list unchanged (`["Capture region","Say hi"]`) until the key was chosen (desktop) |
| Macro delete asks first (`desktop-macro-delete-confirm.png`), then removes it | server list `["Capture region","Desktop hello"]` after deleting "Say hi" |
| Mass storage: upload `test.iso` through the file input, pick it, Mount | fake `msd.drive`: `image: test.iso, connected: true`, `images: ["test.iso"]` (both profiles) |
| Pi log | body shows the fake's two journal lines (both profiles) |
| OCR (desktop): drag over the picture | `snapshot?allow_offline=1&ocr=1&ocr_left=57&ocr_top=57&ocr_right=176&ocr_bottom=78&ocr_langs=eng`; dialog text "FAKE KVMD TEST PATTERN" |
| OCR (phone): Escape while aiming | picker closes, no dialog |
| OCR (phone): drag | **not completed**: the screen's `.kvm-ocr-pick` overlay is only a 235 px strip (no `inset` in `kvm.css`); reported to KvmScreen |
| Dark theme | `desktop-msd-dark.png` |
| Phone targets | paste dialog buttons measured 44 px high; macro list buttons 44 px |

## Not exercised

The Audio devices dialog (its menu item needs live WebRTC audio, which the fake refuses) and the soft
keyboard (headless Chrome has none). Both are covered by unit tests only.

## Unit and component tests

`yarn workspace @pikvm/web test` (vitest, jsdom): `src/kvm/dialogs/` has 126 cases across
`model/model.test.ts`, `shell-atx-paste.test.tsx`, `stream-health.test.tsx`, `msd-log-ocr.test.tsx`,
`macros.test.tsx` and `audio-registry.test.tsx`, numbered against `FAILURE_MODES.md`. The whole app suite
was 316 passing at the time of the run.

## Screenshots

In `docs/e2e/kvm-dialogs/`: `phone-*.png` (paste, stream, stream-after, system, atx-confirm, gpio-confirm,
system-after, macros-list, macros-editor, msd, log, ocr-picker) and `desktop-*.png` (paste, stream,
stream-after, system, atx-confirm, gpio-confirm, system-after, macros, macro-delete-confirm, msd, msd-dark,
log, ocr-picker, ocr-result).
