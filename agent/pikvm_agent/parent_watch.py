"""Exit when the desktop process that started us dies.

The desktop app sets ``PIKVM_AGENT_PARENT_PID`` on the daemon and harness it
starts. Its quit handler stops them, but a crash or ``kill -9`` skips that
handler, and the services then live on, re-parented to the session manager,
holding the unix sockets. Every later desktop run is refused by the leftover
harness (401) and the agent panel cannot start. A real case is recorded in
``tests/test_parent_watch.py``.

Children of those services (the harness's MCP child, ddgs) inherit the
variable and run this same check, so the whole tree goes.

Polling is used because it works the same on Linux and macOS and needs no
native code. On Linux the parent's start time from ``/proc`` is compared too,
so a recycled PID is not mistaken for the desktop.
"""

from __future__ import annotations

import logging
import os
import signal
import threading
import time

ENV = "PIKVM_AGENT_PARENT_PID"

log = logging.getLogger("pikvm_agent.parent_watch")


def _identity(pid: int) -> int | None:
    """The process start time (clock ticks since boot), or None without /proc."""
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii") as handle:
            stat = handle.read()
    except OSError:
        return None
    # Field 22; the command name in field 2 can contain spaces, so split after it.
    fields = stat.rsplit(")", 1)[-1].split()
    return int(fields[19])


def _alive(pid: int, identity: int | None) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else; the start time decides
    return identity is None or _identity(pid) == identity


def _stop(grace_s: float) -> None:
    log.warning("[parent-watch] desktop process is gone; shutting down")
    os.kill(os.getpid(), signal.SIGTERM)
    time.sleep(grace_s)
    log.warning("[parent-watch] graceful shutdown did not finish; exiting")
    os._exit(1)


def _watch(pid: int, identity: int | None, poll_s: float, grace_s: float) -> None:
    while _alive(pid, identity):
        time.sleep(poll_s)
    _stop(grace_s)


def start_from_environment(*, poll_s: float = 1.0, grace_s: float = 5.0) -> bool:
    """Start the watcher if ``PIKVM_AGENT_PARENT_PID`` is set. Returns whether it started."""
    raw = os.environ.get(ENV, "").strip()
    if not raw:
        return False
    try:
        pid = int(raw)
    except ValueError:
        log.warning("[parent-watch] ignoring %s=%r: not a PID", ENV, raw)
        return False
    if pid <= 1:
        log.warning("[parent-watch] ignoring %s=%r: not a desktop PID", ENV, raw)
        return False
    identity = _identity(pid)
    thread = threading.Thread(
        target=_watch,
        args=(pid, identity, poll_s, grace_s),
        name="parent-watch",
        daemon=True,
    )
    thread.start()
    return True
