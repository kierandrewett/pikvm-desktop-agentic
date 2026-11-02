# KVM dialogs: parity with the console

Every dialog in `docs/rebuild/console-inventory.md` §1.8 (and the native `window.confirm` list under
it), ported to `apps/web/src/kvm/dialogs/`. Registered into the screen's seam by
`registerKvmDialogs()` (`dialogs/index.ts`); the ⋯ sheet, the toolbar menus and the dock open them with
`openDialog(name)`.

Evidence: `T` = a vitest case (file in `apps/web/src/kvm/dialogs/`), `E2E` = recorded against the fake
kvmd in `docs/e2e/2026-11-02-kvm-dialogs.md` (phone iPhone 13 and desktop 1400x900), `FM n` = failure
mode n in `apps/web/src/kvm/dialogs/FAILURE_MODES.md`.

Status: **done**, **changed** (behaves differently on purpose, said how), **not a dialog** (owner named),
**gap** (not done, said why).

## Dialogs

| Name | Console | Component | Status |
|---|---|---|---|
| `paste` | Paste to target 4404-4720 | `paste-dialog.tsx` | done |
| `stream` | Stream settings 4102-4310 | `stream-dialog.tsx` | done |
| `msd` | Mass storage 2696-3686 | `msd-dialog.tsx` | done |
| `health` | System / GPIO / health 2907-4075 | `health-dialog.tsx` | done |
| `log` | Pi log 2271-2412 | `log-dialog.tsx` | done |
| `ocr` | OCR result 2465-2690 | `ocr-dialog.tsx` + the screen's `useOcrPicker()` | done |
| `audio-devices` | Audio devices 6565-7260 | `audio-devices-dialog.tsx` | done |
| `macros` | Macros editor 1519-2050 | `macros-dialog.tsx` | done |
| `atx-power`, `atx-power-long`, `atx-reset` | `window.confirm` in `runAtxAction` 4989, `ATX_ACTIONS` 945 | `atx-dialog.tsx` | changed: a real dialog, not `window.confirm` |

## Every inventory item

### Dialog infrastructure (§1.8 "Infra")

| Item | Status | Evidence |
|---|---|---|
| One dialog at a time (`closeOtherDialogs`) | done: the seam holds one name; an in-dialog question is a layer above and takes Escape and Tab first | T shell (1); FM 1 |
| Scrim click dismisses | done, and a drag that ends on the scrim does not | T shell (4); FM 4 |
| Escape closes; the dialog's keys never reach the target | done: key events stop at the dialog, and the screen's forwarder also reads `dialogs.open` | T shell (2); FM 2 |
| Focus trap, initial focus, focus restored | done; never hands focus back to the hidden keyboard field (would raise the phone keyboard) | T shell (3); FM 3 |
| `modalOpen()` guards on every input path | owner KvmScreen (`keyboard-input.tsx`, the pointer machine) reads the dialog store | n/a here |
| `syncModalCursor` (host cursor back while a dialog is up) | owner KvmScreen (reads the dialog store) | n/a here |
| `controlBusy`: never rewrite a `<select>` or slider the user holds | done: selects are React-controlled by the Pi's applied value (no option rebuild unless the set changes); sliders are native-event driven | T stream (14), paste (10); FM 10, 14 |
| Dialog buttons from `pikvmShared.mountButtons` | changed: plain `Btn`, same look (`.dlg-btn`, primary/danger) | E2E screenshots |
| Native `window.confirm` (ATX, stream reset, MSD reset/delete, HID reset, GPIO) | changed: one `ConfirmLayer` above the dialog; Cancel has the focus, Confirm disables while the request runs | T ATX (6-8), stream (16), msd (26), health (19, 20), macros (35) |
| Phone: bottom sheet or full page, safe areas, 44px targets, keyboard-aware | done: sized by the visual viewport (`useViewportFrame`), sticky actions with the safe area under them, 44px targets and 16px text | E2E phone screenshots; FM 5 |

### Paste to target

| Item | Status | Evidence |
|---|---|---|
| Textarea, `POST /api/hid/print?limit=0&delay=0.02[&keymap=]` body `text/plain` | done (engine `paster`) | T paste (9); E2E paste "Hi" with `en-gb` on both profiles |
| Keymap select from `hid_keymaps` (map or list, default in list, one option shown not a choice, none hides it, pick survives repaint) | done; the pick is shared with macro text steps through `session.keymap` | T paste (10) |
| Duration hint from ten seconds | done (engine `pasteDuration`) | T paste (11) |
| Host clipboard prefill (silent when refused) | done | T paste (12) |
| Ctrl/Cmd+Enter sends; refused with the macro's name while one runs | done | T paste (9) |
| 413 "too much text", other statuses, network failure | done (engine); the dialog stays and the text is kept | T paste (9) |
| Sticky "Typing N characters…" | done: toast plus, in the dialog, an estimated progress bar and "Closing this does not stop it." | T paste (11) |
| Cancel | **gap, same as the console**: Cancel/Close closes the dialog; kvmd cannot be told to stop typing (the engine's HTTP port has no abort, and the console measured the target typing on after Cancel). The dialog says so while it types. Cancel before sending discards | T paste (11) |

### Stream settings

| Item | Status | Evidence |
|---|---|---|
| Resolution select, quality / FPS / H.264 bitrate / GOP sliders from `features` / `limits` / `applied` | done | T stream (13-15); E2E stream quality 80 to 55 reaches the fake's params |
| POST only on release; label live while dragging; `aria-valuetext` (FPS 0 = unlimited) | done | T stream (13) |
| Failed change reverts the control; Pi events never rewrite a held control | done | T stream (14) |
| Empty form sentence | done | T stream (15) |
| Reset stream with confirm; `POST /api/streamer/reset` | done | T stream (16) |
| Save screenshot (one at a time) | done: the screen's `saveScreenshot()` plus a busy guard and toasts. The Electron `console:download-done` wait is the desktop phase's | T stream (screenshot) |
| Mode WebRTC / MJPEG | **not a dialog item today**: the console picks WebRTC with MJPEG fallback itself (§1.2, `avSummary`); it has no selector, so none was added (video machine, KvmScreen) | n/a |

### Mass storage

| Item | Status | Evidence |
|---|---|---|
| Hidden when no MSD; "Checking the drive…" before the first event; offline sentence | done | T msd (23), model |
| Image select (newest first), CD/DVD or flash, writable (flash only) | done | T msd (24); E2E select `test.iso` |
| Mount / Unmount (single request in flight; present-tense toast), Delete image (confirm), Reset drive (confirm) | done | T msd (24, 26); E2E mount reaches the fake |
| Everything disabled while connected, busy or uploading | done | T msd (24); FM 24 |
| Upload by file with progress (XHR), Abort as a calm confirmation, closing does not abort | done | T msd (25); E2E upload through a real file input |
| Write from URL, indeterminate until the Pi reports numbers | done | T msd (25) |
| Free space | done | T msd |

### System, GPIO, health

| Item | Status | Evidence |
|---|---|---|
| Problem list (no signal, HID detached/offline, undervolt now/past, throttled, fan), worst first, level in words | done | T health (18), model |
| "Nothing reported yet" vs "Everything looks fine" | done | T health (17) |
| Input not reaching the Pi (the desktop has no connection chip to say so) | done, listed first | T health (18) |
| About line (host, board, kvmd, streamer, temperature, fan) | done, selectable text | T health, model |
| HID attach / detach (online gadget with `connected: null` counts as attached) and Reset (confirm) | done | T health (19) |
| User GPIO rows: switch / pulse, offline vs busy, confirm by default, USB breaker warning, locator no confirm, per-channel double-tap guard | done | T health (20, 21); E2E GPIO switch on `relay0` reaches the fake |
| ATX buttons (power, hold 5 s, reset) with confirm and the power / drive LEDs as text | done, in the System dialog and as the `atx-*` dialogs opened by the titlebar Power and the sheet | T ATX (6-8), health (22); E2E reset asks first then reaches the fake |
| Mass-storage state | done: a row with the summary and a button to the dialog | T health (22) |

### Pi log

| Item | Status | Evidence |
|---|---|---|
| Range select (10 min, hour, day, everything), `GET /api/log?seek=&follow=0`, streamed with a byte count | done | T log (27); E2E |
| Abort on refresh and on close | done | T log (27) |
| 1500-line cap with the dropped count said | done | T log (29), model |
| Copy only real text; Loading / empty / error are messages | done | T log (28) |

### OCR

| Item | Status | Evidence |
|---|---|---|
| Hidden unless the `ocr` event says enabled | owner KvmScreen (the sheet item); the dialog also refuses without it | T ocr (30) |
| Drag a rectangle on the picture (the screen's overlay), kvmd reads the region | done through `useOcrPicker()`; the region is in picture pixels | T ocr (30); E2E desktop: region read, text shown |
| Esc / bare tap cancels without a word | done | T ocr (30) |
| "Reading the screen…" with a way to give up | done (aborts the read; the console had none) | T ocr (30) |
| Result dialog, Copy only real text | done; "Read another region" is new | T ocr (31) |
| Phone | blocked by KvmScreen's `.kvm-ocr-pick` CSS (no `inset`: the overlay is a 235 px strip). Reported to KvmScreen; the dialog itself is unaffected | gap, see below |

### Audio devices

| Item | Status | Evidence |
|---|---|---|
| Microphone and output pinned to a named device, remembered with the label | done (`settings/local-prefs.ts`) | T audio (42) |
| OS aliases not offered; "Follow the system default" first | done | T audio (41) |
| A pinned device that has gone is named, never swapped | done | T audio (41) |
| Notes: no device API, no `setSinkId`, names hidden until microphone access; Allow access button | done | T audio |
| A running stream re-pins | done: `emitAudioDevicesChanged()` | T audio (42) |

### Macros

| Item | Status | Evidence |
|---|---|---|
| List with icon, select (`aria-current`), empty states | done | T macros |
| Name, 23 icons plus "No icon" (radiogroup, one tab stop, arrows move the selection), pinned toggle (missing counts as pinned) | done | T macros (38, 39, 40) |
| Steps: key combo (modifier switches, grouped key list, unknown stored code kept), text, pause (1 to 10000 ms); reorder keeps focus; remove | done | T macros (36, 37); E2E |
| Draft held locally until valid, only usable parts PUT, server reply never replaces the draft, note of what will be dropped | done | T macros (32); E2E "before key chosen" the list on the server is unchanged |
| Saves serialised and coalesced; failed save keeps the draft | done | T macros (33, 34) |
| Delete with confirm, apart from the add buttons | done | T macros (35); E2E |
| Limits (60 macros, 40 steps, 4000 text, 60 label) | done | T model |
| Persisted by `PUT /app/api/v1/macros` | done | E2E: created macro is in `GET /app/api/v1/macros` |
| Run | done: a Run button (closes the dialog, then `session.macros.run`); the pinned strip and sheet tiles are KvmScreen's | T macros; E2E keys and text reach the fake |

### Not dialogs in the console either

| Item | Owner |
|---|---|
| Full screen and Keyboard Lock ("Full screen (send Win and Alt keys)") | a menu item, KvmScreen (`platform.ts`) |
| Terminal | the chat frame, not a dialog; ChatApp (`/app/terminal`) |
| Full PiKVM UI | a view mode, KvmScreen |
| Theme toggle | a menu item, KvmScreen |
| Screen-alerts toggle, touch modes | menu items, KvmScreen |

## Gaps

1. **Paste cannot be stopped once kvmd is typing** (also true of the console; the dialog says so).
2. **Desktop screenshot "saved / cancelled" from Electron's download event** is not wired (phase 6, the
   desktop host); the web path toasts "Screenshot saved".
3. **OCR on a phone** needs KvmScreen's overlay CSS fixed (reported); the dialog and the desktop path work.
4. **Audio devices dialog has unit tests but no E2E**: its menu item only appears with live WebRTC audio,
   which the fake kvmd does not provide (`/janus/ws` is refused).
5. **Soft-keyboard-up behaviour** of the phone sheets rests on `useViewportFrame` (tested with the shell);
   headless Chrome cannot show a soft keyboard, so it was not exercised in the E2E run.
6. `yarn workspace @pikvm/web typecheck` currently stops with "`@pikvm/kvm-engine@workspace:*` is not in
   your lockfile" (`yarn install` needed after the `package.json` change); the same check run directly,
   `tsc --noEmit` in `apps/web`, is clean.
