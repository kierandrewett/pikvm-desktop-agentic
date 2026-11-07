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

## Smart approval fallback, 7 November 2026

Choose the approval mode in Settings, Agent, **Ask before PiKVM actions**.
The setting applies to the next call. Existing saved values and the default remain unchanged.

| Value | Effect |
| --- | --- |
| `risky` (default) | Ask for fixed risks, including destructive text, long or multiline typing, risky chords, drags and stale screenshots. |
| `smart` | Keep every fixed risk check and add OCR-based screen review through the configured Decisions model. |
| `always` | Ask for every input action. |
| `never` | Skip input approval except power actions. |

Smart mode requires approval when no judge or Decisions model is available, OCR fails or finds too little text,
or a model answer fails, times out or is not a finite probability from zero to one.
Pointer movement and scrolling use the fixed rules without model review. Observation tools do not ask.

Recognised payment screens, credential entry and consequential labels are checked locally before any model request.
These checks can require approval but cannot establish that an action is safe.
Smart review currently uses the target's OCR, not the screen-watch PaddleOCR worker.

### Built-host smoke

The rebuilt web host ran on port 18139 against a separate fake kvmd on port 14539.
The data directory was fresh, with no Decisions model configured.
Headless Chrome used the real Settings page and the KVM approval card.
No live service or real PiKVM was changed.

| Scenario | Observed result |
| --- | --- |
| Click with OCR available but no model | Approval card appeared. Deny sent no input. |
| Enter with OCR disabled and no model | Approval card appeared. Deny sent no input. |
| Short typing with OCR disabled and no model | Approval card appeared. Deny sent no input. |
| Allow three typed characters | Exactly three key presses reached the fake PiKVM. |

The repeatable script, screenshots and JSON result are in
`~/.cache/pk-e2e/permission-fallback/`.
The isolated stack uses the existing chat harness with ports 18139, 14539 and 14547.
It requires the built host, built web client and the local Puppeteer/Chrome runtime named in the script.

```sh
node ~/.cache/pk-e2e/permission-fallback/smoke.mjs
```

### Regression coverage

The HTTP approval scenarios in `tests/agent-approvals.test.ts` cover missing models and judges,
disabled, failed, timed-out or unreadable OCR, failed or timed-out models, invalid probabilities,
and an unreadable click target. They also verify that low model scores cannot clear fixed risks
and that recognised credential and payment gates run before provider calls.

These checks prove the fallback path, not model classification accuracy.
Real-screen OCR quality, precise control-to-label association and classifier false-negative rates
remain unverified. The OCR research did not change the OCR engine.

### Verification results

| Check | Result |
| --- | --- |
| Root tests | 772 passed, one skipped |
| MCP package tests | 71 passed |
| Chat server tests | 75 passed |
| Protocol tests | Nine passed |
| Chat settings tests | 33 passed |
| Root and affected-package type checks | Passed |
| Host and web production builds | Passed, with existing Vite/CSS warnings |
| MCP package similarity check | No duplicate functions or similar types |

Run the root suite with `yarn test`. The package suites use Yarn workspace test commands.
Type checks use `yarn tsc --noEmit` at the root and the affected workspaces' `typecheck` commands.

## Limits

Not run with a real MCP client or the real PiKVM. Push notification delivery was not exercised.
