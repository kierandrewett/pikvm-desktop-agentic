# PiKVM console — feature/route inventory for the React migration

Read-only investigation of `~/dev/pikvm-desktop-agentic`. Line refs are to the working tree. `[INFERENCE]` = not directly confirmed by running code.
`console.js` below means `src/views/console.js` (10 987 lines, one IIFE; `"use strict"`, `var`-style, no modules). Other views: `console.html` (700), `console.css` (~2 950), `key-chord.js`, `webrtc.js`, `janus.js`+`adapter.js` (vendored), `touch.js`, `sw.js`, `terminal.html`, `settings-console.html`. Agent chat map is in `local://agent-chat-map.md` (not repeated).

## 0. Headlines

- The console is **one 11k-line script that talks to kvmd through the reverse proxy with root-relative URLs** (`/api/*`, `/streamer/*`, `/janus/ws`) and to our own server through `/_agent/*`. A React rewrite must be served such that both namespaces stay same-origin (or the proxy must be kept as-is).
- **The agent React workspace is NOT embedded in the console any more.** `#chat-frame` loads `/_agent/terminal.html` (xterm.js shared terminal) on desktop *and* web (`console.js:9869, 9989`). Only `workspace/styles.css` + `workspace/shared.js` (`window.pikvmShared.mountIconButtons/mountButtons`) are borrowed (`console.html:32-33`). `/_agent/workspace/` + `/_agent/harness/*` are still mounted and work when opened directly.
- Desktop vs web is decided by `window.desktopConsole` (Electron preload `preload-console.ts`). Touch dock mode = `!desktopConsole && (pointer: coarse)` at load (`console.js:8935`).
- Web has **no Settings UI at all**. Desktop Settings is a separate Electron window (`settings-console.html`) that edits URL/layout/jiggler and **relaunches the app** (`main.ts:855-869`). A new Settings page needs new server endpoints.
- `agentActing` is hard-wired `false` (`console.js:279`, never assigned) → all "agent is driving" guards are dead.

## 1. Console features (console.js / console.html)

### 1.1 Boot, pure helpers, exports
| Feature | Where | Notes / endpoints |
|---|---|---|
| Pure exports for tests (`charToKey, fracToNorm, streamPath, streamModeForInfo, panelCeiling, fracInBox, macroKeyGroups, MACRO_MODS, macroGlyph`) via `module.exports` then `if (typeof window==="undefined") return` | 207-219 | tests `require()` the file → keep a Node-importable pure module |
| US/UK char→physical key map (mirrors `human-typing.ts`) | 19-55 (`US_MAP`,`UK_MAP`, `charToKey` 52) | parity pinned by `keyboard-layout-parity.test.ts` |
| `fracToNorm` fraction→kvmd abs coord (−32768..32767, ×65534) | 58-61 | |
| `streamPath(key, ua)` MJPEG URL w/ per-browser quirk (iOS/Safari/Blink) | 64-73 | `GET /streamer/stream?key=…` |
| `streamModeForInfo(info)` → `"snapshot"` iff `result.extras.vnc_lab.enabled===true` else `"native"` | 76-79 | |
| `panelCeiling(vw,screenMin,min,max)` | 89 | |
| `fracInBox(box,x,y,clamp)` pointer→picture fraction (clamp for held-button drags) | 198-205 | |
| Early-declared shared state (`avState`, `tbState`, `repaint*` hooks) – **load-order sensitive** | 221-266 | comment explains hoisting bugs; React state replaces |

### 1.2 Screen / stream
| Feature | Fns (lines) | Endpoints |
|---|---|---|
| Native MJPEG `<img id=screen>`; random `streamKey`; 7 s first-frame watchdog; reconnect backoff 800 ms ×1.7 → 8 s; `load`/`error` handlers | `loadStream` 5392-5446, `scheduleReconnect` 5447-5456, 5457-5470 | `GET /streamer/stream?key=&t=` |
| Health poll every 2.5 s (4 s abort): distinguishes server-down / no-signal / live; new `streamKey` on recovery | `pollHealth` 5474-5506, interval 5796 | `GET /streamer/state` (`result.source.online`) |
| Snapshot transport for VNC-lab targets (200 ms cadence, 5 s abort, fail backoff 400 ms×1.8ⁿ ≤5 s, ≥3 fails → disconnected, objectURL swap) | 5508-5607 | `GET /api/streamer/snapshot?t=`; mode picked by `detectScreenMode` 5739-5758 → `GET /api/info` (2.5 s abort, fail→native) |
| Status chip + overlay + states (`connecting/live/nosignal/offline/reconnecting/disconnected`), "· input offline" suffix | `STATUS` 5274-5299, `setState` 5318, `paintConnStatus` 5310 | overlay `#overlay-label/#overlay-spinner` (`console.html:~394`) |
| Freeze canvas: last good frame held while stream restarts (`has-frame`/`frozen` classes) | `freezeFrame/thawFrame` 5355-5372 | |
| Stream only while needed (hidden under Full UI / collapsed preview unless screen-alerts watching) | `applyStreamNeed` 5383, `pictureHidden` 5377 | |
| Visual "no signal" (uniform-frame detector, 1.5 s sample, variance<6 for 2.5 s) | `sampleBlank` 5906-5957, `reevalStreamState` 5901 | canvas readback |
| Background screen-change alerts (desktop): luminance grid diff → `desktopConsole.signalScreenChange()`; toggle persisted `pikvm-console-screen-alerts` | 5812-5900 (consts 5836-5839) | IPC `console:screen-activity` |
| **WebRTC/Janus H.264+audio** with MJPEG fallback: `JanusStream({wsUrl,video,wantAudio:true,wantMic:false,micDeviceId,onStatus,onActive})`; muted start (Safari autoplay), swap on `playing`, 6 s play watchdog, 8 s start guard, `fallbackToMjpeg`, unmute-on-gesture | 6064-6392 (`activateWebrtc` 6098, `onVidPlaying` 6125, `tryUnmuteVid` 6163, `fallbackToMjpeg` 6186, `startNativeWebrtc` 6341) | `WS /janus/ws`; `webrtc.js` (`window.JanusStream`, `.available()`, `start/stop/setAudio/setMic/setMicDevice/hasVideo/getAudioLevels`) dynamically `import("/_agent/janus.js")` (→ `./adapter.js`) |
| Resolution toast "W × H · HD·WebRTC / MJPEG / VNC" + 🔊/🎙 badge, 2.6 s, `emptyWhenFaded` | `showResToast` 6307-6338, `avSummary` 6285 | `#res-toast`; desktop auto-fit-native on resolution change 10514+ |
| Generic toast (error styles, sticky option, a11y clearing) | `toast` 835, `hideToast` 861, `emptyWhenFaded` 827 | `#toast` |
| Full PiKVM UI: framed `/?native=1` under our titlebar, 12 s load timeout note, hands keyboard over (`releaseAllMods`, `releaseHeldMouseButtons`, `kbd.blur`), drops MJPEG src, "Back to console" | 5620-5737 (`setFullUi` 5661) | `GET /?native=1` (proxied Pi HTML + injected bundle), iframe `#full-ui-frame allow="fullscreen; clipboard-*"` |
| Zoom/pan transform on both `<img>`/`<video>`/freeze canvas; `ZMAX=6`; zoom-reset button | `applyXform` 7335, `clampPan` 7360, `zoomAround` 7400 | |
| Coordinate mapping through object-fit letterbox + transform | `pictureBox` 7270, `fracAt` 7289, `moveTo` 7305, `clickAt` 7314 | |
| Screenshot (full-res JPEG to download; desktop waits for `console:download-done` ≤20 s) | `saveScreenshot` 4372-4400, `awaitScreenshotSave` 4357, `DOWNLOAD_WAIT_MS` 4345 | `GET /api/streamer/snapshot?allow_offline=1` |
| OCR: drag-rect on picture → kvmd OCR → dialog with Copy/… ; hidden unless `ocr` event says enabled | 2450-2650 (`startOcrPick` 2504, `runOcr` 2603, pointer fns 2563-2602) | `GET /api/streamer/snapshot?allow_offline=1&ocr=1&ocr_left/top/right/bottom=&ocr_langs=` ; WS event `ocr` |

### 1.3 HID socket (`/api/ws`) — `hid` object, 388-753
- `WS {ws|wss}://host/api/ws` (471). Out frames (671-692): `key{key,state}`, `mouse_move{to:{x,y}}`, `mouse_button{button,state}`, `mouse_wheel{delta:{x,y}}`, `mouse_relative{delta,squash:true}` (clamped ±127), `ping`.
- In events handled (521-589): `atx`→`atx.setState`, `hid_keymaps`→`fillKeymaps`, `streamer`→`setStreamerState`+`health.setSource`, `info`→`health.setInfo`, `hid`→`health.setHid` + caps LED (`leds.caps`) + mouse mode (`mouse.absolute`, `mouse.outputs.available/active`), `msd`, `gpio`, `ocr`.
- Reliability: reconnect 1.2 s ×1.7 → 5 s (442-447, 627-634); heartbeat `ping` every 10 s, socket declared dead after 25 s silence → `kickNow` (598-626); offline queue ≤256 items, **drop >2 s old except key/button *releases*** (419-430, 499-504, 651); `kick()` on foreground/online; `everSettled` (400); status callback paints chip + disables drawer (5780-5793).
- Caps Lock: target caps from LED report, `noteCapsToggle`, 1.2 s pending window (448-460, 728-751); host caps mirrored (`syncHostCaps` 8508).
- Mouse output switching `POST /api/hid/set_params?mouse_output=usb|usb_rel`, throttled 1.5 s, only when Pi has reported mode (705-723).
- Agent-gate in `send()` (644-648) is dead (see §6).

### 1.4 Keyboard engine & soft-keyboard mirror
| Feature | Fns (lines) |
|---|---|
| Decision logic (chord / char / ignore; bare modifiers never sent; Caps forwarded bare; IME ignored) | `key-chord.js` `decide` 71, `createModifierMirror` 114 (`window.KeyChord`, also `module.exports`) |
| Serialized key queue: `KEY_HOLD=22ms`, `KEY_GAP=4ms`, `KEY_MOD_SETTLE=6ms` (mods get own report before key); fast-typing safe; caps-aware case resolution | `sendChord` 5090, `drainKeys` 5105, `sendCode` 5140, `sendChar` 5146, consts 5072-5077, `afterKeys` 5079 |
| Armed (sticky) modifiers + modifier lock (double-tap), `modMirror` owned()/release on blur | `armed/clearArmed` 5009-5019, `pressMod/releaseMod/releaseAllMods` 5034-5055, buttons 8728-8790, `withArmedMods` 8794, `paintMod` 8703 |
| Dedupe (keydown + beforeinput double-fire; 60 ms exact id) and auto-repeat throttle (`keyQ.length<2`) | `dedupe` 8472, `DEDUPE_MS` 8464, `admitRepeat` 8469, `recentlySent` 8482, `noteSent` 8487 |
| Hidden `<input id=kbd>` (1×1, `tabindex=-1`) keydown/keyup/beforeinput/input/composition/blur | 8554-8700; `handleKeydown` 8531; host-paste (Ctrl/⌘+V) shortcut → paste-to-target 8551, `pasteHostClipboard` 4639 |
| **Soft-keyboard diff mirror**: field is the record; diff vs last value → N× Backspace + added chars; `KB_PAD` zero-width pad (so Backspace on empty works), `KB_MAX=96`, U+FFFC dictation placeholder stripped, smart-quote/em-dash/ellipsis fold (`KB_FOLD`), composition gating | 8568-8700 (`kbSync` 8614, `kbReset` 8606, `kbSettle` 8643) |
| Focus management: `refocusKbd`, dock presses must not steal focus (`dockPressAt` 700 ms, pointer/mousedown preventDefault) | 8847, 9050-9054, 9186-9195 |
| Modal gate: `blockKvmInput` (agent/fullUi), `modalOpen()` guards on all input entry points (≥4 `if (modalOpen()) return;` pinned by test) | 292, 4985 |

### 1.5 On-screen controls (drawer `#drawer`, `.bar-keys`, `console.html:574-641`)
- Mouse L/M/R (`data-click`, 8802), drag-lock ⤞ (8838), scroll ▲▼ (`data-scroll`, 8816), Esc/Tab/arrows/Home/End etc. (`data-key`, 8728), chord buttons `data-chord` (8740), C-A-D (8827), Caps key mirroring LED (8997-9014), Shift/Ctrl/Alt/Win mods (`data-mod`).
- Touch dock extra rows: Fn row (F1-F12, `kx-fn`) and More row (PgUp/PgDn/Ins/PrtSc/Pause/ScrLk/Menu, Ctrl+C/V/X/Z/A/S/F, Alt+Tab, Alt+F4, Win+D/R/L; `kx-more`) — `console.html:607-640`; toggled by `#fn-toggle`/`#more-keys-toggle` (`setKeyRow` 9121, `wireDockActions` 9138); `buildDockKeys` 9061 re-arranges the drawer into rows (`.krow`).
- Drawer overflow fade (`paintEdgeFade` 8882), drawer disabled when HID socket down (`paintDrawerEnabled` 5772).
- Desktop: native menu `KVM_SHORTCUTS` (CAD, Task Manager, Alt+Tab, Alt+F4, Win, Win+D/L/R, PrtSc, Esc) 10917-10936; `popSendKeys` 10950 (paste + macros + shortcuts).

### 1.6 Touch input (`pane` = `#screen-pane`)
Spec comment 7412-7425; state 7426-7463.
- Modes: **trackpad** (default) vs **direct** (`pikvm-touch-mode`), trackpad HID abs/rel (`pikvm-touch-hid`); toggles in ⋯ sheet (9015-9043). `lastInputTouch` follows last pointer type; Pi mouse output follows input (`wantAbsOutput` 7449; `hid.setMouseOutput` on pointerdown 8075).
- Gestures: 1-finger drag = cursor delta (`relMove` 7655, `SENS .9`, `REL_SENS 1.0`), tap = left click, long-press / hold-still `HOLD_MS=450` arms hold-cue; armed+move = **hold-to-drag** (`startHoldDrag` 8368), armed+lift = right click; 2-finger tap = right click; 2-finger drag = wheel (22 px/step) ; pinch (>12 % dist change) = zoom; 2-finger decision locked once (`twoStart.kind`, 14 px drag threshold) — 8121-8143, 8232-8276; slop `MOVE_SLOP=8`, `TOUCH_SLOP=16` (7533-7538).
- Trackpad cursor blob (`#kvm-cursor`, `paintTrackpadCursor` 7710, `paintCursor` 7957), zoom follows cursor (`followCursor` 7696), virtual cursor `vcur` in kvmd norm units (7547+), relative "debt" held while Pi switches to rel (`awaitingRelative` 7592, `flushMove` 7595, `whenAbsolute` 7878 queues abs actions until Pi reports absolute).
- Lens/magnifier (`#kvm-lens` canvas, speed-adaptive size 64-168 px, total mag 4×, linger 1.4 s): 7723-7853 (consts 7737-7742, 7772-7773).
- `endTouch` 8301 releases held buttons/mods when modal swallows release; drag-lock semantics in pointerdown 8155-8166.
- Browser pinch zoom suppressed (`gesturestart` preventDefault 10003).

### 1.7 Desktop mouse / wheel
- Absolute follow on hover (`pointermove` 8199-8226): `moveTo` rAF-coalesced (`queueMove` 7626); drag keeps steering when pointer leaves picture (clamped, button state from `e.buttons`) ; `buttons===0` ⇒ `releaseHeldMouseButtons` (7473); on non-live stream also sends clamped (±30) **relative nudge** to wake a sleeping target (8214-8222); suppressed when desktop window unfocused (7599, 7967).
- Clicks pass held modifiers (`pressClickMods` 7506, `releaseClickMods` 7529); `hidButtonFor` 7648; right-click context menu suppressed on pane (8405).
- Wheel (8409-8455): wheel step ±1; Ctrl/⌘+wheel zooms local picture **on web only**; on desktop wraps Ctrl/Meta around the wheel via `modMirror.owned`.
- pointerenter/leave 8040-8055; OCR picker takes pointer (8067-8070, 8191).
- Throttled `POST /_agent/daemon/cursor {x,y}` (desktop only, 180 ms, keepalive) 7567-7583 — feeds the agent daemon; **agent-coupled**.

### 1.8 Dialogs (all `.dlg-scrim`/`.dlg`, `hidden` attr, focus trap)
Infra: `closeOtherDialogs` 4806, `openScrim/focusablesIn/initialFocusIn/modalOpen` 4865-4985 (`FOCUSABLE` 4870), `syncModalCursor` 4723 (+`html.modal-open`), dialog action buttons via `window.pikvmShared.mountButtons` (`mountDialogActions` 2091, fallback `renderPlainButtons` 2056, lookup `dialogControl` 2083), `controlBusy` 3199 (never rewrite a focused `<select>`; repaint on blur).
| Dialog | Lines | Endpoints |
|---|---|---|
| **Paste to target** (textarea, keymap select from `hid_keymaps`, duration hint ≥10 s, host clipboard prefill) | 4404-4720: `openPasteDialog` 4525, `sendPasteText` 4549, `sendPaste` 4626, `fillKeymaps` 4460, `printQuery` 333, `PASTE_DELAY_S=0.02` 330 | `POST /api/hid/print?limit=0&delay=0.02[&keymap=]` body text/plain; 413 handled |
| **Stream settings** (resolution select, quality/FPS/H264 bitrate/GOP sliders from `streamer.features/limits/applied`; Reset stream; Save screenshot) | 4102-4310: `STREAM_SLIDERS` 4156, `paintStreamDialog` 4179, `sendStreamParam` 4123 (revert on failure) | `POST /api/streamer/set_params?<name>=<val>`, `POST /api/streamer/reset` (confirm) ; WS event `streamer` |
| **Mass storage** (image select, CD/flash mode, writable, connect/disconnect, delete image, upload file via XHR w/ progress, "write from URL", reset, free space) hidden if no MSD | 2696-2906 (`msd` module), 3248-3686 (`paintMsd`, `startMsdUpload` 3401, `setMsdConnected` 3589, `removeMsdImage` 3640, `msdActionSpecs` 3652) | `POST /api/msd/set_params`, `/set_connected?connected=`, `/write?image=&remove_incomplete=1` (XHR body=file), `/write_remote?url=&remove_incomplete=1`, `/remove?image=`, `/reset`; WS event `msd` |
| **System / GPIO / health** (problem list: no signal, HID detached/offline, undervolt, freq-cap, fan; About line; HID attach/detach + reset; user GPIO switch/pulse rows with confirm for USB-breaker) | health 2907-3030, GPIO 3031-3138 & 3832-3960, HID recovery 3139-3197 (`setHidConnected` 3147, `resetHid` 3172), `paintHealth` 3687, `paintAbout` 3985, `openHealthDialog` 4018 | `POST /api/hid/set_connected?connected=`, `/api/hid/reset`, `POST /api/gpio/switch?channel=&state=`, `/api/gpio/pulse?channel=`; WS `info`,`hid`,`gpio`,`streamer` |
| **Pi log** (range select 10 m/1 h/…, streamed read, 1500-line cap, copy/refresh/abort on close) | 2271-2412 (`loadLog` 2303, `capLog` 2368, `LOG_MAX_LINES` 2367) | `GET /api/log?seek=<s>&follow=0` |
| **OCR result** | 2465-2690 | see §1.2 |
| **Audio devices** (mic / output select, `setSinkId`, missing-device notes, device naming via temporary getUserMedia, persisted `pikvm-console-mic-device`/`-speaker-device`) | 6565-7260 (`chooseDevice` 6878, `nameDevices` 7170, `refreshAudioDevices` 6761, `devicechange` 7229); mic constraint wrapper over `getUserMedia` 6683-6717 | — |
| **Macros editor** (list, name, 23 SVG icons radiogroup w/ roving tabindex, pin to titlebar, steps: chord w/ modifier toggles + key select grouped by `macroKeyGroups`, text, delay; reorder/remove; draft held locally until valid; autosave) | 1519-2050 (`paintMacroEditor` 1527, `openMacroEditor` 2017, `stepWouldPersist` 2006, icons 1014-1037) | `GET/PUT /_agent/api/macros` (1081, 1096) |
| ATX power confirm dialogs (`window.confirm`) | `runAtxAction` 4989, `ATX_ACTIONS` 945 | `POST /api/atx/click?button=power|power_long|reset` (921; 409→"another client") |
Native `window.confirm` used for: ATX, stream reset, MSD reset/delete, HID reset, GPIO USB-breaker.

### 1.9 Macros run
`runMacro` 1184-1336: refuses if macro/paste running or chord macro while HID offline (`macroBlocked` 1390); steps run in order: chord → `sendChord` then wait `afterKeys`; text → `POST /api/hid/print` (same keymap as paste; 413/!ok stops run); delay → timeout; "Running … about N s" sticky toast if ≥2 s (`macroDuration` 376); stop reports remaining steps. Pinned macros: titlebar strip (`pinnedMacroSpecs` 1413, `#tb-macros`, desktop) and ⋯ list/phone sheet grid (`paintMacroMenu` 1452, `#macro-run-list`). Server store `src/macros.ts` (≤60 macros, ≤40 steps, delay ≤10 s, text ≤4000, default "Capture region").

### 1.10 Audio / mic
Toggles `#audio-btn/#mic-btn` (6478-6540): audio default on, auto re-enable after 1 h if user mutes (6400); mic via getUserMedia; permission denied → warn state; levels from WebRTC stats every ~90 ms driving CSS `--vol` (`meterTick` 6428); `paintToggle` 6462; revealed only when WebRTC live (`revealAvToggles` 6240); desktop titlebar pair + chevron device popout (`devMenu` 6915-7090, `#av-dev-menu`); phone dock speaker/mic (`#dock-audio-btn/#dock-mic-btn`, repaint 243-256, wire 9162).

### 1.11 Theme
`pikvm-console-theme` localStorage; inline bootstrap in `<body>` (`console.html:37-43`); `applyTheme` 9755 sets `data-theme` **and** toggles class `dark` (shared Tailwind lib reads class; pinned by test), reports to desktop (`reportAgentTheme`) and posts `{channel:"pikvm-panel",type:"theme"}` to `#chat-frame` (9798); answers `subscribe` from any frame on every platform (9819-9826); follows OS only when no stored choice (9835-9848).

### 1.12 Layout, panels, ⋯ menu
- Grid layout: desktop (≥900px landscape) = chat column + screen column; `fitAspect` 9273 (auto-size `--sh` to stream aspect until user drags), vertical grip resize w/ snap targets (`SNAP=20`, `snapTargets` 9333, keyboard grip 9436, `paintGripValue` 9428), horizontal `#chat-resize` column divider w/ keyboard, width saved `pikvm-chat-workspace-width-v2`, bounds from CSS vars `--chat-min/max/default/--screen-min` (5195-5253, 9468-9587), preview collapse `computer-collapsed` (`setPanel` 10467), intro `booting` slide-in revealed by terminal's `chat-ready` postMessage or 3.5 s timeout (9252-9263, 9583).
- ⋯ menu `#more-menu` (`console.html:456-530`): `placePopover` 9600 (flip/clamp), `setMenuOpen` 9662; items: touch input/trackpad mouse (dock), audio/mic (+chevrons), Audio devices, Paste, Stream settings, Save screenshot, System/GPIO/health, Mass storage (hidden unless MSD), Read text (hidden unless OCR), PiKVM log, Macros (+ macro run list), ATX Power/Power(hold 5s)/Reset (hidden unless ATX), Full screen, Toggle theme, Full PiKVM UI. On desktop the ⋯ button/right-click open a **native Electron menu** instead (`buildMenu` 10754, `runCommand` 10800, `popNative` 10891, contextmenu 10910).
- Haptics: `import("/_agent/haptics.js")` (`web-haptics`), `buzz()` 9322 on drag grab/snap.
- Phone `.bar` bottom bar: conn dot + status text, dock AV buttons, zoom reset, paste, ⌨ (`#kbd-btn`), ⋯ (`console.html:403-454`).

### 1.13 Touch dock (phone/tablet) — 8926-9246
`dockMode` 8935 → `html.touch-dock`; drawer moved into bar (`mountDrawerInBar` 8950); `.app` sized to **visualViewport** (`--app-height/--app-top`, `kb-open` if viewport lost >150 px, `vvTallest`, orientationchange reset) 9196-9222; ⋯ menu becomes in-flow **bottom sheet** inside the bar (9224-9243, macros as 4-col tile grid); ⌨ toggles system keyboard (`toggleSoftKeyboard` 8958, `kbWanted`); safe-area insets in CSS (`console.css` ~2498-2870); status text hidden ≤440 px; `html.no-terminal` same single-column layout when host has no terminal. CSS `@media (max-width:560px)` macro editor stack (2240).

### 1.14 Terminal / chat frame
- `#chat-frame` src `/_agent/terminal.html` (desktop 9869, web after `/api/state` says `features.terminal` 9975-9996 with retry 2 s→15 s). Web hides panel with `html.no-terminal` until state says yes (9970-9973). `features.chat` is returned but **unused** by the console.
- Console↔frame messages: console→frame `{channel:"pikvm-panel",type:"theme"|"placement",value}`; frame→console `chat-ready`, `{pikvm-panel,subscribe|set-side|toggle-detached}` (9583, 9819, 10076).
- Desktop-only titlebar **Agent backend pill** polls `GET /_agent/daemon/status` every 5 s (9906-9951; `#backend-status`).

### 1.15 Desktop titlebar (Electron only; `html.desktop-console`, 38 px) — `console.html:52-93`, `console.js:10015-10986`, CSS 1192-1700
Window `drag region`; clusters (all drawn through `pikvmShared.mountIconButtons`, polled up to 100×50 ms for the bundle, `mountTitlebarButtons` 10592):
- left `#tb-actions-panel`: preview toggle (`panelButtonSpecs` 10452, "Hide/Show target preview"); `#backend-status` pill.
- centre `#tb-title`: "PiKVM" / "VNC lab" / "PiKVM — full UI" (5612, 5598, 5698), yields to clusters (`fitTitle` 10324, ResizeObserver).
- right: `#tb-actions-status` Health (hidden when fine; amber/red) + Power (ATX menu, colour by LED, busy) — 10379-10410; `#tb-macros` pinned macro strip (clips, fade, focus-scroll); `#tb-actions-menus` More (native menu) + "Send keys" (native menu) — 10598-10621; `#tb-actions-av` Audio/Mic + device chevrons (10411-10450); `#tb-actions-view` Fit-to-native (disabled w/o frame, label has resolution) + Settings (10563-10591); then `#tb-window` min/max-restore/close (`windowButtonSpecs` 10283, `paintMax` 10298; macOS hides own and uses native traffic lights `nativeControls`). `html.platform-<os>`, `html.native-window-controls`.
- `?shell=native` variant (10256-10269) is never produced by main (dead, §6).
- Desktop keyboard: global `keydown` forwards physical keys to the KVM (10193-10246) unless modal/preview hidden/own control focused; keyup always releases; window focus from main (`onWindowFocus`→`applyWinFocus` 10162) drops cursor blob, releases mods/click-mods; web uses window focus/blur.
- Fit to native (`fitNativeNow` 10486 → `desktopConsole.fitNative({width,height,chromeWidth,chromeHeight})`), auto-fit on resolution change (10514+).
- Saved panel width, conversation side (`pikvm-console-agent-side`, `html.agent-right`), detach (10041-10145) — see §6 (unreachable).

### 1.16 PWA / lifecycle / platform
| Feature | Where |
|---|---|
| Manifest `/_agent/manifest.webmanifest` (standalone, start `/_agent/console`, scope `/`, icons 192/512 + maskable), apple-touch-icon, theme-color, apple-mobile-web-app-* , viewport `maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content` | `console.html:5-16`, `manifest.webmanifest` |
| Service worker `/_agent/sw.js` scope `/_agent/`, registered only if secure context & not desktop; network-first; offline "Can't reach the KVM" page (503) that auto-retries (5 s poll + `online`); caches `/_agent/*` static assets except `LIVE=/^\/_agent\/(api|daemon|harness|terminal|mcp)(\/|$)/`; cache `pikvm-console-v2` | `console.js:6049-6053`, `sw.js` |
| Wake Lock (screen) when visible, web only; re-request on pointerdown/visible | 5988-6011 |
| `visibilitychange`: hidden → release wake lock; back after >3 s → `hid.kick()` else `connect()`, snapshot/poll health, reload stream | 5966-5982 |
| `online` → `serverDown=false`, `hid.kick()`, reload stream; `offline` → disconnected | 6054-6063 |
| Fullscreen + Keyboard Lock ("Full screen (send Win and Alt keys)") web only, Esc-hold exits | 6018-6048 |
| Mouse jiggler | **server only** (`src/mouse-jiggler.ts` fed by proxy HID tap, `server.ts:100-115`); console has no UI; setting only in desktop Settings window / `PIKVM_JIGGLER=1` on web host; status in `GET /_agent/api/state` `jigglerStatus` (nothing in console reads it) |
| Screenshot save, copy-to-clipboard fallback (`copyText` 2414, `legacyCopy` 2429) | — |
| localStorage keys | `pikvm-console-theme`, `pikvm-touch-mode`, `pikvm-touch-hid`, `pikvm-chat-workspace-width-v2`, `pikvm-console-agent-side`, `pikvm-console-screen-alerts`, `pikvm-console-mic-device`, `pikvm-console-speaker-device` |

## 2. Endpoints called by console / terminal

All kvmd paths go through our proxy (auth injected server-side); same-origin root-relative.

| Method + path (params) | Caller (console.js line) |
|---|---|
| `WS /api/ws` (HID + events) | 471-479 |
| `WS /janus/ws` | 6083 (`webrtc.js`) |
| `GET /streamer/stream?key=&t=` (+quirk) | 66, 5441 |
| `GET /streamer/state` | 5480 |
| `GET /api/info` | 5744 |
| `GET /api/streamer/snapshot?t=` / `?allow_offline=1` / `?allow_offline=1&ocr=1&ocr_*` | 5576 / 4376 / 2613 |
| `POST /api/streamer/set_params?<k>=<v>` | 4124 |
| `POST /api/streamer/reset` | 4278 |
| `POST /api/hid/set_params?mouse_output=usb\|usb_rel` | 718 |
| `POST /api/hid/print?limit=0&delay=0.02&keymap=` (text/plain) | 1294 (macro), 4596 (paste) |
| `POST /api/hid/set_connected?connected=0\|1` | 3148 |
| `POST /api/hid/reset` | 3174 |
| `POST /api/atx/click?button=power\|power_long\|reset` | 921 |
| `POST /api/msd/set_params?<k>=<v>` ; `/set_connected?connected=` ; `/remove?image=` ; `/reset` | 2849, 2873, 3644, 3663 |
| `POST /api/msd/write?image=&remove_incomplete=1` (XHR, file body, upload progress) ; `/write_remote?url=&remove_incomplete=1` | 3432 / 3429 |
| `POST /api/gpio/switch?channel=&state=` ; `/api/gpio/pulse?channel=` | 3120, 3129 |
| `GET /api/log?seek=&follow=0` (abortable stream read) | 2316 |
| `GET /?native=1` (iframe) | 5633/5691 |
| `GET /_agent/api/state` | 9976 (layout `us|uk`, `features.terminal`) |
| `GET /_agent/api/macros`, `PUT /_agent/api/macros` | 1082, 1097 |
| `GET /_agent/daemon/status` (desktop pill, 5 s) ; `POST /_agent/daemon/cursor` | 9907 ; 7577 |
| `GET /_agent/terminal.html` (iframe) → `WS /_agent/terminal` | 9869/9989 → `terminal/main.ts:118-120, 747-748` |
| `GET /_agent/{console.css,console.js,webrtc.js,key-chord.js,janus.js,adapter.js,haptics.js,sw.js,manifest.webmanifest,icon*.png,apple-touch-icon.png}` | `console.html:14-17,695-698`; 6021, 9314, 6052 |
| `GET /_agent/workspace/styles.css`, `/_agent/workspace/shared.js` (module; sets `window.pikvmShared`) | `console.html:32-33` |
| Terminal frame assets `xterm.css`, `terminal.js` (+`.map`) | `terminal.html:7` |
| Terminal WS protocol (`terminal-protocol.ts`): server→client `sessions{sessions,cols,rows,control}`, `data`, `exit`, `control{owner}`, `image{reqId,dataUrl}`; client→server `create`, `input`, `resize`, `close`, `restart`, `openPath`, `openLink`, `readImage` | `terminal-server.ts:235-270` |

kvmd paths **not** used by the console: no `/api/auth/*`, `/api/export`, `/api/redfish`, `/api/switch`, `/api/upgrade`, `/api/hid/events*` HTTP (e2e doc intercepts `/api/hid/events` but console never calls it). Login to kvmd is entirely server-side (proxy injects auth).

## 3. Server routes (src/server.ts and friends)

Entry: `startControlServer(deps, port, host)` `server.ts:79`; callers: Electron `main.ts:538` (full deps), headless `web-server.ts:148` (no terminal; harness only if `PIKVM_DESKTOP_URL`+`PIKVM_DESKTOP_TOKEN`). Evaluation order inside the HTTP handler (`server.ts:158-299`):

| # | Condition | Handler | Auth |
|---|---|---|---|
| 1 | token gate (164-171) | if `settings.accessToken` && !loopback && !authed && path∉{`/_agent/login`,`/_agent/auth`,`/_agent/logout`} → 302 `/_agent/login` (if `Accept` has text/html) else 401 `{error}` | cookie `__agent_session`=sha256(salt:token), or `?token=`, or `Bearer` (`web-auth.ts:40-53`); **loopback always allowed** (`web-auth.ts:25`) |
| 2 | `GET /` and `?native` ≠ 1 and no `agent_shell=desktop` cookie | serve `console.html` (177-179) | gate |
| 3 | path not `/_agent` or `/_agent/*` | `proxy.handleHttp` → kvmd (182-185) | gate |
| 4 | `/_agent/daemon[/*]` any method | `createDaemonProxy` → daemon (`127.0.0.1:47615` or socket), replaces `Authorization` with daemon action token (`daemon-proxy.ts`) | gate only (**no workspace-header check**) |
| 5 | `GET /_agent/workspace[/*]` | `workspaceAssets` (302 to trailing `/`, `host-config.js` synthesized: sets `__PIKVM_HARNESS_API_BASE__`, `sessionStorage pikvm-harness-token="desktop-managed"`, `window.pikvmPanel` postMessage bridge; `index.html` with host-config script injected; static from `agent/pikvm_agent/harness_ui`; 404 "workspace build not found") (200-204; `workspace-assets.ts`) | gate |
| 6 | `/_agent/harness[/*]` | 503 if no harness proxy; 403 unless header `x-pikvm-workspace: 1`; else proxy w/ operator bearer (217-227). Only mounted when origin **and** token both set (129-136) | gate + custom header (CSRF guard) |
| 7 | `GET /_agent/login` → `loginPage(error,bye)`; `ANY /_agent/logout` → 302 `/_agent/login?bye=1` + cookie clear; `POST /_agent/auth` (form `token`) → 302 `/_agent/console` + `Set-Cookie` HttpOnly SameSite=Lax Max-Age 1 y, else `/_agent/login?error=1` (230-257) | | exempt |
| 8 | `GET /_agent/`, `GET /_agent/console` | `console.html` (261-263) | gate |
| 9 | `GET /_agent/<file>` | `webAssets.serve` → any file under `dist/views` (mime map, `no-cache`) (266) | gate |
| 10 | `OPTIONS` (any `/_agent/*` not caught above) | 204 CORS `*`, methods `GET,POST,DELETE,OPTIONS`, header `content-type` (268-275) | gate |
| 11 | `GET /_agent/api/state` → `{settings:{keyboardLayout,jiggler,bindHost}, features:{terminal,chat}, jigglerStatus}` ; `GET /_agent/api/macros` → `{macros}` ; `PUT /_agent/api/macros` body list or `{macros}` → 400 on bad JSON/non-array, else `{macros}` (277-296) | | gate |
| 12 | else | 404 `{error:"Not found"}` | |

WebSocket `upgrade` (327-340): same token gate (socket destroy); `/_agent/terminal` **or bare `/terminal`** → `termWss` (ensurePrimary, subscribe, JSON in/out; closes immediately if no terminalSessions); everything else → `proxy.handleUpgrade` (kvmd; `/api/ws` also tapped for jiggler).

### Proxy behaviour (`proxy.ts`)
- Target + auth headers from `control.proxyTarget()`; `accept-encoding` & `connection` stripped; hop-by-hop response headers dropped; request body piped; client `close` aborts upstream (211-213); 502 text on error.
- **HTML injection** only for `content-type: text/html` responses: `</head>` ← `HEAD_INJECT` (viewport/PWA metas + manifest link), `</body>` ← `BODY_INJECT` unless cookie `agent_shell=desktop` (`web-assets.ts:47-126`); content-length recomputed.
- Cookie rewrite: strip `Domain=`, strip `Secure` when client conn not TLS (`proxy.ts:115-119`). Redirect rewrite: absolute `Location` to Pi host → path-only (`127-135`).
- Upgrade (217-309): copies headers + auth, 15 s timeout, relays non-101 upstream responses and closes, tears both sockets down together, early-abort if client leaves, `makeHidTap` (55-91) passively parses client→server frames on `/api/ws` for activity + `mouse_move` position (jiggler).
- TLS: `rejectUnauthorized` from control (Pi self-signed).

### Auth / login / logout
Single shared token (`settings.accessToken`, no UI anywhere; desktop bind host default `127.0.0.1`). Login page (`web-auth.ts:61-115`) is standalone dark HTML, PWA metas, error/“Signed out” notes (pinned by `web-auth.test.ts`). Web host (`web-server.ts`): `accessToken` forced `""`; sign-in is an upstream OIDC proxy (`PIKVM_AUTH=proxy`), else loopback bind enforced (98-101). Env: `PIKVM_URL, PIKVM_USER, PIKVM_PASSWORD, PIKVM_AUTH, PIKVM_KEYBOARD_LAYOUT, PIKVM_DATA_DIR, PIKVM_JIGGLER, PIKVM_DESKTOP_URL/TOKEN, HOST, PORT`.

### /mcp, workspace, harness
- **No `/mcp` route exists** in `server.ts`. MCP is a separate stdio launcher (`mcp-launcher.ts`, `gui-mcp.ts` wrapper `pikvm-gui-mcp`, ancestry-ticket gated). Only mentions: `sw.js:76` regex, comments (`main.ts:64`).
- Workspace (`/_agent/workspace/`) + harness API (`/_agent/harness/*`) are fully working but not linked from the console.
- Static assets: `webAssets` (`web-assets.ts:20-38,130-139`) serves `dist/views/*` (copied wholesale by `scripts/build.mjs:60`, excluding `.md`), plus `terminal.js`, `xterm.css`, `haptics.js` produced by esbuild (`build.mjs:68-92`). The console is **not bundled**: scripts are served raw, `no-cache`.

### Inconsistencies / risks noticed (routes)
1. `webAssets.serve` containment check is `p.startsWith(assetDir)` (`web-assets.ts:35`) — no trailing-slash guard (sibling dir `views-x` would pass); `workspace-assets.ts:138` does it right.
2. `json()` adds `Access-Control-Allow-Origin: *` (`server.ts:66`) on `/api/state` & `/api/macros`; loopback is gate-exempt ⇒ any web page can read state from `127.0.0.1:25650`. `OPTIONS` advertises no `PUT` though macros uses PUT (same-origin so unaffected).
3. `/_agent/daemon/*` has no `x-pikvm-workspace` guard (harness has) yet attaches the daemon action capability, incl. `POST /panic-stop`, `/sessions*`; loopback-exempt gate ⇒ cross-site simple POSTs to 127.0.0.1 are not blocked [INFERENCE: depends on daemon endpoints accepting text/plain bodies].
4. With a token set, `/_agent/icon.png` and `/_agent/manifest.webmanifest` (both linked from the login page) hit the gate → 401 (only login/auth/logout are exempt). e2e doc shows 200 only because the deployed host has no token.
5. `?token=` accepted on every route (leaks into logs/history); cookie lacks `Secure`; `submitted === token` not constant-time; `/_agent/logout` is method-agnostic GET (CSRF logout); loopback exemption defeats the gate behind a same-host reverse proxy.
6. `/_agent/api/state` includes `features.chat` — unused by console; `bindHost` exposed.
7. Bare `/terminal` WS alias (335) has no client; shadows nothing (kvmd has no `/terminal`).
8. `manifest` `scope:"/"` but SW scope `/_agent/` (SW cannot control `/`); SW registration skipped on plain-http LAN.
9. Upgrade for any other `/_agent/*` path (e.g. typos) is forwarded to the Pi as `/_agent/...` (no 404).
10. Full-UI iframe is proxied Pi HTML ⇒ `BODY_INJECT` FAB markup is rendered inside the iframe; its script returns at `window.top!==window.self`, so the FAB is visible but inert [INFERENCE from `web-assets.ts:87`].

## 4. Desktop shell (Electron) — `window.desktopConsole` (`preload-console.ts`)

Console window = `mainView` (child `WebContentsView`) loaded from `CONSOLE_URL = ${CONSOLE_ORIGIN}/_agent/console` (`main.ts:1043-1046`); remote console origin ⇒ thin client (`remoteConsole`, no local backend). `consoleWinFrom` maps sender id→window (`main.ts:662-667`). Preload also: `platform`, `nativeControls` (=darwin).

| API (preload) | IPC channel (main.ts) | Does | Used by console.js |
|---|---|---|---|
| `minimise/toggleMaximise/close` | `console:minimise` 670, `:toggle-maximise` 671, `:close` 676 (send) | window controls | 10285+ |
| `isMaximised` | `console:is-maximised` 685 (invoke) | initial glyph | 10300s |
| `onMaximiseChange` | `console:maximise-change` (sent 1071 on win maximize/unmaximize) | titlebar glyph | 10298 |
| `fitNative({width,height,chromeWidth,chromeHeight})` | `console:fit-native` 696 | scale-to-workarea, `setContentSize` | 10486 |
| `popupMenu(items,anchor)` / `onMenuCommand` | `console:popup-menu` 718 → reply `console:menu-command` | native menu (normal/separator/checkbox, enabled) | 10892, 10887 |
| `openSettingsWindow` | `console:open-settings` 815 | opens 460×360 Settings BrowserWindow (`openSettingsWindow` 762) | 10731 |
| `signalScreenChange` | `console:screen-activity` 681 | `requestAttention(win)` (taskbar pulse) | 5898 |
| `onWindowFocus` | `kvm:input-enabled` (sent 1425, 1590, 1596) | true window focus | 10179 |
| `onDownloadDone` | `console:download-done` (session `will-download` 1802-1808) | screenshot saved/cancelled/interrupted | 4347 |
| `reportAgentTheme` / `onAgentThemeRequest` | `console:agent-theme` 1121 / `console:agent-theme-request` (via `panel:request-theme`) | persist theme, push to agent window + Settings window | 9791 |
| `reportAgentPlacement` / `onAgentPlacementCommand` / `detachAgent` / `onAgentAttached` | `console:agent-placement` 1134, `console:agent-side`, `console:agent-detach-toggle`, `console:agent-placement-request`, `agent:detach` 1163, `agent:attached` 1209 | detach "conversation" into a window loading `terminal.html` (title "PiKVM — Terminal") | 10041-10145 — **only triggered by messages the terminal never sends (§6)** |
| `onWorkspaceReload` | `console:workspace-reload` (1236, dev asset watcher) | reload frame on rebuilt workspace | wired in desktop block |
| `reportWorkspaceRect` | `console:workspace-rect` **no handler in main** | — | only feature-detected (9855, 9962) |

Settings window (`preload-settings.ts`, `window.pikvmSettings`): `read()` sync `settings:read` (819; `{pikvmUrl,keyboardLayout,jiggler,originLocked}`), `save()` `settings:save` (855; writes `agent-settings.json` layout/jiggler + `pikvm.json` origin → **`app.relaunch(); app.exit(0)`**), `cancel()` 871, `theme()` sync `settings:theme` 874, `onTheme`. UI: PiKVM URL (password masked, tests pin masking), layout US/UK, jiggler checkbox; `originLocked` when `config.consoleOrigin`/`PIKVM_CONSOLE_ORIGIN`.
`preload-agent.ts` → `window.pikvmPanel` (`panel:set-side, :toggle-detached, :request-placement, :request-theme`, `panel:theme`, `panel:placement`) for the detached window.
Other main facts: window 1400×880 frameless (mac `hidden` traffic lights), single-instance lock + `firstFreePort` walk (control 25650, daemon 47615, harness 47616), cookie `agent_shell=desktop` only when `desktopUseProxy`, will-navigate/window-open policy → system browser, `PIKVM_NATIVE_UI=1` legacy mode, load-retry/"Can't reach the console" dialog (1705), disable-background-throttling switches (60-62).
Persistence: `userData/pikvm.json` (origin/consoleOrigin), `agent-settings.json` (AppSettings), `macros.json` beside it (`server.ts:96`). AppSettings (`settings.ts:11-45`) includes agent leftovers: `humanize, wpm, atlas.vaultPath, daemonUrl/Cmd, harnessCmd/Config, sidebarWidth`.

## 5. Tests (`tests/*.test.ts`, run by `scripts/test.mjs` via esbuild + `node --test`; e2e doc reports 314 passing)

**Source-text pins of console files — WILL BREAK on any rewrite** (read file text, regex/`indexOf` slices of function bodies, element ids, CSS selectors):
- `desktop-layout.test.ts` (≥19 tests): console.html/css/js + main.ts + preload-console.ts text (e.g. no `setPanelTab(`, `.app.computer-collapsed`, divider hidden when collapsed, freeze canvas, titlebar title yielding, fit-native label, theme precedence, "operator credential never reaches a renderer", Ctrl+scroll on desktop). Behavioural parts: `require(console.js)` → `streamModeForInfo`, `panelCeiling`, `fracInBox`.
- `macros-ui.test.ts` (≥20): ~all slice console.js/html/css (e.g. `js.indexOf("function paintMacroEditor() {")`, `macroHost.addEventListener("focusin"`, focus restoration, icon radiogroup, titlebar overflow CSS, macro guards while pasting/running, macro text-step failure handling).
- `mount-handle-order.test.ts` (≥20): regexes over console.js/css/html/ui.html/main.ts (no `var x = null` re-init after assignment, MSD buttons not hand-written HTML, `classList.toggle("dark", t === "dark")`, theme CSS selectors, reduced-motion blocks, `no console lookup points at an element that cannot exist` — checks every `getElementById` against html ids, `modalOpen` guard count, `if (window.desktopConsole && !windowFocused) return;`, `releaseAllMods/releaseHeldMouseButtons/releaseClickMods` outside desktop block, `paintConnStatus` body, `sendStreamParam` revert, `runMacro` chord/afterKeys, avSummary).
- `keyboard-layout-parity.test.ts`: extracts `ROWS/SHIFT_ROWS/CODE_ROWS` and `UK_MAP` array literals from console.js text and compares to `human-typing.ts` (keep the maps in a shared module/literal or retarget the test).
- `terminal-view.test.ts`: pins `src/terminal/main.ts`, `terminal.html`, `terminal-server.ts` text (socket-down banner, tab keyboard nav, exited marker, escape-hint, tab overflow fade identical to console's, exit notice in buffer).
- `settings-password-mask.test.ts`: evals functions/regexes extracted from `settings-console.html` + pins `main.ts` `originLocked`/`CONSOLE_ORIGIN` lines.
- `desktop-startup.test.ts`: regexes over `main.ts`/`server.ts` (single-instance, port walk, listen error, load-retry ceilings).
- `daemon-proxy.test.ts` (partly): behavioural proxy tests + text pins on `server.ts` (half-configured harness mounts no route; workspace-header guard).
- `workspace-assets.test.ts`: behavioural server tests (`createWorkspaceAssets`, host-config) + many source pins into `agent/frontend` shell.
- `agent-runtime*.test.ts`, `harness-*.test.ts`, `service-manager.test.ts`, `gui-mcp.test.ts`, `entrypoint.test.ts`: backend/runtime, unaffected.

**Behavioural (survive a rewrite if module contracts are kept):** `key-chord.test.ts` (`require("../src/views/key-chord.js")`: `decide`, `createModifierMirror`, `chordMods`), `macros.test.ts` (`cleanMacros`, `MacroStore`, plus `require(console.js)` → `macroKeyGroups`, `MACRO_MODS`, `macroGlyph`), `mouse-jiggler.test.ts` (+`makeHidTap` from `proxy.ts`), `web-auth.test.ts` (`loginPage`), `endpoint.test.ts`, `daemon-proxy.test.ts` (live servers), `cdp-inspector.test.ts` (script refusal), `workspace-assets` server cases. `macros-ui`/`desktop-layout` include a few `require(console.js)` tests (`fracInBox`, `panelCeiling`, `streamModeForInfo`) that would pass if those pure functions stay importable under the same names/paths.
No test drives the DOM at runtime (no jsdom/playwright for console); real-device checks live in `docs/e2e/2026-11-02-mobile-console.md` (HID-intercept harness via CDP touch events — reusable as a manual script). Mount-order and "id exists in html" tests exist **because** of `var`-hoisting/load-order bugs a React tree would eliminate.

## 6. Dead / obsolete / suspicious

1. **Agent-driving gate** — `agentActing` never set true (`console.js:279`): dead in `blockKvmInput` 293, `hid.send` 644-648, `noteManualKvmInput`/`clearRegionMapForManualInput` 280-283, `onXform` 7334/7347, key/click handlers' `if (agentActing) return;`, `runMacro` 1187. Comment at 9998 confirms the agent overlay was removed.
2. **Sidebar iframe injection** — `BODY_INJECT` (`web-assets.ts:57-116`) builds a FAB + slide-in iframe to `/_agent/sidebar.html`, which does not exist (src/sidebar deleted; `docs/web-client-migration.md:5` says so). Still injected into every proxied HTML page (incl. Full-UI iframe). `touch.js` (injected into the Pi's own UI) is legacy pan/zoom for the native page.
3. **Conversation placement/detach pipeline** unreachable from today's UI: `preload-agent.ts`, IPC `panel:*`, `console:agent-side|detach-toggle|placement|placement-request|theme-request`, `agent:detach/attached`, `console:workspace-reload`, console.js 9798-9830 & 10041-10145, `workspace-assets.ts` `window.pikvmPanel` bridge. Terminal never posts `set-side/toggle-detached`; terminal's own message handlers `agent-action new` / `terminal-fit` (`terminal/main.ts:648-651`) and global `__pikvmTerminalFit` (692) have no sender in console.js/main.ts.
4. `console:workspace-rect` IPC (preload only, no `ipcMain` handler); `reportWorkspaceRect` used only as "is desktop" flag (9855/9962).
5. `EMBED_PARAM` (9854) assigned, never read; `?shell=native` branch (10256-10269) never produced; `nativeShellTitlebar`/`NATIVE_SHELL_TITLEBAR_H` (10144).
6. **Legacy native UI** (`PIKVM_NATIVE_UI=1`, `main.ts:116,1633-1646`): `ui.html`, `settings.html`, `style.css`, `native.svg`, `minimize/maximize/restore/close.svg`, `preload.ts` (injects into Pi page: `kvm:*` audio/transcribe/stream-data/user-input IPC, `kvm-css`), `preload-ui.ts`, `src/static/{index,kvm}.css`, IPC `window:*`, `pikvm:set-origin|connected-to-origin|get-origin|connect|autofill-credentials`, `navigate-back`, `kvm-stream-data`, `kvm:audio-*`, `kvm:transcribe-*`, `kvm:media-transmission`, `window:resize`, `kvm:release-mouse`. Tests still pin `ui.html`. All of `dist/views/*` (incl. these) is publicly servable under `/_agent/`.
7. `/_agent/terminal` alias `/terminal` (server.ts:335); `sw.js` regex `mcp`; `GET /_agent/api/state.features.chat`, `jigglerStatus`, `settings.bindHost` (unused by console).
8. Stale comments/doc refs: `console.js:8-10,16` cite `scripts/smoke-proxy.ts` (does not exist; `scripts/` has build/test/runtime only); `docs/web-client-migration.md` (self-declared stale; `smoke:proxy/harness` gone); `daemon-proxy.ts` & `main.ts:64,1056` mention MCP/sidebar chat bridge/sidebarWidth (now only detached window width).
9. Agent-daemon-coupled console bits (decide keep/drop): backend-status pill, `POST /_agent/daemon/cursor`, `/_agent/daemon` proxy itself, AppSettings `humanize/wpm/atlas/daemon*`.
10. Settings gaps: `bindHost`, `accessToken`, `desktopUseProxy`, `consoleOrigin` have **no UI** (file/env only); layout/jiggler only settable via desktop window (restart) — web console cannot change layout (it only reads `keyboardLayout`; macro/paste use kvmd keymap).
11. Known limit (e2e doc): characters outside US/UK maps are dropped on the key path (use paste).

## 7. Riskiest pieces to port (in order)

1. **HID socket + key queue timing** (`hid` 388-753, `sendChord/drainKeys` 5090-5158): stale-queue rule (2 s, never drop releases), 10 s ping / 25 s dead-kick, 1.2→5 s backoff, 22/4/6 ms hold/gap/settle, per-chord modifier ownership (`modMirror.owned`), dedupe 60 ms, auto-repeat throttle, Caps LED sync with 1.2 s pending window. Must live **outside React render** (single module/store); any re-subscription on re-render can drop keyups ⇒ stuck keys on target.
2. **Soft-keyboard mirror** (8568-8700) + hidden `#kbd` focus ownership (dockPressAt 700 ms, pointerdown/mousedown preventDefault on iOS, `kb-open` via visualViewport >150 px, `interactive-widget=resizes-content`, `autocorrect/autocapitalize` attrs). React controlled inputs will fight the diff algorithm — keep it an uncontrolled imperative input.
3. **Pointer/touch gesture state machine** (7411-8455): capture phase listeners with `preventDefault` + `{passive:false}` wheel; rAF move coalescing; abs/rel output switching with 1.5 s throttle and "debt" accumulation; pinch vs two-finger-drag lock; hold-to-drag; held-button release recovery (`buttons===0`, blur, modal). Must bypass React synthetic events (passive-listener and capture ordering).
4. **Stream pipeline & fallbacks** (5256-5640, 6064-6392): MJPEG src swapping (blank on `src`), freeze canvas, WebRTC muted-start + `playing` swap + watchdogs, iOS/Safari quirks (`streamPath`, `playsinline`, autoplay, `setSinkId` absence), snapshot mode, health poll vs watchdog arbitration (documented 19 state flips in 24 s bug), visibility `kick` >3 s.
5. **Coordinate math with transform + letterbox** (7270-7410) and the lens (canvas drawImage from live element).
6. **Focus/modal system**: native `<select>` must not be rewritten while open (`controlBusy`), dialog focus trap/restore, Full-UI keyboard hand-off, `modalOpen` guards on every input path; Radix/Base UI dialogs will change event ordering — re-verify held-key release.
7. **Desktop interop**: `desktopConsole` feature detection, native menu command round-trip, `-webkit-app-region` drag/no-drag classes (`.tb-btn` is load-bearing), z-index of `#tb-window` above scrim, fit-native `chromeWidth/Height` measurement.
8. **Shared-bundle CSS layering**: `console.css` unlayered vs Tailwind layers; theme must set both `data-theme` and `.dark` class; Tailwind palette tokens unlayered at `:root`.
9. **PWA/SW**: SW LIVE regex, scope `/_agent/` vs manifest scope `/`, offline page, wake lock, fullscreen+Keyboard Lock, secure-context gating; a Vite build changes asset paths (SW cache of `/_agent/*` network-first, no precache) and `console.html` is served by the server at `/`, `/_agent/`, `/_agent/console` — keep those routes or update `server.ts`, `login` redirect (`/_agent/console`), manifest `start_url`/`id`, `sw.js`, `proxy` HTML injection assumptions.
10. **Serving React from this server**: static serving is `dist/views` raw files (no SPA fallback; extensionless `/_agent/console` is special-cased), upgrade/ proxy ordering (`/_agent/*` namespace vs kvmd root), and the headless web host (`web-server.ts`) shares `server.ts` — routing for TanStack Router (history mode) needs explicit fallbacks for any new `/_agent/<route>` paths (chat, settings) or hash routing; `OPTIONS`/404 JSON currently terminate unknown `/_agent/*`.
