# E2E run: Chat inside the PiKVM app (2026-11-03)

Stack under test (`apps/web/e2e/chat-stack.mjs`, one per profile): the web host (`node dist/web-server.js`) with the chat server in it and the real `omp` binary behind that, in front of `tools/fake-kvmd`; `tools/fake-model` is the provider the test adds in Settings. Nothing is mocked between the browser and the agent, and no real PiKVM is touched.

Browser: headless Chrome through puppeteer-core. Profiles: iPhone 13 (390x844, touch) and desktop 1400x900, each in light and dark (`prefers-color-scheme`). Script: `apps/web/e2e/chat.e2e.mjs`; how to run it: `docs/e2e/README.md`.

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| iPhone 13 | Settings -> Providers: add a custom endpoint that points at the fake model | fake-phone saved; its models listed: fake-phone on, fake-2 on, fake-1 on | pass |
| iPhone 13 | Settings pages carry one title each (Providers, Models, Agent) | providers: Providers; models: Models; agent: Agent | pass |
| iPhone 13 | Chat: the agent looks at the screen and clicks, and the fake kvmd records the click | the fake kvmd received button left down, button left up; screenshots taken 1 | pass |
| iPhone 13 | a risky action waits for approval; Deny delivers nothing | keys while waiting 0; after Deny 0; from the KVM tab the Chat tab was marked (data-attention=true) and the banner said "Needs your approval" | pass |
| iPhone 13 | a risky action waits for approval; Allow delivers it | keys while waiting 0; after Allow key AltLeft down, key F4 down, key F4 up, key AltLeft up | pass |
| iPhone 13 | a person's tap on the KVM takes control back, and Hand back gives it again | the banner chip is 274x44px on a 390px screen (one line of text); the person's tap reached the fake kvmd as button left down, button left up; banner "You have control" (reason operator); after Hand back: "Agent is working" | pass |
| iPhone 13 | Stop on the KVM tab banner ends the agent's control and cancels its response | banner "Agent is working" -> gone; activity state idle; Chat still responding: false | pass |
| iPhone 13 | Chat, KVM and Settings stay mounted: the same elements and no new socket or stream | panes shown in turn: kvm, settings, chat, kvm, chat, settings, chat; same composer true, picture true, settings true; draft kept "a draft that must survive"; the focused composer has no app focus ring (box-shadow none); new sockets 0, new streams 0 | pass |
| iPhone 13 | a streaming reply survives switching to KVM and Settings and back | the whole reply is in the thread after the switches | pass |
| iPhone 13 | the chat socket refuses a foreign Origin and accepts the app's own | Origin http://evil.example: refused 403; the app's own Origin: open | pass |
| iPhone 13 | computed styles in the KVM and Settings panes, and the app's root variables, are the same before and after Chat has loaded | (the probe sees a planted :root font rule: true) Opening Chat loaded its stylesheets (1 -> 3; the .chat-scope rules are there from the start before and there after); compared 17 root variables, body, a KVM button, the Settings heading and link, and the nav tab in KVM and Settings, light and dark: identical; app font "Geist Variable"; data-theme light/dark, --background #eef0f4 / #0a0a0c: light and dark differ | pass |
| iPhone 13 | phone: with the soft keyboard up the composer stays in view and the bottom bar steps aside | viewport 844px -> 508px; composer 414-456; chat pane ends at 508; bottom bar before {"top":0,"height":787,"visible":true}, after {"top":0,"height":508,"visible":true} | pass |
| iPhone 13 | secrets: the provider key and the PiKVM password are in no response, page, storage, frame, agent process or agent file | 171 responses, 295 frames, 220 requests, page, storage, cookies, caches and 8 files of process 2711379/2711743/2712798/2713634 checked: none found; the key left the browser in: POST /app/chat/api/providers/test, PUT /app/chat/api/settings/agent.providers; a plaintext copy of the key is on disk in no file (the settings store seals it); of the password in no file; the model received the stored key upstream (1 distinct credential) | pass |
| iPhone 13 | no page error, and no failed request except the login-proxy probe | clean | pass |
| Desktop 1400x900 | Settings -> Providers: add a custom endpoint that points at the fake model | fake-desktop saved; its models listed: fake-desktop on, fake-2 on, fake-1 on | pass |
| Desktop 1400x900 | Settings pages carry one title each (Providers, Models, Agent) | providers: Settings / Providers; models: Settings / Models; agent: Settings / Agent | pass |
| Desktop 1400x900 | Chat: the agent looks at the screen and clicks, and the fake kvmd records the click | the fake kvmd received button left down, button left up; screenshots taken 1 | pass |
| Desktop 1400x900 | a risky action waits for approval; Deny delivers nothing | keys while waiting 0; after Deny 0; from the KVM tab the Chat tab was marked (data-attention=true) and the banner said "Needs your approval" | pass |
| Desktop 1400x900 | a risky action waits for approval; Allow delivers it | keys while waiting 0; after Allow key AltLeft down, key F4 down, key F4 up, key AltLeft up | pass |
| Desktop 1400x900 | a person's tap on the KVM takes control back, and Hand back gives it again | the banner chip is 274x44px on a 1400px screen (one line of text); the person's tap reached the fake kvmd as button left down, button left up; banner "You have control" (reason operator); after Hand back: "Agent is working" | pass |
| Desktop 1400x900 | Stop on the KVM tab banner ends the agent's control and cancels its response | banner "Agent is working" -> gone; activity state idle; Chat still responding: false | pass |
| Desktop 1400x900 | Chat, KVM and Settings stay mounted: the same elements and no new socket or stream | panes shown in turn: kvm, settings, chat, kvm, chat, settings, chat; same composer true, picture true, settings true; draft kept "a draft that must survive"; the focused composer has no app focus ring (box-shadow none); new sockets 0, new streams 0 | pass |
| Desktop 1400x900 | a streaming reply survives switching to KVM and Settings and back | the whole reply is in the thread after the switches | pass |
| Desktop 1400x900 | the chat socket refuses a foreign Origin and accepts the app's own | Origin http://evil.example: refused 403; the app's own Origin: open | pass |
| Desktop 1400x900 | computed styles in the KVM and Settings panes, and the app's root variables, are the same before and after Chat has loaded | (the probe sees a planted :root font rule: true) Opening Chat loaded its stylesheets (1 -> 3; the .chat-scope rules are there from the start before and there after); compared 17 root variables, body, a KVM button, the Settings heading and link, and the nav tab in KVM and Settings, light and dark: identical; app font "Geist Variable"; data-theme light/dark, --background #eef0f4 / #0a0a0c: light and dark differ | pass |
| Desktop 1400x900 | secrets: the provider key and the PiKVM password are in no response, page, storage, frame, agent process or agent file | 178 responses, 292 frames, 232 requests, page, storage, cookies, caches and 8 files of process 2718396/2718761/2720092/2720496 checked: none found; the key left the browser in: POST /app/chat/api/providers/test, PUT /app/chat/api/settings/agent.providers; a plaintext copy of the key is on disk in no file (the settings store seals it); of the password in no file; the model received the stored key upstream (1 distinct credential) | pass |
| Desktop 1400x900 | no page error, and no failed request except the login-proxy probe | clean | pass |

27 of 27 passed.

## Screenshots

- [desktop-dark-01-providers](chat-integrated/desktop-dark-01-providers.png)
- [desktop-dark-03-provider-added](chat-integrated/desktop-dark-03-provider-added.png)
- [desktop-dark-04-settings-agent](chat-integrated/desktop-dark-04-settings-agent.png)
- [desktop-dark-04-settings-models](chat-integrated/desktop-dark-04-settings-models.png)
- [desktop-dark-04-settings-providers](chat-integrated/desktop-dark-04-settings-providers.png)
- [desktop-dark-05-agent-click](chat-integrated/desktop-dark-05-agent-click.png)
- [desktop-dark-06-approval-waiting](chat-integrated/desktop-dark-06-approval-waiting.png)
- [desktop-dark-06a-approval-waiting-on-kvm](chat-integrated/desktop-dark-06a-approval-waiting-on-kvm.png)
- [desktop-dark-07-denied](chat-integrated/desktop-dark-07-denied.png)
- [desktop-dark-08-allowed](chat-integrated/desktop-dark-08-allowed.png)
- [desktop-dark-09-agent-working](chat-integrated/desktop-dark-09-agent-working.png)
- [desktop-dark-10-you-have-control](chat-integrated/desktop-dark-10-you-have-control.png)
- [desktop-dark-11-handed-back](chat-integrated/desktop-dark-11-handed-back.png)
- [desktop-dark-12-stopped](chat-integrated/desktop-dark-12-stopped.png)
- [desktop-dark-12b-chat-after-stop](chat-integrated/desktop-dark-12b-chat-after-stop.png)
- [desktop-dark-14-stream-survived](chat-integrated/desktop-dark-14-stream-survived.png)
- [desktop-light-01-providers](chat-integrated/desktop-light-01-providers.png)
- [desktop-light-02-custom-endpoint](chat-integrated/desktop-light-02-custom-endpoint.png)
- [desktop-light-03-provider-added](chat-integrated/desktop-light-03-provider-added.png)
- [desktop-light-04-settings-agent](chat-integrated/desktop-light-04-settings-agent.png)
- [desktop-light-04-settings-models](chat-integrated/desktop-light-04-settings-models.png)
- [desktop-light-04-settings-providers](chat-integrated/desktop-light-04-settings-providers.png)
- [desktop-light-05-agent-click](chat-integrated/desktop-light-05-agent-click.png)
- [desktop-light-06-approval-waiting](chat-integrated/desktop-light-06-approval-waiting.png)
- [desktop-light-06a-approval-waiting-on-kvm](chat-integrated/desktop-light-06a-approval-waiting-on-kvm.png)
- [desktop-light-07-denied](chat-integrated/desktop-light-07-denied.png)
- [desktop-light-08-allowed](chat-integrated/desktop-light-08-allowed.png)
- [desktop-light-09-agent-working](chat-integrated/desktop-light-09-agent-working.png)
- [desktop-light-10-you-have-control](chat-integrated/desktop-light-10-you-have-control.png)
- [desktop-light-11-handed-back](chat-integrated/desktop-light-11-handed-back.png)
- [desktop-light-12-stopped](chat-integrated/desktop-light-12-stopped.png)
- [desktop-light-12b-chat-after-stop](chat-integrated/desktop-light-12b-chat-after-stop.png)
- [desktop-light-14-stream-survived](chat-integrated/desktop-light-14-stream-survived.png)
- [phone-dark-01-providers](chat-integrated/phone-dark-01-providers.png)
- [phone-dark-03-provider-added](chat-integrated/phone-dark-03-provider-added.png)
- [phone-dark-04-settings-agent](chat-integrated/phone-dark-04-settings-agent.png)
- [phone-dark-04-settings-models](chat-integrated/phone-dark-04-settings-models.png)
- [phone-dark-04-settings-providers](chat-integrated/phone-dark-04-settings-providers.png)
- [phone-dark-05-agent-click](chat-integrated/phone-dark-05-agent-click.png)
- [phone-dark-06-approval-waiting](chat-integrated/phone-dark-06-approval-waiting.png)
- [phone-dark-06a-approval-waiting-on-kvm](chat-integrated/phone-dark-06a-approval-waiting-on-kvm.png)
- [phone-dark-07-denied](chat-integrated/phone-dark-07-denied.png)
- [phone-dark-08-allowed](chat-integrated/phone-dark-08-allowed.png)
- [phone-dark-09-agent-working](chat-integrated/phone-dark-09-agent-working.png)
- [phone-dark-10-you-have-control](chat-integrated/phone-dark-10-you-have-control.png)
- [phone-dark-11-handed-back](chat-integrated/phone-dark-11-handed-back.png)
- [phone-dark-12-stopped](chat-integrated/phone-dark-12-stopped.png)
- [phone-dark-12b-chat-after-stop](chat-integrated/phone-dark-12b-chat-after-stop.png)
- [phone-dark-13-keyboard-up](chat-integrated/phone-dark-13-keyboard-up.png)
- [phone-dark-14-stream-survived](chat-integrated/phone-dark-14-stream-survived.png)
- [phone-light-01-providers](chat-integrated/phone-light-01-providers.png)
- [phone-light-02-custom-endpoint](chat-integrated/phone-light-02-custom-endpoint.png)
- [phone-light-03-provider-added](chat-integrated/phone-light-03-provider-added.png)
- [phone-light-04-settings-agent](chat-integrated/phone-light-04-settings-agent.png)
- [phone-light-04-settings-models](chat-integrated/phone-light-04-settings-models.png)
- [phone-light-04-settings-providers](chat-integrated/phone-light-04-settings-providers.png)
- [phone-light-05-agent-click](chat-integrated/phone-light-05-agent-click.png)
- [phone-light-06-approval-waiting](chat-integrated/phone-light-06-approval-waiting.png)
- [phone-light-06a-approval-waiting-on-kvm](chat-integrated/phone-light-06a-approval-waiting-on-kvm.png)
- [phone-light-07-denied](chat-integrated/phone-light-07-denied.png)
- [phone-light-08-allowed](chat-integrated/phone-light-08-allowed.png)
- [phone-light-09-agent-working](chat-integrated/phone-light-09-agent-working.png)
- [phone-light-10-you-have-control](chat-integrated/phone-light-10-you-have-control.png)
- [phone-light-11-handed-back](chat-integrated/phone-light-11-handed-back.png)
- [phone-light-12-stopped](chat-integrated/phone-light-12-stopped.png)
- [phone-light-12b-chat-after-stop](chat-integrated/phone-light-12b-chat-after-stop.png)
- [phone-light-13-keyboard-up](chat-integrated/phone-light-13-keyboard-up.png)
- [phone-light-14-stream-survived](chat-integrated/phone-light-14-stream-survived.png)

## Added: the screenshot on the PiKVM card

The parity gap with the old harness chat, whose computer sheet showed the agent's frames: a screenshot's image block never reached the thread, so the card had no thumbnail and no click point.

- The chat server now keeps each screenshot per conversation (bounded, deleted with it) and the tool result names it; the card shows it.
- The suite was re-run in full with three new cases per profile: phone 17 of 17 and desktop 16 of 16 passed. The 27 rows above are unchanged cases that still pass. Same stack and profiles.
- The thumbnail is compared with the fake kvmd's colour bars ("FAKE KVMD TEST PATTERN 320x180"). Both are drawn at 80x45; the mean difference is 0.0 of 255 per colour channel, with a spread of 255, so the frame is not blank.

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| iPhone 13 | Chat: the PiKVM cards show the screenshot the agent took (the fake's test pattern) and the click point, and a tap opens it full size | screenshot card: thumbnail 258x145px of a 320x180 picture, loaded, differs from the fake's test pattern by 0.0 (of 255) and spreads 255, no marker; click card: thumbnail 258x145px of a 320x180 picture, loaded, differs from the fake's test pattern by 0.0 (of 255) and spreads 255, marker 129.0,72.6 from the picture's corner (the centre is 129.0,72.6); the thumbnail fits the screen and is 145px tall; a tap opened it as a bottom sheet 390x261px titled "Click at (160, 90)" on a 390x844 screen, the picture 355x200px (the thumbnail was 258px) with the marker on the same pixel; Escape closed it | pass |
| iPhone 13 | a reload keeps the pictures: the same cards, the same frames, and the screen is not looked at again | screenshot card: thumbnail 258x145px of a 320x180 picture, loaded, differs from the fake's test pattern by 0.0 (of 255) and spreads 255, no marker; click card: thumbnail 258x145px of a 320x180 picture, loaded, differs from the fake's test pattern by 0.0 (of 255) and spreads 255, marker 129.0,72.6 from the picture's corner (the centre is 129.0,72.6); after the reload and opening the conversation from the list the cards show the same frames, and the fake kvmd served 0 new snapshots | pass |
| iPhone 13 | a conversation's screenshot is served inside that conversation only: another conversation's frame id is refused | 3 conversations took screenshots; each one's frame: 3 of 3 served as image/jpeg in its own conversation, 6 of 6 refused (404) in another; a path-like frame id: 404 | pass |
| Desktop 1400x900 | Chat: the PiKVM cards show the screenshot the agent took (the fake's test pattern) and the click point, and a tap opens it full size | screenshot card: thumbnail 258x145px of a 320x180 picture, loaded, differs from the fake's test pattern by 0.0 (of 255) and spreads 255, no marker; click card: thumbnail 258x145px of a 320x180 picture, loaded, differs from the fake's test pattern by 0.0 (of 255) and spreads 255, marker 129.0,72.6 from the picture's corner (the centre is 129.0,72.6); the thumbnail fits the screen and is 145px tall; a tap opened it as a dialog 960x591px titled "Click at (160, 90)" on a 1400x900 screen, the picture 923x519px (the thumbnail was 258px) with the marker on the same pixel; Escape closed it | pass |
| Desktop 1400x900 | a reload keeps the pictures: the same cards, the same frames, and the screen is not looked at again | screenshot card: thumbnail 258x145px of a 320x180 picture, loaded, differs from the fake's test pattern by 0.0 (of 255) and spreads 255, no marker; click card: thumbnail 258x145px of a 320x180 picture, loaded, differs from the fake's test pattern by 0.0 (of 255) and spreads 255, marker 129.0,72.6 from the picture's corner (the centre is 129.0,72.6); after the reload and opening the conversation from the list the cards show the same frames, and the fake kvmd served 0 new snapshots | pass |
| Desktop 1400x900 | a conversation's screenshot is served inside that conversation only: another conversation's frame id is refused | 3 conversations took screenshots; each one's frame: 3 of 3 served as image/jpeg in its own conversation, 6 of 6 refused (404) in another; a path-like frame id: 404 | pass |

Also pinned without a browser, with the real omp binary:

- `packages/chat-server/test/e2e.test.ts` ("the pictures a tool took"): the frame on the live item and in history, the route serves the JPEG, another conversation's frame id and a malformed id are 404, delete removes the directory, a fork keeps its frames, and they survive a restart.
- `packages/chat-server/src/storage/frames.test.ts`: the count and byte bounds, oldest first, never the frame just written.
- `tests/routes.test.ts`: the frame URL is behind the host's gate.

Screenshots (each in light and dark): the cards, the full-size viewer, and the cards after a reload.

- [phone-light-05b-pikvm-cards](chat-integrated/phone-light-05b-pikvm-cards.png)
- [phone-dark-05b-pikvm-cards](chat-integrated/phone-dark-05b-pikvm-cards.png)
- [phone-light-05c-frame-viewer](chat-integrated/phone-light-05c-frame-viewer.png)
- [phone-dark-05c-frame-viewer](chat-integrated/phone-dark-05c-frame-viewer.png)
- [phone-light-05d-after-reload](chat-integrated/phone-light-05d-after-reload.png)
- [phone-dark-05d-after-reload](chat-integrated/phone-dark-05d-after-reload.png)
- [desktop-light-05b-pikvm-cards](chat-integrated/desktop-light-05b-pikvm-cards.png)
- [desktop-dark-05b-pikvm-cards](chat-integrated/desktop-dark-05b-pikvm-cards.png)
- [desktop-light-05c-frame-viewer](chat-integrated/desktop-light-05c-frame-viewer.png)
- [desktop-dark-05c-frame-viewer](chat-integrated/desktop-dark-05c-frame-viewer.png)
- [desktop-light-05d-after-reload](chat-integrated/desktop-light-05d-after-reload.png)
- [desktop-dark-05d-after-reload](chat-integrated/desktop-dark-05d-after-reload.png)
