# E2E run: keep-alive tabs (2026-11-02)

Host under test: `node dist/web-server.js` (http://127.0.0.1:8211) in front of `tools/fake-kvmd` (http://127.0.0.1:4611).

Browser: headless Chrome through puppeteer-core. Profiles: iPhone 13 (390x844, touch, coarse pointer) and desktop 1400x900. Script: `apps/web/e2e/keep-alive.e2e.mjs`; how to run it: `docs/e2e/README.md`.

The KVM, Chat and Settings stay mounted once visited and a tab change only hides and shows. Each case drives the page as a person would and asserts what the fake kvmd RECEIVED.

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| iPhone 13 | the KVM is up with one event socket and one stream | ws 1, fake clients 1, streams 1 | pass |
| iPhone 13 | the KVM mounts at app start even when the app opens on Settings | kvm shown false, settings shown true, fake clients 2 (this page + the first) | pass |
| iPhone 13 | keys typed on Settings and Chat never reach the target | the fake saw no key, no print | pass |
| iPhone 13 | Settings stays on the page that was open, with its scroll | /app/settings/display | pass |
| iPhone 13 | KVM -> Chat -> Settings -> KVM opens no socket and no stream | ws 2->2, stream requests 2->2, fake clients 2->2, fake streams 2->2 | pass |
| iPhone 13 | the picture is the same element, with the same source, and is live at once | same element true, same src true, has a frame true, Live straight away true | pass |
| iPhone 13 | the picture kept moving while hidden: a change made on the target while on Settings is there on return | frame on return 351697 differs from the bars frame 344153 | pass |
| iPhone 13 | a key held on the KVM is let go on the target when the tab changes | held ShiftLeft, after leaving nothing | pass |
| iPhone 13 | the keyboard is the target's again on return | key F5 down, key F5 up | pass |
| iPhone 13 | the screen wake lock is let go behind another tab and taken again on return | held 1 -> 0 -> 1 (taken 5 -> 6) | pass |
| iPhone 13 | back and forward move between the tabs without reloading the KVM | after back: kvm; same picture element true | pass |
| iPhone 13 | hidden panes are inert and out of the accessibility tree | kvm:inert:true chat:inert:true settings:live:- | pass |
| iPhone 13 | no page errors | clean | pass |
| Desktop 1400x900 | the KVM is up with one event socket and one stream | ws 1, fake clients 1, streams 1 | pass |
| Desktop 1400x900 | the KVM mounts at app start even when the app opens on Settings | kvm shown false, settings shown true, fake clients 2 (this page + the first) | pass |
| Desktop 1400x900 | keys typed on Settings and Chat never reach the target | the fake saw no key, no print | pass |
| Desktop 1400x900 | Settings stays on the page that was open, with its scroll | /app/settings/display | pass |
| Desktop 1400x900 | KVM -> Chat -> Settings -> KVM opens no socket and no stream | ws 2->2, stream requests 2->2, fake clients 2->2, fake streams 2->2 | pass |
| Desktop 1400x900 | the picture is the same element, with the same source, and is live at once | same element true, same src true, has a frame true, Live straight away true | pass |
| Desktop 1400x900 | the picture kept moving while hidden: a change made on the target while on Settings is there on return | frame on return 351697 differs from the bars frame 344153 | pass |
| Desktop 1400x900 | a key held on the KVM is let go on the target when the tab changes | held ShiftLeft, after leaving nothing | pass |
| Desktop 1400x900 | the keyboard is the target's again on return | key F5 down, key F5 up | pass |
| Desktop 1400x900 | the screen wake lock is let go behind another tab and taken again on return | held 1 -> 0 -> 1 (taken 5 -> 6) | pass |
| Desktop 1400x900 | back and forward move between the tabs without reloading the KVM | after back: kvm; same picture element true | pass |
| Desktop 1400x900 | hidden panes are inert and out of the accessibility tree | kvm:inert:true chat:inert:true settings:live:- | pass |
| Desktop 1400x900 | no page errors | clean | pass |

26 of 26 passed.

## Screenshots

- [desktop-chat](keep-alive/desktop-chat.png)
- [desktop-kvm](keep-alive/desktop-kvm.png)
- [desktop-settings](keep-alive/desktop-settings.png)
- [phone-chat](keep-alive/phone-chat.png)
- [phone-kvm](keep-alive/phone-kvm.png)
- [phone-settings](keep-alive/phone-settings.png)
