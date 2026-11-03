# E2E: phone feedback (2026-11-03)

One section per change.

<!-- phone-chrome:start -->
## Status bar and home-indicator strip (PhoneChrome)

Run 2026-11-03. Host under test: `node dist/web-server.js` (http://127.0.0.1:8161) in front of `tools/fake-kvmd` (http://127.0.0.1:4561). Headless Chrome through puppeteer-core; the iPhone 13 profile (touch, 390x844 portrait and 844x390 landscape) with the safe-area insets emulated by CDP `Emulation.setSafeAreaInsetsOverride` (portrait top 47 / bottom 34; landscape top 0 / bottom 21 / left and right 47). Colours are read back from the screenshots' pixels. The two `standalone` profiles are the installed app as iOS draws it with the `black` status-bar style: the page starts below the bar, so the viewport is 390x797 with no top inset and 34 at the bottom, and `navigator.standalone` is true before any script runs. In the second one the page also reports 62px less than the screen from `innerHeight` and the visual viewport (injected before any script; `100vh` stays the screen), and `window.__keyboard(px)` takes more away as the soft keyboard does. The `update` cases drive coming back to the app after a deploy (the host's `/app/version.json` answered with another build) and check Settings > About against it. Script: `apps/web/e2e/phone-chrome.e2e.mjs`; how to run it: `docs/e2e/README.md`.

**What the earlier versions got wrong.** (1) The status bar: on a real iPhone (iOS 26) the top showed a grey-to-black gradient. That is the system's own scrim over a `black-translucent` page, which no CSS removes, so the style is now `black` (a solid bar, the page below it, no top inset; iOS keeps the style from when the app was added, so the app had to be added again). (2) The gap under the navigation bar was first put down to the web view being short and the system background showing outside it. That was wrong: nothing is outside the web view. In the installed app (no URL bar) `100vh` is the whole screen, while `100dvh`, `100svh`, `innerHeight` and the visual viewport report the screen minus an inset when the app starts, and the shell was sized from those, so it stopped short. The shell became `100vh` in the installed app, and the visual viewport's height is used only while the soft keyboard is up (its baseline is a `100vh` probe). That was not enough on the device (the navigation bar came out cut in half at 811 of 874 pt, the page's own background below the cut): on iOS 26 a `position: fixed` html, body or app container is clipped to the layout viewport, which the installed app reports short, so a 100vh fixed shell is cut off at that height (docs: cjnova/piclaw-monaco PWA.md 8.6 and 8.9). In the installed app with the keyboard closed, html, body and the shell are therefore normal flow and each `--app-height` tall, with no ancestor that clips or is shorter (the `shell fills the screen exactly` case reads the position of html, body and the shell and lists any clipping ancestor shorter than the shell); while the keyboard is up they are fixed to the visual viewport as before (`data-keyboard` on html says which). Headless Chrome does not clip fixed elements that way, so what the e2e can prove is the structure and the geometry, and the `viewport reports 62px short` profile still reproduces the earlier report (shell 0,0,390,735 of 390x797). (3) The blur at the top after visiting Chat or Settings: the resolution pill (`.kvm-res-toast`, top 10px) was a `backdrop-filter` and was still showing; it no longer blurs. With the `black` style the page starts below the bar and the system paints the bar area itself, from what it finds at the top edge of the page, so the top edge is one opaque black `#status-edge` element (12px deep in the installed iOS app, now also recognised by the device when `navigator.standalone` is not true) that the shell is padded by. The `KVM > Chat > Settings > KVM` case scans the top 60px after each step. What the system draws over the page on a real device cannot be reproduced headless: Settings > About > Display lists what the phone reports (flags, insets, every viewport unit, the boxes and positions of html, body, #root, the shell, the bar and #status-edge, and any clipping ancestor) and copies it as text.

**The status area, as read from the phone (iOS 27.2, through the inspector) and decided.** Nothing of ours blurred anything at the top on any tab, and `#status-edge` was opaque black, 62 px, on top of everything on every tab; the grey frosted bar on Chat and Settings is iOS's own glass, tinted from the page (body was `rgb(238, 240, 244)` there and transparent over a black html on the KVM, which is why only the KVM bar was black). So the black edge in point (3) above is superseded: the status area now follows the page, one colour from the active tab and the theme (`app/status-colour.ts`): black over the KVM; the page's own colour on Chat and Settings (`#eef0f4` light, `#0a0a0c` dark). The top edge, html, body and the `theme-color` meta all take it (the `--status-colour` property), the shell updates it on a tab change and on a theme change, and `index.html` works it out before first paint for the route it opens on, so the system samples one solid colour and picks its own text colour for it. Every remaining `backdrop-filter` and blur in the app and the chat is gone (the resolution pill, the dialog scrim, the stream-state card, menus and toolbars, the lightbox, table headers, the composer's progressive-blur scrim, tailed surfaces, ui.blur's glass), and the chat's page card has no resting shadow (it was a soft shadow over the top edge); the `no backdrop-filter or blur anywhere` case scans every element and its pseudo-elements on every tab and with the sheets open, and the `KVM > Chat > Settings > KVM` case also flags a wide soft shadow near the top.

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| static | meta served at /app/ | {"theme-color":"#000000","apple-mobile-web-app-capable":"yes","apple-mobile-web-app-status-bar-style":"black","mobile-web-app-capable":"yes"}; viewport "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content" | pass |
| static | manifest | /app/manifest.webmanifest: theme_color #000000, background_color #0a0a0c, display standalone | pass |
| static | offline page | theme-color #000000 and the inset strip are in /app/sw.js | pass |
| static | the page, sw.js and version.json are revalidated, hashed assets are immutable, the worker never caches a page | {"/app/":"no-cache","/app/sw.js":"no-cache","/app/version.json":"no-cache","/app/manifest.webmanifest":"no-cache"}; /app/assets/index-czb7Tzhj.js public, max-age=31536000, immutable; worker navigations go to the network, skipWaiting and clients.claim present: true | pass |
| update | Settings > About shows the build the host serves in /app/version.json | About lists "App build" and "snap.20261103-164533": true | pass |
| update | coming back to the same build does not reload | page kept its state: true | pass |
| update | coming back after a deploy reloads once, and never twice for the same build | reloaded for "next.20991231-235959", and the second return kept the page (state 2) | pass |
| iPhone 13 portrait, light | kvm: the top edge is 47px of #000000 (the page's colour at the top) and the shell is padded by it | status-edge 47px x 390 (fixed) rgb(0, 0, 0), shell padding-top 47px; 9 pixels over it all #000000; first pixel below it #000000 (page bg #000000); html rgb(0, 0, 0), body rgba(0, 0, 0, 0), theme-color #000000 | pass |
| iPhone 13 portrait, light | kvm: the shell fills the screen exactly (bottom 844) | shell 0,0,390,844 of 390x844; the page reports innerHeight 844; --app-height written by the shell: "844px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 portrait, light | kvm: home-indicator strip is the navigation bar's #ffffff | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 portrait, light | chat: the top edge is 47px of #eef0f4 (the page's colour at the top) and the shell is padded by it | status-edge 47px x 390 (fixed) rgb(238, 240, 244), shell padding-top 47px; 9 pixels over it all #eef0f4; first pixel below it #eef0f4 (page bg #eef0f4); html rgb(238, 240, 244), body rgb(238, 240, 244), theme-color #eef0f4 | pass |
| iPhone 13 portrait, light | chat: the shell fills the screen exactly (bottom 844) | shell 0,0,390,844 of 390x844; the page reports innerHeight 844; --app-height written by the shell: "844px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 portrait, light | chat: home-indicator strip is the navigation bar's #ffffff | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 portrait, light | settings: the top edge is 47px of #eef0f4 (the page's colour at the top) and the shell is padded by it | status-edge 47px x 390 (fixed) rgb(238, 240, 244), shell padding-top 47px; 9 pixels over it all #eef0f4; first pixel below it #eef0f4 (page bg #eef0f4); html rgb(238, 240, 244), body rgb(238, 240, 244), theme-color #eef0f4 | pass |
| iPhone 13 portrait, light | settings: the shell fills the screen exactly (bottom 844) | shell 0,0,390,844 of 390x844; the page reports innerHeight 844; --app-height written by the shell: "844px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 portrait, light | settings: home-indicator strip is the navigation bar's #ffffff | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 portrait, light | KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black | 1. kvm: nothing, edge 47px #000000 \| 2. chat: nothing, edge 47px #eef0f4 \| 3. settings: nothing, edge 47px #eef0f4 \| 4. kvm: nothing, edge 47px #000000 | pass |
| iPhone 13 portrait, light | no backdrop-filter or blur anywhere, on every tab and with the sheets open | kvm: none \| chat: none \| settings: none \| KVM More sheet: none \| KVM full-page dialog: none | pass |
| iPhone 13 portrait, light | Settings: switching the theme in Display repaints the status area to the other theme's page colour at once, with no navigation | light -> dark: theme-color #eef0f4 -> #0a0a0c, status edge rgb(238, 240, 244) -> rgb(10, 10, 12), html rgb(238, 240, 244) -> rgb(10, 10, 12) | pass |
| iPhone 13 portrait, light | a full-page sheet does not paint over the top edge | opened true; sheet rgba(0, 0, 0, 0.62) from y=0; pixels in the edge #000000/#000000, just below #121216 | pass |
| iPhone 13 portrait, light | no console errors | none | pass |
| iPhone 13 landscape, light | kvm: the top edge is 0px of #000000 (the page's colour at the top) and the shell is padded by it | strip height 0px, shell padding-top 0px (nothing of ours at the top: the bar is the system's, the page is below it) | pass |
| iPhone 13 landscape, light | kvm: the shell fills the screen exactly (bottom 390) | shell 0,0,844,390 of 844x390; the page reports innerHeight 390; --app-height written by the shell: "390px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 landscape, light | kvm: home-indicator strip is the navigation bar's #ffffff | nav 0,312,844,390 of 844x390, padding-bottom 25px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 landscape, light | chat: the top edge is 0px of #eef0f4 (the page's colour at the top) and the shell is padded by it | strip height 0px, shell padding-top 0px (nothing of ours at the top: the bar is the system's, the page is below it) | pass |
| iPhone 13 landscape, light | chat: the shell fills the screen exactly (bottom 390) | shell 0,0,844,390 of 844x390; the page reports innerHeight 390; --app-height written by the shell: "390px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 landscape, light | chat: home-indicator strip is the navigation bar's #ffffff | nav 0,312,844,390 of 844x390, padding-bottom 25px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 landscape, light | settings: the top edge is 0px of #eef0f4 (the page's colour at the top) and the shell is padded by it | strip height 0px, shell padding-top 0px (nothing of ours at the top: the bar is the system's, the page is below it) | pass |
| iPhone 13 landscape, light | settings: the shell fills the screen exactly (bottom 390) | shell 0,0,844,390 of 844x390; the page reports innerHeight 390; --app-height written by the shell: "390px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 landscape, light | settings: home-indicator strip is the navigation bar's #ffffff | nav 0,312,844,390 of 844x390, padding-bottom 25px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 landscape, light | KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black | 1. kvm: nothing, edge 0px \| 2. chat: nothing, edge 0px \| 3. settings: nothing, edge 0px \| 4. kvm: nothing, edge 0px | pass |
| iPhone 13 landscape, light | no backdrop-filter or blur anywhere, on every tab and with the sheets open | kvm: none \| chat: none \| settings: none \| KVM More sheet: none \| KVM full-page dialog: none | pass |
| iPhone 13 landscape, light | Settings: switching the theme in Display repaints the status area to the other theme's page colour at once, with no navigation | light -> dark: theme-color #eef0f4 -> #0a0a0c, status edge rgb(238, 240, 244) -> rgb(10, 10, 12), html rgb(238, 240, 244) -> rgb(10, 10, 12) | pass |
| iPhone 13 landscape, light | no console errors | none | pass |
| iPhone 13 portrait, dark | kvm: the top edge is 47px of #000000 (the page's colour at the top) and the shell is padded by it | status-edge 47px x 390 (fixed) rgb(0, 0, 0), shell padding-top 47px; 9 pixels over it all #000000; first pixel below it #000000 (page bg #000000); html rgb(0, 0, 0), body rgba(0, 0, 0, 0), theme-color #000000 | pass |
| iPhone 13 portrait, dark | kvm: the shell fills the screen exactly (bottom 844) | shell 0,0,390,844 of 390x844; the page reports innerHeight 844; --app-height written by the shell: "844px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 portrait, dark | kvm: home-indicator strip is the navigation bar's #121216 | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 portrait, dark | chat: the top edge is 47px of #0a0a0c (the page's colour at the top) and the shell is padded by it | status-edge 47px x 390 (fixed) rgb(10, 10, 12), shell padding-top 47px; 9 pixels over it all #0a0a0c; first pixel below it #0a0a0c (page bg #0a0a0c); html rgb(10, 10, 12), body rgb(10, 10, 12), theme-color #0a0a0c | pass |
| iPhone 13 portrait, dark | chat: the shell fills the screen exactly (bottom 844) | shell 0,0,390,844 of 390x844; the page reports innerHeight 844; --app-height written by the shell: "844px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 portrait, dark | chat: home-indicator strip is the navigation bar's #121216 | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 portrait, dark | settings: the top edge is 47px of #0a0a0c (the page's colour at the top) and the shell is padded by it | status-edge 47px x 390 (fixed) rgb(10, 10, 12), shell padding-top 47px; 9 pixels over it all #0a0a0c; first pixel below it #0a0a0c (page bg #0a0a0c); html rgb(10, 10, 12), body rgb(10, 10, 12), theme-color #0a0a0c | pass |
| iPhone 13 portrait, dark | settings: the shell fills the screen exactly (bottom 844) | shell 0,0,390,844 of 390x844; the page reports innerHeight 844; --app-height written by the shell: "844px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 portrait, dark | settings: home-indicator strip is the navigation bar's #121216 | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 portrait, dark | KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black | 1. kvm: nothing, edge 47px #000000 \| 2. chat: nothing, edge 47px #0a0a0c \| 3. settings: nothing, edge 47px #0a0a0c \| 4. kvm: nothing, edge 47px #000000 | pass |
| iPhone 13 portrait, dark | no backdrop-filter or blur anywhere, on every tab and with the sheets open | kvm: none \| chat: none \| settings: none \| KVM More sheet: none \| KVM full-page dialog: none | pass |
| iPhone 13 portrait, dark | Settings: switching the theme in Display repaints the status area to the other theme's page colour at once, with no navigation | dark -> light: theme-color #0a0a0c -> #eef0f4, status edge rgb(10, 10, 12) -> rgb(238, 240, 244), html rgb(10, 10, 12) -> rgb(238, 240, 244) | pass |
| iPhone 13 portrait, dark | a full-page sheet does not paint over the top edge | opened true; sheet rgba(0, 0, 0, 0.62) from y=0; pixels in the edge #000000/#000000, just below #ffffff | pass |
| iPhone 13 portrait, dark | no console errors | none | pass |
| iPhone 13 landscape, dark | kvm: the top edge is 0px of #000000 (the page's colour at the top) and the shell is padded by it | strip height 0px, shell padding-top 0px (nothing of ours at the top: the bar is the system's, the page is below it) | pass |
| iPhone 13 landscape, dark | kvm: the shell fills the screen exactly (bottom 390) | shell 0,0,844,390 of 844x390; the page reports innerHeight 390; --app-height written by the shell: "390px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 landscape, dark | kvm: home-indicator strip is the navigation bar's #121216 | nav 0,312,844,390 of 844x390, padding-bottom 25px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 landscape, dark | chat: the top edge is 0px of #0a0a0c (the page's colour at the top) and the shell is padded by it | strip height 0px, shell padding-top 0px (nothing of ours at the top: the bar is the system's, the page is below it) | pass |
| iPhone 13 landscape, dark | chat: the shell fills the screen exactly (bottom 390) | shell 0,0,844,390 of 844x390; the page reports innerHeight 390; --app-height written by the shell: "390px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 landscape, dark | chat: home-indicator strip is the navigation bar's #121216 | nav 0,312,844,390 of 844x390, padding-bottom 25px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 landscape, dark | settings: the top edge is 0px of #0a0a0c (the page's colour at the top) and the shell is padded by it | strip height 0px, shell padding-top 0px (nothing of ours at the top: the bar is the system's, the page is below it) | pass |
| iPhone 13 landscape, dark | settings: the shell fills the screen exactly (bottom 390) | shell 0,0,844,390 of 844x390; the page reports innerHeight 390; --app-height written by the shell: "390px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 landscape, dark | settings: home-indicator strip is the navigation bar's #121216 | nav 0,312,844,390 of 844x390, padding-bottom 25px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 landscape, dark | KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black | 1. kvm: nothing, edge 0px \| 2. chat: nothing, edge 0px \| 3. settings: nothing, edge 0px \| 4. kvm: nothing, edge 0px | pass |
| iPhone 13 landscape, dark | no backdrop-filter or blur anywhere, on every tab and with the sheets open | kvm: none \| chat: none \| settings: none \| KVM More sheet: none \| KVM full-page dialog: none | pass |
| iPhone 13 landscape, dark | Settings: switching the theme in Display repaints the status area to the other theme's page colour at once, with no navigation | dark -> light: theme-color #0a0a0c -> #eef0f4, status edge rgb(10, 10, 12) -> rgb(238, 240, 244), html rgb(10, 10, 12) -> rgb(238, 240, 244) | pass |
| iPhone 13 landscape, dark | no console errors | none | pass |
| iPhone 13 standalone, black bar, light | kvm: the top edge is 12px of #000000 (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(0, 0, 0), shell padding-top 12px; 9 pixels over it all #000000; first pixel below it #000000 (page bg #000000); html rgb(0, 0, 0), body rgba(0, 0, 0, 0), theme-color #000000 | pass |
| iPhone 13 standalone, black bar, light | kvm: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 797; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, black bar, light | kvm: home-indicator strip is the navigation bar's #ffffff | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 standalone, black bar, light | chat: the top edge is 12px of #eef0f4 (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(238, 240, 244), shell padding-top 12px; 9 pixels over it all #eef0f4; first pixel below it #eef0f4 (page bg #eef0f4); html rgb(238, 240, 244), body rgb(238, 240, 244), theme-color #eef0f4 | pass |
| iPhone 13 standalone, black bar, light | chat: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 797; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, black bar, light | chat: home-indicator strip is the navigation bar's #ffffff | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 standalone, black bar, light | settings: the top edge is 12px of #eef0f4 (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(238, 240, 244), shell padding-top 12px; 9 pixels over it all #eef0f4; first pixel below it #eef0f4 (page bg #eef0f4); html rgb(238, 240, 244), body rgb(238, 240, 244), theme-color #eef0f4 | pass |
| iPhone 13 standalone, black bar, light | settings: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 797; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, black bar, light | settings: home-indicator strip is the navigation bar's #ffffff | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 standalone, black bar, light | KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black | 1. kvm: nothing, edge 12px #000000 \| 2. chat: nothing, edge 12px #eef0f4 \| 3. settings: nothing, edge 12px #eef0f4 \| 4. kvm: nothing, edge 12px #000000 | pass |
| iPhone 13 standalone, black bar, light | no backdrop-filter or blur anywhere, on every tab and with the sheets open | kvm: none \| chat: none \| settings: none \| KVM More sheet: none \| KVM full-page dialog: none | pass |
| iPhone 13 standalone, black bar, light | Settings: switching the theme in Display repaints the status area to the other theme's page colour at once, with no navigation | light -> dark: theme-color #eef0f4 -> #0a0a0c, status edge rgb(238, 240, 244) -> rgb(10, 10, 12), html rgb(238, 240, 244) -> rgb(10, 10, 12) | pass |
| iPhone 13 standalone, black bar, light | a full-page sheet does not paint over the top edge | opened true; sheet rgba(0, 0, 0, 0.62) from y=0; pixels in the edge #000000/#000000, just below #121216 | pass |
| iPhone 13 standalone, black bar, light | Settings > About > Display reports the viewport, the flags and the clipping chain | 23 lines; html: 0,0 - 390,797 (390 x 797) \| position static, height 797px, overflow hidden/hidden, bg rgb(238, 240, 244) \|\| body: 0,0 - 390,797 (390 x 797) \| position relative, height 797px, overflow hidden/hidden, bg rgb(238, 240, 244) \|\| .app-shell: 0,0 - 390,797 (390 x 797) \| position relative, height 797px, overflow visible/visible, bg rgb(238, 240, 244) \|\| #status-edge: 0,0 - 390,12 (390 x 12) \| position fixed, height 12px, overflow visible/visible, bg rgb(238, 240, 244) | pass |
| iPhone 13 standalone, black bar, light | no console errors | none | pass |
| iPhone 13 standalone, viewport reports 62px short, light | kvm: the top edge is 12px of #000000 (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(0, 0, 0), shell padding-top 12px; 9 pixels over it all #000000; first pixel below it #000000 (page bg #000000); html rgb(0, 0, 0), body rgba(0, 0, 0, 0), theme-color #000000 | pass |
| iPhone 13 standalone, viewport reports 62px short, light | kvm: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 735; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, viewport reports 62px short, light | kvm: home-indicator strip is the navigation bar's #ffffff | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 standalone, viewport reports 62px short, light | chat: the top edge is 12px of #eef0f4 (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(238, 240, 244), shell padding-top 12px; 9 pixels over it all #eef0f4; first pixel below it #eef0f4 (page bg #eef0f4); html rgb(238, 240, 244), body rgb(238, 240, 244), theme-color #eef0f4 | pass |
| iPhone 13 standalone, viewport reports 62px short, light | chat: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 735; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, viewport reports 62px short, light | chat: home-indicator strip is the navigation bar's #ffffff | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 standalone, viewport reports 62px short, light | settings: the top edge is 12px of #eef0f4 (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(238, 240, 244), shell padding-top 12px; 9 pixels over it all #eef0f4; first pixel below it #eef0f4 (page bg #eef0f4); html rgb(238, 240, 244), body rgb(238, 240, 244), theme-color #eef0f4 | pass |
| iPhone 13 standalone, viewport reports 62px short, light | settings: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 735; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, viewport reports 62px short, light | settings: home-indicator strip is the navigation bar's #ffffff | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 standalone, viewport reports 62px short, light | KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black | 1. kvm: nothing, edge 12px #000000 \| 2. chat: nothing, edge 12px #eef0f4 \| 3. settings: nothing, edge 12px #eef0f4 \| 4. kvm: nothing, edge 12px #000000 | pass |
| iPhone 13 standalone, viewport reports 62px short, light | no backdrop-filter or blur anywhere, on every tab and with the sheets open | kvm: none \| chat: none \| settings: none \| KVM More sheet: none \| KVM full-page dialog: none | pass |
| iPhone 13 standalone, viewport reports 62px short, light | the keyboard in the installed app resizes the shell and closing it restores the whole screen | keyboard up: shell 385px (visual viewport 385), data-keyboard open, shell fixed, no bar; closed: data-keyboard closed, shell relative, body relative, shell bottom 797 of 797, bar bottom 797, --app-height written "" | pass |
| iPhone 13 standalone, viewport reports 62px short, light | Settings: switching the theme in Display repaints the status area to the other theme's page colour at once, with no navigation | light -> dark: theme-color #eef0f4 -> #0a0a0c, status edge rgb(238, 240, 244) -> rgb(10, 10, 12), html rgb(238, 240, 244) -> rgb(10, 10, 12) | pass |
| iPhone 13 standalone, viewport reports 62px short, light | a full-page sheet does not paint over the top edge | opened true; sheet rgba(0, 0, 0, 0.62) from y=0; pixels in the edge #000000/#000000, just below #121216 | pass |
| iPhone 13 standalone, viewport reports 62px short, light | Settings > About > Display reports the viewport, the flags and the clipping chain | 23 lines; html: 0,0 - 390,797 (390 x 797) \| position static, height 797px, overflow hidden/hidden, bg rgb(238, 240, 244) \|\| body: 0,0 - 390,797 (390 x 797) \| position relative, height 797px, overflow hidden/hidden, bg rgb(238, 240, 244) \|\| .app-shell: 0,0 - 390,797 (390 x 797) \| position relative, height 797px, overflow visible/visible, bg rgb(238, 240, 244) \|\| #status-edge: 0,0 - 390,12 (390 x 12) \| position fixed, height 12px, overflow visible/visible, bg rgb(238, 240, 244) | pass |
| iPhone 13 standalone, viewport reports 62px short, light | no console errors | none | pass |
| iPhone 13 standalone, black bar, dark | kvm: the top edge is 12px of #000000 (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(0, 0, 0), shell padding-top 12px; 9 pixels over it all #000000; first pixel below it #000000 (page bg #000000); html rgb(0, 0, 0), body rgba(0, 0, 0, 0), theme-color #000000 | pass |
| iPhone 13 standalone, black bar, dark | kvm: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 797; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, black bar, dark | kvm: home-indicator strip is the navigation bar's #121216 | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 standalone, black bar, dark | chat: the top edge is 12px of #0a0a0c (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(10, 10, 12), shell padding-top 12px; 9 pixels over it all #0a0a0c; first pixel below it #0a0a0c (page bg #0a0a0c); html rgb(10, 10, 12), body rgb(10, 10, 12), theme-color #0a0a0c | pass |
| iPhone 13 standalone, black bar, dark | chat: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 797; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, black bar, dark | chat: home-indicator strip is the navigation bar's #121216 | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 standalone, black bar, dark | settings: the top edge is 12px of #0a0a0c (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(10, 10, 12), shell padding-top 12px; 9 pixels over it all #0a0a0c; first pixel below it #0a0a0c (page bg #0a0a0c); html rgb(10, 10, 12), body rgb(10, 10, 12), theme-color #0a0a0c | pass |
| iPhone 13 standalone, black bar, dark | settings: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 797; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, black bar, dark | settings: home-indicator strip is the navigation bar's #121216 | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 standalone, black bar, dark | KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black | 1. kvm: nothing, edge 12px #000000 \| 2. chat: nothing, edge 12px #0a0a0c \| 3. settings: nothing, edge 12px #0a0a0c \| 4. kvm: nothing, edge 12px #000000 | pass |
| iPhone 13 standalone, black bar, dark | no backdrop-filter or blur anywhere, on every tab and with the sheets open | kvm: none \| chat: none \| settings: none \| KVM More sheet: none \| KVM full-page dialog: none | pass |
| iPhone 13 standalone, black bar, dark | Settings: switching the theme in Display repaints the status area to the other theme's page colour at once, with no navigation | dark -> light: theme-color #0a0a0c -> #eef0f4, status edge rgb(10, 10, 12) -> rgb(238, 240, 244), html rgb(10, 10, 12) -> rgb(238, 240, 244) | pass |
| iPhone 13 standalone, black bar, dark | a full-page sheet does not paint over the top edge | opened true; sheet rgba(0, 0, 0, 0.62) from y=0; pixels in the edge #000000/#000000, just below #ffffff | pass |
| iPhone 13 standalone, black bar, dark | Settings > About > Display reports the viewport, the flags and the clipping chain | 23 lines; html: 0,0 - 390,797 (390 x 797) \| position static, height 797px, overflow hidden/hidden, bg rgb(10, 10, 12) \|\| body: 0,0 - 390,797 (390 x 797) \| position relative, height 797px, overflow hidden/hidden, bg rgb(10, 10, 12) \|\| .app-shell: 0,0 - 390,797 (390 x 797) \| position relative, height 797px, overflow visible/visible, bg rgb(10, 10, 12) \|\| #status-edge: 0,0 - 390,12 (390 x 12) \| position fixed, height 12px, overflow visible/visible, bg rgb(10, 10, 12) | pass |
| iPhone 13 standalone, black bar, dark | no console errors | none | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | kvm: the top edge is 12px of #000000 (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(0, 0, 0), shell padding-top 12px; 9 pixels over it all #000000; first pixel below it #000000 (page bg #000000); html rgb(0, 0, 0), body rgba(0, 0, 0, 0), theme-color #000000 | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | kvm: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 735; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | kvm: home-indicator strip is the navigation bar's #121216 | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | chat: the top edge is 12px of #0a0a0c (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(10, 10, 12), shell padding-top 12px; 9 pixels over it all #0a0a0c; first pixel below it #0a0a0c (page bg #0a0a0c); html rgb(10, 10, 12), body rgb(10, 10, 12), theme-color #0a0a0c | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | chat: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 735; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | chat: home-indicator strip is the navigation bar's #121216 | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | settings: the top edge is 12px of #0a0a0c (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(10, 10, 12), shell padding-top 12px; 9 pixels over it all #0a0a0c; first pixel below it #0a0a0c (page bg #0a0a0c); html rgb(10, 10, 12), body rgb(10, 10, 12), theme-color #0a0a0c | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | settings: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 735; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | settings: home-indicator strip is the navigation bar's #121216 | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black | 1. kvm: nothing, edge 12px #000000 \| 2. chat: nothing, edge 12px #0a0a0c \| 3. settings: nothing, edge 12px #0a0a0c \| 4. kvm: nothing, edge 12px #000000 | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | no backdrop-filter or blur anywhere, on every tab and with the sheets open | kvm: none \| chat: none \| settings: none \| KVM More sheet: none \| KVM full-page dialog: none | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | the keyboard in the installed app resizes the shell and closing it restores the whole screen | keyboard up: shell 385px (visual viewport 385), data-keyboard open, shell fixed, no bar; closed: data-keyboard closed, shell relative, body relative, shell bottom 797 of 797, bar bottom 797, --app-height written "" | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | Settings: switching the theme in Display repaints the status area to the other theme's page colour at once, with no navigation | dark -> light: theme-color #0a0a0c -> #eef0f4, status edge rgb(10, 10, 12) -> rgb(238, 240, 244), html rgb(10, 10, 12) -> rgb(238, 240, 244) | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | a full-page sheet does not paint over the top edge | opened true; sheet rgba(0, 0, 0, 0.62) from y=0; pixels in the edge #000000/#000000, just below #ffffff | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | Settings > About > Display reports the viewport, the flags and the clipping chain | 23 lines; html: 0,0 - 390,797 (390 x 797) \| position static, height 797px, overflow hidden/hidden, bg rgb(10, 10, 12) \|\| body: 0,0 - 390,797 (390 x 797) \| position relative, height 797px, overflow hidden/hidden, bg rgb(10, 10, 12) \|\| .app-shell: 0,0 - 390,797 (390 x 797) \| position relative, height 797px, overflow visible/visible, bg rgb(10, 10, 12) \|\| #status-edge: 0,0 - 390,12 (390 x 12) \| position fixed, height 12px, overflow visible/visible, bg rgb(10, 10, 12) | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | no console errors | none | pass |
| Android (Pixel 5, no insets) | kvm: no strips without an inset | bar; strip 0px; nav padding 4px; nav bottom 851 of 851 | pass |
| Android (Pixel 5, no insets) | chat: no strips without an inset | bar; strip 0px; nav padding 4px; nav bottom 851 of 851 | pass |
| Android (Pixel 5, no insets) | settings: no strips without an inset | bar; strip 0px; nav padding 4px; nav bottom 851 of 851 | pass |
| Desktop 1400x900, no insets | kvm: no strips without an inset | rail; strip 0px; nav padding 4px 4px 4px 4px; nav bottom 900 of 900 | pass |
| Desktop 1400x900, no insets | chat: no strips without an inset | rail; strip 0px; nav padding 4px 4px 4px 4px; nav bottom 900 of 900 | pass |
| Desktop 1400x900, no insets | settings: no strips without an inset | rail; strip 0px; nav padding 4px 4px 4px 4px; nav bottom 900 of 900 | pass |

129 of 129 passed.

Screenshots (`docs/e2e/phone-chrome/`):

- [android-light-chat](phone-chrome/android-light-chat.png)
- [android-light-kvm](phone-chrome/android-light-kvm.png)
- [android-light-settings](phone-chrome/android-light-settings.png)
- [desktop-light-chat](phone-chrome/desktop-light-chat.png)
- [desktop-light-kvm](phone-chrome/desktop-light-kvm.png)
- [desktop-light-settings](phone-chrome/desktop-light-settings.png)
- [iPhone-13-landscape-dark-chat](phone-chrome/iPhone-13-landscape-dark-chat.png)
- [iPhone-13-landscape-dark-kvm](phone-chrome/iPhone-13-landscape-dark-kvm.png)
- [iPhone-13-landscape-dark-order-1-kvm](phone-chrome/iPhone-13-landscape-dark-order-1-kvm.png)
- [iPhone-13-landscape-dark-order-2-chat](phone-chrome/iPhone-13-landscape-dark-order-2-chat.png)
- [iPhone-13-landscape-dark-order-3-settings](phone-chrome/iPhone-13-landscape-dark-order-3-settings.png)
- [iPhone-13-landscape-dark-order-4-kvm](phone-chrome/iPhone-13-landscape-dark-order-4-kvm.png)
- [iPhone-13-landscape-dark-settings](phone-chrome/iPhone-13-landscape-dark-settings.png)
- [iPhone-13-landscape-light-chat](phone-chrome/iPhone-13-landscape-light-chat.png)
- [iPhone-13-landscape-light-kvm](phone-chrome/iPhone-13-landscape-light-kvm.png)
- [iPhone-13-landscape-light-order-1-kvm](phone-chrome/iPhone-13-landscape-light-order-1-kvm.png)
- [iPhone-13-landscape-light-order-2-chat](phone-chrome/iPhone-13-landscape-light-order-2-chat.png)
- [iPhone-13-landscape-light-order-3-settings](phone-chrome/iPhone-13-landscape-light-order-3-settings.png)
- [iPhone-13-landscape-light-order-4-kvm](phone-chrome/iPhone-13-landscape-light-order-4-kvm.png)
- [iPhone-13-landscape-light-settings](phone-chrome/iPhone-13-landscape-light-settings.png)
- [iPhone-13-portrait-dark-chat](phone-chrome/iPhone-13-portrait-dark-chat.png)
- [iPhone-13-portrait-dark-kvm](phone-chrome/iPhone-13-portrait-dark-kvm.png)
- [iPhone-13-portrait-dark-order-1-kvm](phone-chrome/iPhone-13-portrait-dark-order-1-kvm.png)
- [iPhone-13-portrait-dark-order-2-chat](phone-chrome/iPhone-13-portrait-dark-order-2-chat.png)
- [iPhone-13-portrait-dark-order-3-settings](phone-chrome/iPhone-13-portrait-dark-order-3-settings.png)
- [iPhone-13-portrait-dark-order-4-kvm](phone-chrome/iPhone-13-portrait-dark-order-4-kvm.png)
- [iPhone-13-portrait-dark-settings](phone-chrome/iPhone-13-portrait-dark-settings.png)
- [iPhone-13-portrait-dark-sheet](phone-chrome/iPhone-13-portrait-dark-sheet.png)
- [iPhone-13-portrait-light-chat](phone-chrome/iPhone-13-portrait-light-chat.png)
- [iPhone-13-portrait-light-kvm](phone-chrome/iPhone-13-portrait-light-kvm.png)
- [iPhone-13-portrait-light-order-1-kvm](phone-chrome/iPhone-13-portrait-light-order-1-kvm.png)
- [iPhone-13-portrait-light-order-2-chat](phone-chrome/iPhone-13-portrait-light-order-2-chat.png)
- [iPhone-13-portrait-light-order-3-settings](phone-chrome/iPhone-13-portrait-light-order-3-settings.png)
- [iPhone-13-portrait-light-order-4-kvm](phone-chrome/iPhone-13-portrait-light-order-4-kvm.png)
- [iPhone-13-portrait-light-settings](phone-chrome/iPhone-13-portrait-light-settings.png)
- [iPhone-13-portrait-light-sheet](phone-chrome/iPhone-13-portrait-light-sheet.png)
- [iPhone-13-standalone-black-bar-dark-about-display](phone-chrome/iPhone-13-standalone-black-bar-dark-about-display.png)
- [iPhone-13-standalone-black-bar-dark-chat](phone-chrome/iPhone-13-standalone-black-bar-dark-chat.png)
- [iPhone-13-standalone-black-bar-dark-kvm](phone-chrome/iPhone-13-standalone-black-bar-dark-kvm.png)
- [iPhone-13-standalone-black-bar-dark-order-1-kvm](phone-chrome/iPhone-13-standalone-black-bar-dark-order-1-kvm.png)
- [iPhone-13-standalone-black-bar-dark-order-2-chat](phone-chrome/iPhone-13-standalone-black-bar-dark-order-2-chat.png)
- [iPhone-13-standalone-black-bar-dark-order-3-settings](phone-chrome/iPhone-13-standalone-black-bar-dark-order-3-settings.png)
- [iPhone-13-standalone-black-bar-dark-order-4-kvm](phone-chrome/iPhone-13-standalone-black-bar-dark-order-4-kvm.png)
- [iPhone-13-standalone-black-bar-dark-settings](phone-chrome/iPhone-13-standalone-black-bar-dark-settings.png)
- [iPhone-13-standalone-black-bar-dark-sheet](phone-chrome/iPhone-13-standalone-black-bar-dark-sheet.png)
- [iPhone-13-standalone-black-bar-light-about-display](phone-chrome/iPhone-13-standalone-black-bar-light-about-display.png)
- [iPhone-13-standalone-black-bar-light-chat](phone-chrome/iPhone-13-standalone-black-bar-light-chat.png)
- [iPhone-13-standalone-black-bar-light-kvm](phone-chrome/iPhone-13-standalone-black-bar-light-kvm.png)
- [iPhone-13-standalone-black-bar-light-order-1-kvm](phone-chrome/iPhone-13-standalone-black-bar-light-order-1-kvm.png)
- [iPhone-13-standalone-black-bar-light-order-2-chat](phone-chrome/iPhone-13-standalone-black-bar-light-order-2-chat.png)
- [iPhone-13-standalone-black-bar-light-order-3-settings](phone-chrome/iPhone-13-standalone-black-bar-light-order-3-settings.png)
- [iPhone-13-standalone-black-bar-light-order-4-kvm](phone-chrome/iPhone-13-standalone-black-bar-light-order-4-kvm.png)
- [iPhone-13-standalone-black-bar-light-settings](phone-chrome/iPhone-13-standalone-black-bar-light-settings.png)
- [iPhone-13-standalone-black-bar-light-sheet](phone-chrome/iPhone-13-standalone-black-bar-light-sheet.png)
- [iPhone-13-standalone-viewport-reports-62px-short-dark-about-display](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-dark-about-display.png)
- [iPhone-13-standalone-viewport-reports-62px-short-dark-chat](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-dark-chat.png)
- [iPhone-13-standalone-viewport-reports-62px-short-dark-kvm](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-dark-kvm.png)
- [iPhone-13-standalone-viewport-reports-62px-short-dark-order-1-kvm](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-dark-order-1-kvm.png)
- [iPhone-13-standalone-viewport-reports-62px-short-dark-order-2-chat](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-dark-order-2-chat.png)
- [iPhone-13-standalone-viewport-reports-62px-short-dark-order-3-settings](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-dark-order-3-settings.png)
- [iPhone-13-standalone-viewport-reports-62px-short-dark-order-4-kvm](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-dark-order-4-kvm.png)
- [iPhone-13-standalone-viewport-reports-62px-short-dark-settings](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-dark-settings.png)
- [iPhone-13-standalone-viewport-reports-62px-short-dark-sheet](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-dark-sheet.png)
- [iPhone-13-standalone-viewport-reports-62px-short-light-about-display](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-light-about-display.png)
- [iPhone-13-standalone-viewport-reports-62px-short-light-chat](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-light-chat.png)
- [iPhone-13-standalone-viewport-reports-62px-short-light-kvm](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-light-kvm.png)
- [iPhone-13-standalone-viewport-reports-62px-short-light-order-1-kvm](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-light-order-1-kvm.png)
- [iPhone-13-standalone-viewport-reports-62px-short-light-order-2-chat](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-light-order-2-chat.png)
- [iPhone-13-standalone-viewport-reports-62px-short-light-order-3-settings](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-light-order-3-settings.png)
- [iPhone-13-standalone-viewport-reports-62px-short-light-order-4-kvm](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-light-order-4-kvm.png)
- [iPhone-13-standalone-viewport-reports-62px-short-light-settings](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-light-settings.png)
- [iPhone-13-standalone-viewport-reports-62px-short-light-sheet](phone-chrome/iPhone-13-standalone-viewport-reports-62px-short-light-sheet.png)
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

<!-- chat-dock:start -->
## Chat composer on the phone: docked above the bar, greeting centred (PhoneChrome)

Run 2026-11-03. A real host with the chat server and the real omp binary, `tools/fake-kvmd`, `tools/fake-model` (`apps/web/e2e/chat-stack.mjs`); headless Chrome, the installed-app geometry of the other section (390x797 below a black bar, `navigator.standalone` true, the page reporting 62px short, `window.__keyboard(px)` for the soft keyboard). Script: `apps/web/e2e/chat-dock.e2e.mjs`.

**Cause.** On the phone the new-chat screen padded the bottom inset twice (the pane's own padding, `max(12px, --safe-bottom)`, and the composer's `pb-safe`), and the navigation bar below already owns that inset, so about 75 pt of dead space sat under the composer. A conversation's docked footer padded it once. The shell now tells the chat its docks inside the pane pad nothing for the inset (`--host-dock-safe-bottom: 0` on `.app-main`, read as `--dock-safe-bottom`), so both screens end 12px above the bar, and above the keyboard when it is up (it was 34px, the inset, there too). On a phone the new-chat screen is now a column: the greeting centred in the room above, the composer docked below. The wide layout is unchanged.

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| iPhone 13, installed app (390x797, viewport reports 62px short) | new chat: the composer is docked 12px above the navigation bar, and the page has no dead gap under it | composer (with its options) ends 694, the bar starts 706: 12px between; composer padding-bottom 0px | pass |
| iPhone 13, installed app (390x797, viewport reports 62px short) | new chat: the greeting is centred in the room between the header and the composer | greeting centre 337.9; room 64..611.8, centre 337.9 | pass |
| iPhone 13, installed app (390x797, viewport reports 62px short) | new chat: the composer is 12px in from each side and as wide as a conversation's column | composer 12..378 of 390 | pass |
| iPhone 13, installed app (390x797, viewport reports 62px short) | new chat, keyboard up: the composer sits 12px above the keyboard and the greeting stays above it | keyboard top 385, composer ends 373: 12px; bar hidden; greeting ends 194.4, composer starts 290.8 | pass |
| iPhone 13, installed app (390x797, viewport reports 62px short) | conversation: the composer's bottom is the new-chat screen's (within 1px), above the bar | conversation composer ends 694 (new chat 694); 12px above the bar | pass |
| iPhone 13, installed app (390x797, viewport reports 62px short) | conversation: the composer stays inside the screen with the thread's gutters (recorded against the new-chat screen's 12px) | conversation form 16..374 of 390; new chat 12..378 | pass |
| iPhone 13, installed app (390x797, viewport reports 62px short) | conversation, keyboard up: the composer sits 12px above the keyboard, as on the new-chat screen | composer ends 373: 12px above the keyboard (new chat 373) | pass |
| desktop 1280x800 | new chat: the composer is still the column's box, 12px above the bottom, the greeting above it (unchanged) | composer 768 wide, centred on the column; ends 788 of 800 (12px from the bottom); phone-only greeting wrapper absent: true | pass |
| all | no page error | clean | pass |

9 of 9 passed. Screenshots: `docs/e2e/chat-dock/`.
<!-- chat-dock:end -->
