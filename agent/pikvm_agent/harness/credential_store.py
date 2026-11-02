"""Write-only API-key storage for harness model providers.

Keys are accepted on one dedicated endpoint, never returned, never written to the
YAML config, and live in a single JSON file next to that config. The file is
created 0600 (and its directory 0700 when we create it); every write goes through
a same-directory temp file and an atomic rename, so a crash leaves either the old
file or the new one and never a world-readable copy.

Why a file and not the OS keyring: the harness is a child process of the desktop
app or a service on a headless host. Secret Service needs a session bus and an
unlocked collection, macOS and Windows prompt, and a failed keyring lookup at
request time would silently turn a configured provider into "not set". A 0600
file in the user's own settings directory is as exposed as the CLI logins
(`~/.claude`, `~/.codex`) the harness already relies on, works everywhere the
harness runs, and is easy to reason about and back up. Encryption at rest would
need a key stored beside it, which only moves the problem.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import tempfile
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Protocol

_LOG = logging.getLogger(__name__)

STORE_FILENAME = "provider-keys.json"
_STORE_VERSION = 1
MAX_API_KEY_LENGTH = 4096

CredentialSource = Literal["stored", "environment", "missing"]

# The `credential` field of a provider's readiness status for each key source.
CREDENTIAL_STATE_LABEL: dict[CredentialSource, str] = {
    "stored": "stored-key",
    "environment": "env-present",
    "missing": "env-missing",
}

# What a provider kind reads when the connection does not name an env variable.
# The stored key is looked up first, so the name only matters as a fallback for
# operators who already export the variable.
_DEFAULT_CREDENTIAL_ENV = {
    "openai_responses": "OPENAI_API_KEY",
    "anthropic_api": "ANTHROPIC_API_KEY",
    "gemini_api": "GEMINI_API_KEY",
    "openai_compatible": "MODEL_GATEWAY_KEY",
    "vertex_gemini": "GOOGLE_CLOUD_ACCESS_TOKEN",
}


def default_credential_env(kind: str, auth_mode: str | None) -> str | None:
    if kind == "azure_openai_responses":
        return (
            "AZURE_OPENAI_API_KEY"
            if auth_mode == "api_key"
            else "AZURE_OPENAI_ACCESS_TOKEN"
        )
    return _DEFAULT_CREDENTIAL_ENV.get(kind)


class CredentialStoreError(RuntimeError):
    """The store file is unreadable or could not be written.

    Messages never contain key material.
    """


class InvalidCredentialValue(ValueError):
    """A submitted key cannot be a usable credential. Never carries the value."""


class CredentialLookup(Protocol):
    """What a provider needs at call time: the stored key for its alias."""

    def get(self, alias: str) -> str | None: ...


@dataclass(frozen=True)
class StoredKey:
    updated_at: str


def credential_store_path(settings_path: Path) -> Path:
    """The store lives beside the harness config it complements."""

    return settings_path.expanduser().resolve().parent / STORE_FILENAME


def normalize_api_key(raw: object) -> str:
    """Trim and validate a pasted key.

    The value ends up in an HTTP header, so anything that is not printable ASCII
    without spaces (newlines above all) is refused rather than escaped.
    """

    if not isinstance(raw, str):
        raise InvalidCredentialValue("the key must be a string")
    value = raw.strip()
    if not value:
        raise InvalidCredentialValue("the key is empty")
    if len(value) > MAX_API_KEY_LENGTH:
        raise InvalidCredentialValue(
            f"the key is longer than {MAX_API_KEY_LENGTH} characters"
        )
    if any(not 0x21 <= ord(char) <= 0x7E for char in value):
        raise InvalidCredentialValue(
            "the key must be printable ASCII without spaces or line breaks"
        )
    return value


def credential_source(
    alias: str,
    env_name: str | None,
    credentials: CredentialLookup | None,
    environ: Mapping[str, str] | None = None,
) -> CredentialSource:
    """Where a provider's key would come from right now, without returning it."""

    if credentials is not None and credentials.get(alias):
        return "stored"
    source = os.environ if environ is None else environ
    if env_name and source.get(env_name):
        return "environment"
    return "missing"


def resolve_api_key(
    alias: str,
    env_name: str,
    credentials: CredentialLookup | None,
) -> str | None:
    """The stored key for ``alias`` first, then the named environment variable."""

    if credentials is not None:
        stored = credentials.get(alias)
        if stored:
            return stored
    return os.environ.get(env_name) or None


_PATH_LOCKS: dict[Path, threading.RLock] = {}
_PATH_LOCKS_GUARD = threading.Lock()


def _lock_for(path: Path) -> threading.RLock:
    with _PATH_LOCKS_GUARD:
        return _PATH_LOCKS.setdefault(path, threading.RLock())


class CredentialStore:
    """A small JSON file of ``alias -> key`` with ``updated_at`` per entry."""

    def __init__(self, path: Path) -> None:
        self._path = path.expanduser().resolve()
        self._lock = _lock_for(self._path)
        self._cache: tuple[tuple[int, int, int], dict[str, dict[str, str]]] | None = None

    @property
    def path(self) -> Path:
        return self._path

    # -- reads ---------------------------------------------------------

    def get(self, alias: str) -> str | None:
        """The stored key, or None. An unreadable file reads as no keys."""

        try:
            entry = self._read().get(alias)
        except CredentialStoreError:
            return None
        if entry is None:
            return None
        value = entry.get("value")
        return value if isinstance(value, str) and value else None

    def describe(self) -> dict[str, StoredKey]:
        """Which aliases have a key and when it changed. Never any value."""

        return {
            alias: StoredKey(updated_at=str(entry.get("updated_at") or ""))
            for alias, entry in self._read().items()
        }

    # -- writes --------------------------------------------------------

    def set(self, alias: str, value: str) -> StoredKey:
        key = normalize_api_key(value)
        with self._lock:
            keys = dict(self._read())
            updated_at = _now()
            keys[alias] = {"value": key, "updated_at": updated_at}
            self._write(keys)
        return StoredKey(updated_at=updated_at)

    def remove(self, alias: str) -> bool:
        with self._lock:
            keys = dict(self._read())
            if alias not in keys:
                return False
            del keys[alias]
            self._write(keys)
        return True

    # -- file handling -------------------------------------------------

    def _read(self) -> dict[str, dict[str, str]]:
        with self._lock:
            try:
                info = self._path.stat()
            except FileNotFoundError:
                self._cache = None
                return {}
            except OSError as exc:
                raise CredentialStoreError(
                    "the provider key file cannot be read"
                ) from exc
            signature = (info.st_ino, info.st_size, info.st_mtime_ns)
            if self._cache is not None and self._cache[0] == signature:
                return self._cache[1]
            if info.st_mode & 0o077:
                with contextlib.suppress(OSError):
                    os.chmod(self._path, 0o600)
            try:
                raw = json.loads(self._path.read_text(encoding="utf-8"))
                keys = raw["keys"]
                if (
                    raw.get("version") != _STORE_VERSION
                    or not isinstance(keys, dict)
                    or not all(
                        isinstance(alias, str) and isinstance(entry, dict)
                        for alias, entry in keys.items()
                    )
                ):
                    raise ValueError("unexpected shape")
            except (OSError, ValueError, KeyError, TypeError) as exc:
                # The message names the problem class only; the file content
                # is key material.
                _LOG.warning(
                    "provider key file is unreadable (%s)", type(exc).__name__
                )
                raise CredentialStoreError(
                    "the provider key file is unreadable; fix or remove it"
                ) from None
            parsed = {
                alias: {
                    "value": str(entry.get("value") or ""),
                    "updated_at": str(entry.get("updated_at") or ""),
                }
                for alias, entry in keys.items()
            }
            self._cache = (signature, parsed)
            return parsed

    def _write(self, keys: dict[str, dict[str, str]]) -> None:
        directory = self._path.parent
        try:
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            descriptor, temporary = tempfile.mkstemp(
                prefix=f".{self._path.name}.", suffix=".tmp", dir=directory
            )
        except OSError as exc:
            raise CredentialStoreError(
                "the provider key file cannot be written"
            ) from exc
        temporary_path = Path(temporary)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                os.fchmod(handle.fileno(), 0o600)
                json.dump({"version": _STORE_VERSION, "keys": keys}, handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self._path)
        except OSError as exc:
            raise CredentialStoreError(
                "the provider key file cannot be written"
            ) from exc
        finally:
            temporary_path.unlink(missing_ok=True)
        self._cache = None
        with contextlib.suppress(OSError):
            directory_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
