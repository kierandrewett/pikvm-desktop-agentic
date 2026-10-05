"""Run one task with cua's ComputerAgent on a PiKVM target.

This is the whole loop on our side: build the computer, hand cua the task,
stream what it does, and stop at a step or cost limit. cua decides each
action; PiKVMComputer carries it out. See docs/CUA.md.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from pikvm_agent.cua import qwen_shim
from pikvm_agent.cua.computer import Confirm, Environment, PiKVMComputer

log = logging.getLogger("pikvm_agent.cua")

# Works with only OPENROUTER_API_KEY: cua's Qwen3-VL loop uses plain function
# calling, which OpenRouter passes through. Claude's native computer tool is
# the stronger choice when ANTHROPIC_API_KEY is set
# (model "anthropic/claude-sonnet-4-5").
DEFAULT_MODEL = "openrouter/qwen/qwen3-vl-235b-a22b-instruct"

INSTRUCTIONS = """\
You operate a physical computer through an IP-KVM. You only see screenshots
of its display and you only control a USB keyboard and mouse. You cannot run
code on it except by typing into its own programs. Act like a careful person
at the keyboard: look at the latest screenshot before each action, prefer
keyboard shortcuts when they are reliable, and wait for the screen to change
after launching something. Do not send messages, make purchases, delete
data, or change security settings unless the task explicitly asks for it.
When the task is done, or cannot be done, say so plainly and stop."""


@dataclass
class RunResult:
    status: str  # "done" | "max_steps" | "error"
    steps: int = 0
    messages: list[str] = field(default_factory=list)
    error: str | None = None


def _disable_cua_telemetry() -> None:
    os.environ.setdefault("CUA_TELEMETRY_ENABLED", "false")


def _assistant_text(item: dict[str, Any]) -> str:
    if item.get("type") != "message":
        return ""
    parts = item.get("content") or []
    return "".join(
        str(part.get("text", "")) for part in parts if isinstance(part, dict)
    ).strip()


async def run_task(
    task: str,
    *,
    backend: Any,
    model: str = DEFAULT_MODEL,
    environment: Environment = "windows",
    max_steps: int = 40,
    max_budget_usd: float | None = 2.0,
    trajectory_dir: Path | None = None,
    confirm: Confirm | None = None,
    on_event: Callable[[str, str], None] | None = None,
) -> RunResult:
    """Run ``task`` until the model stops, ``max_steps`` actions, or the budget."""
    _disable_cua_telemetry()
    qwen_shim.install()
    from cua_agent import ComputerAgent

    emit = on_event or (lambda kind, text: None)
    computer = PiKVMComputer(backend, environment=environment, confirm=confirm)
    agent = ComputerAgent(
        model=model,
        tools=[computer],
        instructions=INSTRUCTIONS,
        only_n_most_recent_images=3,
        trajectory_dir=str(trajectory_dir) if trajectory_dir else None,
        max_trajectory_budget=(
            {"max_budget": max_budget_usd, "raise_error": True}
            if max_budget_usd
            else None
        ),
        telemetry_enabled=False,
        screenshot_delay=0.5,
    )
    result = RunResult(status="done")
    try:
        async for chunk in agent.run([{"role": "user", "content": task}]):
            for item in chunk.get("output", []):
                kind = item.get("type")
                if kind == "computer_call":
                    result.steps += 1
                    emit("action", str(item.get("action")))
                elif kind == "message" and (text := _assistant_text(item)):
                    result.messages.append(text)
                    emit("message", text)
                elif kind == "reasoning":
                    summary = item.get("summary") or []
                    text = " ".join(str(s.get("text", "")) for s in summary if isinstance(s, dict))
                    if text.strip():
                        emit("reasoning", text.strip())
            if result.steps >= max_steps:
                result.status = "max_steps"
                break
    except Exception as exc:  # noqa: BLE001 - reported to the caller, not swallowed
        log.exception("[cua] run failed")
        result.status = "error"
        result.error = f"{type(exc).__name__}: {exc}"
    finally:
        try:
            await backend.release_all()
        except Exception:  # noqa: BLE001
            log.warning("[cua] release_all after run failed", exc_info=True)
    return result
