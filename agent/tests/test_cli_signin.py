"""CLI sign-in driven from the browser, against fake CLIs on PATH.

FAILURE MODES (listed before the tests and the implementation)

Status
 1. A missing binary reported as "signed out" instead of "not installed".
 2. A CLI's raw status line (codex prints a masked key) or an account token is
    returned; only a classification and an account name are allowed.
 3. Gemini, which has no non-interactive login, is offered a Sign in that cannot
    work, or its sign-in/out pretends to succeed. It must name the exact command.
 4. Status for claude/codex/gemini is stale after a sign-in or sign-out.

Sign-in
 5. The verification URL or one-time code is not captured (ANSI colour codes in
    the way), or is reported before the code has appeared (device flow).
 6. A second Start while one is running spawns a second CLI.
 7. Starting over an existing login silently replaces it (codex deletes its
    auth.json when a device flow does not finish).
 8. The pasted claude code is echoed in any attempt/response/log, or a wrong
    code ends the attempt instead of letting the user retry.
 9. Cancel leaves the CLI process running; a timeout leaves it running or
    reports "failed" instead of "expired".
10. A CLI that exits non-zero reports success, or loses the reason.
11. The child inherits provider API keys or harness tokens from the harness env.
12. The harness shutting down leaves login processes behind.

HTTP
13. The endpoints answer the agent token or no token; an unknown CLI is a 500.
14. The pasted code is echoed in a 422, logged, or accepted for a CLI that takes
    none.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx
import pytest

from pikvm_agent.harness.agent_store import InMemoryRunStore
from pikvm_agent.harness.api import create_harness_app
from pikvm_agent.harness.cli_signin import CliAuthError, CliSignInManager
from pikvm_agent.harness.model_pool import ModelPool

OPERATOR = "operator-" + "a" * 32
AGENT = "agent-" + "b" * 32
GOOD_CODE = "GOODCODE-abc123-from-browser"
WRONG_CODE = "WRONGCODE-zzz999-typo"

FAKE_CLI = '''#!{python}
import json, os, signal, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
NAME = Path(sys.argv[0]).name
ARGS = sys.argv[1:]
signed = HERE / (NAME + ".signed-in")


def say(text, end="\\n"):
    sys.stdout.write(text + end)
    sys.stdout.flush()


with (HERE / "calls.log").open("a") as log:
    log.write(json.dumps({{
        "cli": NAME,
        "pid": os.getpid(),
        "argv": ARGS,
        "env": {{k: os.environ.get(k) for k in ("BROWSER", "TEST_SECRET_ENV", "PIKVM_HARNESS_TOKEN", "NO_COLOR")}},
    }}) + "\\n")

if NAME == "claude":
    if ARGS[:2] == ["auth", "status"]:
        say(json.dumps({{"loggedIn": signed.exists(), "authMethod": "oauth_token", "email": "kieran@example.test"}}
                       if signed.exists() else {{"loggedIn": False}}))
        sys.exit(0)
    if ARGS[:2] == ["auth", "login"]:
        say("Opening browser to sign in\\u2026")
        say("If the browser didn't open, visit: https://claude.example/oauth/authorize?state=abc123")
        say("Paste code here if prompted > ", end="")
        if (HERE / "claude.exit-1").exists():
            say("")
            say("Login failed: network unreachable")
            sys.exit(1)
        for line in sys.stdin:
            if line.strip() == "{good}":
                signed.write_text("1")
                say("")
                say("Login successful.")
                sys.exit(0)
            say("Invalid code. Please make sure the full code was copied.")
        sys.exit(1)
    if ARGS[:2] == ["auth", "logout"]:
        signed.unlink(missing_ok=True)
        say("Logged out")
        sys.exit(0)

if NAME == "codex":
    if ARGS[:2] == ["login", "status"]:
        override = HERE / "codex.status"
        if override.exists():
            say(override.read_text().strip())
            sys.exit(0)
        if signed.exists():
            say("Logged in using ChatGPT")
            sys.exit(0)
        say("Not logged in")
        sys.exit(1)
    if ARGS == ["login", "--device-auth"]:
        if signed.exists():
            signed.unlink()  # codex wipes the old login when a device flow starts
        say("")
        say("Welcome to Codex [v\\x1b[90m0.0.0\\x1b[0m]")
        say("1. Open this link in your browser and sign in to your account")
        say("   \\x1b[94mhttps://auth.example/codex/device\\x1b[0m")
        time.sleep(0.2)
        say("2. Enter this one-time code \\x1b[90m(expires in 15 minutes)\\x1b[0m")
        say("   \\x1b[94mW179-2GB16\\x1b[0m")
        for _ in range(400):
            if (HERE / "approve").exists():
                signed.write_text("1")
                say("Successfully logged in")
                sys.exit(0)
            if (HERE / "deny").exists():
                say("Device code expired")
                sys.exit(1)
            time.sleep(0.05)
        sys.exit(1)
    if ARGS == ["logout"]:
        signed.unlink(missing_ok=True)
        say("Logged out")
        sys.exit(0)

say("unexpected invocation: " + " ".join(ARGS))
sys.exit(2)
'''


class Bin:
    def __init__(self, directory: Path) -> None:
        self.dir = directory
        self.dir.mkdir()
        script = FAKE_CLI.format(python=sys.executable, good=GOOD_CODE)
        for name in ("claude", "codex"):
            path = self.dir / name
            path.write_text(script)
            path.chmod(0o755)

    def signed_in(self, name: str, value: bool = True) -> None:
        marker = self.dir / f"{name}.signed-in"
        if value:
            marker.write_text("1")
        else:
            marker.unlink(missing_ok=True)

    def touch(self, name: str) -> None:
        (self.dir / name).write_text("1")

    def calls(self) -> list[dict[str, Any]]:
        log = self.dir / "calls.log"
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text().splitlines()]

    def alive(self, pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        try:
            return Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"
        except OSError:
            return False


@pytest.fixture
def bin_dir(tmp_path: Path) -> Bin:
    return Bin(tmp_path / "bin")


def make_manager(
    bin_dir: Bin,
    tmp_path: Path,
    **overrides: Any,
) -> CliSignInManager:
    environ = {
        "PATH": f"{bin_dir.dir}{os.pathsep}/usr/bin{os.pathsep}/bin",
        "HOME": str(tmp_path / "home"),
        "TEST_SECRET_ENV": "must-not-reach-children",
        "PIKVM_HARNESS_TOKEN": OPERATOR,
        **overrides.pop("environ", {}),
    }
    (tmp_path / "home").mkdir(exist_ok=True)
    return CliSignInManager(environ=environ, status_ttl_s=0, **overrides)


async def until(predicate: Any, timeout: float = 8.0) -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if asyncio.iscoroutine(value):
            value = await value
        if value:
            return value
        await asyncio.sleep(0.02)
    raise AssertionError("condition not met in time")


async def attempt_in(manager: CliSignInManager, cli: str, state: str) -> dict[str, Any]:
    await until(lambda: (manager.attempt(cli) or {}).get("state") == state)
    attempt = manager.attempt(cli)
    assert attempt is not None
    return attempt


# -- status ------------------------------------------------------------


async def test_status_reports_installed_and_signed_in_per_cli(
    bin_dir: Bin, tmp_path: Path
) -> None:
    bin_dir.signed_in("claude")
    manager = make_manager(bin_dir, tmp_path)

    by_cli = {item["cli"]: item for item in await manager.statuses()}

    assert by_cli["claude"]["installed"] is True
    assert by_cli["claude"]["signed_in"] is True
    assert by_cli["claude"]["account"] == "kieran@example.test"
    assert by_cli["claude"]["method"] == "oauth_token"
    assert by_cli["claude"]["status_source"] == "cli"
    assert by_cli["codex"]["installed"] is True
    assert by_cli["codex"]["signed_in"] is False
    assert by_cli["gemini"]["installed"] is False
    assert by_cli["gemini"]["browser_sign_in"] is False
    assert by_cli["claude"]["browser_sign_in"] is True
    assert by_cli["codex"]["sign_in"] == "device_code"
    assert by_cli["claude"]["sign_in"] == "url_code"


async def test_not_installed_is_not_signed_out(bin_dir: Bin, tmp_path: Path) -> None:
    (bin_dir.dir / "codex").unlink()
    manager = make_manager(bin_dir, tmp_path)

    status = await manager.status("codex")

    assert status["installed"] is False
    assert status["executable"] is None
    assert status["signed_in"] is None
    with pytest.raises(CliAuthError) as raised:
        await manager.start("codex")
    assert raised.value.code == "not_installed"


async def test_codex_api_key_status_never_returns_the_raw_line(
    bin_dir: Bin, tmp_path: Path
) -> None:
    (bin_dir.dir / "codex.status").write_text("Logged in using an API key - sk-proj-AAAA***ZZZZ")
    manager = make_manager(bin_dir, tmp_path)

    status = await manager.status("codex")

    assert status["signed_in"] is True
    assert status["method"] == "api_key"
    assert "sk-proj" not in json.dumps(status)


async def test_unknown_cli_is_a_clean_404(bin_dir: Bin, tmp_path: Path) -> None:
    manager = make_manager(bin_dir, tmp_path)

    with pytest.raises(CliAuthError) as raised:
        await manager.status("nope")

    assert raised.value.status == 404


async def test_gemini_is_desktop_only_with_the_exact_command(
    bin_dir: Bin, tmp_path: Path
) -> None:
    profile = tmp_path / "gemini profile"
    data = profile / ".gemini"
    data.mkdir(parents=True)
    gemini = bin_dir.dir / "gemini"
    gemini.write_text("#!/bin/sh\nexit 9\n")
    gemini.chmod(0o755)
    manager = make_manager(
        bin_dir, tmp_path, environ={"PIKVM_GEMINI_CLI_HOME": str(profile)}
    )

    signed_out = await manager.status("gemini")
    (data / "oauth_creds.json").write_text('{"refresh_token": "SECRET-TOKEN"}')
    (data / "google_accounts.json").write_text('{"active": "me@example.test", "old": []}')
    signed_in = await manager.status("gemini", fresh=True)

    assert signed_out["installed"] is True
    assert signed_out["signed_in"] is False
    assert signed_out["browser_sign_in"] is False
    assert signed_out["manual_command"] == f"GEMINI_CLI_HOME='{profile}' gemini"
    assert "Login with Google" in str(signed_out["manual_hint"])
    assert signed_in["signed_in"] is True
    assert signed_in["account"] == "me@example.test"
    assert signed_in["status_source"] == "credential_file"
    assert "SECRET-TOKEN" not in json.dumps(signed_in)
    for action in (manager.start("gemini"), manager.sign_out("gemini")):
        with pytest.raises(CliAuthError) as raised:
            await action
        assert raised.value.status == 409
        assert raised.value.code == "desktop_only"
        assert raised.value.extra["manual_command"] == signed_out["manual_command"]
    assert not any(call["cli"] == "gemini" for call in bin_dir.calls())


# -- device-code flow (codex) --------------------------------------------


async def test_codex_device_flow_captures_url_and_code_then_succeeds(
    bin_dir: Bin, tmp_path: Path
) -> None:
    manager = make_manager(bin_dir, tmp_path)

    started = await manager.start("codex")
    attempt = await attempt_in(manager, "codex", "awaiting_user")
    bin_dir.touch("approve")
    done = await attempt_in(manager, "codex", "succeeded")
    status = await manager.status("codex")

    assert started["id"] == attempt["id"] == done["id"]
    assert attempt["verification_url"] == "https://auth.example/codex/device"
    assert attempt["user_code"] == "W179-2GB16"
    assert attempt["method"] == "device_code"
    assert attempt["expects_code"] is False
    assert attempt["expires_at"] is not None
    assert "\x1b" not in json.dumps(attempt)
    assert status["signed_in"] is True
    assert status["attempt"]["state"] == "succeeded"
    login = [c for c in bin_dir.calls() if c["argv"] == ["login", "--device-auth"]]
    assert len(login) == 1
    await manager.aclose()


async def test_second_start_returns_the_running_attempt(
    bin_dir: Bin, tmp_path: Path
) -> None:
    manager = make_manager(bin_dir, tmp_path)

    first = await manager.start("codex")
    second = await manager.start("codex", replace=True)
    await attempt_in(manager, "codex", "awaiting_user")

    assert first["id"] == second["id"]
    assert len([c for c in bin_dir.calls() if c["argv"] == ["login", "--device-auth"]]) == 1
    await manager.aclose()


async def test_already_signed_in_needs_replace(bin_dir: Bin, tmp_path: Path) -> None:
    bin_dir.signed_in("codex")
    manager = make_manager(bin_dir, tmp_path)

    with pytest.raises(CliAuthError) as raised:
        await manager.start("codex")
    assert raised.value.status == 409
    assert raised.value.code == "already_signed_in"
    assert not any(c["argv"] == ["login", "--device-auth"] for c in bin_dir.calls())

    started = await manager.start("codex", replace=True)
    assert started["state"] in {"starting", "awaiting_user"}
    await manager.aclose()


async def test_cancel_stops_the_cli_and_reports_cancelled(
    bin_dir: Bin, tmp_path: Path
) -> None:
    manager = make_manager(bin_dir, tmp_path)
    await manager.start("codex")
    await attempt_in(manager, "codex", "awaiting_user")
    pid = next(c["pid"] for c in bin_dir.calls() if c["argv"] == ["login", "--device-auth"])

    cancelled = await manager.cancel("codex")

    assert cancelled["state"] == "cancelled"
    await until(lambda: not bin_dir.alive(pid))
    again = await manager.cancel("codex")  # idempotent once finished
    assert again["state"] == "cancelled"


async def test_cancel_without_an_attempt_is_404(bin_dir: Bin, tmp_path: Path) -> None:
    manager = make_manager(bin_dir, tmp_path)

    with pytest.raises(CliAuthError) as raised:
        await manager.cancel("codex")

    assert raised.value.status == 404


async def test_timeout_expires_the_attempt_and_kills_the_cli(
    bin_dir: Bin, tmp_path: Path
) -> None:
    manager = make_manager(bin_dir, tmp_path, attempt_timeout_s=0.5)
    await manager.start("codex")
    pid = (await until(lambda: [c for c in bin_dir.calls() if c["argv"] == ["login", "--device-auth"]]))[0]["pid"]

    expired = await attempt_in(manager, "codex", "expired")

    assert "expired" in str(expired["message"]).lower()
    await until(lambda: not bin_dir.alive(pid))


async def test_device_flow_failure_reports_the_cli_reason(
    bin_dir: Bin, tmp_path: Path
) -> None:
    manager = make_manager(bin_dir, tmp_path)
    await manager.start("codex")
    await attempt_in(manager, "codex", "awaiting_user")
    bin_dir.touch("deny")

    failed = await attempt_in(manager, "codex", "failed")

    assert failed["message"] == "Device code expired"


async def test_aclose_kills_running_logins(bin_dir: Bin, tmp_path: Path) -> None:
    manager = make_manager(bin_dir, tmp_path)
    await manager.start("codex")
    await attempt_in(manager, "codex", "awaiting_user")
    pid = next(c["pid"] for c in bin_dir.calls() if c["argv"] == ["login", "--device-auth"])

    await manager.aclose()

    assert not bin_dir.alive(pid)


async def test_children_get_a_scrubbed_environment(bin_dir: Bin, tmp_path: Path) -> None:
    manager = make_manager(bin_dir, tmp_path)

    await manager.status("claude")
    await manager.start("codex")
    await attempt_in(manager, "codex", "awaiting_user")
    await manager.aclose()

    calls = bin_dir.calls()
    assert calls
    for call in calls:
        assert call["env"]["TEST_SECRET_ENV"] is None
        assert call["env"]["PIKVM_HARNESS_TOKEN"] is None
        assert call["env"]["BROWSER"] == "true"


# -- URL + pasted code flow (claude) -----------------------------------------


async def test_claude_flow_retries_a_wrong_code_and_never_echoes_codes(
    bin_dir: Bin, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    manager = make_manager(bin_dir, tmp_path)

    await manager.start("claude")
    waiting = await attempt_in(manager, "claude", "awaiting_user")
    wrong = await manager.submit_code("claude", WRONG_CODE)
    await until(lambda: "Invalid" in str((manager.attempt("claude") or {}).get("message")))
    still = manager.attempt("claude")
    right = await manager.submit_code("claude", f" {GOOD_CODE}\n")
    done = await attempt_in(manager, "claude", "succeeded")
    status = await manager.status("claude")

    assert waiting["verification_url"] == "https://claude.example/oauth/authorize?state=abc123"
    assert waiting["expects_code"] is True
    assert waiting["user_code"] is None
    assert still is not None and still["state"] == "awaiting_user"
    assert wrong["code_submissions"] == 1 and right["code_submissions"] == 2
    assert status["signed_in"] is True
    everything = json.dumps([waiting, wrong, still, right, done, status]) + caplog.text
    assert GOOD_CODE not in everything
    assert WRONG_CODE not in everything


@pytest.mark.parametrize("code", ["", "   ", "has space inside", "x" * 3000, "new\nline", 42, None])
async def test_invalid_codes_are_refused_without_reaching_the_cli(
    bin_dir: Bin, tmp_path: Path, code: Any
) -> None:
    manager = make_manager(bin_dir, tmp_path)
    await manager.start("claude")
    await attempt_in(manager, "claude", "awaiting_user")

    with pytest.raises(CliAuthError) as raised:
        await manager.submit_code("claude", code)

    assert raised.value.status == 422
    assert "x" * 50 not in raised.value.detail
    assert manager.attempt("claude")["code_submissions"] == 0  # type: ignore[index]
    await manager.aclose()


async def test_code_is_refused_when_nothing_waits_or_cli_takes_none(
    bin_dir: Bin, tmp_path: Path
) -> None:
    manager = make_manager(bin_dir, tmp_path)

    with pytest.raises(CliAuthError) as idle:
        await manager.submit_code("claude", GOOD_CODE)
    with pytest.raises(CliAuthError) as device:
        await manager.submit_code("codex", GOOD_CODE)

    assert idle.value.code == "not_waiting"
    assert device.value.code == "no_code_expected"


async def test_claude_failure_keeps_the_reason(bin_dir: Bin, tmp_path: Path) -> None:
    bin_dir.touch("claude.exit-1")
    manager = make_manager(bin_dir, tmp_path)

    await manager.start("claude")
    failed = await attempt_in(manager, "claude", "failed")

    assert failed["message"] == "Login failed: network unreachable"


# -- sign-out -----------------------------------------------------------


async def test_sign_out_runs_the_cli_and_refreshes_status(
    bin_dir: Bin, tmp_path: Path
) -> None:
    bin_dir.signed_in("claude")
    bin_dir.signed_in("codex")
    manager = make_manager(bin_dir, tmp_path)
    assert (await manager.status("claude"))["signed_in"] is True

    claude = await manager.sign_out("claude")
    codex = await manager.sign_out("codex")

    assert claude["signed_in"] is False
    assert codex["signed_in"] is False
    argvs = [c["argv"] for c in bin_dir.calls()]
    assert ["auth", "logout"] in argvs and ["logout"] in argvs


async def test_sign_out_is_refused_while_a_sign_in_runs(
    bin_dir: Bin, tmp_path: Path
) -> None:
    manager = make_manager(bin_dir, tmp_path)
    await manager.start("codex")
    await attempt_in(manager, "codex", "awaiting_user")

    with pytest.raises(CliAuthError) as raised:
        await manager.sign_out("codex")

    assert raised.value.code == "sign_in_active"
    await manager.aclose()


# -- HTTP ---------------------------------------------------------------


def http_client(manager: CliSignInManager | None, token: str | None = OPERATOR) -> httpx.AsyncClient:
    app = create_harness_app(
        harness=object(),  # type: ignore[arg-type]
        store=InMemoryRunStore(),
        models=ModelPool(providers={}, routes={}),
        access_token=OPERATOR,
        agent_token=AGENT,
        allowed_origins={"http://harness"},
        cli_signin=manager,
    )
    headers = {"authorization": f"Bearer {token}"} if token else {}
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://harness",
        headers=headers,
    )


async def test_http_flow_for_claude_end_to_end(
    bin_dir: Bin, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    manager = make_manager(bin_dir, tmp_path)
    async with http_client(manager) as client:
        listing = await client.get("/api/cli-auth")
        started = await client.post("/api/cli-auth/claude/sign-in")
        await until(
            lambda: manager.attempt("claude") and manager.attempt("claude")["state"] == "awaiting_user"
        )
        polled = await client.get("/api/cli-auth/claude/sign-in")
        wrong = await client.post(
            "/api/cli-auth/claude/sign-in/code", json={"auth_code": WRONG_CODE}
        )
        bad_body = await client.post(
            "/api/cli-auth/claude/sign-in/code", json={"auth_code": "has space " + WRONG_CODE}
        )
        extra = await client.post(
            "/api/cli-auth/claude/sign-in/code", json={"auth_code": WRONG_CODE, "x": WRONG_CODE}
        )
        right = await client.post(
            "/api/cli-auth/claude/sign-in/code", json={"auth_code": GOOD_CODE}
        )
        await until(lambda: manager.attempt("claude")["state"] == "succeeded")  # type: ignore[index]
        after = await client.get("/api/cli-auth")

    clis = {item["cli"]: item for item in listing.json()["clis"]}
    assert set(clis) == {"claude", "codex", "gemini"}
    assert started.status_code == 202
    assert started.json()["cli"] == "claude"
    assert polled.json()["verification_url"].startswith("https://claude.example/")
    assert wrong.status_code == 200
    assert bad_body.status_code == 422
    assert extra.status_code == 422
    assert right.status_code == 200
    assert {i["cli"]: i for i in after.json()["clis"]}["claude"]["signed_in"] is True
    for response in (wrong, bad_body, extra, right):
        assert GOOD_CODE not in response.text and WRONG_CODE not in response.text
    assert GOOD_CODE not in caplog.text and WRONG_CODE not in caplog.text


async def test_http_codex_cancel_sign_out_and_errors(bin_dir: Bin, tmp_path: Path) -> None:
    bin_dir.signed_in("codex")
    manager = make_manager(bin_dir, tmp_path)
    async with http_client(manager) as client:
        conflict = await client.post("/api/cli-auth/codex/sign-in")
        started = await client.post("/api/cli-auth/codex/sign-in", json={"replace": True})
        await until(
            lambda: manager.attempt("codex") and manager.attempt("codex")["state"] == "awaiting_user"
        )
        cancelled = await client.delete("/api/cli-auth/codex/sign-in")
        no_attempt = await client.get("/api/cli-auth/claude/sign-in")
        unknown = await client.get("/api/cli-auth/nope/sign-in")
        gemini = await client.post("/api/cli-auth/gemini/sign-in")
        bad_replace = await client.post("/api/cli-auth/codex/sign-in", json={"replace": "yes"})
        signed_out = await client.post("/api/cli-auth/claude/sign-out")

    assert conflict.status_code == 409 and conflict.json()["code"] == "already_signed_in"
    assert started.status_code == 202
    assert cancelled.json()["state"] == "cancelled"
    assert no_attempt.status_code == 404
    assert unknown.status_code == 404
    assert gemini.status_code == 409
    assert gemini.json()["code"] == "desktop_only"
    assert gemini.json()["manual_command"] == "gemini"
    assert bad_replace.status_code == 422
    assert signed_out.status_code == 200 and signed_out.json()["signed_in"] is False


async def test_http_endpoints_are_operator_only(bin_dir: Bin, tmp_path: Path) -> None:
    manager = make_manager(bin_dir, tmp_path)
    for token in (None, AGENT):
        async with http_client(manager, token) as client:
            assert (await client.get("/api/cli-auth")).status_code == 401
            assert (await client.post("/api/cli-auth/codex/sign-in")).status_code == 401
            assert (await client.get("/api/cli-auth/codex/sign-in")).status_code == 401
            assert (await client.delete("/api/cli-auth/codex/sign-in")).status_code == 401
            assert (await client.post("/api/cli-auth/codex/sign-out")).status_code == 401
            assert (
                await client.post(
                    "/api/cli-auth/claude/sign-in/code", json={"auth_code": GOOD_CODE}
                )
            ).status_code == 401
    assert bin_dir.calls() == []


async def test_http_answers_503_when_sign_in_is_not_wired() -> None:
    async with http_client(None) as client:
        assert (await client.get("/api/cli-auth")).status_code == 503
        assert (await client.post("/api/cli-auth/codex/sign-in")).status_code == 503
