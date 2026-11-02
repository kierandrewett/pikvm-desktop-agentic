"""Relay the web app's cursor report to the machine-control daemon.

kvmd does not broadcast where the pointer is, so the daemon only learns of a
person's own mouse moves when the app tells it (`POST /cursor`). The daemon
also ends the agent's control when that happens. On the desktop the app posts
to the daemon directly; a hosted page cannot reach it, so the operator API
accepts the report and sends it on with the harness capability the daemon
already grants this process.
"""

from __future__ import annotations

from typing import Protocol

import httpx

from pikvm_agent.endpoint import httpx_client_kwargs


class CursorRelay(Protocol):
    async def report(self, x: int, y: int) -> None: ...


class DaemonCursorRelay:
    def __init__(
        self,
        daemon_url: str,
        *,
        bearer_token: str,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_s: float = 5.0,
    ) -> None:
        self._client = httpx.AsyncClient(
            **httpx_client_kwargs(daemon_url, transport),
            timeout=timeout_s,
            headers={"Authorization": f"Bearer {bearer_token}"},
        )

    async def report(self, x: int, y: int) -> None:
        response = await self._client.post("/cursor", json={"x": x, "y": y})
        response.raise_for_status()

    async def aclose(self) -> None:
        await self._client.aclose()
