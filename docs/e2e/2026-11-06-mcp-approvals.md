# Approvals for outside MCP clients, 6 November 2026

## Environment

The web host ran from `dist/web-server.js` against the repository's fake kvmd on port 4510. `PIKVM_PUBLIC_URL` was `http://127.0.0.1:8099`, so the host could give a link. A headless Chrome signed in with the access token acted as the person. The MCP client was a plain script using the access token as a Bearer, with no browser.

Run, with the fake and the host already up:

```sh
PUPPETEER_CORE=$HOME/dev/sidekick/node_modules CHROME=/usr/bin/google-chrome \
  node ~/.cache/pk-e2e/approvals/e2e.mjs
```

The script and its screenshots are in `~/.cache/pk-e2e/approvals/`.

## What ran

| Step | Result |
| --- | --- |
| A 300-character `type_text` from the client | Held. The KVM tab showed a card with who, what and why. Nothing was typed. |
| Allow on the KVM tab | The held call went on and typed the text. |
| The same Bearer answers over HTTP | 403. A script cannot approve for an agent. |
| A second `type_text`, nobody answers for 30 seconds | The call ended with the link. Nothing was typed. |
| The link opened in the signed-in browser | The card for that action showed. Allow cleared it. |
| The client repeats the exact call | It went through and typed once. |
| The client repeats it again | It asked again. |
| Stop | The waiting question was dropped. Nothing was typed. |

## Also run

`tests/agent-approvals.test.ts` covers the queue, the routes and the MCP handler together with an injected clock: first-in first-out joining, expiry, a client that goes away, the cap of 20, the single-use allowance bound to client and arguments, and Stop. `apps/web` covers the card, Allow and Deny, the order, and the linked action shown first.

## Limits

This was not run with a real MCP client or the real PiKVM. Push notification delivery was not exercised. The link needs `PIKVM_PUBLIC_URL`; the desktop app has none and tells the client to use the KVM tab.
