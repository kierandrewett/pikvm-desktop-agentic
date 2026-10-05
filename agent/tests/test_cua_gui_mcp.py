"""The GUI-only cua MCP server: gate, task lifecycle, and the real stdio path.

Kieran's design (2026-10-05): a higher-level model (Claude, GPT, ...) in any
agent harness writes the task; cua does all of the computer use. Any harness
started inside PiKVM Desktop's sidebar terminal can use the server; nothing
else can.

The gate is process ancestry, not an environment token: Codex passes MCP
servers only an allow-list of variables and Gemini strips names containing
TOKEN, so a token in the environment would silently not arrive. A harness
started in the sidebar is a descendant of the desktop process, and so is the
MCP server it spawns.

Failure modes, written before the code:

1. Started outside the sidebar (desktop is not an ancestor): the server
   still starts, so a global registration is quiet elsewhere, but it has no
   tools.
2. Missing ticket, or a ticket another user could read: no tools.
3. A ticket left by an earlier app run whose process is gone: no tools.
4. The app quits after the server started: every later tool call refuses.
5. A library prints to stdout and corrupts the MCP stream.
6. A second task while one is running: refused clearly, one machine.
7. A task that outlives the client's tool timeout: the call returns
   "running" with an id, and get_computer_task waits for more.
8. The higher model wants cua to stop: stop cancels and releases HID.
9. An unknown task id: a clear error.
10. cua fails (no API key, provider error): status "error" with the
    message, not a crashed server.
11. The ancestry walk loops or runs away on a strange process table.
"""

from __future__ import annotations

import asyncio
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

TOOLS = {"run_computer_task", "get_computer_task", "stop_computer_task"}


def _ticket(path: Path, *, pid: int | None = None, mode: int = 0o600) -> Path:
    path.write_text(
        json.dumps({"schema_version": 2, "desktop_pid": os.getpid() if pid is None else pid})
    )
    path.chmod(mode)
    return path


def _sleeper() -> subprocess.Popen[bytes]:
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])


# 1, 2, 3, 11


def test_gate_accepts_when_the_desktop_is_an_ancestor(tmp_path: Path) -> None:
    # This test process stands in for the desktop: it is our own ancestor-or-self.
    gui_gate.verify(str(_ticket(tmp_path / "t.json")))


def test_ancestry_includes_self_and_parent() -> None:
    chain = gui_gate.ancestors(os.getpid())
    assert chain[0] == os.getpid()
    assert os.getppid() in chain


@pytest.mark.parametrize(
    "case",
    ["no-ticket-arg", "missing-ticket", "readable-by-others", "dead-app", "not-an-ancestor", "garbage"],
)
def test_gate_refuses(tmp_path: Path, case: str) -> None:
    ticket = tmp_path / "t.json"
    other = None
    if case == "no-ticket-arg":
        path = None
    elif case == "missing-ticket":
        path = str(ticket)
    elif case == "readable-by-others":
        path = str(_ticket(ticket, mode=0o644))
    elif case == "dead-app":
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        path = str(_ticket(ticket, pid=dead.pid))
    elif case == "not-an-ancestor":
        other = _sleeper()
        path = str(_ticket(ticket, pid=other.pid))
    else:
        ticket.write_text("not json")
        ticket.chmod(0o600)
        path = str(ticket)
    try:
        with pytest.raises(gui_gate.GateError):
            gui_gate.verify(path)
    finally:
        if other is not None:
            other.kill()
            other.wait()


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


def _server_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PIKVM_AGENT_FAKE"] = "1"
    env["CUA_TELEMETRY_ENABLED"] = "false"
    return env


async def _tool_names(params) -> set[str]:
    from mcp import ClientSession
    from mcp.client.stdio import stdio_client

    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return {tool.name for tool in (await session.list_tools()).tools}


async def test_outside_the_sidebar_the_server_runs_with_no_tools(tmp_path: Path) -> None:
    from mcp import StdioServerParameters

    stranger = _sleeper()
    try:
        ticket = _ticket(tmp_path / "t.json", pid=stranger.pid)
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "pikvm_agent.cli", "gui-mcp", "--ticket", str(ticket)],
            env=_server_env(),
        )
        assert await _tool_names(params) == set()
    finally:
        stranger.kill()
        stranger.wait()


async def test_inside_the_sidebar_tools_work_until_the_desktop_quits(tmp_path: Path) -> None:
    """sh plays the desktop: it writes the ticket with its own pid, then runs
    the server as its child and stays alive as its parent until killed."""
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    ticket = tmp_path / "t.json"
    pidfile = tmp_path / "desktop.pid"
    script = (
        'umask 077; echo $$ > "$PIDFILE"; '
        'printf \'{"schema_version": 2, "desktop_pid": %s}\' $$ > "$TICKET"; '
        '"$PY" -m pikvm_agent.cli gui-mcp --ticket "$TICKET"; true'
    )
    env = {**_server_env(), "PIDFILE": str(pidfile), "TICKET": str(ticket), "PY": sys.executable}
    params = StdioServerParameters(command="/bin/sh", args=["-c", script], env=env)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            assert {t.name for t in (await session.list_tools()).tools} == TOOLS

            missing = await session.call_tool("get_computer_task", {"task_id": "nope"})
            assert missing.isError
            assert "unknown task" in str(missing.content)

            os.kill(int(pidfile.read_text()), 9)
            await asyncio.sleep(0.3)
            gone = await session.call_tool("get_computer_task", {"task_id": "nope"})
            assert gone.isError
            assert "PiKVM Desktop" in str(gone.content)
