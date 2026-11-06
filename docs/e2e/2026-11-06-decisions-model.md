# Decisions model (Jev) end to end, 2026-11-06

Command: `cd packages/chat-server && set -a && . ~/.env && set +a && npx vitest run test/decisions.real.test.ts`
Environment: real OpenRouter, the key in `GNOBLIN_OPENROUTER_API_KEY`, stored as the operator's OpenRouter provider; role `agent.modelRoles.decisions` = `openrouter/typesafe/jev-1.14`.
Log: `~/.cache/pk-e2e/decisions.log`.

| Failure mode | Result |
| --- | --- |
| The picker never lists a decisions model | `GET /api/v1/models?output_modalities=decisions` with the user's key: 36 models, Jev 1.14 among them, no error |
| A decisions model is sent to the chat API | Not hit: the call goes to `https://openrouter.ai/api/alpha/decisions` |
| Wrong host or key (the chat gateway cannot reach `/api/alpha`) | Not hit: OpenRouter is called directly with the stored key |
| A routine pop-up answered yes, an urgent one no | "Dependabot: 3 updates available": P(yes) 0.05. "Priya Shah: the build is failing and prod is down, call me now": 0.99 |

Not covered by this run: the gate inside the watch (a confident no, 0.15 or less, ends the check; every other answer or a failure goes on to the chat model) was checked by reading the code and by the type checker only, and not with a real screen. The picker in a browser was not opened.
