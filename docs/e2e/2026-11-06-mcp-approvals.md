# Approvals for outside MCP clients, 6 November 2026

## Environment

The web host ran from `dist/web-server.js` against the repository's fake kvmd on port 4510, with a fresh data directory. A headless Chrome signed in with the access token acted as the person. The MCP client was a plain script using the access token as a Bearer, with no browser.

Run, with the fake and the host already up and the fake's state reset:

```sh
PUPPETEER_CORE=$HOME/dev/sidekick/node_modules CHROME=/usr/bin/google-chrome \
  node ~/.cache/pk-e2e/approvals/e2e.mjs
```

The script and its screenshots are in `~/.cache/pk-e2e/approvals/`.

## What ran

An answer decides only the call it was shown for; nothing is remembered. The fake's key-press count is the proof of what was typed.

| Step | Result |
| --- | --- |
| A 300-character `type_text` from the client | Held. The KVM tab showed a card with who, what and why. No key was pressed. |
| Allow on the KVM tab | The held call went on and typed the text. |
| The same Bearer answers over HTTP | 403. A script cannot approve for an agent. |
| A second `type_text`, the person opens `/app/kvm?approve=<id>` and allows | That held call went through and typed. |
| A third `type_text`, the person presses Stop | The waiting question was dropped, the call was refused, nothing was typed. |

The 90-second refusal is covered by `tests/agent-approvals.test.ts` with an injected clock, not waited out here.

## Also run

`tests/agent-approvals.test.ts` covers the queue, the routes and the MCP handler together: first-in first-out order, joining, a client that goes away, the cap of 20, a refusal when nobody answers, a late Allow finding nothing, a repeat asking again, Stop, and the refusal of a script's answer. `apps/web` covers the card, Allow and Deny, the order, and the linked action shown first.

## Limits

Not run with a real MCP client or the real PiKVM. Push notification delivery was not exercised.
