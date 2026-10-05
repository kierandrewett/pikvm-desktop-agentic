"""Services started by the desktop exit when the desktop process dies.

On 2026-10-05 a daemon and harness from a desktop run on 2026-09-21 were
still alive, re-parented to the session manager, holding the unix sockets.
Every later desktop then got 401 from the leftover harness and showed "The
agent panel could not start". The desktop had been killed or had crashed,
so its quit handler never stopped them.

Failure modes, written before the code:

1. The variable is unset (normal CLI use): no watcher, no exit.
2. The variable is not a PID: ignored with a log line, no crash.
3. The parent is already dead at startup: exit at once.
4. The parent PID is reused by an unrelated process: still treated as dead
   (Linux, by comparing the /proc start time).
5. Graceful shutdown hangs: a hard exit follows after a grace period.
6. The watcher keeps the process alive at normal exit: it must be a daemon
   thread.
7. Grandchildren (the harness's MCP child, ddgs) inherit the variable, so
   they also exit. Covered by 1-3: they run the same entry point.

These tests use real processes, not mocks.
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import time

import pytest

from pikvm_agent import parent_watch

CHILD = textwrap.dedent(
    """
    import signal, sys, time
    from pikvm_agent import parent_watch
    hang = len(sys.argv) > 1 and sys.argv[1] == "hang"
    if hang:
        signal.signal(signal.SIGTERM, lambda *_: None)  # ignore graceful stop
    started = parent_watch.start_from_environment(poll_s=0.1, grace_s=0.5)
    print("watching" if started else "not-watching", flush=True)
    time.sleep(30)
    """
)


def _child(env_pid: str | None, *args: str) -> subprocess.Popen[str]:
    env = dict(os.environ)
    env.pop(parent_watch.ENV, None)
    if env_pid is not None:
        env[parent_watch.ENV] = env_pid
    return subprocess.Popen(
        [sys.executable, "-c", CHILD, *args],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _exits_within(proc: subprocess.Popen[str], seconds: float) -> bool:
    try:
        proc.wait(timeout=seconds)
        return True
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        return False


def _first_line(proc: subprocess.Popen[str]) -> str:
    assert proc.stdout is not None
    return proc.stdout.readline().strip()


def test_unset_variable_does_not_watch() -> None:
    proc = _child(None)
    assert _first_line(proc) == "not-watching"
    assert not _exits_within(proc, 1.0)


def test_garbage_variable_is_ignored() -> None:
    proc = _child("not-a-pid")
    assert _first_line(proc) == "not-watching"
    assert not _exits_within(proc, 1.0)


def test_exits_when_the_parent_dies() -> None:
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    proc = _child(str(parent.pid))
    assert _first_line(proc) == "watching"
    assert not _exits_within_peek(proc, 0.5)
    parent.kill()
    parent.wait()
    assert _exits_within(proc, 3.0)


def test_exits_at_once_when_the_parent_is_already_dead() -> None:
    parent = subprocess.Popen([sys.executable, "-c", "pass"])
    parent.wait()
    proc = _child(str(parent.pid))
    assert _exits_within(proc, 3.0)


def test_hard_exit_when_graceful_stop_hangs() -> None:
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    proc = _child(str(parent.pid), "hang")
    assert _first_line(proc) == "watching"
    parent.kill()
    parent.wait()
    assert _exits_within(proc, 4.0)


@pytest.mark.skipif(not os.path.exists("/proc/self/stat"), reason="needs /proc")
def test_reused_pid_counts_as_dead() -> None:
    me = os.getpid()
    identity = parent_watch._identity(me)
    assert identity is not None
    assert parent_watch._alive(me, identity)
    assert not parent_watch._alive(me, identity + 1)


def test_watcher_thread_does_not_block_exit() -> None:
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        env = {**os.environ, parent_watch.ENV: str(parent.pid)}
        code = "from pikvm_agent import parent_watch; parent_watch.start_from_environment()"
        started = time.monotonic()
        subprocess.run([sys.executable, "-c", code], env=env, check=True, timeout=10)
        assert time.monotonic() - started < 5
    finally:
        parent.kill()
        parent.wait()


def _exits_within_peek(proc: subprocess.Popen[str], seconds: float) -> bool:
    """Like _exits_within, but leaves a still-running process running."""
    try:
        proc.wait(timeout=seconds)
        return True
    except subprocess.TimeoutExpired:
        return False
