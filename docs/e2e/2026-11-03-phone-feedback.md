# E2E: phone feedback (2026-11-03)

One section per change.

<!-- phone-chrome:start -->
## Status bar and home-indicator strip (PhoneChrome)

Run 2026-11-03. Host under test: `node dist/web-server.js` (http://127.0.0.1:8161) in front of `tools/fake-kvmd` (http://127.0.0.1:4561). Headless Chrome through puppeteer-core; the iPhone 13 profile (touch, 390x844 portrait and 844x390 landscape) with the safe-area insets emulated by CDP `Emulation.setSafeAreaInsetsOverride` (portrait top 47 / bottom 34; landscape top 0 / bottom 21 / left and right 47). Colours are read back from the screenshots' pixels. The two `standalone` profiles are the installed app as iOS draws it with the `black` status-bar style: the page starts below the bar, so the viewport is 390x797 with no top inset and 34 at the bottom, and `navigator.standalone` is true before any script runs. In the second one the page also reports 62px less than the screen from `innerHeight` and the visual viewport (injected before any script; `100vh` stays the screen), and `window.__keyboard(px)` takes more away as the soft keyboard does. The `update` cases drive coming back to the app after a deploy (the host's `/app/version.json` answered with another build) and check Settings > About against it. Script: `apps/web/e2e/phone-chrome.e2e.mjs`; how to run it: `docs/e2e/README.md`.

**What the earlier versions got wrong.** (1) The status bar: on a real iPhone (iOS 26) the top showed a grey-to-black gradient. That is the system's own scrim over a `black-translucent` page, which no CSS removes, so the style is now `black` (a solid bar, the page below it, no top inset; iOS keeps the style from when the app was added, so the app had to be added again). (2) The gap under the navigation bar was first put down to the web view being short and the system background showing outside it. That was wrong: nothing is outside the web view. In the installed app (no URL bar) `100vh` is the whole screen, while `100dvh`, `100svh`, `innerHeight` and the visual viewport report the screen minus an inset when the app starts, and the shell was sized from those, so it stopped short. The shell became `100vh` in the installed app, and the visual viewport's height is used only while the soft keyboard is up (its baseline is a `100vh` probe). That was not enough on the device (the navigation bar came out cut in half at 811 of 874 pt, the page's own background below the cut): on iOS 26 a `position: fixed` html, body or app container is clipped to the layout viewport, which the installed app reports short, so a 100vh fixed shell is cut off at that height (docs: cjnova/piclaw-monaco PWA.md 8.6 and 8.9). In the installed app with the keyboard closed, html, body and the shell are therefore normal flow and each `--app-height` tall, with no ancestor that clips or is shorter (the `shell fills the screen exactly` case reads the position of html, body and the shell and lists any clipping ancestor shorter than the shell); while the keyboard is up they are fixed to the visual viewport as before (`data-keyboard` on html says which). Headless Chrome does not clip fixed elements that way, so what the e2e can prove is the structure and the geometry, and the `viewport reports 62px short` profile still reproduces the earlier report (shell 0,0,390,735 of 390x797). (3) The blur at the top after visiting Chat or Settings: the resolution pill (`.kvm-res-toast`, top 10px) was a `backdrop-filter` and was still showing; it no longer blurs. With the `black` style the page starts below the bar and the system paints the bar area itself, from what it finds at the top edge of the page, so the top edge is one opaque black `#status-edge` element (12px deep in the installed iOS app, now also recognised by the device when `navigator.standalone` is not true) that the shell is padded by. The `KVM > Chat > Settings > KVM` case scans the top 60px after each step. What the system draws over the page on a real device cannot be reproduced headless: Settings > About > Display lists what the phone reports (flags, insets, every viewport unit, the boxes and positions of html, body, #root, the shell, the bar and #status-edge, and any clipping ancestor) and copies it as text.

**The status area, as read from the phone (iOS 27.2, through the inspector) and decided.** Nothing of ours blurred anything at the top on any tab, and `#status-edge` was opaque black, 62 px, on top of everything on every tab; the grey frosted bar on Chat and Settings is iOS's own glass, tinted from the page (body was `rgb(238, 240, 244)` there and transparent over a black html on the KVM, which is why only the KVM bar was black). So the black edge in point (3) above is superseded: the status area now follows the page, one colour from the active tab and the theme (`app/status-colour.ts`): black over the KVM; the page's own colour on Chat and Settings (`#eef0f4` light, `#0a0a0c` dark). The top edge, html, body and the `theme-color` meta all take it (the `--status-colour` property), the shell updates it on a tab change and on a theme change, and `index.html` works it out before first paint for the route it opens on, so the system samples one solid colour and picks its own text colour for it. Every remaining `backdrop-filter` and blur in the app and the chat is gone (the resolution pill, the dialog scrim, the stream-state card, menus and toolbars, the lightbox, table headers, the composer's progressive-blur scrim, tailed surfaces, ui.blur's glass), and the chat's page card has no resting shadow (it was a soft shadow over the top edge); the `no backdrop-filter or blur anywhere` case scans every element and its pseudo-elements on every tab and with the sheets open, and the `KVM > Chat > Settings > KVM` case also flags a wide soft shadow near the top.

**The source-level finding (so nobody chases it again).** The blur is UIKit's soft scroll edge effect (the top scroll pocket) of the WKWebView's scroll view, about the status bar and 40 pt below it. WebKit hides it only when a top colour extension view exists, which needs `_obscuredInsets.top > 0` and a fixed or sticky opaque full-width box over 10 px deep at the top edge; in the installed app with the `black` style the top obscured inset is 0, and live tests with `#status-edge` at 62 px, at 80 px and with `pointer-events: auto` stayed blurred. No page change removes it; what the page controls is what lies under it, so the headers there are opaque in the status colour. Details and the WebKit source references: `docs/rebuild/ios-top-edge.md`. This does not apply in a normal browser tab (Safari or Firefox on iOS), which has no top inset and draws its own bars.

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| static | meta served at /app/ | {"theme-color":"#000000","apple-mobile-web-app-capable":"yes","apple-mobile-web-app-status-bar-style":"black","mobile-web-app-capable":"yes"}; viewport "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content" | pass |
| static | manifest | /app/manifest.webmanifest: theme_color #000000, background_color #0a0a0c, display standalone | pass |
| static | offline page | theme-color #000000 and the inset strip are in /app/sw.js | pass |
| static | the page, sw.js and version.json are revalidated, hashed assets are immutable, the worker never caches a page | {"/app/":"no-cache","/app/sw.js":"no-cache","/app/version.json":"no-cache","/app/manifest.webmanifest":"no-cache"}; /app/assets/index-BpWwUKid.js public, max-age=31536000, immutable; worker navigations go to the network, skipWaiting and clients.claim present: true | pass |
| update | Settings > About shows the build the host serves in /app/version.json | About lists "App build" and "wt.20261103-171951": true | pass |
| update | coming back to the same build does not reload | page kept its state: true | pass |
| update | coming back after a deploy reloads once, and never twice for the same build | reloaded for "next.20991231-235959", and the second return kept the page (state 2) | pass |
| iPhone 13 portrait, light | kvm: the top edge is 47px of #000000 (the page's colour at the top) and the shell is padded by it | status-edge 47px x 390 (fixed) rgb(0, 0, 0), shell padding-top 47px; 9 pixels over it all #000000; first pixel below it #000000 (page bg #000000); html rgb(0, 0, 0), body rgba(0, 0, 0, 0), theme-color #000000 | pass |
| iPhone 13 portrait, light | kvm: the shell fills the screen exactly (bottom 844) | shell 0,0,390,844 of 390x844; the page reports innerHeight 844; --app-height written by the shell: "844px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 portrait, light | kvm: home-indicator strip is the navigation bar's #ffffff | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 portrait, light | chat: the top edge is 47px of #eef0f4 (the page's colour at the top) and the shell is padded by it | status-edge 47px x 390 (fixed) rgb(238, 240, 244), shell padding-top 47px; 9 pixels over it all #eef0f4; first pixel below it #eef0f4 (page bg #eef0f4); html rgb(238, 240, 244), body rgb(238, 240, 244), theme-color #eef0f4 | pass |
| iPhone 13 portrait, light | chat: the shell fills the screen exactly (bottom 844) | shell 0,0,390,844 of 390x844; the page reports innerHeight 844; --app-height written by the shell: "844px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 portrait, light | chat: home-indicator strip is the navigation bar's #ffffff | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 portrait, light | settings: the top edge is 47px of #eef0f4 (the page's colour at the top) and the shell is padded by it | status-edge 47px x 390 (fixed) rgb(238, 240, 244), shell padding-top 47px; 9 pixels over it all #eef0f4; first pixel below it #e7e9ed (page bg #eef0f4); html rgb(238, 240, 244), body rgb(238, 240, 244), theme-color #eef0f4 | pass |
| iPhone 13 portrait, light | settings: the shell fills the screen exactly (bottom 844) | shell 0,0,390,844 of 390x844; the page reports innerHeight 844; --app-height written by the shell: "844px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 portrait, light | settings: home-indicator strip is the navigation bar's #ffffff | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 portrait, light | KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black | 1. kvm: nothing, edge 47px #000000 \| 2. chat: nothing, edge 47px #eef0f4 \| 3. settings: nothing, edge 47px #eef0f4 \| 4. kvm: nothing, edge 47px #000000 | pass |
| iPhone 13 portrait, light | the header under the top edge is opaque in the page's colour on every tab | kvm: img.kvm-img rgb(0, 0, 0) alpha 1 (want #000000) \| chat: header.flex h-[var(--header-height) rgb(238, 240, 244) alpha 1 (want #eef0f4) \| settings: div.chat-scope relative isolate  rgb(238, 240, 244) alpha 1 (want #eef0f4) | pass |
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
| iPhone 13 landscape, light | the header under the top edge is opaque in the page's colour on every tab | kvm: img.kvm-img rgb(0, 0, 0) alpha 1 (want #000000) \| chat: header.flex h-[var(--header-height) rgb(238, 240, 244) alpha 1 (want #eef0f4) \| settings: div.chat-scope relative isolate  rgb(238, 240, 244) alpha 1 (want #eef0f4) | pass |
| iPhone 13 landscape, light | no backdrop-filter or blur anywhere, on every tab and with the sheets open | kvm: none \| chat: none \| settings: none \| KVM More sheet: none \| KVM full-page dialog: none | pass |
| iPhone 13 landscape, light | Settings: switching the theme in Display repaints the status area to the other theme's page colour at once, with no navigation | light -> dark: theme-color #eef0f4 -> #0a0a0c, status edge rgb(238, 240, 244) -> rgb(10, 10, 12), html rgb(238, 240, 244) -> rgb(10, 10, 12) | pass |
| iPhone 13 landscape, light | no console errors | none | pass |
| iPhone 13 portrait, dark | kvm: the top edge is 47px of #000000 (the page's colour at the top) and the shell is padded by it | status-edge 47px x 390 (fixed) rgb(0, 0, 0), shell padding-top 47px; 9 pixels over it all #000000; first pixel below it #000000 (page bg #000000); html rgb(0, 0, 0), body rgba(0, 0, 0, 0), theme-color #000000 | pass |
| iPhone 13 portrait, dark | kvm: the shell fills the screen exactly (bottom 844) | shell 0,0,390,844 of 390x844; the page reports innerHeight 844; --app-height written by the shell: "844px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 portrait, dark | kvm: home-indicator strip is the navigation bar's #121216 | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 portrait, dark | chat: the top edge is 47px of #0a0a0c (the page's colour at the top) and the shell is padded by it | status-edge 47px x 390 (fixed) rgb(10, 10, 12), shell padding-top 47px; 9 pixels over it all #0a0a0c; first pixel below it #0a0a0c (page bg #0a0a0c); html rgb(10, 10, 12), body rgb(10, 10, 12), theme-color #0a0a0c | pass |
| iPhone 13 portrait, dark | chat: the shell fills the screen exactly (bottom 844) | shell 0,0,390,844 of 390x844; the page reports innerHeight 844; --app-height written by the shell: "844px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 portrait, dark | chat: home-indicator strip is the navigation bar's #121216 | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 portrait, dark | settings: the top edge is 47px of #0a0a0c (the page's colour at the top) and the shell is padded by it | status-edge 47px x 390 (fixed) rgb(10, 10, 12), shell padding-top 47px; 9 pixels over it all #0a0a0c; first pixel below it #09090a (page bg #0a0a0c); html rgb(10, 10, 12), body rgb(10, 10, 12), theme-color #0a0a0c | pass |
| iPhone 13 portrait, dark | settings: the shell fills the screen exactly (bottom 844) | shell 0,0,390,844 of 390x844; the page reports innerHeight 844; --app-height written by the shell: "844px"; position html fixed / body fixed / shell fixed; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 portrait, dark | settings: home-indicator strip is the navigation bar's #121216 | nav 0,753,390,844 of 390x844, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 portrait, dark | KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black | 1. kvm: nothing, edge 47px #000000 \| 2. chat: nothing, edge 47px #0a0a0c \| 3. settings: nothing, edge 47px #0a0a0c \| 4. kvm: nothing, edge 47px #000000 | pass |
| iPhone 13 portrait, dark | the header under the top edge is opaque in the page's colour on every tab | kvm: img.kvm-img rgb(0, 0, 0) alpha 1 (want #000000) \| chat: header.flex h-[var(--header-height) rgb(10, 10, 12) alpha 1 (want #0a0a0c) \| settings: div.chat-scope relative isolate  rgb(10, 10, 12) alpha 1 (want #0a0a0c) | pass |
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
| iPhone 13 landscape, dark | the header under the top edge is opaque in the page's colour on every tab | kvm: img.kvm-img rgb(0, 0, 0) alpha 1 (want #000000) \| chat: header.flex h-[var(--header-height) rgb(10, 10, 12) alpha 1 (want #0a0a0c) \| settings: div.chat-scope relative isolate  rgb(10, 10, 12) alpha 1 (want #0a0a0c) | pass |
| iPhone 13 landscape, dark | no backdrop-filter or blur anywhere, on every tab and with the sheets open | kvm: none \| chat: none \| settings: none \| KVM More sheet: none \| KVM full-page dialog: none | pass |
| iPhone 13 landscape, dark | Settings: switching the theme in Display repaints the status area to the other theme's page colour at once, with no navigation | dark -> light: theme-color #0a0a0c -> #eef0f4, status edge rgb(10, 10, 12) -> rgb(238, 240, 244), html rgb(10, 10, 12) -> rgb(238, 240, 244) | pass |
| iPhone 13 landscape, dark | no console errors | none | pass |
| iPhone 13 standalone, black bar, light | kvm: the top edge is 12px of #000000 (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(0, 0, 0), shell padding-top 12px; 9 pixels over it all #000000; first pixel below it #000000 (page bg #000000); html rgb(0, 0, 0), body rgba(0, 0, 0, 0), theme-color #000000 | pass |
| iPhone 13 standalone, black bar, light | kvm: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 797; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, black bar, light | kvm: home-indicator strip is the navigation bar's #ffffff | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 standalone, black bar, light | chat: the top edge is 12px of #eef0f4 (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(238, 240, 244), shell padding-top 12px; 9 pixels over it all #eef0f4; first pixel below it #eef0f4 (page bg #eef0f4); html rgb(238, 240, 244), body rgb(238, 240, 244), theme-color #eef0f4 | pass |
| iPhone 13 standalone, black bar, light | chat: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 797; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, black bar, light | chat: home-indicator strip is the navigation bar's #ffffff | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 standalone, black bar, light | settings: the top edge is 12px of #eef0f4 (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(238, 240, 244), shell padding-top 12px; 9 pixels over it all #eef0f4; first pixel below it #e7e9ed (page bg #eef0f4); html rgb(238, 240, 244), body rgb(238, 240, 244), theme-color #eef0f4 | pass |
| iPhone 13 standalone, black bar, light | settings: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 797; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, black bar, light | settings: home-indicator strip is the navigation bar's #ffffff | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 standalone, black bar, light | KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black | 1. kvm: nothing, edge 12px #000000 \| 2. chat: nothing, edge 12px #eef0f4 \| 3. settings: nothing, edge 12px #eef0f4 \| 4. kvm: nothing, edge 12px #000000 | pass |
| iPhone 13 standalone, black bar, light | the header under the top edge is opaque in the page's colour on every tab | kvm: img.kvm-img rgb(0, 0, 0) alpha 1 (want #000000) \| chat: header.flex h-[var(--header-height) rgb(238, 240, 244) alpha 1 (want #eef0f4) \| settings: div.chat-scope relative isolate  rgb(238, 240, 244) alpha 1 (want #eef0f4) | pass |
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
| iPhone 13 standalone, viewport reports 62px short, light | settings: the top edge is 12px of #eef0f4 (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(238, 240, 244), shell padding-top 12px; 9 pixels over it all #eef0f4; first pixel below it #e7e9ed (page bg #eef0f4); html rgb(238, 240, 244), body rgb(238, 240, 244), theme-color #eef0f4 | pass |
| iPhone 13 standalone, viewport reports 62px short, light | settings: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 735; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, viewport reports 62px short, light | settings: home-indicator strip is the navigation bar's #ffffff | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #ffffff, bar edge pixels #ffffff, element at the bottom edge: nav | pass |
| iPhone 13 standalone, viewport reports 62px short, light | KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black | 1. kvm: nothing, edge 12px #000000 \| 2. chat: nothing, edge 12px #eef0f4 \| 3. settings: nothing, edge 12px #eef0f4 \| 4. kvm: nothing, edge 12px #000000 | pass |
| iPhone 13 standalone, viewport reports 62px short, light | the header under the top edge is opaque in the page's colour on every tab | kvm: img.kvm-img rgb(0, 0, 0) alpha 1 (want #000000) \| chat: header.flex h-[var(--header-height) rgb(238, 240, 244) alpha 1 (want #eef0f4) \| settings: div.chat-scope relative isolate  rgb(238, 240, 244) alpha 1 (want #eef0f4) | pass |
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
| iPhone 13 standalone, black bar, dark | settings: the top edge is 12px of #0a0a0c (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(10, 10, 12), shell padding-top 12px; 9 pixels over it all #0a0a0c; first pixel below it #09090a (page bg #0a0a0c); html rgb(10, 10, 12), body rgb(10, 10, 12), theme-color #0a0a0c | pass |
| iPhone 13 standalone, black bar, dark | settings: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 797; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, black bar, dark | settings: home-indicator strip is the navigation bar's #121216 | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 standalone, black bar, dark | KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black | 1. kvm: nothing, edge 12px #000000 \| 2. chat: nothing, edge 12px #0a0a0c \| 3. settings: nothing, edge 12px #0a0a0c \| 4. kvm: nothing, edge 12px #000000 | pass |
| iPhone 13 standalone, black bar, dark | the header under the top edge is opaque in the page's colour on every tab | kvm: img.kvm-img rgb(0, 0, 0) alpha 1 (want #000000) \| chat: header.flex h-[var(--header-height) rgb(10, 10, 12) alpha 1 (want #0a0a0c) \| settings: div.chat-scope relative isolate  rgb(10, 10, 12) alpha 1 (want #0a0a0c) | pass |
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
| iPhone 13 standalone, viewport reports 62px short, dark | settings: the top edge is 12px of #0a0a0c (the page's colour at the top) and the shell is padded by it | status-edge 12px x 390 (fixed) rgb(10, 10, 12), shell padding-top 12px; 9 pixels over it all #0a0a0c; first pixel below it #09090a (page bg #0a0a0c); html rgb(10, 10, 12), body rgb(10, 10, 12), theme-color #0a0a0c | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | settings: the shell fills the screen exactly (bottom 797) | shell 0,0,390,797 of 390x797; the page reports innerHeight 735; --app-height written by the shell: ""; position html static / body relative / shell relative; clipping ancestors shorter than the shell: none | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | settings: home-indicator strip is the navigation bar's #121216 | nav 0,706,390,797 of 390x797, padding-bottom 38px, shell padding-bottom 0px; inset pixels #121216, bar edge pixels #121216, element at the bottom edge: nav | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | KVM > Chat > Settings > KVM: nothing blurred, masked, gradient or translucent in the top 60px, the edge stays black | 1. kvm: nothing, edge 12px #000000 \| 2. chat: nothing, edge 12px #0a0a0c \| 3. settings: nothing, edge 12px #0a0a0c \| 4. kvm: nothing, edge 12px #000000 | pass |
| iPhone 13 standalone, viewport reports 62px short, dark | the header under the top edge is opaque in the page's colour on every tab | kvm: img.kvm-img rgb(0, 0, 0) alpha 1 (want #000000) \| chat: header.flex h-[var(--header-height) rgb(10, 10, 12) alpha 1 (want #0a0a0c) \| settings: div.chat-scope relative isolate  rgb(10, 10, 12) alpha 1 (want #0a0a0c) | pass |
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

137 of 137 passed.

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
## The cursor lens, made basic

Kieran, on the real iPhone: "make the zoom cursor thing just more basic, it's doing too much at the moment and it's confusing".

What it is now (`packages/kvm-engine/src/view/lens.ts`, every number in its tuning block; failure modes L1-L10 in `view/FAILURE_MODES.md`):

- One fixed size (96 px) and one fixed zoom (3x total, the picture's own zoom counted), a short CSS fade in and out, nothing inside it but the magnified picture and the cursor point.
- On while ONE finger is down on the trackpad and moving slowly; off when the finger speeds up, lifts, or a second finger comes down. Speed decides only that: show under 300 px/s, hide over 420 px/s, in between it keeps what it had. No continuous speed-to-zoom curve, no grow animation, no linger after the lift.
- Fixed place: 24 px above the cursor (its bottom edge), following it sideways, held inside the pane. Below the cursor only where it would not fit above (in a pane too short for either side, on whichever has more room), and back above only with 40 px to spare, so it never hops.
- Desktop mouse: unchanged; the lens has never applied there.

Script: `apps/web/e2e/lens.e2e.mjs`; iPhone 13 (portrait, then landscape for the top edge) with raw CDP touch events, then the desktop mouse. The page records the lens box and the cursor centre on every animation frame and every pointermove on its own clock; the finger speed below is read off those pointermoves (trailing 120 ms).

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| iPhone 13 | slow finger: the lens is there at once, no hold: within a frame or two of the finger leaving its touch point by 4 px, and not before | finger past 4 px at +166.1 ms of the touch; lens first on 54.5 ms later; on before that: 0 frames | pass |
| iPhone 13 | slow finger: the lens stays on for the whole slow stretch | 51 frames at 40-40 px/s, on in 51 | pass |
| iPhone 13 | speeding up: it goes off once, between the show and the hide speed, and stays off | went off at 448 px/s of finger speed (show under 300, hide over 420); on/off changes 1; off for the rest of the fast stretch: true | pass |
| iPhone 13 | fast finger: never on, from its first fast frame | 22 frames at up to 562 px/s: on in 0 | pass |
| iPhone 13 | slowing down: back on once, under the show speed, and stays on | back on at 283 px/s; on/off changes 1; on from there to the lift: true | pass |
| iPhone 13 | one fixed size: 96 x 96 on every frame it is on, however fast the finger | 190 frames on, sizes 96x96 | pass |
| iPhone 13 | one fixed place: centred on the cursor sideways and 72 px above it on every frame, and it never jumps | 190 frames: x offset from the (pane-held) cursor 0.0..0.0, y offset -72.0..-72.0 (expected 0 and -72); worst deviation 0.00 px | pass |
| iPhone 13 | the lift hides it on the next frame: no linger | off 34.9 ms after the pointerup; off for the 467 ms after that | pass |
| iPhone 13 | hysteresis: held at 360 px/s (between show and hide) after a slow stretch it stays on, after a fast one it stays off | after slow, 28 frames at 359-361 px/s: on in 28; after fast, 28 frames at 358-362 px/s: on in 0 | pass |
| iPhone 13 | screenshots: finger held slow shows it, fast does not | slow on=true; fast on=false (lens-1-slow.png, lens-2-fast.png) | pass |
| iPhone 13 | a tap and a resting finger with a few px of jitter never show it | 111 frames over a 1.5 s rest with 1.5 px jitter: on in 0 | pass |
| iPhone 13 | two fingers (a pinch) take it away | one finger on=true; second finger down on=false | pass |
| iPhone 13 | no page errors | clean | pass |
| iPhone 13 landscape | at the top edge of a short pane (landscape): it goes below the cursor where there is no room above, and does not hop | pane 197 px high; 415 frames on; cursor reached 0 px below the pane top; side changes 2 (at most above to below to above); every above frame 72 px up (inside the pane wherever the cursor is 120 px or more down): true; every below frame 72 px down: true | pass |
| Desktop 1400x900 | desktop mouse: no lens, slow or fast (the lens is a trackpad aid) | 113 frames over a slow then a fast mouse sweep: lens on in 0 | pass |

One gesture, one finger: slow (40 px/s) -> speeding up to 560 px/s -> fast (560) -> slowing down to 40 -> slow again, then lift. Sampled every 150 ms:

| t (s) | leg | finger px/s | lens | lens centre vs cursor (x, y) |
| --- | --- | --- | --- | --- |
| 0.00 |  | 0 | off | - |
| 0.15 | slow | 40 | off | - |
| 0.30 | slow | 40 | on | 0, -72 |
| 0.45 | slow | 40 | on | 0, -72 |
| 0.60 | slow | 40 | on | 0, -72 |
| 0.75 | slow | 40 | on | -2, -72 |
| 0.90 | slow | 40 | on | -7, -72 |
| 1.05 | slow | 40 | on | -13, -72 |
| 1.20 | speeding up | 38 | on | -17, -72 |
| 1.35 | speeding up | 109 | on | -17, -72 |
| 1.50 | speeding up | 188 | on | -17, -72 |
| 1.65 | speeding up | 265 | on | -17, -72 |
| 1.80 | speeding up | 344 | on | -17, -72 |
| 1.95 | speeding up | 426 | on | -17, -72 |
| 2.10 | speeding up | 499 | off | - |
| 2.25 | fast | 457 | off | - |
| 2.40 | fast | 561 | off | - |
| 2.55 | fast | 561 | off | - |
| 2.70 | slowing down | 450 | off | - |
| 2.85 | slowing down | 482 | off | - |
| 3.00 | slowing down | 400 | off | - |
| 3.15 | slowing down | 323 | off | - |
| 3.30 | slowing down | 243 | on | -48, -72 |
| 3.45 | slowing down | 169 | on | -48, -72 |
| 3.60 | slowing down | 91 | on | -48, -72 |
| 3.75 | slow again | 34 | on | -46, -72 |
| 3.90 | slow again | 40 | on | -40, -72 |
| 4.05 | slow again | 40 | on | -35, -72 |
| 4.20 | slow again | 40 | on | -30, -72 |
| 4.35 | slow again | 40 | on | -25, -72 |
| 4.50 | slow again | 40 | on | -19, -72 |
| 4.65 | lifted | 40 | off | - |
| 4.80 | lifted | 0 | off | - |

Screenshots: [finger slow](phone-feedback/lens-1-slow.png), [finger fast](phone-feedback/lens-2-fast.png), [landscape, cursor at the top edge, lens below it](phone-feedback/lens-3-top-edge.png).
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
