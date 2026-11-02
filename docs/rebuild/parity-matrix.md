# Parity matrix: desktop, web, mobile

Every user-facing feature of the app, on the three places it runs. Sources: `console-inventory.md`,
`kvm-parity.md`, `kvm-dialogs-parity.md`, the Settings pages (`apps/web/src/settings`), Chat and
Providers, and the desktop bridge (`packages/contracts/src/desktop.ts`).

**Platforms**

- **Desktop**: the Electron app (`window.pikvmDesktop` exists).
- **Web**: a browser on a computer, including the hosted `kvm.drewett.dev` (Docker, behind oauth2-proxy).
- **Mobile**: the same web app on a phone, installed as a PWA or in a browser (coarse pointer: the touch dock).

**Cells** are one of:

- **available**: it works there (the evidence column says how it was checked).
- **n/p `Rn`**: not possible on this platform, for the reason `Rn` in the table below.
- **missing**: possible and not done. There are none left; anything that cannot be finished is listed under
  [Blocked](#blocked) and its cell says `blocked Bn`.

**Evidence**: `T` = vitest (file named), `E2E` = a run under `docs/e2e/` against `tools/fake-kvmd`
(`parity`, `settings-macros`, `kvm-screen`, `kvm-dialogs`; phone = iPhone 13, desktop = 1400x900 browser),
`Real` = checked against the real PiKVM (`kvm-real-pikvm-video`), `Code` = read, not run. **The Electron
shell itself was not run by this audit**: a Desktop cell is proven by the same web code in a browser plus the
bridge's unit tests, and says so.

## Reasons a cell is "not possible"

| | Reason |
|---|---|
| R1 | A web page cannot move, resize, minimise or close the browser window. Only the Electron shell owns a window. |
| R2 | In a browser or on a phone the OS or the browser draws the window frame; the macOS traffic lights only exist in the desktop app. |
| R3 | A phone suspends a page the moment it leaves the foreground (iOS and Android), so nothing can watch the picture, run a timer or hold a socket in the background. |
| R4 | iPhone Safari has no Fullscreen API for pages (an installed PWA already runs full screen); Keyboard Lock exists only in Chromium, and only in full screen. |
| R5 | A computer has no soft keyboard, so no dictation, keyboard-aware viewport or on-screen key rows are needed. |
| R6 | Haptics need a phone: `navigator.vibrate` on Android, the Taptic shim on iOS. |
| R7 | The touch dock is for a coarse primary pointer. A mouse and keyboard computer has no finger gestures, and its mouse has a real wheel and buttons. |
| R8 | The hosted web host pins the PiKVM address and credentials by environment (`PIKVM_URL`, `PIKVM_USER`, `PIKVM_PASSWORD`). The page shows them read-only; changing them is a host configuration change. |
| R9 | A browser tells the page nothing about a download once the link is clicked; it hands the file to its own downloads UI. |
| R10 | Listing and choosing audio devices needs `navigator.mediaDevices`, which a browser only exposes in a secure context (https or localhost). |
| R11 | Choosing the output device needs `setSinkId`, which Safari and Firefox lack (the app says so on the page). |
| R12 | Sign-out exists only when a sign-in proxy (oauth2-proxy) is in front of the host; the desktop app and a plain host have no session to end. |
| R13 | The desktop app is already an installed app, served from loopback: there is nothing to install and the server is always on the same machine. |
| R14 | CLI sign-in methods marked `desktop_only` (Gemini) need an interactive terminal on the machine that runs the agent; the page says so. |
| R15 | Another application's windows, a taskbar and a dock are the shell's: a page has a tab title, a badge and notifications instead (see Screen-change alerts). |

## 1. The app

| Feature | Desktop | Web | Mobile | Evidence and notes |
|---|---|---|---|---|
| Three destinations: KVM, Chat, Settings (rail on a wide window, tab bar on a phone) | available | available | available | T `nav.test.tsx`; E2E kvm-screen, settings-macros |
| Window controls, titlebar and drag region | available | n/p R1 | n/p R2 | T `window-controls.test.tsx`. Desktop: not run in Electron |
| macOS traffic lights (`nativeControls`) | available (macOS) | n/p R2 | n/p R2 | T `window-controls.test.tsx` |
| Phone shell: tab bar above the home indicator, hidden while the soft keyboard is up, sized to the visual viewport | n/p R5 | n/p R5 | available | T `viewport.test.ts`, `nav.test.tsx`; E2E phone |
| Installable app: manifest, icons, service worker | n/p R13 | available | available | T `host/public-files.test.ts`, `host/service-worker.test.ts`; E2E parity (Chrome's own installability check: no errors; worker controls `/app/`). **Fixed in this audit**: the new app had neither the manifest link nor the worker (only the old console had them) |
| "Can't reach the KVM" page that retries by itself when the host is down | available (the shell's load-retry dialog, `src/main.ts`) | available | available | E2E parity (network cut at page and worker, page recovers on its own). Code for the Electron dialog |
| Theme: light, dark, system | available | available | available | T `settings.test.tsx`; the More menu and Display page |
| Sign out of the sign-in proxy | n/p R12 | available (behind oauth2-proxy) | available (behind oauth2-proxy) | T `settings.test.tsx` (Account) |
| External links open in the user's browser | available (bridge `openExternal`, `window.ts` policy) | available (a link) | available (a link) | T `tests/desktop-bridge.test.ts`. Desktop: not run in Electron |
| About: app version, host version | available (+ desktop app version and OS) | available | available | T `about-page.test.tsx`. **Fixed**: the bridge's `version` and `platform` were not shown anywhere |

## 2. The KVM screen: picture and view

| Feature | Desktop | Web | Mobile | Evidence and notes |
|---|---|---|---|---|
| Live picture: WebRTC H.264 with MJPEG fallback, VNC snapshot mode | available | available | available | Real (`kvm-real-pikvm-video`: 60 fps, audio track); E2E kvm-screen (MJPEG, fallback) |
| Status, overlay, resolution toast, freeze frame | available | available | available | T `picture-controller.test.ts`; E2E kvm-screen |
| Zoom and pan; zoom-out button | available (wheel) | available (Ctrl+wheel) | available (pinch) | E2E kvm-screen (pinch, Ctrl+wheel) |
| Full PiKVM UI framed over the picture | available | available | available | T `kvm-screen.test.tsx`. Not in an E2E run |
| Save screenshot (full-resolution JPEG) | available (and "saved/cancelled" from the shell's download event) | available (browser download; no outcome, R9) | available (browser download) | E2E parity: a real JPEG arrives on both profiles. T `platform.test.tsx` (the desktop wait) |
| Read text from the screen (OCR) | available | available | available | T `ocr-picker.test.tsx`, `msd-log-ocr.test.tsx`; E2E kvm-dialogs (desktop and phone drag) |
| Screen-change alerts while the window is behind others | available (taskbar pulse through the bridge) | available (tab title marker, app badge, notification) | n/p R3 | **Fixed**. T `attention.test.ts`, `screen-alerts.test.ts`, `kvm-screen.test.tsx`, `screen-alerts-page.test.tsx`; E2E parity (hidden tab: title, badge, notification; cleared when looked at; phone: switch absent and Settings says why). Starts off in a browser, on in the desktop app |
| Full screen with Keyboard Lock (Win, Alt+Tab reach the target) | available (bridge `setFullscreen` + lock) | available (Chromium: full screen and lock; Firefox, Safari: full screen without lock) | n/p R4 (an installed PWA is already full screen; Android Chrome offers full screen but has no keys to lock) | T `platform.test.tsx`; E2E kvm-screen (offered in More). Real lock not exercised (headless) |
| Screen stays awake while viewing (wake lock) | available (Electron power save blocker via the bridge's `keepDisplayAwake`) | available | available | T `platform.test.tsx` |
| Pointer: absolute hover, drag past the edge, wheel, right-click suppressed | available | available | n/p R7 | E2E kvm-screen (desktop) |
| Touch: trackpad and direct modes, tap, hold-to-drag, two-finger tap and scroll, pinch | n/p R7 | n/p R7 | available | E2E kvm-screen (phone, real CDP touch events) |
| Cursor dot, hold cue, magnifier lens | n/p R7 | n/p R7 | available | E2E kvm-screen (screenshot) |
| Absolute or relative trackpad mouse; touch mode | available (Settings -> Touch and mouse; in effect only on a touch screen) | available (same) | available (Settings and the More sheet) | T `kvm-screen.test.tsx` (K10); E2E kvm-screen |
| Haptics on the hold cue | n/p R6 | n/p R6 | available | T `haptics.test.ts` |
| Cursor position reported to the agent daemon | available | available | available | T `cursor-report.test.ts`, `picture-controller.test.ts`, `tests/harness-proxy.test.ts`, `agent/tests/test_harness_cursor.py`. On the hosted deployment the host relays `POST /app/daemon/cursor` (and only that daemon route) to the sidecar's `POST /api/cursor`, which sends it to its daemon; the page reports whenever `features.chat` is true |

## 3. The KVM screen: keys and typing

| Feature | Desktop | Web | Mobile | Evidence and notes |
|---|---|---|---|---|
| Hardware keyboard drives the target | available (window key events, no focus step) | available (click the picture first) | available (external keyboard into the hidden field) | E2E kvm-screen (desktop "Hi", Ctrl+C, Win+Shift+S) |
| Soft keyboard with diff mirroring and dictation | n/p R5 | n/p R5 | available | E2E kvm-screen (diff typing) |
| Sticky modifiers (tap to arm, double tap to lock), Caps mirroring the LED | available (on-screen keys) | available (on-screen keys) | available | E2E kvm-screen |
| Esc, Tab, arrows, Fn row, More row (paging keys, Ctrl+C/V/X/Z/A/S/F, Alt+Tab, Alt+F4, Win+D/R/L, C-A-D) | available (Send keys menu + on-screen keys) | available | available | E2E kvm-screen |
| Ctrl+Shift+Esc (Task Manager) and the Windows key on its own | available (Send keys menu) | available (Send keys menu) | available | **Fixed**: the phone had neither. T `key-rows.test.tsx` (including "every Send keys shortcut is reachable on a phone"); E2E parity (exact keys reach the fake) |
| Paste to target (dialog, keymap, Ctrl/Cmd+Enter) and Ctrl/Cmd+V host paste | available | available | available (dock button) | T `shell-atx-paste.test.tsx`, `kvm-screen.test.tsx`; E2E kvm-dialogs |
| Mouse buttons L/M/R, drag-lock, scroll up/down | available (on-screen keys) | available | available (More sheet) | E2E kvm-screen |
| Pinned macros one tap away | available (toolbar strip) | available (toolbar strip) | available (tiles in the More sheet) | E2E kvm-screen, settings-macros (strip and tiles follow Settings) |

## 4. The KVM screen: device control

| Feature | Desktop | Web | Mobile | Evidence and notes |
|---|---|---|---|---|
| ATX power, hold, reset with confirmation | available (Power button) | available (Power button) | available (More sheet) | T `shell-atx-paste.test.tsx`; E2E kvm-dialogs |
| Mass storage (upload, mount, write from URL) | available | available | available | T `msd-log-ocr.test.tsx`; E2E kvm-dialogs (upload through a real file input) |
| System, GPIO and health dialog | available | available | available | T `stream-health.test.tsx`; E2E kvm-dialogs |
| Health indicator (appears only when something is wrong) | available (toolbar) | available (toolbar) | available (dock) | **Fixed** (the phone had only the menu item). T `dock.test.tsx`, `toolbar.test.tsx`; E2E parity (appears and clears on both profiles) |
| Stream settings | available | available | available | T `stream-health.test.tsx`; E2E kvm-dialogs |
| PiKVM log | available | available | available | T `msd-log-ocr.test.tsx`; E2E kvm-dialogs |
| Speaker and microphone buttons, level meters | available | available | available | T `dock.test.tsx` (K12); Real (audio track) |
| Audio output and microphone device choice from the KVM (chevrons, "Audio devices" dialog) | available | available (output choice n/p R11 on Safari, Firefox) | available (n/p R11 on iOS) | T `toolbar.test.tsx`, `audio-registry.test.tsx` |

## 5. Macros

| Feature | Desktop | Web | Mobile | Evidence and notes |
|---|---|---|---|---|
| Macro manager: create, name, 23 icons, key combos with modifiers, text, pauses, reorder steps, pin, delete with confirm, run | available (KVM dialog and Settings -> Macros) | available (both) | available (both; Settings page is full page) | **Fixed**: Settings -> Macros was a read-only list. It is now the same component as the KVM dialog (`MacrosDialog` with `presentation="page"`). T `settings/macros-page.test.tsx` (M1-M7), `kvm/dialogs/macros.test.tsx`; E2E settings-macros (create, edit, icon, pin, run from Settings, reorder, tiles and strip follow, delete with confirm) |
| Reorder the list (the order of the tiles and strip) | available | available | available | **Fixed**: only steps could be reordered. T `model.test.ts`, `macros-page.test.tsx`; E2E settings-macros |
| Run any macro (not only pinned) | available (Send keys menu, Run in the manager) | available (same) | available (Run in the manager, Settings or the KVM dialog) | E2E settings-macros |

## 6. Settings

| Page | Desktop | Web | Mobile | Evidence and notes |
|---|---|---|---|---|
| Connection: PiKVM address and link state | available, editable (address, user name, password; relaunch) | available, read-only on the hosted host (R8) | available, read-only on the hosted host (R8) | T `settings.test.tsx` (pinned host draws no form, sends no PUT; the desktop form saves, validates, keeps the password); desktop: `2026-11-02-desktop-change-address.md` |
| Keep awake (mouse jiggler) | available | available | available | T `settings.test.tsx` |
| Keyboard layout (US or UK for typed text) | available | available | available | T `settings.test.tsx` |
| Touch and mouse (touch mode, trackpad absolute or relative) | available | available | available | T `settings.test.tsx` |
| Macros | available | available | available | section 5 |
| Providers: API keys (write-only) and CLI sign-in | available | available through the host's agent (sidecar or desktop) | available through the host's agent | T `providers.test.tsx`; Chat E2E `docs/e2e/chat-sidecar`. CLIs marked `desktop_only` (Gemini): n/p R14 on every platform that is not the machine running the agent |
| Display: theme | available | available | available | T `settings.test.tsx` |
| Display: screen-change alerts | available (taskbar) | available (title, badge, notification; blocked-permission note) | n/p R3 (the page says why) | T `screen-alerts-page.test.tsx` (S1-S4); E2E parity |
| Audio: microphone and speaker devices | available | available (hidden without a secure context, R10; speaker n/p R11 on Safari, Firefox, said on the page) | available (same) | T `settings.test.tsx` |
| Account: sign out | n/p R12 | available (behind oauth2-proxy) | available (behind oauth2-proxy) | T `settings.test.tsx` |
| About | available | available | available | T `about-page.test.tsx` |

## 7. Chat and the agent

Chat on the web and phone is the WebChat agent's work (`docs/deploy-web.md`, `docs/e2e/chat-sidecar`); this
matrix records its rows and defers to those documents for evidence.

| Feature | Desktop | Web | Mobile | Evidence and notes |
|---|---|---|---|---|
| Conversation, composer, run activity, approvals, model picker, diagnostics, computer sheet | available (harness runs beside the app) | available when the host has an agent (sidecar, or the desktop app) | available (same; phone layout) | `@pikvm/chat-ui` is the one implementation for all three; T `chat-route.test.tsx`, `packages/chat-ui`; E2E `docs/e2e/chat-sidecar` |
| "Chat is not available" page and automatic reconnect when the agent is down | available | available | available | T `chat-route.test.tsx` |
| Provider connections inside Chat | available | available | available | same component as Settings -> Providers |
| Shared terminal (the old xterm panel over `/app/terminal`) | missing, blocked B1 | missing, blocked B1 | missing, blocked B1 | The server socket remains; nothing in the app opens it |

## 8. The desktop bridge (`packages/contracts/src/desktop.ts`)

Each member of `DesktopBridge`, and what a browser or phone does instead.

| Bridge member | Desktop | Web | Mobile | Notes |
|---|---|---|---|---|
| `platform`, `version` | available (About) | n/p R1 (there is no shell to report) | n/p R1 | **Fixed**: now shown in About |
| `nativeControls` | available | n/p R2 | n/p R2 | the page leaves a gap for the lights instead of drawing its own buttons |
| `window.minimise / toggleMaximise / close / isMaximised / onMaximiseChange` | available | n/p R1 | n/p R2 | `window-controls.tsx` |
| `window.setFullscreen / isFullscreen / onFullscreenChange` | available | available (`requestFullscreen`, `fullscreenchange`, Keyboard Lock) | n/p R4 | `platform.ts` |
| `window.onFocusChange` | available (pointer is not driven while the window is unfocused) | available (the page's own focus and visibility, used for alerts) | n/p R3 | `useInBackground` |
| `requestAttention` | available (taskbar or dock) | available (title marker, badge, notification: `attention.ts`) | n/p R3 | **Fixed** |
| `onDownloadDone` | available | n/p R9 (the browser's downloads UI owns it; the screenshot is assumed saved) | n/p R9 | `awaitDownload` |
| `openExternal` | available | available (an ordinary link) | available (an ordinary link) | |

## 9. Whole-surface checks

The four sweeps the audit was asked to make, and what each found.

- **Shown only when `window.pikvmDesktop` exists** (`grep -rn "desktopBridge\|isDesktopApp" apps/web/src`): the
  window titlebar and controls (R1), the taskbar pulse (now a browser alert as well), the download-done wait (R9),
  the wake-lock exemption (B2), and the Connection form (editable
  in the desktop app, read-only on a hosted host, R8). Nothing else.
- **Only in the desktop toolbar**: Send keys shortcuts (the phone lacked Task Manager and the Windows key:
  fixed), the health indicator (the phone lacked it: fixed), Power, the macro strip (phone: tiles) and the audio
  device chevrons (phone: the Audio devices item). Nothing left.
- **Only in the phone sheet**: mouse buttons, touch settings and macro tiles. The desktop has the same buttons in
  its key strip, the same settings in Settings, and the strip. Nothing left.
- **Settings sections hidden on a platform**: the Connection form on a hosted host (R8), Audio without a secure
  context (R10), Account without a proxy (R12), screen alerts on a phone (R3). Each says why on the page. The old
  Macros page was a read-only list on every platform: fixed.

## Blocked

| | What | Why it is not done | What unblocks it |
|---|---|---|---|
| B1 | The shared terminal has no view in the app. The server still hosts the PTY sessions and the `/app/terminal` socket (`src/server/terminal-socket.ts`; `features.terminal` in `/state` is read by nothing). | `docs/PRODUCT_REQUIREMENTS.md` makes the chat the only primary harness surface with "no terminal-first default", and the PLAN lists the terminal as a desktop capability. Whether the rebuild brings an xterm view back (a Settings or Chat subpage that attaches to the socket) is a product decision, not a parity fix: it is absent on every platform, not one. The hosted host also has no PTY (`terminalSessions` is desktop-only). | A decision to keep the terminal. Then a lazy xterm route over `/app/terminal` (the protocol is in `src/terminal-protocol.ts`), desktop first; the hosted web host would need the sidecar to expose its PTY. Otherwise delete the socket and `features.terminal`. |
| B2 | ~~Screen wake lock inside the desktop app.~~ Done: the bridge member `keepDisplayAwake(on)` (Electron `powerSaveBlocker`, "prevent-display-sleep", one per window, released when the window closes) is driven by `useWakeLock` on the web wake lock's visibility rule. | | |

## Evidence index

| Run | File |
|---|---|
| Platform parity (installable, offline, health, phone shortcuts, browser alerts, screenshot) | `docs/e2e/2026-11-02-parity.md`, `apps/web/e2e/parity.e2e.mjs` |
| Settings -> Macros | `docs/e2e/2026-11-02-settings-macros.md`, `apps/web/e2e/settings-macros.e2e.mjs` |
| KVM screen | `docs/e2e/2026-11-02-kvm-screen.md` |
| KVM dialogs | `docs/e2e/2026-11-02-kvm-dialogs.md` |
| Real PiKVM, video and audio only (input guarded) | `docs/e2e/2026-11-02-kvm-real-pikvm-video.md` |
| Desktop: change the PiKVM address | `docs/e2e/2026-11-02-desktop-change-address.md` |
| Chat on the hosted web | `docs/e2e/chat-sidecar/` |
