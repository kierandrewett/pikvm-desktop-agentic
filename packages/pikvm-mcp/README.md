# @pikvm/mcp

The PiKVM computer-use MCP server: the tool definitions, the risk rules that decide what asks the person, and the request handler. It does not listen, authenticate or touch the PiKVM itself. A host gives it two ports.

```ts
import { createPikvmMcp } from "@pikvm/mcp";

const mcp = createPikvmMcp({ desk, approver, policy: () => settings.pikvmPolicy() });
// per request, after the host has checked the bearer token:
const reply = await mcp.handle({ conversationId, signal: req.signal }, jsonRpcMessage);
// reply is undefined for a notification: answer 202 with no body
```

## Ports

- `Desk` (`src/types.ts`): everything that touches the target. `src/server/agent/desk.ts` is the real one, over `@pikvm/kvm-engine` and kvmd. Its `open()` is the one place the lease, the release state and the stale-frame rule are checked, so a refusal comes before the person is asked anything.
- `Approver`: `ask({ conversationId, tool, title, summary, reasons, arguments, signal })` resolves to `approved`, `denied` or `unavailable`. The chat server implements it with its elicitation in the thread of that conversation. `unavailable` means nobody could be asked; the action is then refused, never queued. `signal` aborts when the person takes over, so the question can be withdrawn.
- `FrameSink` (`McpCaller.frames`, optional): where this conversation's screenshots are kept for the person to look at afterwards. `save(jpeg, size)` returns `{ id, width, height }`, or undefined when the host keeps nothing or refuses the picture. A `screenshot` result then carries the reference in its `_meta["chat/frame"]` (`FRAME_META_KEY`), and so does each `click`, `mouse_move`, `drag` and `scroll` result, naming the conversation's latest whole-screen frame (the picture its coordinates refer to; a zoom is kept but never replaces it). The model gets the image in the result as before. The chat server implements the sink (`BuiltinMcpContext.saveFrame`): per conversation, bounded, served at `/app/chat/api/conversations/:id/frames/:frameId`, and shown on the PiKVM card in the thread.

## Tools

Model-visible names are `mcp__pikvm_<tool>`: `screenshot`, `read_text`, `mouse_move`, `click`, `drag`, `scroll`, `type_text`, `key`, `wait`, `screen_info`, and `power` when the policy allows it. Every coordinate is a pixel of the last full screenshot. Failures are tool results with `isError` and text `<code>: <what to do>`, never protocol errors.

## Approval

`risk.ts` decides on the arguments. With the default policy (`risky`) these ask: a bare super key, `ctrl+alt+Delete`, `alt+F4`, `ctrl+w`, `ctrl+shift+Delete`, `ctrl+alt+F1` to `F12`; any drag; typed text with a line break or over 200 characters; any input with no screenshot in the last 30 seconds. `always` asks before every input, `never` asks for none. `power` asks under every policy.

## Testing

`@pikvm/mcp/testing` has a fake desk, a scripted approver, and an MCP client that talks to the handler in process or to a URL over HTTP. `tests/agent-desk.test.ts` runs the whole stack against `tools/fake-kvmd`.
