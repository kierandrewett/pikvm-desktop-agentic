# Native feel on the phone (2026-11-03)

`apps/web/e2e/native-feel.e2e.mjs`: iPhone 13 emulation in headless Chrome, once as the installed app (`navigator.standalone`) and once as a browser tab with a Firefox-on-iOS user agent (FxiOS, never standalone), against the real web host with its chat server in front of the fake kvmd and fake model.
Chromium cannot parse `font: -apple-system-body`, so the Dynamic Type rows set `--dt` on `<body>` (17px default, 23px xxxLarge, 53px past the 28px cap) and judge layout; the system font and the real Dynamic Type sizes are Safari's and are NOT exercised here.

| Result | Profile | Check | Observed |
| --- | --- | --- | --- |
| PASS | app | no tap highlight on the tabs, buttons and rows | 12 controls, rgba(0, 0, 0, 0) |
| PASS | app | pressed: the :active style dims at once with no transition; a touch tap shows it, and it lets go | forced :active {"opacity":0.6,"duration":"0s"} (idle {"opacity":1,"duration":"0.15s, 0.15s"}); during a touch tap the control dimmed to 0.6 and was back at 1 |
| PASS | app | no root overscroll: html and body overscroll-behavior none, and the page does not scroll | {"html":"none","body":"none","y":0,"tall":false} |
| PASS | app | controls are touch-action: manipulation; the KVM picture keeps its own | {"tab":"manipulation","button":"manipulation","picture":"auto"} |
| PASS | app | the chrome is not selectable and has no callout; the nav tab, a button and a key are | {"tab":{"sel":"none","callout":""},"button":{"sel":"none","callout":""},"screen":{"sel":"none","callout":""}} |
| PASS | app | no :hover rule applies on a touch screen (every matching rule sits behind (hover: hover) and (pointer: fine)) | 0 loose, pointer-fine hover matches: false  |
| PASS | app | installed: data-standalone and data-ios are set | {"ios":"true","standalone":"true"} |
| PASS | app | every launch image link resolves 200 as a PNG of the size its media query names | 24 links, 0 wrong  |
| PASS | app | every text field in the KVM, Chat and each Settings page computes to >= 16px | 32 fields over 12 Settings pages, smallest 16px  |
| PASS | app | the chat composer: enterkeyhint=send, autocapitalize=sentences, autocorrect=on, spellcheck=true | {"hint":"send","cap":"sentences","corr":"on","spell":"true","px":16} |
| PASS | app | the worker puts a pushed count on the icon (stubbed setAppBadge), an open page clears it only on the KVM | worker [1]; page on Chat (keeps it) [1]; on KVM [1,"clear"]; cache after {"screen":0}; push while on KVM ["clear"] |
| PASS | app | a page with no Badging API (Firefox) runs the same flow without an error | setAppBadge is function; 0 console lines, none about the badge |
| PASS | app | Dynamic Type default 17px: nothing clipped or off screen in the nav bar, KVM toolbar and keys, Settings rows, Chat composer | nav bar: 6 boxes, 0 clipped, 0 off; KVM toolbar: 24 boxes, 0 clipped, 0 off; KVM keys: 18 boxes, 0 clipped, 0 off; keys: 16 keys; Settings rows: 73 boxes, 0 clipped, 0 off; Chat composer: 25 boxes, 0 clipped, 0 off; nav label 11px, text 17px |
| PASS | app | Dynamic Type xxxLarge 23px: nothing clipped or off screen in the nav bar, KVM toolbar and keys, Settings rows, Chat composer | nav bar: 6 boxes, 0 clipped, 0 off; KVM toolbar: 24 boxes, 0 clipped, 0 off; KVM keys: 18 boxes, 0 clipped, 0 off; keys: 16 keys; Settings rows: 73 boxes, 0 clipped, 0 off; Chat composer: 25 boxes, 0 clipped, 0 off; nav label 14px, text 23px |
| PASS | app | Dynamic Type AX5 53px, capped to 28px: nothing clipped or off screen in the nav bar, KVM toolbar and keys, Settings rows, Chat composer | nav bar: 6 boxes, 0 clipped, 0 off; KVM toolbar: 24 boxes, 0 clipped, 0 off; KVM keys: 18 boxes, 0 clipped, 0 off; keys: 16 keys; Settings rows: 73 boxes, 0 clipped, 0 off; Chat composer: 25 boxes, 0 clipped, 0 off; nav label 14px, text 28px |
| PASS | app | no console errors or page errors during the run | none |
| PASS | tab | no tap highlight on the tabs, buttons and rows | 12 controls, rgba(0, 0, 0, 0) |
| PASS | tab | pressed: the :active style dims at once with no transition; a touch tap shows it, and it lets go | forced :active {"opacity":0.6,"duration":"0s"} (idle {"opacity":1,"duration":"0.15s, 0.15s"}); during a touch tap the control dimmed to 0.6 and was back at 1 |
| PASS | tab | no root overscroll: html and body overscroll-behavior none, and the page does not scroll | {"html":"none","body":"none","y":0,"tall":false} |
| PASS | tab | controls are touch-action: manipulation; the KVM picture keeps its own | {"tab":"manipulation","button":"manipulation","picture":"auto"} |
| PASS | tab | the chrome is not selectable and has no callout; the nav tab, a button and a key are | {"tab":{"sel":"none","callout":""},"button":{"sel":"none","callout":""},"screen":{"sel":"none","callout":""}} |
| PASS | tab | no :hover rule applies on a touch screen (every matching rule sits behind (hover: hover) and (pointer: fine)) | 0 loose, pointer-fine hover matches: false  |
| PASS | tab | browser tab: data-ios is set and data-standalone is not | {"ios":"true"} |
| PASS | tab | every launch image link resolves 200 as a PNG of the size its media query names | 24 links, 0 wrong  |
| PASS | tab | every text field in the KVM, Chat and each Settings page computes to >= 16px | 33 fields over 12 Settings pages, smallest 16px  |
| PASS | tab | the chat composer: enterkeyhint=send, autocapitalize=sentences, autocorrect=on, spellcheck=true | {"hint":"send","cap":"sentences","corr":"on","spell":"true","px":16} |
| PASS | tab | the worker puts a pushed count on the icon (stubbed setAppBadge), an open page clears it only on the KVM | worker [1]; page on Chat (keeps it) [1]; on KVM [1,"clear"]; cache after {"screen":0}; push while on KVM ["clear"] |
| PASS | tab | a page with no Badging API (Firefox) runs the same flow without an error | setAppBadge is function; 0 console lines, none about the badge |
| PASS | tab | Dynamic Type default 17px: nothing clipped or off screen in the nav bar, KVM toolbar and keys, Settings rows, Chat composer | nav bar: 6 boxes, 0 clipped, 0 off; KVM toolbar: 24 boxes, 0 clipped, 0 off; KVM keys: 18 boxes, 0 clipped, 0 off; keys: 16 keys; Settings rows: 73 boxes, 0 clipped, 0 off; Chat composer: 25 boxes, 0 clipped, 0 off; nav label 11px, text 17px |
| PASS | tab | Dynamic Type xxxLarge 23px: nothing clipped or off screen in the nav bar, KVM toolbar and keys, Settings rows, Chat composer | nav bar: 6 boxes, 0 clipped, 0 off; KVM toolbar: 24 boxes, 0 clipped, 0 off; KVM keys: 18 boxes, 0 clipped, 0 off; keys: 16 keys; Settings rows: 73 boxes, 0 clipped, 0 off; Chat composer: 25 boxes, 0 clipped, 0 off; nav label 14px, text 23px |
| PASS | tab | Dynamic Type AX5 53px, capped to 28px: nothing clipped or off screen in the nav bar, KVM toolbar and keys, Settings rows, Chat composer | nav bar: 6 boxes, 0 clipped, 0 off; KVM toolbar: 24 boxes, 0 clipped, 0 off; KVM keys: 18 boxes, 0 clipped, 0 off; keys: 16 keys; Settings rows: 73 boxes, 0 clipped, 0 off; Chat composer: 25 boxes, 0 clipped, 0 off; nav label 14px, text 28px |
| PASS | tab | no console errors or page errors during the run | none |

All checks passed.
