# E2E: phone feedback (2026-11-03)

One section per change.

<!-- phone-chrome:start -->
## Status bar and home-indicator strip (PhoneChrome)

Run 2026-11-03. Host under test: `node dist/web-server.js` (http://127.0.0.1:8161) in front of `tools/fake-kvmd` (http://127.0.0.1:4561). Headless Chrome through puppeteer-core; the iPhone 13 profile (touch, 390x844 portrait and 844x390 landscape) with the safe-area insets emulated by CDP `Emulation.setSafeAreaInsetsOverride` (portrait top 47 / bottom 34; landscape top 0 / bottom 21 / left and right 47). Colours are read back from the screenshots' pixels. Script: `apps/web/e2e/phone-chrome.e2e.mjs`; how to run it: `docs/e2e/README.md`.

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| static | meta served at /app/ | {"theme-color":"#000000","apple-mobile-web-app-capable":"yes","apple-mobile-web-app-status-bar-style":"black-translucent","mobile-web-app-capable":"yes"}; viewport "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content" | pass |
| static | manifest | /app/manifest.webmanifest: theme_color #000000, background_color #0a0a0c, display standalone | pass |
| static | offline page | theme-color #000000 and the inset strip are in /app/sw.js | pass |
| iPhone 13 portrait, light | kvm: status-bar strip is 47px of #000000 | strip 47px, 9 pixels over the inset all #000000; first pixel below it #000000 (page bg #000000) | pass |
| iPhone 13 portrait, light | kvm: home-indicator strip is the navigation bar's #ffffff | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 portrait, light | chat: status-bar strip is 47px of #000000 | strip 47px, 9 pixels over the inset all #000000; first pixel below it #eef0f4 (page bg #eef0f4) | pass |
| iPhone 13 portrait, light | chat: home-indicator strip is the navigation bar's #ffffff | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 portrait, light | settings: status-bar strip is 47px of #000000 | strip 47px, 9 pixels over the inset all #000000; first pixel below it #eef0f4 (page bg #eef0f4) | pass |
| iPhone 13 portrait, light | settings: home-indicator strip is the navigation bar's #ffffff | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 portrait, light | a shell that stops short of the screen edge leaves the bar's colour under it | kvm: bar ends 810 of 844, strip #ffffff (bar #ffffff); chat: bar ends 810 of 844, strip #ffffff (bar #ffffff); settings: bar ends 810 of 844, strip #ffffff (bar #ffffff) | pass |
| iPhone 13 portrait, light | theme-color meta and the strip are black whatever the theme | meta #000000, data-theme light | pass |
| iPhone 13 portrait, light | a full-page sheet does not paint the status-bar strip | opened true; sheet rgba(0, 0, 0, 0.62) from y=0; pixels in the strip #000000/#000000, just below #ffffff | pass |
| iPhone 13 portrait, light | no console errors | none | pass |
| iPhone 13 landscape, light | kvm: status-bar strip is 0px of #000000 | strip height 0px (no status bar in landscape) | pass |
| iPhone 13 landscape, light | kvm: home-indicator strip is the navigation bar's #ffffff | nav 0,312,844,390 of 844x390, padding-bottom 25px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 landscape, light | chat: status-bar strip is 0px of #000000 | strip height 0px (no status bar in landscape) | pass |
| iPhone 13 landscape, light | chat: home-indicator strip is the navigation bar's #ffffff | nav 0,312,844,390 of 844x390, padding-bottom 25px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 landscape, light | settings: status-bar strip is 0px of #000000 | strip height 0px (no status bar in landscape) | pass |
| iPhone 13 landscape, light | settings: home-indicator strip is the navigation bar's #ffffff | nav 0,312,844,390 of 844x390, padding-bottom 25px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 landscape, light | a shell that stops short of the screen edge leaves the bar's colour under it | kvm: bar ends 369 of 390, strip #ffffff (bar #ffffff); chat: bar ends 369 of 390, strip #ffffff (bar #ffffff); settings: bar ends 369 of 390, strip #ffffff (bar #ffffff) | pass |
| iPhone 13 landscape, light | theme-color meta and the strip are black whatever the theme | meta #000000, data-theme light | pass |
| iPhone 13 landscape, light | no console errors | none | pass |
| iPhone 13 portrait, dark | kvm: status-bar strip is 47px of #000000 | strip 47px, 9 pixels over the inset all #000000; first pixel below it #000000 (page bg #000000) | pass |
| iPhone 13 portrait, dark | kvm: home-indicator strip is the navigation bar's #121216 | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 portrait, dark | chat: status-bar strip is 47px of #000000 | strip 47px, 9 pixels over the inset all #000000; first pixel below it #0a0a0c (page bg #0a0a0c) | pass |
| iPhone 13 portrait, dark | chat: home-indicator strip is the navigation bar's #121216 | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 portrait, dark | settings: status-bar strip is 47px of #000000 | strip 47px, 9 pixels over the inset all #000000; first pixel below it #0a0a0c (page bg #0a0a0c) | pass |
| iPhone 13 portrait, dark | settings: home-indicator strip is the navigation bar's #121216 | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 portrait, dark | a shell that stops short of the screen edge leaves the bar's colour under it | kvm: bar ends 810 of 844, strip #121216 (bar #121216); chat: bar ends 810 of 844, strip #121216 (bar #121216); settings: bar ends 810 of 844, strip #121216 (bar #121216) | pass |
| iPhone 13 portrait, dark | theme-color meta and the strip are black whatever the theme | meta #000000, data-theme dark | pass |
| iPhone 13 portrait, dark | a full-page sheet does not paint the status-bar strip | opened true; sheet rgba(0, 0, 0, 0.62) from y=0; pixels in the strip #000000/#000000, just below #121216 | pass |
| iPhone 13 portrait, dark | no console errors | none | pass |
| iPhone 13 landscape, dark | kvm: status-bar strip is 0px of #000000 | strip height 0px (no status bar in landscape) | pass |
| iPhone 13 landscape, dark | kvm: home-indicator strip is the navigation bar's #121216 | nav 0,312,844,390 of 844x390, padding-bottom 25px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 landscape, dark | chat: status-bar strip is 0px of #000000 | strip height 0px (no status bar in landscape) | pass |
| iPhone 13 landscape, dark | chat: home-indicator strip is the navigation bar's #121216 | nav 0,312,844,390 of 844x390, padding-bottom 25px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 landscape, dark | settings: status-bar strip is 0px of #000000 | strip height 0px (no status bar in landscape) | pass |
| iPhone 13 landscape, dark | settings: home-indicator strip is the navigation bar's #121216 | nav 0,312,844,390 of 844x390, padding-bottom 25px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 landscape, dark | a shell that stops short of the screen edge leaves the bar's colour under it | kvm: bar ends 369 of 390, strip #121216 (bar #121216); chat: bar ends 369 of 390, strip #121216 (bar #121216); settings: bar ends 369 of 390, strip #121216 (bar #121216) | pass |
| iPhone 13 landscape, dark | theme-color meta and the strip are black whatever the theme | meta #000000, data-theme dark | pass |
| iPhone 13 landscape, dark | no console errors | none | pass |
| Android (Pixel 5, no insets) | kvm: no strips without an inset | bar; strip 0px; nav padding 4px; nav bottom 851 of 851 | pass |
| Android (Pixel 5, no insets) | chat: no strips without an inset | bar; strip 0px; nav padding 4px; nav bottom 851 of 851 | pass |
| Android (Pixel 5, no insets) | settings: no strips without an inset | bar; strip 0px; nav padding 4px; nav bottom 851 of 851 | pass |
| Desktop 1400x900, no insets | kvm: no strips without an inset | rail; strip 0px; nav padding 8px 8px 8px 8px; nav bottom 900 of 900 | pass |
| Desktop 1400x900, no insets | chat: no strips without an inset | rail; strip 0px; nav padding 8px 8px 8px 8px; nav bottom 900 of 900 | pass |
| Desktop 1400x900, no insets | settings: no strips without an inset | rail; strip 0px; nav padding 8px 8px 8px 8px; nav bottom 900 of 900 | pass |

47 of 47 passed.

Screenshots (`docs/e2e/phone-chrome/`):

- [android-light-chat](phone-chrome/android-light-chat.png)
- [android-light-kvm](phone-chrome/android-light-kvm.png)
- [android-light-settings](phone-chrome/android-light-settings.png)
- [desktop-light-chat](phone-chrome/desktop-light-chat.png)
- [desktop-light-kvm](phone-chrome/desktop-light-kvm.png)
- [desktop-light-settings](phone-chrome/desktop-light-settings.png)
- [iPhone-13-landscape-dark-chat-short-shell](phone-chrome/iPhone-13-landscape-dark-chat-short-shell.png)
- [iPhone-13-landscape-dark-chat](phone-chrome/iPhone-13-landscape-dark-chat.png)
- [iPhone-13-landscape-dark-kvm-short-shell](phone-chrome/iPhone-13-landscape-dark-kvm-short-shell.png)
- [iPhone-13-landscape-dark-kvm](phone-chrome/iPhone-13-landscape-dark-kvm.png)
- [iPhone-13-landscape-dark-settings-short-shell](phone-chrome/iPhone-13-landscape-dark-settings-short-shell.png)
- [iPhone-13-landscape-dark-settings](phone-chrome/iPhone-13-landscape-dark-settings.png)
- [iPhone-13-landscape-light-chat-short-shell](phone-chrome/iPhone-13-landscape-light-chat-short-shell.png)
- [iPhone-13-landscape-light-chat](phone-chrome/iPhone-13-landscape-light-chat.png)
- [iPhone-13-landscape-light-kvm-short-shell](phone-chrome/iPhone-13-landscape-light-kvm-short-shell.png)
- [iPhone-13-landscape-light-kvm](phone-chrome/iPhone-13-landscape-light-kvm.png)
- [iPhone-13-landscape-light-settings-short-shell](phone-chrome/iPhone-13-landscape-light-settings-short-shell.png)
- [iPhone-13-landscape-light-settings](phone-chrome/iPhone-13-landscape-light-settings.png)
- [iPhone-13-portrait-dark-chat-short-shell](phone-chrome/iPhone-13-portrait-dark-chat-short-shell.png)
- [iPhone-13-portrait-dark-chat](phone-chrome/iPhone-13-portrait-dark-chat.png)
- [iPhone-13-portrait-dark-kvm-short-shell](phone-chrome/iPhone-13-portrait-dark-kvm-short-shell.png)
- [iPhone-13-portrait-dark-kvm](phone-chrome/iPhone-13-portrait-dark-kvm.png)
- [iPhone-13-portrait-dark-settings-short-shell](phone-chrome/iPhone-13-portrait-dark-settings-short-shell.png)
- [iPhone-13-portrait-dark-settings](phone-chrome/iPhone-13-portrait-dark-settings.png)
- [iPhone-13-portrait-dark-sheet](phone-chrome/iPhone-13-portrait-dark-sheet.png)
- [iPhone-13-portrait-light-chat-short-shell](phone-chrome/iPhone-13-portrait-light-chat-short-shell.png)
- [iPhone-13-portrait-light-chat](phone-chrome/iPhone-13-portrait-light-chat.png)
- [iPhone-13-portrait-light-kvm-short-shell](phone-chrome/iPhone-13-portrait-light-kvm-short-shell.png)
- [iPhone-13-portrait-light-kvm](phone-chrome/iPhone-13-portrait-light-kvm.png)
- [iPhone-13-portrait-light-settings-short-shell](phone-chrome/iPhone-13-portrait-light-settings-short-shell.png)
- [iPhone-13-portrait-light-settings](phone-chrome/iPhone-13-portrait-light-settings.png)
- [iPhone-13-portrait-light-sheet](phone-chrome/iPhone-13-portrait-light-sheet.png)
<!-- phone-chrome:end -->

<!-- resume:begin -->
## Stream and socket resume after the app was backgrounded

Host under test: `node dist/web-server.js` (http://127.0.0.1:8320) in front of `tools/fake-kvmd` (http://127.0.0.1:4620). Script: `apps/web/e2e/resume.e2e.mjs`; how to run it: `docs/e2e/README.md`.

Headless Chrome, iPhone 13 and desktop 1400x900. "Away" is Chrome's own freeze (`Page.setWebLifecycleState` frozen/active: no timer or handler runs) with `document.hidden`, visibilitychange, pageshow, focus, resume and online delivered as a platform delivers them, and the fake kvmd cutting or silencing (`/__fake/drop?what=`, `/__fake/stall`) the stream and the event socket meanwhile. A pass is the new picture on screen within 3 s of return, exactly one new stream and one new socket (counted on the fake), nothing opened while hidden.

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| iPhone 13 | one stream and one event socket to begin with | streams 1, sockets 1, opened 1/1 | pass |
| iPhone 13 | a touch drag holding a button when the page is hidden is let go on the target | held left; after hide nothing | pass |
| iPhone 13 | app switched away 5 s: stream and socket cut meanwhile, screen back within 3 s | frames 116 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| iPhone 13 | the hidden event never came: only the return, stream silent, socket cut, screen back within 3 s | frames 209 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| iPhone 13 | back after only 1.5 s with the stream silent: screen back within 3 s | frames 109 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| iPhone 13 | restored from the back/forward cache (pageshow, persisted): screen back within 3 s | frames 209 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| iPhone 13 | only the window gaining focus after a freeze: screen back within 3 s | frames 208 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| iPhone 13 | the page's resume event after a freeze: screen back within 3 s | frames 210 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| iPhone 13 | network back (online) after a freeze: screen back within 3 s | frames 110 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| iPhone 13 | visible, pageshow, focus and online at once make ONE new stream and ONE new socket | frames 211 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| iPhone 13 | hidden and NOT frozen for 12 s with everything cut: nothing reconnects until it is shown again | frames 110 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| iPhone 13 | a short, healthy switch away and back (0.4 s) keeps the same stream | stream opens 10 -> 10, socket opens 10 -> 10, alive 1/1, live true | pass |
| iPhone 13 | no page errors | 0 page errors; console: WebSocket connection to 'ws://127.0.0.1/api/ws' failed: Page entered Back-Forward Cache. \| WebSocket connection to 'ws://127.0.0.1/api/ws' failed: WebSocket is closed before the connection is established. | pass |
| Desktop 1400x900 | one stream and one event socket to begin with | streams 1, sockets 1, opened 1/1 | pass |
| Desktop 1400x900 | a key held when the page is hidden is let go on the target, and typing works after return | held ShiftLeft; after hide nothing; typed after return F7 down, F7 up | pass |
| Desktop 1400x900 | a mouse button held when the page is hidden is let go on the target | held left; after hide nothing | pass |
| Desktop 1400x900 | app switched away 5 s: stream and socket cut meanwhile, screen back within 3 s | frames 118 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| Desktop 1400x900 | the hidden event never came: only the return, stream silent, socket cut, screen back within 3 s | frames 208 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| Desktop 1400x900 | back after only 1.5 s with the stream silent: screen back within 3 s | frames 108 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| Desktop 1400x900 | restored from the back/forward cache (pageshow, persisted): screen back within 3 s | frames 109 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| Desktop 1400x900 | only the window gaining focus after a freeze: screen back within 3 s | frames 209 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| Desktop 1400x900 | the page's resume event after a freeze: screen back within 3 s | frames 114 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| Desktop 1400x900 | network back (online) after a freeze: screen back within 3 s | frames 188 ms after return; new streams 1, new sockets 2; alive streams 1, sockets 1; opened while away 0/0 | pass |
| Desktop 1400x900 | visible, pageshow, focus and online at once make ONE new stream and ONE new socket | frames 300 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| Desktop 1400x900 | hidden and NOT frozen for 12 s with everything cut: nothing reconnects until it is shown again | frames 213 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/0 | pass |
| Desktop 1400x900 | a short, healthy switch away and back (0.4 s) keeps the same stream | stream opens 10 -> 10, socket opens 11 -> 11, alive 1/1, live true | pass |
| Desktop 1400x900 | a key held while the socket is down, page hidden meanwhile: released on the new socket after return | held ShiftLeft; while the socket was down ShiftLeft; after return nothing | pass |
| Desktop 1400x900 | no page errors | 0 page errors; console: WebSocket connection to 'ws://127.0.0.1/api/ws' failed: Page entered Back-Forward Cache. \| WebSocket connection to 'ws://127.0.0.1/api/ws' failed: WebSocket is closed before the connection is established. | pass |

28 of 28 passed.

**Before the fix, phone** (`before-phone.txt`, the same script against the build from 69ca5dd1): 6 of 13 passed; the failing rows:

- [iPhone 13] a touch drag holding a button when the page is hidden is let go on the target: held left; after hide left
- [iPhone 13] the hidden event never came: only the return, stream silent, socket cut, screen back within 3 s: frames never after return; new streams 0, new sockets 1; alive streams 1, sockets 1; opened while away 0/0
- [iPhone 13] back after only 1.5 s with the stream silent: screen back within 3 s: frames never after return; new streams 0, new sockets 1; alive streams 1, sockets 1; opened while away 0/0
- [iPhone 13] restored from the back/forward cache (pageshow, persisted): screen back within 3 s: frames never after return; new streams 0, new sockets 1; alive streams 1, sockets 1; opened while away 0/0
- [iPhone 13] only the window gaining focus after a freeze: screen back within 3 s: frames never after return; new streams 0, new sockets 1; alive streams 1, sockets 1; opened while away 0/0
- [iPhone 13] the page's resume event after a freeze: screen back within 3 s: frames never after return; new streams 0, new sockets 1; alive streams 1, sockets 1; opened while away 0/0
- [iPhone 13] hidden and NOT frozen for 12 s with everything cut: nothing reconnects until it is shown again: frames 107 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/1

**Before the fix, desktop** (`before-desktop.txt`, the same script against the build from 69ca5dd1): 6 of 15 passed; the failing rows:

- [Desktop 1400x900] a key held when the page is hidden is let go on the target, and typing works after return: held ShiftLeft; after hide ShiftLeft; typed after return F7 down, F7 up
- [Desktop 1400x900] a mouse button held when the page is hidden is let go on the target: held left; after hide left
- [Desktop 1400x900] the hidden event never came: only the return, stream silent, socket cut, screen back within 3 s: frames never after return; new streams 0, new sockets 1; alive streams 1, sockets 1; opened while away 0/0
- [Desktop 1400x900] back after only 1.5 s with the stream silent: screen back within 3 s: frames never after return; new streams 0, new sockets 1; alive streams 1, sockets 1; opened while away 0/0
- [Desktop 1400x900] restored from the back/forward cache (pageshow, persisted): screen back within 3 s: frames never after return; new streams 0, new sockets 1; alive streams 1, sockets 1; opened while away 0/0
- [Desktop 1400x900] only the window gaining focus after a freeze: screen back within 3 s: frames never after return; new streams 0, new sockets 1; alive streams 1, sockets 1; opened while away 0/0
- [Desktop 1400x900] the page's resume event after a freeze: screen back within 3 s: frames never after return; new streams 0, new sockets 1; alive streams 1, sockets 1; opened while away 0/0
- [Desktop 1400x900] hidden and NOT frozen for 12 s with everything cut: nothing reconnects until it is shown again: frames 210 ms after return; new streams 1, new sockets 1; alive streams 1, sockets 1; opened while away 0/1
- [Desktop 1400x900] a key held while the socket is down, page hidden meanwhile: released on the new socket after return: held ShiftLeft; while the socket was down ShiftLeft; after return ShiftLeft

<!-- resume:end -->

<!-- lens:begin -->
## Zoom-in cursor lens: trigger and speed-tied zoom

Kieran: "the zoom in cursor thing I need you to make it easier to trigger, and you gotta tie it directly to the movement speed".

What changed (`packages/kvm-engine/src/view/lens.ts`, every number in its tuning block; failure modes L1-L15 in `view/FAILURE_MODES.md`, P17 in `pointer/FAILURE_MODES.md`):

- Trigger: no hold. The lens used to need about a second of sustained fine movement (and a 160 px path cap) before it appeared and 450 ms to grow. It now appears on the first frame after the finger has moved more than 4 px from where it touched in trackpad mode (before the cursor itself starts moving at the 16 px tap slop), and opens in 160 ms. A tap, a hold or a resting finger (jitter under 4 px) never shows it.
- Zoom is a function of finger speed: the finger's px/s, averaged over about 70 ms (decayed distance / decayed time, using each event's own timestamp), goes through a smoothstep from 5x total at <= 60 px/s to 1x (no lens) at >= 360 px/s. Continuous and monotonic, flat at both ends.
- Hysteresis: the lens appears at 1.3x and goes away only below 1.12x, so a finger hovering on the threshold does not flicker.
- The speed is held while the finger rests (a swipe that ends still never lets the lens creep in; a nudge that ends still keeps its zoom). The picture's own zoom still counts towards the total (lens mag = max(1, zoom / picture scale)).
- Desktop mouse: unchanged, the lens has never applied there (it needs the trackpad's virtual cursor); the desktop case below confirms none appears.

Found by the run: the painter proxy in `picture-controller.ts` dropped the event timestamp, so the first version timed moves by when the browser handed them over (a frame's worth together) and the zoom jumped by up to 1.2x a frame. With the proxy forwarding it the largest frame-to-frame change in these runs is 0.2-0.35x.

Script: `apps/web/e2e/lens.e2e.mjs`; iPhone 13 profile with raw CDP touch events, then the desktop mouse. The page records the lens (on, `data-mag`, size) on every animation frame and every pointermove on its own clock; the finger speed in the table is read off those pointermoves (trailing 120 ms).

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| iPhone 13 | trackpad lens: a slow finger shows it at once, with no hold: within a frame or two of leaving its touch point by 4 px, and not before | finger past 4 px at +178.7 ms of the touch (4.3 px away); lens first on 36.4 ms later at 5.00x and 56px; on before that: 0 frames | pass |
| iPhone 13 | trackpad lens: slow movement is at the full zoom | 48 frames at 40-40 px/s: lens always on, zoom >= 5.00x (max 5) | pass |
| iPhone 13 | trackpad lens: speeding up zooms out continuously, to nothing by the fast speed, with no jump | 42 frames on; largest frame-to-frame zoom change 0.32x (longest pointer gap just before it 31 ms); zoom every 200 ms 5.0 > 4.9 > 3.5 > 1.7; on/off changes 1; went off at 352 px/s of finger speed (fast = 360) | pass |
| iPhone 13 | trackpad lens: fast movement never has it, from the first fast frame | 27 frames at up to 521 px/s: lens on in 0 | pass |
| iPhone 13 | trackpad lens: slowing down zooms back in continuously, with no jump | back on at 285 px/s (lens needs the finger under 360); largest frame-to-frame zoom change 0.35x (longest pointer gap just before it 33 ms); zoom every 200 ms 1.4 < 1.4 < 1.4 < 1.6 < 3.5; on/off changes 1; ended at 4.91x | pass |
| iPhone 13 | trackpad lens: slow again is back to the full zoom | 25 frames, zoom >= 5.00x | pass |
| iPhone 13 | trackpad lens: the zoom is tied to the speed: the slower the finger, the higher the zoom, across the whole gesture | 0-90 px/s: 4.99x (n=133); 90-150 px/s: 4.52x (n=14); 150-220 px/s: 3.50x (n=18); 220-300 px/s: 2.15x (n=18); 300-420 px/s: 1.41x (n=6) | pass |
| iPhone 13 | trackpad lens: it grows from small to full size inside 200 ms, then lingers after the lift and goes | first 56px, full 96px 133 ms later; 1.0 s after lift on=true; 1.7 s after on=false | pass |
| iPhone 13 | trackpad lens: screenshots slow / medium / fast | slow on=true 5.00x; medium on=true 3.20x; fast on=false -x (lens-1-slow.png, lens-2-medium.png, lens-3-fast.png) | pass |
| iPhone 13 | trackpad lens: a tap and a resting finger with a few px of jitter never show it | 111 frames over a 1.5 s rest with 1.5 px jitter: lens on in 0 | pass |
| iPhone 13 | no page errors | clean | pass |
| Desktop 1400x900 | desktop mouse: no lens, slow or fast (the lens is a trackpad aid) | 111 frames over a slow then a fast mouse sweep: lens on in 0 | pass |

One gesture, one finger: slow (40 px/s) -> speeding up to 520 px/s -> fast (520) -> slowing down to 40 -> slow again, then lift. Sampled every 150 ms:

| t (s) | leg | finger px/s | lens | zoom | size px |
| --- | --- | --- | --- | --- | --- |
| 0.02 |  | 0 | off | - | - |
| 0.17 | slow | 40 | off | - | - |
| 0.32 | slow | 40 | on | 5.00 | 94 |
| 0.47 | slow | 40 | on | 5.00 | 96 |
| 0.62 | slow | 40 | on | 5.00 | 96 |
| 0.77 | slow | 40 | on | 5.00 | 96 |
| 0.92 | slow | 40 | on | 5.00 | 96 |
| 1.06 | slow | 40 | on | 5.00 | 96 |
| 1.22 | speeding up | 37 | on | 5.00 | 96 |
| 1.37 | speeding up | 105 | on | 4.96 | 96 |
| 1.52 | speeding up | 176 | on | 4.06 | 96 |
| 1.67 | speeding up | 247 | on | 2.68 | 96 |
| 1.81 | speeding up | 320 | on | 1.45 | 96 |
| 1.97 | speeding up | 391 | off | - | - |
| 2.12 | speeding up | 463 | off | - | - |
| 2.27 | fast | 426 | off | - | - |
| 2.42 | fast | 520 | off | - | - |
| 2.57 | fast | 521 | off | - | - |
| 2.72 | slowing down | 432 | off | - | - |
| 2.87 | slowing down | 449 | off | - | - |
| 3.02 | slowing down | 372 | off | - | - |
| 3.17 | slowing down | 304 | off | - | - |
| 3.32 | slowing down | 232 | on | 2.05 | 94 |
| 3.47 | slowing down | 160 | on | 3.55 | 96 |
| 3.62 | slowing down | 88 | on | 4.70 | 96 |
| 3.77 | slow again | 34 | on | 5.00 | 96 |
| 3.92 | slow again | 40 | on | 5.00 | 96 |
| 4.06 | slow again | 40 | on | 5.00 | 96 |
| 4.21 | slow again | 40 | on | 5.00 | 96 |
| 4.37 | slow again | 40 | on | 5.00 | 96 |
| 4.51 | slow again | 40 | on | 5.00 | 96 |
| 4.66 | lifted | 40 | on | 5.00 | 96 |
| 4.82 | lifted | 0 | on | 5.00 | 96 |
| 4.96 | lifted | 0 | on | 5.00 | 96 |
| 5.11 | lifted | 0 | on | 5.00 | 96 |
| 5.26 | lifted | 0 | on | 5.00 | 96 |

Screenshots (finger held at 40, 200 and 650 px/s, cursor recentred first): [slow](phone-feedback/lens-1-slow.png), [medium](phone-feedback/lens-2-medium.png), [fast](phone-feedback/lens-3-fast.png).
<!-- lens:end -->
