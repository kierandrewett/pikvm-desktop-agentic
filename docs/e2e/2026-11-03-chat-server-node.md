# E2E run: the chat server on Node with the real omp binary (2026-11-03)

`packages/chat-server` (`createChatServer`) behind a minimal host (`test/host.ts`: one listener that mounts the REST routes and the socket under `/app/chat`, as the PiKVM host will), the real `omp` standalone binary, `tools/fake-model` as the provider, and a fake MCP server standing in for the PiKVM one. Nothing between the WebSocket client and the agent is mocked. Suite: `packages/chat-server/test/e2e.test.ts`.

The binary is upstream omp 18.14.2 as pinned in `deploy/omp.lock` and fetched by `scripts/fetch-omp.mjs` (sha256 checked, `omp/18.14.2`). The fork build (`18.14.2-fork.7`, `~/.local/bin/omp`) passed the same suite earlier.

## Without Bun

The whole suite ran under `env -i` with `PATH=/usr/local/bin:/usr/bin:/bin` and `OMP_BIN` set, no Bun on the machine's PATH for that process, and no `omp` on it either:

```
PATH=/usr/local/bin:/usr/bin:/bin
bun: not found
omp on PATH: not found (OMP_BIN used)
omp/18.14.2
 Test Files  5 passed (5)
      Tests  31 passed (31)
```

The agent's own PATH is `/usr/local/bin:/usr/bin:/bin` whatever the host's is; the test reads it from `/proc/<pid>/environ` of the running agent.

## Cases

| Case | Observed | Result |
| --- | --- | --- |
| no Bun anywhere the agent or the host looks | `which("bun")` undefined on the host PATH and on the agent's; runtime found | pass |
| a reply streams, the chat is named and kept | `You said: hello there friend` in several deltas; `chat.hello` first; the chat listed; a title arrived as `chat.conversation.updated`; history = user, assistant | pass |
| the agent is offered exactly `ask`, `todo` and the PiKVM tools | model request tools: `ask, mcp__pikvm_click, mcp__pikvm_key, mcp__pikvm_screenshot, todo` (`agent.conversationsTool` is off by default) | pass |
| a tool call reaches the server with its conversation | `screenshot`, then `click {x:160,y:90}` with `conversationId` of the chat; two `function_call` items named `mcp__pikvm_*` | pass |
| approval: the card appears and nothing runs until it is answered | `mcp_approval_request` (server `pikvm`, `reason: "risky"`, title `Press alt+F4 on the PiKVM?`); while it waits only `screenshot` was called; after approve, `key` ran | pass |
| approval denied | after deny the fake server had received no `key` | pass |
| Stop while an approval is open | the run ended without completing, no action was sent, and with no running response `askApproval` answers `unavailable` | pass |
| Stop mid-stream | the reply was cut; the next prompt in the same chat completed | pass |
| resume after a restart | server stopped and a new one started on the same data directory; the new agent process saw the first turn's messages from the session JSONL | pass |
| the agent holds no secret | environment names exactly `CHAT_CONVERSATION_ID, HOME, LANG, OMP_SKIP_SETUP, PATH, PI_NOTIFICATIONS, TERM`; the canary provider key is in no environment, command line, generated file (`models.yml`, `mcp.json`, `config.yml`, mode 0600) or model request; the model saw `Authorization: Bearer <real key>` only because the gateway added it; the key is not in `chat.db` in the clear | pass |
| the agent surface | every path answers 401 without the gateway token and with a forged one; with the real token, `/app/...`, `/api/...`, `/healthz` and unknown `/mcp/...` answer 404 | pass |
| CSRF | a DELETE without `x-chat-request` is 403 | pass |
| routes outside the prefix | 404; `/bootstrap` is the operator | pass |
| a malformed socket event | an `error` event, code `unknown_event` | pass |
| the composer's tool list | `GET /mcp?fresh=1` lists `pikvm` connected with `click, key, screenshot`, by the same client calls the agent makes | pass |

## Not covered here, on purpose

- No sandbox (open question 3 decided: computer profile only), so there is no `--unshare-net` case.
- The model is the chat-completions fake only; chat's chaos scenarios and the other wire families are not lifted.
- The real PiKVM server, the Desk and the browser UI are S2 to S4.

## Note on a flake that was not one

Early runs failed two or three tests at random. The cause was the machine's /tmp cleaner deleting the run's data directory (`chat.db` gone mid-test), not the server. The suite's directories now live under `~/.cache/pikvm-chat-server-tests`; 8 consecutive runs passed before the move (the one run that failed under CPU saturation was the deleted-directory case). The final suite passed once after it.
