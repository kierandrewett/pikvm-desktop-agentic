"""Browser-driven sign-in for the provider CLIs the harness already uses.

The harness never reads or stores a CLI's tokens. Sign-in here means running the
CLI's own login command, capturing the verification URL (and one-time code) it
prints so a phone can open it, and reporting what the CLI itself says afterwards.

What each CLI allows, checked against the installed binaries:

* ``codex login --device-auth``: prints a verification URL and a one-time code,
  then polls until the user approves on any device. Fully drivable. It deletes
  the existing ``auth.json`` when the flow ends without success, so the manager
  requires ``replace`` when a login already exists and a cancel leaves the CLI
  signed out.
* ``claude auth login``: prints an authorize URL whose redirect lands on a
  page that shows a code; the CLI reads that code from stdin ("Paste code here").
  Drivable: the browser shows the URL, the user pastes the code back, and we
  write it to the CLI's stdin.
* ``gemini``: has no login subcommand. Sign-in happens inside its interactive
  terminal UI, so it cannot be driven without faking a terminal. Status is
  inferred from the presence of its credential file (never read) and the
  manual command is returned instead.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import signal
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

_LOG = logging.getLogger(__name__)

SignInMethod = Literal["device_code", "url_code", "desktop_only"]
AttemptState = Literal[
    "starting",
    "awaiting_user",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
]

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
_URL = re.compile(r"https?://[^\s\x1b<>\"']+")
_DEVICE_CODE = re.compile(r"[A-Z0-9]{3,8}-[A-Z0-9]{3,10}")
_EXPIRES = re.compile(r"expires in (\d+) minute", re.IGNORECASE)
_PROMPT = re.compile(r"^Paste code here if prompted\s*>\s*")

# Only what a login or status command needs. Provider API keys and the
# harness's own tokens are not in this list on purpose.
_CHILD_ENV = (
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
    "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "SYSTEMROOT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
)  # fmt: skip
_MAX_CODE_LENGTH = 2048
_MESSAGE_LIMIT = 200
_STATUS_TIMEOUT_S = 20.0


class CliAuthError(Exception):
    """A refusal with a stable ``code`` the UI can branch on."""

    def __init__(
        self,
        status: int,
        code: str,
        detail: str,
        **extra: object,
    ) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail
        self.extra = extra

    def body(self) -> dict[str, object]:
        return {"detail": self.detail, "code": self.code, **self.extra}


@dataclass(frozen=True)
class CliSpec:
    cli: str
    label: str
    executable: str
    sign_in: SignInMethod
    login_args: tuple[str, ...] = ()
    logout_args: tuple[str, ...] | None = None
    status_args: tuple[str, ...] | None = None
    manual_hint: str | None = None


CLI_SPECS: dict[str, CliSpec] = {
    "claude": CliSpec(
        cli="claude",
        label="Claude Code",
        executable="claude",
        sign_in="url_code",
        login_args=("auth", "login"),
        logout_args=("auth", "logout"),
        status_args=("auth", "status", "--json"),
    ),
    "codex": CliSpec(
        cli="codex",
        label="Codex (ChatGPT)",
        executable="codex",
        sign_in="device_code",
        login_args=("login", "--device-auth"),
        logout_args=("logout",),
        status_args=("login", "status"),
    ),
    "gemini": CliSpec(
        cli="gemini",
        label="Gemini CLI",
        executable="gemini",
        sign_in="desktop_only",
        manual_hint=(
            "Gemini CLI only signs in inside its interactive terminal UI. "
            "Run the command below in a terminal on the desktop and choose "
            "\"Login with Google\"."
        ),
    ),
}


def _utc(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clean(line: str) -> str:
    return _ANSI.sub("", line).strip()


def _short(text: str) -> str:
    return text if len(text) <= _MESSAGE_LIMIT else text[: _MESSAGE_LIMIT - 1] + "…"


@dataclass
class _Attempt:
    cli: str
    method: SignInMethod
    id: str = field(default_factory=lambda: secrets.token_urlsafe(8))
    state: AttemptState = "starting"
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at: datetime | None = None
    verification_url: str | None = None
    user_code: str | None = None
    message: str | None = None
    code_submissions: int = 0
    # Private: never part of the public view.
    submitted: list[str] = field(default_factory=list)
    process: asyncio.subprocess.Process | None = None
    task: asyncio.Task[None] | None = None
    cancel_requested: bool = False
    timed_out: bool = False
    last_line: str | None = None

    @property
    def active(self) -> bool:
        return self.state in {"starting", "awaiting_user"}

    def public(self) -> dict[str, object]:
        return {
            "id": self.id,
            "cli": self.cli,
            "state": self.state,
            "method": self.method,
            "verification_url": self.verification_url,
            "user_code": self.user_code,
            "expects_code": self.method == "url_code" and self.active,
            "started_at": _utc(self.started_at),
            "expires_at": _utc(self.expires_at) if self.expires_at else None,
            "message": self.message,
            "code_submissions": self.code_submissions,
        }

    def scrub(self, text: str) -> str:
        for code in self.submitted:
            text = text.replace(code, "[code]")
        return text


class CliSignInManager:
    """Status, sign-in, sign-out for the supported provider CLIs."""

    def __init__(
        self,
        *,
        environ: Mapping[str, str] | None = None,
        executables: Mapping[str, str] | None = None,
        gemini_profile_env: str = "PIKVM_GEMINI_CLI_HOME",
        attempt_timeout_s: float = 900.0,
        status_ttl_s: float = 10.0,
    ) -> None:
        self._environ = os.environ if environ is None else environ
        self._executables = dict(executables or {})
        self._gemini_profile_env = gemini_profile_env
        self._attempt_timeout_s = attempt_timeout_s
        self._status_ttl_s = status_ttl_s
        self._attempts: dict[str, _Attempt] = {}
        self._status_cache: dict[str, tuple[float, dict[str, object]]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    # -- lookups -------------------------------------------------------

    def _spec(self, cli: str) -> CliSpec:
        try:
            return CLI_SPECS[cli]
        except KeyError:
            raise CliAuthError(404, "unknown_cli", f"unknown CLI: {cli}") from None

    def _executable(self, spec: CliSpec) -> str | None:
        name = self._executables.get(spec.cli, spec.executable)
        return shutil.which(name, path=self._environ.get("PATH"))

    def _child_env(self) -> dict[str, str]:
        env = {
            name: self._environ[name]
            for name in _CHILD_ENV
            if name in self._environ
        }
        # Keep the CLI from opening a browser on a machine nobody is sitting at;
        # the UI offers the URL instead. Headless macOS ignores this and opens
        # the desktop browser, which is also fine.
        env.update({"BROWSER": "true", "NO_COLOR": "1", "TERM": "dumb"})
        return env

    def _lock(self, cli: str) -> asyncio.Lock:
        return self._locks.setdefault(cli, asyncio.Lock())

    def _gemini_home(self) -> Path:
        configured = self._environ.get(self._gemini_profile_env) or self._environ.get(
            "GEMINI_CLI_HOME"
        )
        return Path(configured) if configured else Path.home()

    def _manual_command(self, spec: CliSpec) -> str | None:
        if spec.sign_in != "desktop_only":
            return None
        configured = self._environ.get(self._gemini_profile_env)
        if configured:
            return f"GEMINI_CLI_HOME={shlex.quote(configured)} {spec.executable}"
        return spec.executable

    # -- status --------------------------------------------------------

    async def statuses(self) -> list[dict[str, object]]:
        return list(
            await asyncio.gather(*(self.status(cli) for cli in CLI_SPECS))
        )

    async def status(self, cli: str, *, fresh: bool = False) -> dict[str, object]:
        spec = self._spec(cli)
        cached = self._status_cache.get(cli)
        if (
            not fresh
            and cached is not None
            and time.monotonic() - cached[0] < self._status_ttl_s
        ):
            result = dict(cached[1])
        else:
            result = await self._probe(spec)
            self._status_cache[cli] = (time.monotonic(), result)
            result = dict(result)
        attempt = self._attempts.get(cli)
        result["attempt"] = attempt.public() if attempt else None
        return result

    def _invalidate(self, cli: str) -> None:
        self._status_cache.pop(cli, None)

    async def _probe(self, spec: CliSpec) -> dict[str, object]:
        executable = self._executable(spec)
        base: dict[str, object] = {
            "cli": spec.cli,
            "label": spec.label,
            "installed": executable is not None,
            "executable": executable,
            "signed_in": None,
            "account": None,
            "method": None,
            "status_source": "unavailable",
            "sign_in": spec.sign_in,
            "browser_sign_in": spec.sign_in != "desktop_only",
            "can_sign_out": spec.logout_args is not None,
            "manual_command": self._manual_command(spec),
            "manual_hint": spec.manual_hint,
            "error": None,
        }
        if spec.cli == "gemini":
            return {**base, **self._probe_gemini(executable)}
        if executable is None or spec.status_args is None:
            return base
        try:
            code, output = await self._capture(
                [executable, *spec.status_args], _STATUS_TIMEOUT_S
            )
        except (OSError, asyncio.TimeoutError):
            return {**base, "error": "the status command did not complete"}
        if spec.cli == "claude":
            return {**base, **self._parse_claude(code, output)}
        return {**base, **self._parse_codex(code, output)}

    @staticmethod
    def _parse_claude(code: int, output: str) -> dict[str, object]:
        start = output.find("{")
        try:
            data = json.loads(output[start:]) if start >= 0 else None
        except ValueError:
            data = None
        if not isinstance(data, dict) or "loggedIn" not in data:
            return {"error": "unexpected status output"}
        email = data.get("email")
        method = data.get("authMethod")
        return {
            "signed_in": bool(data["loggedIn"]),
            "account": email if isinstance(email, str) and email else None,
            "method": method if isinstance(method, str) else None,
            "status_source": "cli",
        }

    @staticmethod
    def _parse_codex(code: int, output: str) -> dict[str, object]:
        # `codex login status` may print a masked key; the raw line is never
        # returned, only the classification.
        lines = [_clean(line) for line in output.splitlines()]
        logged_in = next(
            (line for line in lines if line.startswith("Logged in")), None
        )
        if logged_in is not None and code == 0:
            method = (
                "chatgpt"
                if "chatgpt" in logged_in.lower()
                else "api_key"
                if "api key" in logged_in.lower()
                else None
            )
            return {"signed_in": True, "method": method, "status_source": "cli"}
        if any(line.startswith("Not logged in") for line in lines):
            return {"signed_in": False, "status_source": "cli"}
        return {"error": "unexpected status output"}

    def _probe_gemini(self, executable: str | None) -> dict[str, object]:
        # Existence and the active-account name only; token files are not read.
        data_dir = self._gemini_home() / ".gemini"
        credentials_file = data_dir / "oauth_creds.json"
        api_key = bool(self._environ.get("GEMINI_API_KEY"))
        signed_in = credentials_file.is_file() or api_key
        account = None
        with contextlib.suppress(OSError, ValueError):
            accounts = data_dir / "google_accounts.json"
            if accounts.is_file() and accounts.stat().st_size < 4096:
                active = json.loads(accounts.read_text(encoding="utf-8")).get("active")
                account = active if isinstance(active, str) and active else None
        return {
            "signed_in": signed_in,
            "account": account,
            "method": (
                "oauth" if credentials_file.is_file() else "api_key" if api_key else None
            ),
            "status_source": "credential_file",
        }

    async def _capture(self, argv: Sequence[str], timeout: float) -> tuple[int, str]:
        process = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=self._child_env(),
            start_new_session=os.name != "nt",
        )
        try:
            output, _ = await asyncio.wait_for(process.communicate(), timeout)
        except asyncio.TimeoutError:
            await self._terminate(process)
            raise
        return process.returncode or 0, output.decode("utf-8", "replace")

    # -- sign-in -------------------------------------------------------

    def attempt(self, cli: str) -> dict[str, object] | None:
        self._spec(cli)
        attempt = self._attempts.get(cli)
        return attempt.public() if attempt else None

    async def start(self, cli: str, *, replace: bool = False) -> dict[str, object]:
        spec = self._spec(cli)
        if spec.sign_in == "desktop_only":
            raise CliAuthError(
                409,
                "desktop_only",
                spec.manual_hint or f"{spec.label} cannot sign in from the browser.",
                manual_command=self._manual_command(spec),
            )
        executable = self._executable(spec)
        if executable is None:
            raise CliAuthError(
                409,
                "not_installed",
                f"{spec.label} is not installed on the machine running the harness.",
            )
        async with self._lock(cli):
            current = self._attempts.get(cli)
            if current is not None and current.active:
                return current.public()
            status = await self.status(cli)
            if status.get("signed_in") is True and not replace:
                raise CliAuthError(
                    409,
                    "already_signed_in",
                    f"{spec.label} is already signed in. Pass replace to sign in again.",
                    method=status.get("method"),
                )
            attempt = _Attempt(cli=cli, method=spec.sign_in)
            attempt.expires_at = datetime.now(timezone.utc) + timedelta(
                seconds=self._attempt_timeout_s
            )
            try:
                attempt.process = await asyncio.create_subprocess_exec(
                    executable,
                    *spec.login_args,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    env=self._child_env(),
                    start_new_session=os.name != "nt",
                )
            except OSError as exc:
                raise CliAuthError(
                    500, "spawn_failed", f"could not start {spec.executable}"
                ) from exc
            self._attempts[cli] = attempt
            self._invalidate(cli)
            attempt.task = asyncio.create_task(self._run(attempt))
            _LOG.info("started %s sign-in", cli)
            return attempt.public()

    async def _run(self, attempt: _Attempt) -> None:
        process = attempt.process
        assert process is not None and process.stdout is not None
        try:
            try:
                await asyncio.wait_for(
                    self._pump(attempt, process.stdout),
                    self._attempt_timeout_s,
                )
                code = await asyncio.wait_for(process.wait(), 10)
            except asyncio.TimeoutError:
                attempt.timed_out = True
                await self._terminate(process)
                code = process.returncode if process.returncode is not None else -1
            if attempt.cancel_requested:
                attempt.state = "cancelled"
                attempt.message = None
            elif attempt.timed_out:
                attempt.state = "expired"
                attempt.message = "The sign-in link expired. Start again."
            elif code == 0:
                attempt.state = "succeeded"
            else:
                attempt.state = "failed"
                attempt.message = _short(
                    attempt.scrub(
                        attempt.last_line or "The sign-in did not complete."
                    )
                )
        except asyncio.CancelledError:
            await self._terminate(process)
            attempt.state = "cancelled"
            raise
        finally:
            if attempt.process is not None and attempt.process.stdin is not None:
                with contextlib.suppress(Exception):
                    attempt.process.stdin.close()
            self._invalidate(attempt.cli)

    async def _pump(self, attempt: _Attempt, stream: asyncio.StreamReader) -> None:
        buffer = ""
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                break
            buffer += chunk.decode("utf-8", "replace").replace("\r", "\n")
            *lines, buffer = buffer.split("\n")
            for line in lines:
                self._parse_line(attempt, _clean(line))
            if len(buffer) > 16_384:
                buffer = buffer[-4096:]
        if buffer.strip():
            self._parse_line(attempt, _clean(buffer))

    def _parse_line(self, attempt: _Attempt, line: str) -> None:
        line = _PROMPT.sub("", line)
        if not line:
            return
        expires = _EXPIRES.search(line)
        if expires and attempt.expires_at is not None:
            attempt.expires_at = datetime.now(timezone.utc) + timedelta(
                minutes=int(expires.group(1))
            )
        if attempt.verification_url is None:
            match = _URL.search(line)
            if match:
                attempt.verification_url = match.group(0).rstrip(".,)")
        elif (
            attempt.method == "device_code"
            and attempt.user_code is None
            and _DEVICE_CODE.fullmatch(line)
        ):
            attempt.user_code = line
        if attempt.state == "starting" and attempt.verification_url is not None:
            if attempt.method == "url_code" or attempt.user_code is not None:
                attempt.state = "awaiting_user"
        if attempt.code_submissions and not _URL.search(line):
            # After a pasted code, whatever the CLI says next is the outcome.
            attempt.message = _short(attempt.scrub(line))
        attempt.last_line = line

    async def submit_code(self, cli: str, code: object) -> dict[str, object]:
        spec = self._spec(cli)
        if spec.sign_in != "url_code":
            raise CliAuthError(
                409, "no_code_expected", f"{spec.label} does not take a pasted code."
            )
        if (
            not isinstance(code, str)
            or not code.strip()
            or len(code.strip()) > _MAX_CODE_LENGTH
            or any(not 0x21 <= ord(char) <= 0x7E for char in code.strip())
        ):
            raise CliAuthError(422, "invalid_code", "the code is not valid")
        value = code.strip()
        attempt = self._attempts.get(cli)
        if (
            attempt is None
            or attempt.state != "awaiting_user"
            or attempt.process is None
            or attempt.process.stdin is None
        ):
            raise CliAuthError(
                409, "not_waiting", "no sign-in is waiting for a code"
            )
        attempt.submitted.append(value)
        attempt.code_submissions += 1
        attempt.message = None
        try:
            attempt.process.stdin.write(f"{value}\n".encode())
            await attempt.process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            raise CliAuthError(
                409, "not_waiting", "the sign-in has already ended"
            ) from None
        return attempt.public()

    async def cancel(self, cli: str) -> dict[str, object]:
        self._spec(cli)
        attempt = self._attempts.get(cli)
        if attempt is None:
            raise CliAuthError(404, "no_attempt", "no sign-in has been started")
        if attempt.active:
            attempt.cancel_requested = True
            if attempt.process is not None:
                await self._terminate(attempt.process)
            if attempt.task is not None:
                await asyncio.gather(attempt.task, return_exceptions=True)
        return attempt.public()

    # -- sign-out ------------------------------------------------------

    async def sign_out(self, cli: str) -> dict[str, object]:
        spec = self._spec(cli)
        if spec.logout_args is None:
            raise CliAuthError(
                409,
                "desktop_only",
                f"{spec.label} has no sign-out command; remove its login on the desktop.",
                manual_command=self._manual_command(spec),
            )
        executable = self._executable(spec)
        if executable is None:
            raise CliAuthError(
                409,
                "not_installed",
                f"{spec.label} is not installed on the machine running the harness.",
            )
        async with self._lock(cli):
            current = self._attempts.get(cli)
            if current is not None and current.active:
                raise CliAuthError(
                    409, "sign_in_active", "cancel the sign-in in progress first"
                )
            try:
                code, _ = await self._capture(
                    [executable, *spec.logout_args], _STATUS_TIMEOUT_S
                )
            except (OSError, asyncio.TimeoutError):
                raise CliAuthError(
                    502, "sign_out_failed", f"{spec.label} did not finish signing out"
                ) from None
            self._invalidate(cli)
            if code != 0:
                raise CliAuthError(
                    502, "sign_out_failed", f"{spec.label} could not sign out"
                )
        return await self.status(cli, fresh=True)

    # -- lifecycle -----------------------------------------------------

    async def _terminate(self, process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        self._signal(process, signal.SIGTERM)
        try:
            await asyncio.wait_for(process.wait(), 3)
        except asyncio.TimeoutError:
            self._signal(process, getattr(signal, "SIGKILL", signal.SIGTERM))
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(process.wait(), 3)

    @staticmethod
    def _signal(process: asyncio.subprocess.Process, sig: int) -> None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            if os.name != "nt":
                os.killpg(process.pid, sig)
            else:
                process.send_signal(sig)

    async def aclose(self) -> None:
        for attempt in list(self._attempts.values()):
            if attempt.active:
                attempt.cancel_requested = True
                if attempt.process is not None:
                    await self._terminate(attempt.process)
        tasks = [a.task for a in self._attempts.values() if a.task is not None]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def executables_from_settings(providers: Mapping[str, Any]) -> dict[str, str]:
    """Honour a custom ``executable`` configured on a CLI provider."""

    by_kind = {
        "claude_cli": "claude",
        "codex_cli": "codex",
        "codex_app_server": "codex",
        "gemini_cli": "gemini",
    }
    found: dict[str, str] = {}
    for spec in providers.values():
        cli = by_kind.get(getattr(spec, "kind", ""))
        executable = getattr(spec, "executable", None)
        if cli and executable and cli not in found:
            found[cli] = str(executable)
    return found
