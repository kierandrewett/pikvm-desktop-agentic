# E2E run: Chat and Providers on the hosted deployment (2026-11-02)

Host under test: the web image (http://127.0.0.1:18080) with its agent sidecar image behind `/app/harness`, in front of `tools/fake-kvmd` (http://127.0.0.1:14510); `tools/fake-model` is the provider. Stack: `deploy/e2e/compose.yml`.

Browser: headless Chrome through puppeteer-core. Profiles: iPhone 13 (390x844, touch, coarse pointer) and desktop 1400x900. Script: `apps/web/e2e/chat-sidecar.e2e.mjs`; how to run it: `docs/e2e/README.md`.

The two CLI sign-in cases start the real `codex` and `claude` sign-in inside the sidecar (they need outbound internet); nothing is submitted and each attempt is cancelled.

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| phone | the host offers Chat because the agent answers | features.chat=true; the workspace rendered | pass |
| phone | the operator token is held by the host, not the browser | bare request 403; browser sent Bearer desktop-managed; token absent from requests, responses, storage and page | pass |
| phone | Settings -> Providers: add an API provider and its key | fake-phone-3ffd: the key is listed as set: yes; no response carries it: yes; the config does not hold it: yes; the store is 0600: yes; no other file on the volume holds it: yes; store mode 600 | pass |
| phone | Settings -> Providers: Codex sign-in shows the URL and one-time code, and can be cancelled | link https://auth.openai.com/codex/device; code WAYW-1DLG3; after Cancel sign-in: cancelled | pass |
| phone | Settings -> Providers: Claude sign-in shows the URL and a box for the code, and can be cancelled | link https://claude.com/cai/oauth/authorize?code=true&client_id=9...; 1 code field; after Cancel sign-in: cancelled | pass |
| phone | Chat: a run streams its events and a click reaches the kvmd | event stream opened: true; fake kvmd received button left down, button left up; the model was called with the stored key (…e94f) | pass |
| phone | Chat: an action the harness holds is not delivered until the person allows it | while waiting the fake kvmd received 0 key events; after Allow once -> Confirm it received key Enter down, key Enter up; approval POST 200 | pass |
| phone | Chat: denying a held action delivers nothing | run status rejected; the fake kvmd received 0 key events | pass |
| phone | a host whose agent is down does not offer Chat, and says so | features.chat=false; the Chat page says "Chat is not available" and shows no workspace | pass |
| phone | no page errors | clean | pass |
| desktop | the host offers Chat because the agent answers | features.chat=true; the workspace rendered | pass |
| desktop | the operator token is held by the host, not the browser | bare request 403; browser sent Bearer desktop-managed; token absent from requests, responses, storage and page | pass |
| desktop | Settings -> Providers: add an API provider and its key | fake-desktop-6a33: the key is listed as set: yes; no response carries it: yes; the config does not hold it: yes; the store is 0600: yes; no other file on the volume holds it: yes; store mode 600 | pass |
| desktop | Settings -> Providers: Codex sign-in shows the URL and one-time code, and can be cancelled | link https://auth.openai.com/codex/device; code WB00-FNQG8; after Cancel sign-in: cancelled | pass |
| desktop | Settings -> Providers: Claude sign-in shows the URL and a box for the code, and can be cancelled | link https://claude.com/cai/oauth/authorize?code=true&client_id=9...; 1 code field; after Cancel sign-in: cancelled | pass |
| desktop | Chat: a run streams its events and a click reaches the kvmd | event stream opened: true; fake kvmd received button left down, button left up; the model was called with the stored key (…73aa) | pass |
| desktop | Chat: an action the harness holds is not delivered until the person allows it | while waiting the fake kvmd received 0 key events; after Allow once -> Confirm it received key Enter down, key Enter up; approval POST 200 | pass |
| desktop | Chat: denying a held action delivers nothing | run status rejected; the fake kvmd received 0 key events | pass |
| desktop | a host whose agent is down does not offer Chat, and says so | features.chat=false; the Chat page says "Chat is not available" and shows no workspace | pass |
| desktop | no page errors | clean | pass |

20 of 20 passed.

## Screenshots

- [desktop-01-chat](chat-sidecar/desktop-01-chat.png)
- [desktop-02-add-provider](chat-sidecar/desktop-02-add-provider.png)
- [desktop-03-provider-added](chat-sidecar/desktop-03-provider-added.png)
- [desktop-04-codex-sign-in](chat-sidecar/desktop-04-codex-sign-in.png)
- [desktop-05-claude-sign-in](chat-sidecar/desktop-05-claude-sign-in.png)
- [desktop-06-click-run](chat-sidecar/desktop-06-click-run.png)
- [desktop-07-approval-waiting](chat-sidecar/desktop-07-approval-waiting.png)
- [desktop-08-approval-confirm](chat-sidecar/desktop-08-approval-confirm.png)
- [desktop-09-approved](chat-sidecar/desktop-09-approved.png)
- [desktop-10-denied](chat-sidecar/desktop-10-denied.png)
- [desktop-11-agent-down](chat-sidecar/desktop-11-agent-down.png)
- [phone-01-chat](chat-sidecar/phone-01-chat.png)
- [phone-02-add-provider](chat-sidecar/phone-02-add-provider.png)
- [phone-03-provider-added](chat-sidecar/phone-03-provider-added.png)
- [phone-04-codex-sign-in](chat-sidecar/phone-04-codex-sign-in.png)
- [phone-05-claude-sign-in](chat-sidecar/phone-05-claude-sign-in.png)
- [phone-06-click-run](chat-sidecar/phone-06-click-run.png)
- [phone-07-approval-waiting](chat-sidecar/phone-07-approval-waiting.png)
- [phone-08-approval-confirm](chat-sidecar/phone-08-approval-confirm.png)
- [phone-09-approved](chat-sidecar/phone-09-approved.png)
- [phone-10-denied](chat-sidecar/phone-10-denied.png)
- [phone-11-agent-down](chat-sidecar/phone-11-agent-down.png)
