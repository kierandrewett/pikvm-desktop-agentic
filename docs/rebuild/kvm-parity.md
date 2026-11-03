# KVM screen parity checklist

Every item of `console-inventory.md` that belongs to the KVM screen (`apps/web/src/kvm/**`), with
its status and the evidence for it. Section numbers are the inventory's.

Status: **done** (built and checked), **seam** (the screen side is built; what appears is another
module's), **gap** (not built; reason given), **n/a** (the new design has no such thing).

Evidence names:

- **E2E**: the run in `docs/e2e/2026-11-02-kvm-screen.md`. Headless Chrome, iPhone 13 and desktop 1400x900, against `tools/fake-kvmd`, asserting what the fake recorded.
- **Kn**: a failure mode in `apps/web/src/kvm/FAILURE_MODES.md`, and the test that asserts it.
- **engine**: a test in `packages/kvm-engine`. The machine's own failure modes, which the screen only wires.

## 1.2 Screen and stream

| Item | Status | Evidence |
|---|---|---|
| Native MJPEG `<img>`, stream key, 7 s first-frame watchdog, backoff 800 ms x1.7 to 8 s | done | engine V4; the screen wires it: E2E "picture fills the area" (live MJPEG through the host) |
| Health poll (2.5 s), server-down vs no-signal vs live | done | engine V5-V9; `createVideoDom.pollHealth` is used unchanged |
| Snapshot transport for VNC-lab targets, mode detection by `/api/info` | done, unverified end to end | engine S1-S4; the screen shows "VNC" in the resolution toast and drops Full UI in that mode (`K` none: the fake has no VNC lab) |
| Status chip, overlay, six states, "input offline" suffix | done | dock dot + word and toolbar chip (`dock.test.tsx` "the dot and word"); overlay label from the engine's `STATUS`; E2E "socket drop recovers" sees "input offline" then Live |
| Freeze canvas holding the last frame | done | `kvm.css` `.frozen`; the machine's `freeze`/`thaw` effects drive it (engine V7) |
| Stream only while needed (collapsed preview, Full UI) | done for Full UI, n/a for the collapsed preview | Full UI sends `fullUi` to the machine (`kvm-screen.test.tsx` "the Pi's own UI"); the new layout has no collapsible preview |
| Visual "no signal" (uniform-frame detector) | done | engine B1-B4; `sampleBlank` is wired by `createVideoDom` |
| Background screen-change alerts: taskbar pulse in the desktop app; tab title, app badge and notification in a browser; not offered on a phone (the page is suspended) | done; the Electron pulse is unverified in Electron | `screen-alerts.ts` over the engine's detector, `attention.ts` for the sink; `attention.test.ts`, `screen-alerts.test.ts`; E2E `2026-11-02-parity.md` (hidden tab). See `parity-matrix.md` |
| Screen watch on the server, notifying the installed app (Web Push), including a phone, where the page cannot watch | done; real iPhone delivery is unverified (Chrome stood in for the installed app) | `src/server/watch/`, `/app/api/v1/watch/*`, the worker's `push` and `notificationclick`, Settings, Notifications; unit and component tests, E2E `2026-11-03-screen-watch.md`. See `parity-matrix.md` and `docs/deploy-web.md` |
| WebRTC/Janus H.264 + audio, muted start, play watchdog, MJPEG fallback | done | Real PiKVM, video only: `docs/e2e/2026-11-02-kvm-real-pikvm-video.md` (60 fps, live audio track, 1920x1080 label). Fallback: E2E against the fake's 503 |
| Resolution toast "W x H . source" with the audio badge, 2.6 s | done | `picture-controller.test.ts` "the resolution toast"; E2E "resolution toast names the picture" |
| Generic toast: error styling and role, sticky, emptied after the fade | done | K15 `notices.test.ts` |
| Full PiKVM UI framed under the screen, 12 s load note, keyboard hand-off, Back | done | `kvm-screen.test.tsx` "the Pi's own UI"; `/?native=1` reaches kvmd (routes.ts). Not in the E2E |
| Zoom/pan transform on img, video and freeze canvas; zoom-out button | done | K18 `picture-controller.test.ts`; E2E "pinch zooms the picture; the zoom-out button restores it" (4.2x, restored, hidden), "Ctrl+wheel zooms" |
| Coordinate mapping through the letterbox and transform | done | engine view/pointer tests; E2E "click on the picture" lands at the picture's centre (0,0) |
| Screenshot (full-resolution JPEG download), desktop waits for the shell's download-done | done | `platform.test.tsx` "screenshot" and "waiting for the download to land" (saved, cancelled, silent shell) |
| OCR: drag a region, kvmd reads it | seam | the region picker (`useOcrPicker`, K19 `ocr-picker.test.tsx`) is built; the "ocr" dialog, the request and the result are the dialogs module's |

## 1.3 HID socket

All of it is the engine's target link (reconnect, heartbeat, dead-socket kick, queue and staleness,
Caps pending window, output switch throttle: engine `link.test.ts`). What the screen owns:

| Item | Status | Evidence |
|---|---|---|
| One link per app, started by the screen, never re-created by a render | done | `session.tsx`; K20 (`start` is idempotent) |
| Reconnect on foreground after more than 3 s hidden, and on `online` | done | K20 `picture-controller.test.ts` (one kick for either, however many screens call `start`) |
| Pi reports: Caps LED, mouse mode and outputs, ATX, MSD, OCR, keymaps | done | state read through `useTarget`; E2E "Caps key toggles the fake LED and lights" |
| Keys offered only while the socket is up (drawer disabled) | done | K21 `key-rows.test.tsx` |
| Mouse blob not left claiming a remote cursor when the socket drops (`not-allowed`) | done | `picture-controller.test.ts` "input offline" |
| Mouse output follows the input in use (absolute for mouse/pen/direct, relative for trackpad when pinned) | done | E2E "trackpad pinned to relative" (Pi switched to `usb_rel`, relative moves only) and "back to absolute"; changing the setting asks the Pi at once |

## 1.4 Keyboard engine and soft keyboard

| Item | Status | Evidence |
|---|---|---|
| Chord/char/ignore decisions, bare modifiers, Caps forwarded, serialized queue 22/4/6 ms | done | engine keyboard tests; E2E "typing Hi" (Shift, H, Shift up, I) on both profiles |
| Sticky modifiers with double-tap lock, keeps the soft keyboard | done | K6 `key-rows.test.tsx`; E2E "Ctrl tap, then c" (armed, one chord, cleared, keyboard kept) |
| Dedupe and auto-repeat throttle | done | engine; the field and the desktop forwarder both go through `keyboard.keydown` |
| Hidden `<input>`, uncontrolled, keydown/keyup/beforeinput/input/composition/blur | done | K3 `kvm-screen.test.tsx`; `bindHiddenField` |
| Soft-keyboard diff mirror (pad, 96 limit, dictation placeholder, smart-quote fold, composition) | done | engine field-mirror tests; E2E "soft-keyboard diff typing" (insert, then a rewrite: 3 Backspaces, text arrives "hello world") |
| Focus management: dock presses never steal focus, 700 ms rule | done | K1/K2 `dock.test.tsx`; E2E "Ctrl tap, then c" keeps the field focused |
| Modal gate (a dialog owns the keyboard, releases held modifiers) | done | K5 `kvm-screen.test.tsx` |
| Ctrl/Cmd+V pastes the HOST clipboard on the target | done | `kvm-screen.test.tsx` "host paste" (types it, sends no chord, says why when it cannot) |
| Hardware keyboard in a browser: click the picture, type | done | E2E desktop "click focuses the hardware keyboard; typing Hi", "Ctrl + C", "Win + Shift + S" (all with no key left held on the fake) |
| Desktop app: window key events forwarded (no field focus), Electron window-focus handling | done in code, unverified in Electron | `keyboard-input.tsx`; `isDesktopApp()` in `platform.ts` (phase 6 swaps its source) |

## 1.5 On-screen controls

| Item | Status | Evidence |
|---|---|---|
| Mouse L/M/R with armed modifiers around the click, drag-lock, scroll up/down | done | `dock.test.tsx` "mouse buttons click through the link", "drag-lock"; machine D8 for drag-lock |
| Esc, Tab, arrows, Enter, Backspace, Del, Home, End, chord keys, C-A-D | done | `key-rows.test.tsx`; E2E "alt+tab shortcut key" |
| Caps key mirrors the LED | done | K7; E2E phone "Caps key toggles the fake LED and lights" (LED on, key lit; off, unlit), desktop strip likewise |
| Fn row (F1-F12) and More row (paging keys, shortcuts, C-A-D), one open at a time | done | K8; E2E "Fn and More rows open one at a time" (12 F-keys; 13 shortcut keys) |
| Drawer overflow edge fade | done | `toolbar.test.tsx` "key strip edge fade" (the dock wraps, so only the desktop strip needs it) |
| Desktop "Send keys" menu: Paste, macros, CAD, Task Manager, Alt+Tab, Alt+F4, Win, Win+D/L/R, PrtSc, Esc | done | E2E desktop "Send keys menu: shortcut goes out" |

## 1.6 Touch input

All gesture rules are the pointer machine's (engine `gestures.test.ts`, P1-P16, R1-R6, D1-D9). Wired
and exercised through real touch events:

| Item | Status | Evidence |
|---|---|---|
| Trackpad: drag moves a cursor, tap = left click and nothing else | done | E2E "tap = one left click, no move" |
| Hold-still arms (cue), move = hold-to-drag, lift = right click | done | E2E "hold, then drag" (cue shown, one down, moves, one up, no right click), "hold, then lift = one right click" |
| Two-finger tap = right click; two-finger drag = wheel (22 px/step); pinch zoom | done | E2E "two-finger tap", "two-finger drag scrolls the target, no clicks, no zoom", "pinch zooms" |
| Touch (direct) vs trackpad; absolute vs relative; stored under `pikvm-touch-mode`/`-hid` | done | K10 `kvm-screen.test.tsx`; E2E "touch (direct) mode" (move, then click, at the finger); machine D1-D9 |
| Cursor dot, hold cue, magnifier lens (one fixed size and zoom, 3x total, above the cursor; on while one finger moves slowly, off when it speeds up or lifts) | done | `cursor-lens.ts` over the engine's view module; T `lens.test.ts` L1-L10, `cursor-lens.test.ts`; E2E `lens.e2e.mjs` (on/off against finger speed over one gesture, fixed size and place, top-edge flip, screenshots) |
| Browser pinch suppressed | done | `gesturestart` handler in `kvm-screen.tsx` |

## 1.7 Desktop mouse and wheel

| Item | Status | Evidence |
|---|---|---|
| Absolute follow on hover, one move per frame, drag past the edge, `buttons===0` release, wake nudge on a non-live target | done | engine M1-M13; E2E desktop "hover moves absolutely", "click on the picture" |
| Wheel; Ctrl+wheel zooms the picture on the web only | done | E2E "wheel scrolls the target; Ctrl+wheel zooms the picture" (scale 1.21, no wheel sent). Desktop app: engine M10 |
| Right-click menu suppressed on the picture | done | `attachPointerInput` |
| Throttled cursor report to the agent daemon | done | `POST /app/daemon/cursor` with the workspace header, 180 ms, desktop app only (the contract has no daemon feature flag, so the desktop bridge gates it); `cursor-report.test.ts` |
| One cursor for every client (desktop, phone, the agent) | done | The host tracks the pointer (`src/server/cursor/hub.ts`) from every client's input socket and the agent's tools and tells every page over `GET /app/api/v1/cursor` (SSE, one update per frame, the current one first). A page follows while idle and keeps its own while it moves (500 ms hold); the trackpad's blob moves, and elsewhere a distinct marker draws the other client's pointer. Engine S1-S5, web K30-K37; E2E `docs/e2e/2026-11-03-cursor-sync.md` |

## 1.8 Dialogs

The screen owns the seam; the dialogs agent owns the content.

| Item | Status | Evidence |
|---|---|---|
| `openDialog(name)`, registry, scrim, focus trap and Escape (`ModalFrame`), pointer and keyboard blocked while open | done | K16, K5 `kvm-screen.test.tsx` |
| Paste dialog (keymap from `hid_keymaps`, count, duration, host clipboard prefill, Ctrl+Enter) | done (minimal; the dialogs module may replace it) | K17 `kvm-screen.test.tsx` |
| Stream settings, Mass storage, System/GPIO/health, Pi log, OCR result, Audio devices, Macros editor | done by the dialogs module | registered through `registerKvmDialogs`; the screen side is the seam and `useOcrPicker` |
| ATX power confirmations | seam | `atx-power`, `atx-power-long`, `atx-reset` open the dialogs module's confirmations (no `window.confirm`); the entries appear only when the Pi reports ATX and grey while it is busy |

## 1.9 Macros run

| Item | Status | Evidence |
|---|---|---|
| Run through the engine's runner, with its refusals (another macro or a paste running, socket down for key steps) | done | engine macros tests; K11 `kvm-screen.test.tsx` (runs, greys while running, refusal, text-only still works) |
| Pinned macros as tiles in the phone sheet with their icons (the order is the manager's list order) | done | E2E phone "macro tile in the sheet runs on the target" (Win+R, then "calc" typed) |
| Pinned macros as a strip in the desktop toolbar; all macros in Send keys | done | E2E desktop "pinned macro in the toolbar runs on the target" |
| "Running ... about N s" sticky notice for slow runs | done | engine runner; notices K15 |
| Macro editor | done | the dialogs module's `macros`, and the same component as Settings -> Macros (`presentation="page"`); E2E `2026-11-02-settings-macros.md` |

## 1.10 Audio and mic

| Item | Status | Evidence |
|---|---|---|
| Speaker and mic buttons only while WebRTC carries audio; pressed, warn and pip states | done | K12 `dock.test.tsx` |
| Audio on by default, auto re-enable after an hour, mic pre-flight with named failures, level meters from WebRTC stats | done | audio track and speaker/mic buttons proven against the real Pi (`kvm-real-pikvm-video`); level meters and mic capture not exercised |
| The sheet's Audio output and Microphone toggles with pips | done | `sheet.tsx`, `dock.test.tsx` |
| Device chevron popouts beside each toggle (desktop toolbar) | done | `toolbar.test.tsx` "audio device popouts"; the phone sheet keeps its "Audio devices..." item |
| Pinned mic and speaker (`setSinkId`) re-applied when the dialog changes them | done | `audio-devices-event.ts`; `micDeviceChanged()`; not exercised without a Janus |

## 1.11 Theme

| Item | Status | Evidence |
|---|---|---|
| "Toggle theme" in the sheet and the More menu | done | `actions.ts` via `setThemeChoice` (the shell's own store; both `data-theme` and `dark`) |

## 1.12 Layout, panels, the more menu

| Item | Status | Evidence |
|---|---|---|
| Phone bar: dot and status, speaker, mic, zoom-out, paste, keyboard, more | done | `dock.test.tsx`; E2E screenshot `phone-dock.png` |
| Every item of the more menu; mass storage, read text and ATX only when the Pi reports them | done | `actions.ts`; E2E desktop "More menu" lists them; `phone-sheet.png` |
| Desktop: more menu popover with its separators | done | `menu-button.tsx`, K14 `menu-button.test.tsx` |
| Grid layout with the chat column, resizable divider, snap targets, preview collapse, intro slide-in | n/a | the new shell has no chat column beside the screen |
| Haptics (web-haptics, iOS Taptic) | done | `haptics.ts` on the hold cue where `navigator.vibrate` is absent (iOS); the resize grip it was built for no longer exists. `haptics.test.ts` |

## 1.13 Touch dock

| Item | Status | Evidence |
|---|---|---|
| Dock only on a coarse pointer and not in the desktop app | done | `kvm-screen.test.tsx` "layout"; E2E "touch dock layout" (`pointer: coarse` true) |
| Status row on top, key rows beneath, rides the visual viewport, drawn above the nav | done | The shell follows `visualViewport` and hides its bar while the keyboard is up. Real iOS not tested |
| The sheet grows upward in flow, hides the key rows, puts the keyboard away, closes on outside tap or Escape | done | K4 `dock.test.tsx`; E2E "macro tile in the sheet" (3 separators) and `phone-sheet.png` |
| Keyboard stays up across dock taps | done | K1; E2E "Ctrl tap, then c" |
| Black page background on a phone | done | `kvm.css` (`:has(.kvm-screen[data-layout="dock"])`) |
| Safe-area insets | done | side padding in `kvm.css`; the shell pads top and the nav bar pads the home indicator |

## 1.15 Desktop titlebar (the parts that are the KVM's)

| Item | Status | Evidence |
|---|---|---|
| Compact toolbar: connection chip, pinned macros, Send keys, Power (colour by LED, greyed while busy), audio and mic pair, zoom-out, More | done | `toolbar.tsx`; `desktop-toolbar.png`; E2E desktop |
| Health indicator (hidden when fine, amber/red) | done | the dialogs module's `healthProblems`; `toolbar.test.tsx` "health indicator" |
| Window controls, drag region, title, backend pill, Settings button, Fit to native, preview toggle | n/a here | the shell and the desktop bridge (phase 6); the toolbar keeps `-webkit-app-region: drag` and pads for `--window-controls-inset` |

## 1.16 PWA and lifecycle

| Item | Status | Evidence |
|---|---|---|
| Wake lock while visible, not in the desktop app, asked again on first touch | done | `platform.test.tsx` "wake lock" (held, released on hidden, re-asked on return, retried after a refusal, released on unmount, skipped in Electron) |
| Visibility: kick after more than 3 s hidden; `online` kicks; stream reloaded | done | K20; the video machine does the reload (engine L1-L3) |
| Full screen with Keyboard Lock (web only) | done | `platform.test.tsx` "full screen"; E2E "More menu" offers it. Headless cannot enter full screen, so the real lock is unverified |
| Manifest, service worker, "can't reach the KVM" page | done | `apps/web/public/manifest.webmanifest`, `sw.js`, `host/service-worker.ts`; `public-files.test.ts`; E2E `2026-11-02-parity.md` (Chrome's installability check, network cut, recovery) |
