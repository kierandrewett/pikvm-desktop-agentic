"""Proof that this process was started from a terminal inside PiKVM Desktop.

At startup the desktop writes an owner-only ticket into its run directory:

    {"schema_version": 1, "desktop_pid": 1234, "token_sha256": "<hex>"}

and gives the token itself only to the shells in its terminal panel, as
``PIKVM_GUI_MCP_TOKEN``, with the ticket path in ``PIKVM_GUI_MCP_TICKET``. A
harness started in one of those shells passes both on to the MCP server it
launches. Anywhere else the token is absent, and the server refuses.

This keeps the server to the GUI. It is not a security boundary against code
running as the same user, which can read another process's environment.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import stat
from collections.abc import Mapping
from pathlib import Path

TOKEN_ENV = "PIKVM_GUI_MCP_TOKEN"
TICKET_ENV = "PIKVM_GUI_MCP_TICKET"

_MAX_TICKET_BYTES = 4096
_OUTSIDE = (
    "the pikvm MCP server only runs from a terminal inside PiKVM Desktop; "
    "open the terminal panel there and start your agent harness from it"
)


class GateError(RuntimeError):
    """The process was not started from inside a running PiKVM Desktop."""


def _desktop_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return False  # another user's process is not our desktop
    return True


def verify(environ: Mapping[str, str] | None = None) -> None:
    """Raise GateError unless the environment carries a live desktop's token."""
    env = os.environ if environ is None else environ
    token = env.get(TOKEN_ENV, "")
    ticket_path = env.get(TICKET_ENV, "")
    if not token or not ticket_path:
        raise GateError(_OUTSIDE)
    path = Path(ticket_path)
    if not path.is_absolute():
        raise GateError(f"{TICKET_ENV} must be an absolute path")
    try:
        info = path.lstat()
    except OSError:
        raise GateError(
            "PiKVM Desktop's MCP ticket is missing; quit and restart PiKVM Desktop"
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
        pid = int(ticket["desktop_pid"])
        expected = str(ticket["token_sha256"])
        if ticket.get("schema_version") != 1:
            raise ValueError("schema_version")
    except (ValueError, KeyError, TypeError, OSError):
        raise GateError("PiKVM Desktop's MCP ticket is unreadable") from None
    if not _desktop_alive(pid):
        raise GateError(
            "PiKVM Desktop is not running (this terminal outlived it); "
            "reopen PiKVM Desktop and start your harness from its terminal"
        )
    actual = hashlib.sha256(token.encode("utf-8")).hexdigest()
    if not hmac.compare_digest(actual, expected):
        raise GateError(
            "this terminal's token is from another PiKVM Desktop run; "
            "open a new terminal tab in PiKVM Desktop"
        )
