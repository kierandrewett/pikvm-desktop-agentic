"""``pikvm-agent gui-mcp``: a stdio MCP server that hands tasks to cua.

The division of work, as Kieran set it: a higher-level model in any agent
harness (Claude Code, Codex, OpenCode, ...) thinks and writes the task; cua's
ComputerAgent does all of the computer use. So the server exposes no
screenshot, click or type tools, only tasks:

- ``run_computer_task``: start a task and wait up to ``wait_seconds``
- ``get_computer_task``: wait longer on a task, or read its progress
- ``stop_computer_task``: stop cua and release keys and buttons

A finished task returns a small screenshot of the final screen, so the
higher-level model can check the result before it writes the next task.

The tools exist only when PiKVM Desktop is an ancestor of this process,
meaning a harness started in its sidebar terminal (``gui_gate``), and every
call checks again. Anywhere else the server still starts, so a harness's
global registration stays quiet, but it offers no tools. Failure modes are
listed in ``tests/test_cua_gui_mcp.py``.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from pikvm_agent.cua import gui_gate
from pikvm_agent.cua.runner import DEFAULT_MODEL, RunResult, build_backend, run_task

log = logging.getLogger("pikvm_agent.cua")

_MAX_WAIT_SECONDS = 600
_SCREENSHOT_LONG_EDGE = 1024
_RECENT_MESSAGES = 8

Run = Callable[..., Awaitable[RunResult]]


@dataclass
class _Task:
    id: str
    task: str
    started: float
    runner: asyncio.Task[None] | None = None
    backend: Any = None
    status: str = "running"
    steps: int = 0
    messages: list[str] = field(default_factory=list)
    error: str | None = None
    finished: float | None = None
    screenshot: bytes | None = None


class TaskManager:
    """One cua task at a time against one machine."""

    def __init__(
        self,
        *,
        backend_factory: Callable[[], Any] = build_backend,
        run: Run = run_task,
        model: str | None = None,
        environment: str | None = None,
    ) -> None:
        self._backend_factory = backend_factory
        self._run = run
        self._model = model or os.environ.get("PIKVM_CUA_MODEL") or DEFAULT_MODEL
        self._environment = environment or os.environ.get("PIKVM_CUA_ENV") or "windows"
        self._tasks: dict[str, _Task] = {}

    def _running(self) -> _Task | None:
        return next((t for t in self._tasks.values() if t.status == "running"), None)

    def _lookup(self, task_id: str) -> _Task:
        record = self._tasks.get(task_id)
        if record is None:
            raise ValueError(f"unknown task {task_id!r}")
        return record

    @staticmethod
    def _view(record: _Task) -> dict[str, Any]:
        end = record.finished or time.monotonic()
        return {
            "task_id": record.id,
            "status": record.status,
            "steps": record.steps,
            "messages": record.messages[-_RECENT_MESSAGES:],
            "error": record.error,
            "elapsed_seconds": round(end - record.started, 1),
        }

    async def _wait(self, record: _Task, wait_seconds: float) -> dict[str, Any]:
        if record.runner is not None and not record.runner.done():
            wait = max(0.0, min(float(wait_seconds), _MAX_WAIT_SECONDS))
            await asyncio.wait({record.runner}, timeout=wait)
        return self._view(record)

    async def _execute(
        self, record: _Task, *, max_steps: int, budget_usd: float | None
    ) -> None:
        def on_event(kind: str, text: str) -> None:
            if kind == "action":
                record.steps += 1
            elif kind == "message":
                record.messages.append(text)

        try:
            record.backend = self._backend_factory()
            result = await self._run(
                record.task,
                backend=record.backend,
                model=self._model,
                environment=self._environment,
                max_steps=max_steps,
                max_budget_usd=budget_usd,
                on_event=on_event,
            )
            record.status = result.status
            record.steps = max(record.steps, result.steps)
            record.messages = result.messages or record.messages
            record.error = result.error
            record.screenshot = await _final_screenshot(record.backend)
        except asyncio.CancelledError:
            record.status = "stopped"
            raise
        except Exception as exc:  # noqa: BLE001 - reported to the caller as a status
            log.exception("[cua] task %s failed", record.id)
            record.status = "error"
            record.error = f"{type(exc).__name__}: {exc}"
        finally:
            record.finished = time.monotonic()
            await _close(record.backend)

    async def run(
        self,
        task: str,
        *,
        wait_seconds: float = 120,
        max_steps: int = 40,
        budget_usd: float | None = 2.0,
    ) -> dict[str, Any]:
        task = task.strip()
        if not task:
            raise ValueError("task is empty")
        busy = self._running()
        if busy is not None:
            raise ValueError(
                f"task {busy.id} is already running on this machine; "
                "wait for it with get_computer_task or stop it with stop_computer_task"
            )
        record = _Task(id=uuid.uuid4().hex[:12], task=task, started=time.monotonic())
        self._tasks[record.id] = record
        record.runner = asyncio.create_task(
            self._execute(record, max_steps=max_steps, budget_usd=budget_usd),
            name=f"cua-task-{record.id}",
        )
        log.info("[cua] task %s started (%d chars)", record.id, len(task))
        return await self._wait(record, wait_seconds)

    async def get(self, task_id: str, *, wait_seconds: float = 60) -> dict[str, Any]:
        return await self._wait(self._lookup(task_id), wait_seconds)

    async def stop(self, task_id: str) -> dict[str, Any]:
        record = self._lookup(task_id)
        if record.runner is not None and not record.runner.done():
            record.runner.cancel()
            await asyncio.wait({record.runner}, timeout=10)
            record.status = "stopped"
            log.info("[cua] task %s stopped", record.id)
        if record.backend is not None:
            try:
                await record.backend.release_all()
            except Exception:  # noqa: BLE001 - best effort after a stop
                log.warning("[cua] release_all after stop failed", exc_info=True)
        return self._view(record)

    def screenshot(self, task_id: str) -> bytes | None:
        return self._lookup(task_id).screenshot


async def _final_screenshot(backend: Any) -> bytes | None:
    try:
        frame = await backend.screenshot()
        return await asyncio.to_thread(_small_jpeg, frame.data)
    except Exception:  # noqa: BLE001 - a missing picture must not fail the task
        log.warning("[cua] final screenshot failed", exc_info=True)
        return None


def _small_jpeg(data: bytes) -> bytes:
    from PIL import Image

    image = Image.open(io.BytesIO(data)).convert("RGB")
    image.thumbnail((_SCREENSHOT_LONG_EDGE, _SCREENSHOT_LONG_EDGE))
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=70)
    return out.getvalue()


async def _close(backend: Any) -> None:
    close = getattr(backend, "aclose", None)
    if close is None:
        return
    try:
        await close()
    except Exception:  # noqa: BLE001
        log.warning("[cua] closing the backend failed", exc_info=True)


def build_server(ticket: str | None, manager: TaskManager | None = None) -> Any:
    """The server, with the task tools only when the gate passes now."""
    import base64

    from mcp.server.fastmcp import FastMCP
    from mcp.types import ImageContent, TextContent

    try:
        gui_gate.verify(ticket)
    except gui_gate.GateError as exc:
        log.info("[pikvm gui-mcp] no tools: %s", exc)
        return FastMCP("pikvm", instructions=f"Unavailable here: {exc}.")

    tasks = manager or TaskManager()
    server = FastMCP(
        "pikvm",
        instructions=(
            "Operate a physical computer (seen through a PiKVM) by giving tasks to a "
            "computer-use agent (cua). You do not click or type yourself. Write each task "
            "as plain instructions with one goal and a visible way to tell it is done, "
            "for example 'Open Notepad, type the line \"hello\", and leave the window "
            "open'. Break large jobs into several tasks and check each result (its "
            "messages and final screenshot) before writing the next."
        ),
    )

    def answer(view: dict[str, Any]) -> list[Any]:
        import json

        content: list[Any] = [TextContent(type="text", text=json.dumps(view, indent=2))]
        picture = tasks.screenshot(view["task_id"]) if view["status"] != "running" else None
        if picture:
            content.append(
                ImageContent(
                    type="image",
                    data=base64.b64encode(picture).decode("ascii"),
                    mimeType="image/jpeg",
                )
            )
        return content

    @server.tool()
    async def run_computer_task(
        task: str, wait_seconds: int = 120, max_steps: int = 40
    ) -> list[Any]:
        """Give a task to the computer-use agent and wait up to wait_seconds (max 600).

        Returns status "running" with a task_id if it is not finished yet; call
        get_computer_task to keep waiting. When it finishes, the result has
        cua's messages and a screenshot of the final screen. Only one task runs
        at a time. Status is one of running, done, max_steps, error, stopped.
        """
        gui_gate.verify(ticket)
        return answer(await tasks.run(task, wait_seconds=wait_seconds, max_steps=max_steps))

    @server.tool()
    async def get_computer_task(task_id: str, wait_seconds: int = 60) -> list[Any]:
        """Wait up to wait_seconds (max 600) for a task, then return its progress or result."""
        gui_gate.verify(ticket)
        return answer(await tasks.get(task_id, wait_seconds=wait_seconds))

    @server.tool()
    async def stop_computer_task(task_id: str) -> list[Any]:
        """Stop a running task now and release any held keys or mouse buttons."""
        gui_gate.verify(ticket)
        return answer(await tasks.stop(task_id))

    return server


async def serve(ticket: str | None) -> None:
    """Serve over stdio with the protocol on its own copy of stdout.

    cua, LiteLLM and qwen-agent can print to stdout, which would corrupt the
    MCP stream. fd 1 is pointed at stderr for everything else, and the
    protocol writes to a private duplicate of the original stdout.
    """
    from io import TextIOWrapper

    import anyio
    from mcp.server.stdio import stdio_server

    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    protocol_out = anyio.wrap_file(
        TextIOWrapper(os.fdopen(protocol_fd, "wb"), encoding="utf-8")
    )
    server = build_server(ticket)
    # FastMCP.run_stdio_async does exactly this, but with no way to pass stdout.
    low_level = server._mcp_server
    async with stdio_server(stdout=protocol_out) as (read_stream, write_stream):
        await low_level.run(
            read_stream, write_stream, low_level.create_initialization_options()
        )


def main(ticket: str | None) -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(message)s", stream=sys.stderr, force=True
    )
    os.environ.setdefault("CUA_TELEMETRY_ENABLED", "false")
    # Loads ~/.config/pikvm-agent/.env (model API keys, PiKVM credentials)
    # whichever backend a task later uses.
    from pikvm_agent.config import load_config

    load_config()
    asyncio.run(serve(ticket))
    return 0
