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
