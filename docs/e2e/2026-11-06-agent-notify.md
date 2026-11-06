# The agent needs the person: a notification (end to end)

Result: 12 of 12 checks passed.

| Check | Result | Observed |
| --- | --- | --- |
| on by default, with no device set up | pass | notifyAgent true, devices 0 |
| no device: the card waits and nothing is sent | pass | 0 pushes |
| the device is subscribed | pass | HTTP 200 |
| while the person is using the app nothing is sent | pass | 0 pushes |
| with the person away one push arrives | pass | 1 pushes |
| it says that the agent needs approval, in fixed words | pass | {"title":"PiKVM","body":"The agent needs your approval."} |
| it does not say what the agent wants to do | pass | {"title":"PiKVM","body":"The agent needs your approval.","tag":"pikvm-agent-01a1ae33-f80d-7238-9585-6c4e0179f6af","url":"/app/chat","badge":true} |
| a tap opens Chat, and it is marked as urgent and short-lived | pass | url /app/chat, urgency high, ttl 900 |
| the push is signed and the payload decrypted | pass | signatureValid true |
| the same wait does not notify again | pass | 1 pushes |
| it can be switched off | pass | notifyAgent false |
| switched off, a waiting approval sends nothing | pass | 0 new pushes |

## How this run was made

```sh
PUPPETEER_CORE=/home/kieran/dev/sidekick/node_modules CHROME=/usr/bin/google-chrome OMP_BIN=/home/kieran/dev/omp/build/prefix/usr/bin/omp \
  node --experimental-strip-types --disable-warning=ExperimentalWarning apps/web/e2e/agent-notify.e2e.mjs
```

- Repository commit: `5c3fabc7`. The stack is `apps/web/e2e/chat-stack.mjs`: the web host with the chat server in it and the real `omp` binary, `tools/fake-kvmd`, `tools/fake-model` (scenario `pikvm:approve`) and `tools/fake-push` as the push service (it checks the VAPID signature and decrypts the payload).
- Node v22.22.2. No real PiKVM, push service or phone was used.
