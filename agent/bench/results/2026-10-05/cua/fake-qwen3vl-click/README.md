# cua end to end on the fake screen (Qwen3-VL via OpenRouter)

Date: 2026-10-05. Branch `feat/cua-agent`. No PiKVM was contacted.

## Command

```sh
cd agent
CUA_TELEMETRY_ENABLED=false pikvm-agent cua run \
  "Click on the word 'desktop' shown on the screen, then stop." \
  --fake --max-steps 3 --budget 0.10 \
  --trajectory-dir bench/results/2026-10-05/cua/fake-qwen3vl-click/trajectory
```

## Environment

- venv synced from `agent/uv.lock` with `--extra cua --extra dev` (Python 3.12.14)
- `cua-agent` 0.9.0, `litellm` 1.86.2, torch not installed
  (the `qwen_vl_utils` shim supplied `smart_resize`)
- model `openrouter/qwen/qwen3-vl-235b-a22b-instruct` (the default)
- backend `FakeBackend` 1280x720

## Result

- exit 0, `{"status": "done", "steps": 2, "error": null}`
- both clicks at (35, 82) and (35, 80); `click-check.png` marks the first on
  the screenshot the model saw, and it is on the word
- full log in `run.log`, every screenshot and model turn in `trajectory/`

## What this does not show

The fake screen is static, so it shows the wiring and the coordinate mapping
only. It says nothing about task success on a real desktop.
