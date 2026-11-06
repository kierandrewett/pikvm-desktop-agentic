# Subscription sign-in (Claude, ChatGPT/Codex), 2026-11-06

Command: `cd packages/chat-server && npx vitest run test/login.e2e.test.ts` (real omp binary, no network login completed).

| Check | Result |
| --- | --- |
| A provider that is not a subscription is refused (400) | pass |
| `anthropic` and `openai-codex`: the runtime's `omp login` runs in the user's own home, the sign-in address (claude.ai / auth.openai.com) comes back, the login waits | pass |
| A wrong paste ends the login as `failed` with a reason and no credential in the reply | pass |
| Cancel ends it; an unknown id is 404 | pass |

Not covered: a real sign-in (it needs a real account and a browser), that the runtime then uses the stored credential in a chat, a second user, the Settings page in a browser.
