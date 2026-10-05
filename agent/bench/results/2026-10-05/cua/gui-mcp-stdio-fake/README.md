# gui-mcp over real stdio, fake screen, real model

Date: 2026-10-05. Branch `feat/cua-agent`. No PiKVM was contacted.

## Command

```sh
cd agent
python bench/results/2026-10-05/cua/gui-mcp-stdio-fake/drive.py \
  bench/results/2026-10-05/cua/gui-mcp-stdio-fake/final-screen.jpg
```

`drive.py` plays the harness: it starts `pikvm-agent gui-mcp` as an MCP
stdio server, with a stand-in desktop process and an owner-only ticket for
the GUI gate, then calls `run_computer_task` once.

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
