"""BYOK key store and its harness endpoints.

FAILURE MODES (listed before the tests and the implementation)

Secrecy
 1. The key value is echoed: in the PUT reply, the list, /api/providers health,
    any error body (including FastAPI's default 422, which repeats the input).
 2. The key value is logged by any logger, or appears in an exception message.
 3. The key value reaches the YAML config (it must stay secret-free).
 4. The store file is group/other readable: on first write, after a replace
    (temp-file mode), or when a pre-existing file had loose permissions.
 5. A temp file with the secret is left behind after a write.
 6. Delete leaves the value (or the alias) in the file.

Input
 7. A key with a newline or control character reaches an HTTP header.
 8. Empty, blank, oversized, non-string or missing keys are accepted.
 9. A key is accepted for an alias that does not exist, for a CLI-owned provider,
    or for a bearer_command provider.

Runtime
10. The stored key is ignored (env wins) or needs a restart to take effect.
11. After removal the provider still sends the stale key, or no longer falls back
    to the environment variable.
12. Readiness metadata stays stale after set/remove, so the UI says "needs a key"
    while the key works (or the reverse).
13. Startup refuses to boot a harness whose only providers have stored keys.

One-flow connect + key
14. A rejected connection (conflict, secret-like model, bearer_command) leaves a
    key behind, or overwrites the existing alias's key.
15. The YAML names no env var for the new provider.

Access and degradation
16. The endpoints answer without the operator token, or to the agent token.
17. No settings directory (store disabled) crashes instead of answering 503.
18. A corrupt store file crashes reads or is silently replaced.
19. Concurrent writers lose keys.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import stat
from pathlib import Path
from typing import Any

import httpx
import pytest
import yaml

from pikvm_agent.harness.agent_store import InMemoryRunStore
from pikvm_agent.harness.api import create_harness_app
from pikvm_agent.harness.config import (
    HarnessSettings,
    build_model_pool,
    ensure_provider_prerequisites,
)
from pikvm_agent.harness.credential_store import (
    CredentialStore,
    CredentialStoreError,
    credential_store_path,
)
from pikvm_agent.harness.provider_connections import ProviderConnectionManager
from pikvm_agent.harness.providers import (
    AnthropicApiProvider,
    EnvironmentHeaderAuth,
    OpenAICompatibleProvider,
)
from pikvm_agent.harness.agent_models import ModelRequest

SECRET = "sk-test-0123456789abcdefghij-NEVER-ECHO"
OPERATOR = "operator-" + "a" * 32
AGENT = "agent-" + "b" * 32
ENV_VALUE = "env-key-0000000001"
STORED_ONE = "stored-key-000000001"
STORED_TWO = "stored-key-000000002"


def _settings(tmp_path: Path) -> HarnessSettings:
    return HarnessSettings.model_validate(
        {
            "listen": "127.0.0.1:47616",
            "state_path": str(tmp_path / "state.sqlite3"),
            "artifact_dir": str(tmp_path / "artifacts"),
            "providers": {
                "codex-account": {"kind": "codex_cli", "model": "account-default"},
                "openai-main": {
                    "kind": "openai_responses",
                    "model": "gpt-5-mini",
                    "api_key_env": "TEST_PK_OPENAI_KEY",
                },
            },
            "routes": {
                "reasoner": ["codex-account", "openai-main"],
                "controller": ["codex-account"],
                "verifier": ["codex-account"],
            },
        }
    )


class Rig:
    def __init__(self, tmp_path: Path, *, with_store: bool = True) -> None:
        self.settings = _settings(tmp_path)
        self.config_path = tmp_path / "config" / "harness.yaml"
        self.config_path.parent.mkdir()
        self.config_path.write_text(
            yaml.safe_dump(
                self.settings.model_dump(
                    mode="json", exclude_none=True, exclude_defaults=True
                ),
                sort_keys=False,
            )
        )
        self.store_path = credential_store_path(self.config_path)
        self.store = CredentialStore(self.store_path) if with_store else None
        self.pool = build_model_pool(self.settings, credentials=self.store)
        self.manager = ProviderConnectionManager(
            settings=self.settings,
            settings_path=self.config_path,
            models=self.pool,
            credentials=self.store,
        )
        self.app = create_harness_app(
            harness=object(),  # type: ignore[arg-type]
            store=InMemoryRunStore(),
            models=self.pool,
            access_token=OPERATOR,
            agent_token=AGENT,
            allowed_origins={"http://harness"},
            provider_connections=self.manager,
            credentials=self.store,
            provider_specs=lambda: self.manager.settings.providers,
        )

    def client(self, token: str | None = OPERATOR) -> httpx.AsyncClient:
        headers = {"authorization": f"Bearer {token}"} if token else {}
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app),
            base_url="http://harness",
            headers=headers,
        )

    def everything_on_disk(self) -> str:
        chunks = []
        for path in self.config_path.parent.rglob("*"):
            if path.is_file():
                chunks.append(path.read_text(errors="replace"))
        return "\n".join(chunks)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TEST_PK_OPENAI_KEY", raising=False)


@pytest.fixture
def rig(tmp_path: Path) -> Rig:
    return Rig(tmp_path)


async def test_put_stores_key_0600_and_never_echoes_it(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    async with rig.client() as client:
        put = await client.put(
            "/api/providers/openai-main/key", json={"api_key": SECRET}
        )
        listing = await client.get("/api/provider-keys")
        health = await client.get("/api/providers")

    assert put.status_code == 200
    body = put.json()
    assert body["alias"] == "openai-main"
    assert body["set"] is True
    assert body["source"] == "stored"
    assert body["updated_at"]
    for response in (put, listing, health):
        assert SECRET not in response.text
    entry = next(
        item for item in listing.json()["keys"] if item["alias"] == "openai-main"
    )
    assert entry["set"] is True and entry["updated_at"] == body["updated_at"]
    assert "value" not in entry and "api_key" not in entry
    assert SECRET not in caplog.text
    # The YAML stays secret-free; the store file is the only place it lives.
    assert SECRET not in rig.config_path.read_text()
    assert rig.store_path.exists()
    assert stat.S_IMODE(rig.store_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(rig.store_path.parent.stat().st_mode) & 0o077 == 0 or (
        rig.store_path.parent == rig.config_path.parent
    )
    assert [p.name for p in rig.store_path.parent.iterdir() if p.name.endswith(".tmp")] == []


async def test_list_covers_api_providers_only_with_set_flags(rig: Rig) -> None:
    async with rig.client() as client:
        listing = await client.get("/api/provider-keys")

    keys = listing.json()["keys"]
    assert [item["alias"] for item in keys] == ["openai-main"]
    assert keys[0]["set"] is False
    assert keys[0]["updated_at"] is None
    assert keys[0]["source"] == "missing"
    assert keys[0]["credential_env"] == "TEST_PK_OPENAI_KEY"


async def test_list_reports_environment_source_without_the_value(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TEST_PK_OPENAI_KEY", "env-secret-value-1234567890")
    async with rig.client() as client:
        listing = await client.get("/api/provider-keys")

    assert listing.json()["keys"][0]["source"] == "environment"
    assert listing.json()["keys"][0]["set"] is False
    assert "env-secret-value" not in listing.text


async def test_replace_overwrites_and_leaves_no_residue(rig: Rig) -> None:
    async with rig.client() as client:
        await client.put("/api/providers/openai-main/key", json={"api_key": SECRET})
        replaced = await client.put(
            "/api/providers/openai-main/key", json={"api_key": "second-key-0000000001"}
        )

    assert replaced.status_code == 200
    assert rig.store is not None
    assert rig.store.get("openai-main") == "second-key-0000000001"
    assert SECRET not in rig.everything_on_disk()
    assert stat.S_IMODE(rig.store_path.stat().st_mode) == 0o600
    assert [p.name for p in rig.store_path.parent.iterdir() if p.name.endswith(".tmp")] == []


async def test_delete_removes_key_from_disk_and_status(rig: Rig) -> None:
    async with rig.client() as client:
        await client.put("/api/providers/openai-main/key", json={"api_key": SECRET})
        deleted = await client.delete("/api/providers/openai-main/key")
        again = await client.delete("/api/providers/openai-main/key")
        listing = await client.get("/api/provider-keys")

    assert deleted.status_code == 200
    assert deleted.json()["removed"] is True
    assert deleted.json()["set"] is False
    assert again.status_code == 200
    assert again.json()["removed"] is False
    assert SECRET not in rig.everything_on_disk()
    assert "openai-main" not in rig.store_path.read_text()
    assert listing.json()["keys"][0]["set"] is False
    assert stat.S_IMODE(rig.store_path.stat().st_mode) == 0o600


@pytest.mark.parametrize(
    "payload",
    [
        {"api_key": ""},
        {"api_key": "   "},
        {"api_key": "good-prefix\nX-Injected: 1"},
        {"api_key": "tab\tinside-key-0123456789"},
        {"api_key": "x" * 5000},
        {"api_key": 12345},
        {"api_key": None},
        {"other": SECRET},
        {"api_key": SECRET, "extra": SECRET},
        ["list", SECRET],
    ],
)
async def test_invalid_bodies_are_refused_without_echo(
    rig: Rig, payload: Any, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    async with rig.client() as client:
        response = await client.put("/api/providers/openai-main/key", json=payload)
        raw = await client.put(
            "/api/providers/openai-main/key",
            content=f'{{"api_key": "{SECRET}" '.encode(),
            headers={"content-type": "application/json"},
        )

    assert response.status_code in {413, 422}
    assert raw.status_code == 422
    assert SECRET not in response.text and SECRET not in raw.text
    assert SECRET not in caplog.text
    assert not rig.store_path.exists()


async def test_key_is_trimmed_but_otherwise_kept_verbatim(rig: Rig) -> None:
    async with rig.client() as client:
        await client.put(
            "/api/providers/openai-main/key", json={"api_key": f"  {SECRET}\n"}
        )

    assert rig.store is not None
    assert rig.store.get("openai-main") == SECRET


async def test_unknown_alias_404_cli_provider_409(rig: Rig) -> None:
    async with rig.client() as client:
        unknown = await client.put(
            "/api/providers/nope/key", json={"api_key": SECRET}
        )
        cli = await client.put(
            "/api/providers/codex-account/key", json={"api_key": SECRET}
        )
        cli_delete = await client.delete("/api/providers/codex-account/key")

    assert unknown.status_code == 404
    assert cli.status_code == 409
    assert cli_delete.status_code == 409
    assert SECRET not in unknown.text + cli.text
    assert not rig.store_path.exists()


async def test_endpoints_require_the_operator_token(rig: Rig) -> None:
    async with rig.client(token=None) as anonymous, rig.client(token=AGENT) as agent:
        for client in (anonymous, agent):
            assert (await client.get("/api/provider-keys")).status_code == 401
            put = await client.put(
                "/api/providers/openai-main/key", json={"api_key": SECRET}
            )
            assert put.status_code == 401
            assert (await client.delete("/api/providers/openai-main/key")).status_code == 401
            assert (
                await client.post(
                    "/api/providers/with-key",
                    json={"connection": {}, "api_key": SECRET},
                )
            ).status_code == 401

    assert not rig.store_path.exists()


async def test_endpoints_answer_503_when_the_store_is_disabled(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path, with_store=False)
    async with rig.client() as client:
        assert (await client.get("/api/provider-keys")).status_code == 503
        put = await client.put(
            "/api/providers/openai-main/key", json={"api_key": SECRET}
        )
        assert put.status_code == 503
        assert (await client.delete("/api/providers/openai-main/key")).status_code == 503
        assert SECRET not in put.text


async def test_readiness_follows_the_stored_key_without_restart(rig: Rig) -> None:
    assert rig.pool.health()["openai-main"]["ready"] is False
    async with rig.client() as client:
        await client.put("/api/providers/openai-main/key", json={"api_key": SECRET})
        ready = (await client.get("/api/providers")).json()["openai-main"]
        await client.delete("/api/providers/openai-main/key")
        gone = (await client.get("/api/providers")).json()["openai-main"]

    assert ready["ready"] is True
    assert ready["credential"] == "stored-key"
    assert ready["readiness_error"] is None
    assert gone["ready"] is False
    assert gone["credential"] == "env-missing"
    assert gone["readiness_error"] == "credential-env-missing"


def test_startup_prerequisites_count_a_stored_key(tmp_path: Path) -> None:
    settings = HarnessSettings.model_validate(
        {
            "state_path": str(tmp_path / "s.sqlite3"),
            "artifact_dir": str(tmp_path / "a"),
            "providers": {
                "only-api": {
                    "kind": "anthropic_api",
                    "model": "claude-opus-4-8",
                    "api_key_env": "TEST_PK_ANTHROPIC_KEY",
                }
            },
            "routes": {
                "reasoner": ["only-api"],
                "controller": ["only-api"],
                "verifier": ["only-api"],
            },
        }
    )
    store = CredentialStore(tmp_path / "provider-keys.json")

    with pytest.raises(ValueError, match="no ready provider"):
        ensure_provider_prerequisites(settings, credentials=store)
    store.set("only-api", SECRET)
    ensure_provider_prerequisites(settings, credentials=store)


def _request() -> ModelRequest:
    return ModelRequest(
        role="reasoner",
        prompt="hi",
        output_schema={"type": "object", "properties": {}},
        run_id="run_1",
    )


async def test_runtime_prefers_stored_key_then_falls_back_to_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = CredentialStore(tmp_path / "provider-keys.json")
    monkeypatch.setenv("TEST_PK_GATEWAY", ENV_VALUE)
    seen: list[str] = []

    def handler(http_request: httpx.Request) -> httpx.Response:
        seen.append(http_request.headers["authorization"])
        return httpx.Response(
            200,
            json={
                "model": "m",
                "choices": [{"message": {"content": "{}"}}],
            },
        )

    provider = OpenAICompatibleProvider(
        name="gateway",
        model="m",
        base_url="https://gw.example/v1",
        api_key_env="TEST_PK_GATEWAY",
        transport=httpx.MockTransport(handler),
        credentials=store,
    )
    await provider.complete(_request())  # nothing stored: environment
    store.set("gateway", STORED_ONE)
    await provider.complete(_request())  # stored wins, no rebuild
    store.set("gateway", STORED_TWO)
    await provider.complete(_request())  # replaced value is used at once
    store.remove("gateway")
    await provider.complete(_request())  # removed: back to the environment
    await provider.aclose()

    assert seen == [
        f"Bearer {ENV_VALUE}",
        f"Bearer {STORED_ONE}",
        f"Bearer {STORED_TWO}",
        f"Bearer {ENV_VALUE}",
    ]
    monkeypatch.delenv("TEST_PK_GATEWAY")
    with pytest.raises(RuntimeError, match="TEST_PK_GATEWAY is not set") as raised:
        provider._api_key()
    assert "stored-key" not in str(raised.value)


async def test_runtime_header_auth_and_anthropic_use_the_alias_key(
    tmp_path: Path,
) -> None:
    store = CredentialStore(tmp_path / "provider-keys.json")
    store.set("azure-main", "azure-stored-0000001")
    store.set("claude-api", "claude-stored-000001")

    auth = EnvironmentHeaderAuth(
        env_name="TEST_PK_UNSET_AZURE",
        header="api-key",
        alias="azure-main",
        credentials=store,
    )
    anthropic = AnthropicApiProvider(
        name="claude-api",
        model="claude-opus-4-8",
        api_key_env="TEST_PK_UNSET_ANTHROPIC",
        credentials=store,
    )

    assert await auth.headers() == {"api-key": "azure-stored-0000001"}
    assert anthropic._api_key() == "claude-stored-000001"


async def test_connect_with_key_in_one_flow(rig: Rig) -> None:
    body = {
        "connection": {
            "alias": "claude-review",
            "kind": "anthropic_api",
            "model": "claude-opus-4-8",
        },
        "api_key": SECRET,
    }
    async with rig.client() as client:
        created = await client.post("/api/providers/with-key", json=body)
        health = await client.get("/api/providers")
        listing = await client.get("/api/provider-keys")

    assert created.status_code == 201
    payload = created.json()
    assert payload["provider"]["provider"] == "claude-review"
    assert payload["provider"]["ready"] is True
    assert payload["key"]["set"] is True
    assert payload["key"]["source"] == "stored"
    for response in (created, health, listing):
        assert SECRET not in response.text
    assert "claude-review" in rig.pool.providers
    assert rig.store is not None and rig.store.get("claude-review") == SECRET
    config = yaml.safe_load(rig.config_path.read_text())
    spec = config["providers"]["claude-review"]
    assert spec["api_key_env"] == "ANTHROPIC_API_KEY"
    assert SECRET not in rig.config_path.read_text()
    assert stat.S_IMODE(rig.config_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(rig.store_path.stat().st_mode) == 0o600


async def test_connect_with_key_respects_an_explicit_env_name(rig: Rig) -> None:
    async with rig.client() as client:
        created = await client.post(
            "/api/providers/with-key",
            json={
                "connection": {
                    "alias": "gw",
                    "kind": "openai_compatible",
                    "model": "fast",
                    "base_url": "https://gw.example/v1",
                    "credential_env": "MY_GATEWAY_KEY",
                },
                "api_key": SECRET,
            },
        )

    assert created.status_code == 201
    config = yaml.safe_load(rig.config_path.read_text())
    assert config["providers"]["gw"]["api_key_env"] == "MY_GATEWAY_KEY"


async def test_connect_with_key_conflict_keeps_the_existing_key(rig: Rig) -> None:
    assert rig.store is not None
    rig.store.set("openai-main", "original-key-0000001")
    async with rig.client() as client:
        conflict = await client.post(
            "/api/providers/with-key",
            json={
                "connection": {
                    "alias": "openai-main",
                    "kind": "openai_responses",
                    "model": "gpt-5-mini",
                },
                "api_key": SECRET,
            },
        )

    assert conflict.status_code == 409
    assert SECRET not in conflict.text
    assert rig.store.get("openai-main") == "original-key-0000001"


@pytest.mark.parametrize(
    "connection",
    [
        {"alias": "bad", "kind": "openai_responses", "model": "sk-live-abcdefghijklmnop"},
        {"alias": "cli", "kind": "claude_cli", "model": "sonnet"},
        {
            "alias": "az",
            "kind": "azure_openai_responses",
            "model": "gpt-5",
            "base_url": "https://r.openai.azure.com/openai/v1",
            "auth_mode": "bearer_command",
        },
        {"alias": "missing-kind", "model": "x"},
    ],
)
async def test_connect_with_key_rejections_store_nothing(
    rig: Rig, connection: dict[str, Any], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    async with rig.client() as client:
        response = await client.post(
            "/api/providers/with-key",
            json={"connection": connection, "api_key": SECRET},
        )
        no_key = await client.post(
            "/api/providers/with-key", json={"connection": connection}
        )

    assert response.status_code == 422
    assert no_key.status_code == 422
    assert SECRET not in response.text + no_key.text + caplog.text
    assert not rig.store_path.exists()
    assert connection["alias"] not in rig.pool.providers


async def test_existing_validators_still_refuse_secrets_on_the_plain_endpoint(
    rig: Rig,
) -> None:
    async with rig.client() as client:
        response = await client.post(
            "/api/providers",
            json={
                "alias": "plain",
                "kind": "openai_responses",
                "model": "gpt-5-mini",
                "credential_env": "sk-live-abcdefghijklmnop",
            },
        )

    assert response.status_code == 422


def test_store_tightens_loose_permissions_on_load(tmp_path: Path) -> None:
    path = tmp_path / "provider-keys.json"
    path.write_text(
        json.dumps(
            {"version": 1, "keys": {"a": {"value": SECRET, "updated_at": "2026-01-01T00:00:00Z"}}}
        )
    )
    os.chmod(path, 0o644)

    store = CredentialStore(path)

    assert store.get("a") == SECRET
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_store_creates_private_directory_and_file(tmp_path: Path) -> None:
    path = tmp_path / "fresh" / "provider-keys.json"
    store = CredentialStore(path)

    store.set("a", SECRET)

    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert list(path.parent.iterdir()) == [path]


async def test_corrupt_store_degrades_reads_and_refuses_to_overwrite(
    rig: Rig,
) -> None:
    rig.store_path.write_text("{ not json")
    os.chmod(rig.store_path, 0o600)
    assert rig.store is not None

    assert rig.store.get("openai-main") is None
    with pytest.raises(CredentialStoreError) as raised:
        rig.store.set("openai-main", SECRET)
    assert SECRET not in str(raised.value)
    async with rig.client() as client:
        put = await client.put(
            "/api/providers/openai-main/key", json={"api_key": SECRET}
        )
        listing = await client.get("/api/provider-keys")

    assert put.status_code == 500
    assert SECRET not in put.text
    assert listing.status_code == 500
    assert rig.store_path.read_text() == "{ not json"


async def test_concurrent_writers_keep_every_key(tmp_path: Path) -> None:
    store = CredentialStore(tmp_path / "provider-keys.json")
    other = CredentialStore(tmp_path / "provider-keys.json")

    await asyncio.gather(
        *[
            asyncio.to_thread((store if n % 2 else other).set, f"p{n}", f"value-{n:08d}")
            for n in range(20)
        ]
    )

    assert {alias for alias in store.describe()} == {f"p{n}" for n in range(20)}
    assert stat.S_IMODE((tmp_path / "provider-keys.json").stat().st_mode) == 0o600
