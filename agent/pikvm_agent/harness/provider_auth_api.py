"""Operator routes for provider API keys and CLI sign-in.

Every route here is operator-only: the auth middleware gives the agent and
observer tokens no access to ``/api/providers/*``, ``/api/provider-keys`` or
``/api/cli-auth``.

Secret handling: bodies that carry a key or a sign-in code are parsed by hand.
FastAPI's default 422 echoes the offending input, which would put the secret in
a response (and in any proxy log of it). Errors here name the problem, never the
value.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable, Mapping
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from pikvm_agent.harness.cli_signin import CliAuthError, CliSignInManager
from pikvm_agent.harness.config import ProviderSpec
from pikvm_agent.harness.credential_store import (
    CREDENTIAL_STATE_LABEL,
    CredentialSource,
    CredentialStore,
    CredentialStoreError,
    InvalidCredentialValue,
    credential_source,
    default_credential_env,
    normalize_api_key,
)
from pikvm_agent.harness.provider_connections import (
    ProviderConnectionConflict,
    ProviderConnectionPolicyConflict,
    ProviderConnectionRequest,
)

_LOG = logging.getLogger(__name__)
_MAX_BODY_BYTES = 16_384
_KEYLESS_KINDS = {
    "codex_cli",
    "codex_app_server",
    "claude_cli",
    "gemini_cli",
    "subprocess_json",
}


async def _json_body(request: Request) -> dict[str, Any]:
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > _MAX_BODY_BYTES:
        raise HTTPException(413, "request body is too large")
    raw = await request.body()
    if len(raw) > _MAX_BODY_BYTES:
        raise HTTPException(413, "request body is too large")
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        raise HTTPException(422, "the body must be valid JSON") from None
    if not isinstance(data, dict):
        raise HTTPException(422, "the body must be a JSON object")
    return data


def _only_fields(data: Mapping[str, Any], allowed: set[str]) -> None:
    if set(data) - allowed:
        raise HTTPException(
            422, "the body has unexpected fields; allowed: " + ", ".join(sorted(allowed))
        )


def _key_env(spec: ProviderSpec) -> str | None:
    """The env name a provider falls back to, or None if it takes no key."""

    if spec.kind in _KEYLESS_KINDS:
        return None
    if spec.kind in {"azure_openai_responses", "vertex_gemini"}:
        if spec.auth_mode in {"api_key", "bearer_env"}:
            return spec.credential_env
        return None
    return spec.api_key_env


def install_provider_auth_routes(
    app: FastAPI,
    *,
    credentials: CredentialStore | None,
    provider_specs: Callable[[], Mapping[str, ProviderSpec]] | None,
    provider_connections: Any | None,
    models: Any,
    cli_signin: CliSignInManager | None,
) -> None:
    def require_store() -> CredentialStore:
        if credentials is None or provider_specs is None:
            raise HTTPException(
                503, "provider key storage is not enabled for this harness"
            )
        return credentials

    def key_status(alias: str, spec: ProviderSpec) -> dict[str, object]:
        store = require_store()
        env_name = _key_env(spec)
        stored = store.describe().get(alias)
        source: CredentialSource = credential_source(alias, env_name, store)
        return {
            "alias": alias,
            "kind": spec.kind,
            "credential_env": env_name,
            "set": stored is not None,
            "updated_at": (stored.updated_at or None) if stored else None,
            "source": source,
        }

    def refresh_pool(alias: str, spec: ProviderSpec) -> None:
        refresh = getattr(models, "set_credential_state", None)
        if refresh is None:
            return
        source = credential_source(alias, _key_env(spec), credentials)
        try:
            refresh(
                alias,
                credential=CREDENTIAL_STATE_LABEL[source],
                ready=source != "missing",
                readiness_error=(
                    "credential-env-missing" if source == "missing" else None
                ),
            )
        except ValueError:
            # A provider that is configured but not (yet) in the pool.
            _LOG.debug("credential state refresh skipped for an unknown provider")

    def eligible_spec(alias: str) -> ProviderSpec:
        require_store()
        assert provider_specs is not None
        spec = provider_specs().get(alias)
        if spec is None:
            raise HTTPException(404, "unknown provider")
        if _key_env(spec) is None:
            raise HTTPException(
                409, "this provider does not use an API key; it signs in or uses a command"
            )
        return spec

    def storage_failure(exc: CredentialStoreError) -> HTTPException:
        return HTTPException(500, str(exc))

    @app.get("/api/provider-keys")
    async def list_provider_keys() -> dict[str, object]:
        store = require_store()
        assert provider_specs is not None
        try:
            described = await asyncio.to_thread(store.describe)
        except CredentialStoreError as exc:
            raise storage_failure(exc) from None
        keys = []
        for alias, spec in sorted(provider_specs().items()):
            env_name = _key_env(spec)
            if env_name is None:
                continue
            stored = described.get(alias)
            keys.append(
                {
                    "alias": alias,
                    "kind": spec.kind,
                    "credential_env": env_name,
                    "set": stored is not None,
                    "updated_at": (stored.updated_at or None) if stored else None,
                    "source": credential_source(alias, env_name, store),
                }
            )
        return {"keys": keys}

    @app.put("/api/providers/{alias}/key")
    async def put_provider_key(alias: str, request: Request) -> dict[str, object]:
        spec = eligible_spec(alias)
        data = await _json_body(request)
        _only_fields(data, {"api_key"})
        try:
            value = normalize_api_key(data.get("api_key"))
        except InvalidCredentialValue as exc:
            raise HTTPException(422, str(exc)) from None
        assert credentials is not None
        try:
            await asyncio.to_thread(credentials.set, alias, value)
        except CredentialStoreError as exc:
            raise storage_failure(exc) from None
        refresh_pool(alias, spec)
        return key_status(alias, spec)

    @app.delete("/api/providers/{alias}/key")
    async def delete_provider_key(alias: str) -> dict[str, object]:
        spec = eligible_spec(alias)
        assert credentials is not None
        try:
            removed = await asyncio.to_thread(credentials.remove, alias)
        except CredentialStoreError as exc:
            raise storage_failure(exc) from None
        refresh_pool(alias, spec)
        return {**key_status(alias, spec), "removed": removed}

    @app.post("/api/providers/with-key", status_code=201)
    async def connect_provider_with_key(request: Request) -> dict[str, object]:
        require_store()
        if provider_connections is None:
            raise HTTPException(
                503, "provider connections are not enabled for this harness"
            )
        data = await _json_body(request)
        _only_fields(data, {"connection", "api_key"})
        connection = data.get("connection")
        if not isinstance(connection, dict):
            raise HTTPException(422, "connection must be an object")
        try:
            value = normalize_api_key(data.get("api_key"))
        except InvalidCredentialValue as exc:
            raise HTTPException(422, str(exc)) from None
        values = dict(connection)
        kind = values.get("kind")
        if values.get("credential_env") is None and isinstance(kind, str):
            default = default_credential_env(kind, values.get("auth_mode"))
            if default is not None:
                values["credential_env"] = default
        try:
            parsed = ProviderConnectionRequest.model_validate(values)
        except ValidationError as exc:
            # `loc` and `msg` only: the full error carries the offending input.
            raise HTTPException(
                422,
                "; ".join(
                    f"{'.'.join(str(part) for part in error['loc']) or 'connection'}: "
                    f"{error['msg']}"
                    for error in exc.errors(include_input=False, include_url=False)
                ),
            ) from None
        spec = parsed.provider_spec()
        if _key_env(spec) is None:
            raise HTTPException(
                422, "this provider does not use an API key; connect it without one"
            )
        try:
            result = await provider_connections.connect(parsed)
        except (ProviderConnectionConflict, ProviderConnectionPolicyConflict) as exc:
            raise HTTPException(409, str(exc)) from None
        assert credentials is not None
        try:
            await asyncio.to_thread(credentials.set, parsed.alias, value)
        except CredentialStoreError as exc:
            raise HTTPException(
                500,
                f"the provider was added but its key could not be saved: {exc}",
            ) from None
        refresh_pool(parsed.alias, spec)
        health = models.health().get(parsed.alias, {})
        result = result.model_copy(
            update={
                "ready": bool(health.get("ready", True)),
                "readiness_error": (
                    str(health["readiness_error"])
                    if health.get("readiness_error")
                    else None
                ),
            }
        )
        return {
            "provider": result.model_dump(mode="json"),
            "key": key_status(parsed.alias, spec),
        }

    # -- CLI sign-in -----------------------------------------------------

    def require_cli() -> CliSignInManager:
        if cli_signin is None:
            raise HTTPException(503, "CLI sign-in is not enabled for this harness")
        return cli_signin

    @app.exception_handler(CliAuthError)
    async def cli_auth_error(_: Request, exc: CliAuthError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content=exc.body())

    @app.get("/api/cli-auth")
    async def cli_auth_status() -> dict[str, object]:
        return {"clis": await require_cli().statuses()}

    @app.post("/api/cli-auth/{cli}/sign-in", status_code=202)
    async def cli_sign_in(cli: str, request: Request) -> dict[str, object]:
        manager = require_cli()
        data = await _json_body(request)
        _only_fields(data, {"replace"})
        replace = data.get("replace", False)
        if not isinstance(replace, bool):
            raise HTTPException(422, "replace must be true or false")
        return await manager.start(cli, replace=replace)

    @app.get("/api/cli-auth/{cli}/sign-in")
    async def cli_sign_in_attempt(cli: str) -> dict[str, object]:
        attempt = require_cli().attempt(cli)
        if attempt is None:
            raise HTTPException(404, "no sign-in has been started")
        return attempt

    @app.post("/api/cli-auth/{cli}/sign-in/code")
    async def cli_sign_in_code(cli: str, request: Request) -> dict[str, object]:
        manager = require_cli()
        data = await _json_body(request)
        _only_fields(data, {"auth_code"})
        return await manager.submit_code(cli, data.get("auth_code"))

    @app.delete("/api/cli-auth/{cli}/sign-in")
    async def cli_sign_in_cancel(cli: str) -> dict[str, object]:
        return await require_cli().cancel(cli)

    @app.post("/api/cli-auth/{cli}/sign-out")
    async def cli_sign_out(cli: str) -> dict[str, object]:
        return await require_cli().sign_out(cli)
