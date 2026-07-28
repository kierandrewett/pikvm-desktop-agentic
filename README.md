# PiKVM Desktop

A chat-first desktop workspace for supervised computer use. Bring an OAuth- or
API-backed model, connect a managed PiKVM/VNC target, ask for an outcome in
plain language, and watch planning, exact tool calls, screen transitions,
verification, and approvals in one conversation.

The desktop owns two local services:

- the provider-neutral chat and operator harness;
- the machine-control daemon selected at runtime.

The model never receives a VNC address, PiKVM credential, browser token, or
approval capability. Normal Claude MCP compatibility exposes only the five
high-level managed computer controls. The first-party harness—not Claude
Code—plans, selects bounded input, verifies the resulting frame, and handles
recovery. Guarded direct MCP remains available only with the explicit
`--control-mode direct` launcher argument.

## Development

```bash
npm install
npm run build
npm test
npm start
```

`PIKVM_AGENT_DAEMON`, `PIKVM_HARNESS_ORIGIN`, `PIKVM_AGENT_CONFIG`, and
`PIKVM_HARNESS_CONFIG` select local runtime services without hard-coding a
computer endpoint. Use `PIKVM_AGENT_FAKE=1` for target-free development.

The ordinary MCP entrypoint is:

```bash
node dist/mcp-launcher.js \
  --runtime "/path/to/owner-only/harness-runtime.json" \
  --caller-label claude-cli
```

The default launches `harness managed-mcp`. Direct compatibility must be
requested deliberately:

```bash
node dist/mcp-launcher.js \
  --runtime "/path/to/owner-only/harness-runtime.json" \
  --caller-label claude-cli \
  --control-mode direct
```

The runtime handoff is mode `0600`, tied to the live desktop process, and never
contains the browser operator token or daemon approval capability.
