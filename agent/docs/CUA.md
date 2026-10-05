# cua computer-use loop

The `cua` path drives PiKVM with [trycua/cua](https://github.com/trycua/cua)'s
`ComputerAgent` instead of the first-party `AgentHarness`. cua owns the
reason-act loop and the model-specific action formats. We own one thin object,
`PiKVMComputer` (`pikvm_agent/cua/computer.py`), that turns cua's computer
actions into PiKVM HID calls on the existing `PiKVMBackend`.

```text
ComputerAgent (cua, any supported model)
  -> PiKVMComputer (screenshot, click, type, keypress, scroll, drag, ...)
    -> PiKVMBackend (HID websocket + snapshot HTTP)
      -> PiKVM -> target machine
```

## Usage

```sh
cd agent
uv sync --extra cua            # into whichever venv runs the agent
pikvm-agent cua run "Open Notepad and type hello"            # live PiKVM
pikvm-agent cua run "Click the word desktop" --fake          # no hardware
pikvm-agent cua run "..." --model anthropic/claude-sonnet-4-5 --confirm
```

Options: `--env windows|mac|linux|browser` (default `windows`),
`--max-steps` (40), `--budget` USD (2.0, `0` for no limit), `--confirm`
(ask before each action), `--trajectory-dir` (screenshots and model turns).
PiKVM credentials and `OPENROUTER_API_KEY` come from
`~/.config/pikvm-agent/.env` as usual.

## From any agent harness: the GUI-only MCP server

`pikvm-agent gui-mcp` is a stdio MCP server named `pikvm`. A higher-level
model in your harness writes the task; cua does all of the computer use. It
has three tools:

| Tool | Does |
| --- | --- |
| `run_computer_task(task, wait_seconds=120, max_steps=40)` | Start a task and wait up to `wait_seconds` (max 600). Returns `running` with a `task_id` if it is not finished. |
| `get_computer_task(task_id, wait_seconds=60)` | Wait more, or read progress (steps, cua's last messages). |
| `stop_computer_task(task_id)` | Stop cua now and release held keys and buttons. |

A finished task returns cua's messages and a small JPEG of the final screen.
One task runs at a time.

Any harness started in the sidebar terminal can use it; nothing else can.
At startup the desktop writes an owner-only ticket naming its pid
(`<settings dir>/gui-mcp/gui-mcp.json`) and a wrapper next to it,
`<settings dir>/gui-mcp/bin/pikvm-gui-mcp`, which runs
`pikvm-agent gui-mcp --ticket <ticket>`. The server has tools only when that
desktop process is one of its ancestors, and checks again on every call
(`pikvm_agent/cua/gui_gate.py`, `src/gui-mcp.ts`). Elsewhere it starts with
no tools, so a global registration stays quiet.

Ancestry rather than an environment token, because Codex passes MCP servers
only an allow-list of variables and Gemini strips names containing TOKEN.
Limits: a harness inside tmux or screen in the sidebar is refused (the
multiplexer server is not a child of the desktop), and this is not a
boundary against code running as the same user.

Register the wrapper once per harness, by its absolute path. On Linux the
settings dir is `~/.config/PiKVM Desktop`; PiKVM Desktop logs the exact
path at start (`[gui-mcp] register this as the pikvm MCP server: ...`).

```sh
W="$HOME/.config/PiKVM Desktop/gui-mcp/bin/pikvm-gui-mcp"
claude mcp add --scope user pikvm -- "$W"
codex mcp add pikvm -- "$W"
gemini mcp add --scope user pikvm "$W"
```

For OpenCode, add to `~/.config/opencode/opencode.json`:
`"mcp": {"pikvm": {"type": "local", "command": ["<W>"]}}`.

Settings, from the environment or `~/.config/pikvm-agent/.env`:
`PIKVM_CUA_MODEL` (default below), `PIKVM_CUA_ENV` (`windows`).

## Models

cua picks its loop from the model string.

| Model string | cua loop | Key | Notes |
| --- | --- | --- | --- |
| `openrouter/qwen/qwen3-vl-235b-a22b-instruct` (default) | Qwen3-VL | `OPENROUTER_API_KEY` | Plain function calling, so OpenRouter works. Checked end to end on the fake screen. |
| `anthropic/claude-sonnet-4-5` | Anthropic computer tool | `ANTHROPIC_API_KEY` | cua's most used loop. Not run here (no key). |
| `openrouter/anthropic/claude-...` | Anthropic computer tool | `OPENROUTER_API_KEY` | Not checked. The native computer tool may not pass through OpenRouter. |
| `openai/computer-use-preview` | OpenAI Responses | `OPENAI_API_KEY` | Not run here. |

The Qwen-family loops import `smart_resize` from `qwen_vl_utils`, which loads
torch. `pikvm_agent/cua/qwen_shim.py` supplies that one function without
torch when the real package cannot import. Its output is checked against the
installed upstream source in `tests/test_cua_qwen_shim.py`.

## What this path does not do

This path does not go through the daemon. That means it has none of these:

- the daemon policy gate and the approval queue
- the stale-frame refusal (`based_on_world_version`)
- watched typing with OCR read-back
- the daemon trace log (cua writes its own trajectory instead)

Every action is logged with a `[cua]` prefix, and the optional confirm hook
can hold an action for a human decision. That hook is a basic guard, not a
replacement for the daemon policy.

## Failure modes

This list was written before the code and the isolated tests. Each item has a
test in `tests/test_cua_computer.py`.

1. **Size mismatch.** `get_dimensions()` does not equal the size of the
   screenshot the model saw, so every click lands in the wrong place.
2. **Dimensions before the first screenshot.** A loop calls
   `get_dimensions()` first and gets the backend's 1920x1080 placeholder
   instead of the real, downscaled frame size.
3. **Wrong image type.** cua labels every screenshot `image/png`. A JPEG
   frame under a PNG label can be refused by the provider.
4. **Coordinates out of range.** A model returns a point outside the frame,
   and the HID move goes to the screen edge or fails.
5. **Key names.** Loops send `"ctrl+s"` as one string, `["ctrl", "s"]` as a
   list, X11 names (`Return`, `Page_Down`, `super`, `KP_Enter`), or a single
   upper-case letter. An unknown name must fail loudly, not do nothing.
6. **Newlines in typed text.** The backend turns newlines into spaces. cua
   models expect `"\n"` to press Enter, so the line structure is lost.
7. **Slow typing.** Per-key humanised typing makes long text very slow.
8. **Stuck modifiers or buttons.** An error during a chord or a drag leaves
   Shift, Ctrl or the left button held on the target.
9. **Scroll direction and units.** cua uses `scroll_y > 0` for down. The
   backend uses `dy > 0` for up. OpenAI sends pixels (hundreds), Anthropic
   sends wheel clicks (single digits).
10. **Scroll position.** A scroll at `(x, y)` scrolls whatever is under the
    old cursor position if the pointer does not move first.
11. **Drag edge cases.** An empty path or a one-point path.
12. **HID not connected.** The first action fails because the websocket was
    never opened.
13. **Wrong environment.** `get_environment()` reports `linux` for a Windows
    target, and the model uses the wrong shortcuts.
14. **Refused action.** The confirm hook refuses an action, and the action
    still reaches the HID.

## Known cua behaviour to keep in mind

- cua's UI-TARS v1 loop sends `scroll_y > 0` for **up**, against the other
  loops. Prefer Claude, OpenAI, Gemini or Qwen3-VL until this is checked.
- cua acknowledges OpenAI `pending_safety_checks` automatically.
- cua telemetry is on by default. `pikvm-agent cua run` turns it off.
