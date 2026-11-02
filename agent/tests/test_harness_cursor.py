"""POST /api/cursor: the web app's cursor report, relayed to the daemon.

The daemon is the only thing that learns where the USER moved the pointer
(kvmd does not broadcast it), and it ends the agent's control when a person
takes the mouse. On the desktop the app posts to the daemon directly; a hosted
page cannot, so the harness, which already holds a daemon capability, relays it.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from pikvm_agent.harness.agent_store import InMemoryRunStore
from pikvm_agent.harness.api import create_harness_app
from pikvm_agent.harness.cursor_relay import DaemonCursorRelay
from tests.test_harness_api import (
    TEST_ACCESS_TOKEN,
    TEST_AGENT_TOKEN,
    StubHarness,
    StubModels,
)

CAPABILITY = "harness-capability-0123456789abcdef0123"
AUTH = {"Authorization": f"Bearer {TEST_ACCESS_TOKEN}"}


class RecordingRelay:
    def __init__(self, failure: Exception | None = None) -> None:
        self.reports: list[tuple[int, int]] = []
        self.failure = failure

    async def report(self, x: int, y: int) -> None:
        if self.failure is not None:
            raise self.failure
        self.reports.append((x, y))


def _app(tmp_path: Path, relay: object | None):
    store = InMemoryRunStore()
    frame = tmp_path / "frame.jpg"
    frame.write_bytes(b"frame")
    return create_harness_app(
        harness=StubHarness(store, frame),  # type: ignore[arg-type]
        store=store,
        models=StubModels(),
        access_token=TEST_ACCESS_TOKEN,
        agent_token=TEST_AGENT_TOKEN,
        allowed_origins={"http://harness"},
        cursor_relay=relay,  # type: ignore[arg-type]
    )


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://harness"
    )


@pytest.mark.asyncio
async def test_a_report_is_relayed_to_the_daemon(tmp_path: Path) -> None:
    relay = RecordingRelay()
    async with _client(_app(tmp_path, relay)) as client:
        response = await client.post(
            "/api/cursor", json={"x": 120, "y": -32768}, headers=AUTH
        )
    assert response.status_code == 204
    assert relay.reports == [(120, -32768)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"x": 32768, "y": 0},
        {"x": 0, "y": -32769},
        {"x": "1", "y": 0},
        {"x": 1.5, "y": 0},
        {"x": 1},
        {"x": 1, "y": 2, "extra": 3},
        {},
    ],
)
async def test_a_report_outside_kvmd_units_is_refused_and_not_relayed(
    tmp_path: Path, body: dict[str, object]
) -> None:
    relay = RecordingRelay()
    async with _client(_app(tmp_path, relay)) as client:
        response = await client.post("/api/cursor", json=body, headers=AUTH)
    assert response.status_code == 422
    assert relay.reports == []


@pytest.mark.asyncio
async def test_only_the_operator_may_report(tmp_path: Path) -> None:
    # The model-side agent token must not be able to tell the daemon a human moved the mouse.
    relay = RecordingRelay()
    async with _client(_app(tmp_path, relay)) as client:
        anonymous = await client.post("/api/cursor", json={"x": 1, "y": 1})
        agent = await client.post(
            "/api/cursor",
            json={"x": 1, "y": 1},
            headers={"Authorization": f"Bearer {TEST_AGENT_TOKEN}"},
        )
    assert anonymous.status_code == 401
    assert agent.status_code == 401
    assert relay.reports == []


@pytest.mark.asyncio
async def test_without_a_daemon_there_is_nothing_to_report_to(tmp_path: Path) -> None:
    async with _client(_app(tmp_path, None)) as client:
        response = await client.post("/api/cursor", json={"x": 1, "y": 1}, headers=AUTH)
    assert response.status_code == 503


@pytest.mark.asyncio
async def test_a_daemon_that_is_down_is_a_502_not_a_crash(tmp_path: Path) -> None:
    relay = RecordingRelay(failure=httpx.ConnectError("down"))
    async with _client(_app(tmp_path, relay)) as client:
        response = await client.post("/api/cursor", json={"x": 1, "y": 1}, headers=AUTH)
    assert response.status_code == 502


@pytest.mark.asyncio
async def test_the_daemon_relay_posts_with_the_harness_capability() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    relay = DaemonCursorRelay(
        "http://daemon",
        bearer_token=CAPABILITY,
        transport=httpx.MockTransport(handler),
    )
    await relay.report(7, -9)
    await relay.aclose()

    [request] = seen
    assert request.method == "POST"
    assert request.url.path == "/cursor"
    assert request.headers["authorization"] == f"Bearer {CAPABILITY}"
    assert json.loads(request.content) == {"x": 7, "y": -9}


@pytest.mark.asyncio
async def test_the_daemon_relay_raises_when_the_daemon_refuses() -> None:
    relay = DaemonCursorRelay(
        "http://daemon",
        bearer_token=CAPABILITY,
        transport=httpx.MockTransport(lambda _r: httpx.Response(401)),
    )
    with pytest.raises(httpx.HTTPStatusError):
        await relay.report(1, 1)
    await relay.aclose()
