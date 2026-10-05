# gui-mcp over real stdio, fake screen, real model

Date: 2026-10-05. Branch `feat/cua-agent`. No PiKVM was contacted.

## Command

```sh
cd agent
python bench/results/2026-10-05/cua/gui-mcp-stdio-fake/drive.py \
  bench/results/2026-10-05/cua/gui-mcp-stdio-fake/final-screen.jpg
```

`drive.py` plays both the desktop and the harness: it writes an owner-only
ticket naming its own pid, starts `pikvm-agent gui-mcp --ticket <ticket>` as
its child (so the ancestry gate passes, as it does for a harness started in
the sidebar), then calls `run_computer_task` once.

Rerun after the gate moved from an environment token to process ancestry:
`status: done`, 2 steps, 12.1 s. The first-run numbers below are kept.

## Environment

- venv synced from `agent/uv.lock` with `--extra cua --extra dev`
- `PIKVM_AGENT_FAKE=1` (FakeBackend, 1280x720)
- default model `openrouter/qwen/qwen3-vl-235b-a22b-instruct`, key from
  `~/.config/pikvm-agent/.env`

## Result

- `status: done`, 2 steps, 14.7 s, final screenshot attached as JPEG
  (`final-screen.jpg`); full tool result in `run.log`
- `server-stderr.log` has the LiteLLM and cua output that would have
  corrupted the MCP stream if it had gone to stdout; the session stayed
  intact

## Bug this run found

The first attempt returned `status: error` with an OpenRouter 401. With the
fake screen, `gui-mcp` never called `load_config()`, so
`~/.config/pikvm-agent/.env` was not loaded. Fixed by loading the config in
`gui_mcp.main()` before serving.
