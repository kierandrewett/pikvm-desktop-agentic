"""The GUI-only cua MCP server: gate, task lifecycle, and the real stdio path.

Kieran's design (2026-10-05): a higher-level model (Claude, GPT, ...) in any
agent harness writes the task; cua does all of the computer use. The server
must only work from a terminal inside PiKVM Desktop.

Failure modes, written before the code:

1. Started outside the GUI (no token in the environment): refuse, exit
   non-zero, say why on stderr.
2. Wrong token, missing ticket, or a ticket another user could read: refuse.
3. A ticket left by an earlier app run whose process is gone: refuse.
4. The app quits after the server started: every later tool call refuses.
5. A library prints to stdout and corrupts the MCP stream.
6. A second task while one is running: refused clearly, one machine.
7. A task that outlives the client's tool timeout: the call returns
   "running" with an id, and get_computer_task waits for more.
8. The higher model wants cua to stop: stop cancels and releases HID.
9. An unknown task id: a clear error.
10. cua fails (no API key, provider error): status "error" with the
    message, not a crashed server.
11. The token appears in a log or a tool result.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from pikvm_agent.cua import gui_gate
from pikvm_agent.cua.gui_mcp import TaskManager
from pikvm_agent.cua.runner import RunResult
from pikvm_agent.pikvm.fake import FakeBackend

TOKEN = "a" * 64


def _ticket(path: Path, *, pid: int | None = None, token: str = TOKEN, mode: int = 0o600) -> Path:
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "desktop_pid": os.getpid() if pid is None else pid,
                "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
            }
        )
    )
    path.chmod(mode)
    return path


def _env(ticket: Path, token: str = TOKEN) -> dict[str, str]:
    return {gui_gate.TICKET_ENV: str(ticket), gui_gate.TOKEN_ENV: token}


# 1, 2, 3


def test_gate_accepts_a_live_matching_ticket(tmp_path: Path) -> None:
    gui_gate.verify(_env(_ticket(tmp_path / "t.json")))


@pytest.mark.parametrize(
    "case",
    ["no-env", "wrong-token", "missing-ticket", "readable-by-others", "dead-app", "garbage"],
)
def test_gate_refuses(tmp_path: Path, case: str) -> None:
    ticket = tmp_path / "t.json"
    if case == "no-env":
        env: dict[str, str] = {}
    elif case == "wrong-token":
        env = _env(_ticket(ticket), token="b" * 64)
    elif case == "missing-ticket":
        env = _env(ticket)
    elif case == "readable-by-others":
        env = _env(_ticket(ticket, mode=0o644))
    elif case == "dead-app":
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        env = _env(_ticket(ticket, pid=dead.pid))
    else:
        ticket.write_text("not json")
        ticket.chmod(0o600)
        env = _env(ticket)
    with pytest.raises(gui_gate.GateError) as err:
        gui_gate.verify(env)
    assert TOKEN not in str(err.value)  # 11


# 6, 7, 8, 9, 10


class _Runs:
    """Stands in for runner.run_task so lifecycle tests make no model call."""

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.started = asyncio.Event()
        self.fail: str | None = None

    async def __call__(self, task: str, **kwargs) -> RunResult:
        self.started.set()
        if self.fail:
            raise RuntimeError(self.fail)
        await self.release.wait()
        return RunResult(status="done", steps=3, messages=[f"did: {task}"])


def _manager(runs: _Runs) -> TaskManager:
    return TaskManager(backend_factory=FakeBackend, run=runs)


async def test_task_finishes_within_the_wait() -> None:
    runs = _Runs()
    runs.release.set()
    result = await _manager(runs).run("open notepad", wait_seconds=5)
    assert result["status"] == "done"
    assert result["steps"] == 3
    assert result["messages"] == ["did: open notepad"]


async def test_long_task_returns_running_then_finishes() -> None:
    runs = _Runs()
    manager = _manager(runs)
    first = await manager.run("long job", wait_seconds=0.05)
    assert first["status"] == "running"
    runs.release.set()
    second = await manager.get(first["task_id"], wait_seconds=5)
    assert second["status"] == "done"


async def test_second_task_is_refused_while_one_runs() -> None:
    runs = _Runs()
    manager = _manager(runs)
    await manager.run("first", wait_seconds=0.05)
    with pytest.raises(ValueError, match="already running"):
        await manager.run("second", wait_seconds=0.05)
    runs.release.set()


async def test_stop_cancels_and_releases_hid() -> None:
    runs = _Runs()
    backend = FakeBackend()
    manager = TaskManager(backend_factory=lambda: backend, run=runs)
    first = await manager.run("long job", wait_seconds=0.05)
    stopped = await manager.stop(first["task_id"])
    assert stopped["status"] == "stopped"
    assert ("release_all", {}) in backend.calls
    # A stopped task frees the machine for the next one.
    runs.release.set()
    assert (await manager.run("next", wait_seconds=5))["status"] == "done"


async def test_unknown_task_id() -> None:
    with pytest.raises(ValueError, match="unknown task"):
        await _manager(_Runs()).get("nope", wait_seconds=0)


async def test_runner_failure_is_a_status_not_a_crash() -> None:
    runs = _Runs()
    runs.fail = "OPENROUTER_API_KEY is not set"
    result = await _manager(runs).run("anything", wait_seconds=5)
    assert result["status"] == "error"
    assert "OPENROUTER_API_KEY" in result["error"]


# 1, 4, 5: the real process over real stdio


def _server_env(ticket: Path, token: str = TOKEN) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("PIKVM_GUI_MCP")}
    env.update(_env(ticket, token))
    env["PIKVM_AGENT_FAKE"] = "1"
    env["CUA_TELEMETRY_ENABLED"] = "false"
    return env


def test_server_refuses_to_start_outside_the_gui(tmp_path: Path) -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith("PIKVM_GUI_MCP")}
    proc = subprocess.run(
        [sys.executable, "-m", "pikvm_agent.cli", "gui-mcp"],
        env=env,
        input="",
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 2
    assert "inside PiKVM Desktop" in proc.stderr
    assert proc.stdout == ""


async def test_server_over_stdio_lists_tools_and_refuses_after_app_quits(tmp_path: Path) -> None:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    app = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        ticket = _ticket(tmp_path / "t.json", pid=app.pid)
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "pikvm_agent.cli", "gui-mcp"],
            env=_server_env(ticket),
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = {tool.name for tool in (await session.list_tools()).tools}
                assert tools == {"run_computer_task", "get_computer_task", "stop_computer_task"}

                missing = await session.call_tool("get_computer_task", {"task_id": "nope"})
                assert missing.isError
                assert "unknown task" in str(missing.content)

                app.kill()
                app.wait()
                gone = await session.call_tool("get_computer_task", {"task_id": "nope"})
                assert gone.isError
                assert "PiKVM Desktop" in str(gone.content)
                assert TOKEN not in str(gone.content)
    finally:
        if app.poll() is None:
            app.kill()
            app.wait()
