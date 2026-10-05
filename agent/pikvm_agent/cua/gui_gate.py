"""Proof that this process was started from inside PiKVM Desktop.

At startup the desktop writes an owner-only ticket:

    {"schema_version": 2, "desktop_pid": 1234}

and a wrapper, ``<settings dir>/gui-mcp/bin/pikvm-gui-mcp``, that runs
``pikvm-agent gui-mcp --ticket <that ticket>``. Harnesses register the
wrapper as their ``pikvm`` MCP server once. The server is usable only when
the desktop process named in the ticket is alive and is an ancestor of the
server: a harness started in the sidebar terminal is a child of the desktop's
shell, and it spawns the server as its own child.

Ancestry, not an environment token, because harnesses filter what they pass
to MCP servers: Codex forwards an allow-list of variables, and Gemini strips
names that contain TOKEN. A token would silently fail to arrive in exactly
those harnesses.

Known limit: a harness inside tmux or screen in the sidebar fails, because
the multiplexer's server is not a child of the desktop. This is not a
boundary against code running as the same user.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
from pathlib import Path

_MAX_TICKET_BYTES = 4096
_MAX_HOPS = 128
OUTSIDE = (
    "the pikvm MCP server only works for an agent harness started from the "
    "terminal in PiKVM Desktop's sidebar"
)


class GateError(RuntimeError):
    """The process was not started from inside a running PiKVM Desktop."""


def _parent(pid: int) -> int | None:
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii") as handle:
            # Field 4. The command name in field 2 can contain spaces and ")".
            return int(handle.read().rsplit(")", 1)[-1].split()[1])
    except FileNotFoundError:
        if not Path("/proc/self/stat").exists():
            return _parent_from_ps(pid)  # macOS: no /proc
        return None
    except (OSError, ValueError, IndexError):
        return None


def _parent_from_ps(pid: int) -> int | None:
    try:
        out = subprocess.run(
            ["ps", "-o", "ppid=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        ).stdout.strip()
        return int(out) if out else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def ancestors(pid: int) -> list[int]:
    """``pid`` and its parents up to init, stopping on a loop or after 128 hops."""
    chain = [pid]
    while len(chain) < _MAX_HOPS:
        parent = _parent(chain[-1])
        if parent is None or parent <= 0 or parent in chain:
            break
        chain.append(parent)
    return chain


def verify(ticket_path: str | None) -> None:
    """Raise GateError unless the ticket's desktop is alive and our ancestor."""
    if not ticket_path:
        raise GateError(OUTSIDE)
    path = Path(ticket_path)
    if not path.is_absolute():
        raise GateError("--ticket must be an absolute path")
    try:
        info = path.lstat()
    except OSError:
        raise GateError(
            "PiKVM Desktop's MCP ticket is missing; start PiKVM Desktop"
        ) from None
    if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_TICKET_BYTES:
        raise GateError("PiKVM Desktop's MCP ticket is not a small regular file")
    if os.name == "posix":
        if info.st_mode & 0o077:
            raise GateError("PiKVM Desktop's MCP ticket must be readable by its owner only")
        if info.st_uid != os.getuid():
            raise GateError("PiKVM Desktop's MCP ticket belongs to another user")
    try:
        ticket = json.loads(path.read_text(encoding="utf-8"))
        if ticket.get("schema_version") != 2:
            raise ValueError("schema_version")
        desktop = int(ticket["desktop_pid"])
    except (ValueError, KeyError, TypeError, AttributeError, OSError):
        raise GateError("PiKVM Desktop's MCP ticket is unreadable") from None
    if desktop <= 1:
        raise GateError("PiKVM Desktop's MCP ticket is unreadable")
    if desktop not in ancestors(os.getpid()):
        raise GateError(OUTSIDE + " (PiKVM Desktop is not running, or this harness was not started from it)")
