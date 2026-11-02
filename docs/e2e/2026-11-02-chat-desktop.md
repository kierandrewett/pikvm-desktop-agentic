# E2E run: the desktop app's Chat tab on its embedded harness (2026-11-02)

The real Electron app (the packaged layout: `resources/app`, `resources/apps/web/dist`, the agent runtime from the checkout's `agent/.venv`) under a headless sway (`env -u ENABLE_VULKAN_RENDERDOC_CAPTURE`), driven through its own window over Electron's remote-debugging port, in front of `tools/fake-kvmd` (http://127.0.0.1:4592); `tools/fake-model` is the provider. Script: `apps/web/e2e/chat-desktop.e2e.mjs`.

The `*-window.png` pictures are the compositor's (grim): the whole window with its frame. The others are the page's own.

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| desktop app | this is the desktop shell, and it offers KVM, Chat and Settings only | pikvmDesktop on linux; tabs: KVM, Chat, Settings | pass |
| desktop app | there is no terminal: no feature flag, no page, no socket | features: chat; /app/terminal.html 404, terminal.js 404, xterm.css 404; /app/terminal socket refused | pass |
| desktop app | the embedded server offers Chat because its harness answers; the Chat tab shows the conversation | features.chat=true; on /app/chat; the conversation rendered | pass |
| desktop app | Settings -> Providers: add an API provider and its key | fake-desktop-ba0c: key listed as set: true | pass |
| desktop app | Chat: a run is created, its events render in the conversation, and the click reaches the kvmd | run "Please click the centre of the screen" paused; event stream opened: true; "Click at 160" rendered in the conversation; fake kvmd received button left down, button left up | pass |
| desktop app | Chat: an action the harness holds waits for the person | while waiting the fake kvmd received 0 key events; after Allow once -> Confirm it received key Enter down, key Enter up | pass |
| desktop app | the agent's daemon hit the app's PiKVM (the fake) and nothing outside loopback | the fake kvmd answered 17 snapshot request(s); the app's process tree held sockets to 6 address(es), outside loopback: none (the daemon's own config pointed at a closed decoy port) | pass |
| desktop app | Settings -> Connection: saving a new PiKVM address moves the agent onto it | PUT /target 200; after it the new fake kvmd answered 8 snapshot request(s) and the old one 0; outside loopback: none | pass |
| desktop app | no page errors | clean | pass |

9 of 9 passed.

## Screenshots

- [01-kvm-window](chat-desktop/01-kvm-window.png)
- [01-kvm](chat-desktop/01-kvm.png)
- [02-chat-window](chat-desktop/02-chat-window.png)
- [02-chat](chat-desktop/02-chat.png)
- [03-provider-added-window](chat-desktop/03-provider-added-window.png)
- [03-provider-added](chat-desktop/03-provider-added.png)
- [04-click-run-window](chat-desktop/04-click-run-window.png)
- [04-click-run](chat-desktop/04-click-run.png)
- [05-approval-waiting-window](chat-desktop/05-approval-waiting-window.png)
- [05-approval-waiting](chat-desktop/05-approval-waiting.png)
- [06-approved-window](chat-desktop/06-approved-window.png)
- [06-approved](chat-desktop/06-approved.png)
