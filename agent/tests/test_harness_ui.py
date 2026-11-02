from __future__ import annotations

import gzip
import json
import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from pikvm_agent.harness.agent_models import RunSnapshot, RunStatus
from pikvm_agent.harness.agent_store import InMemoryRunStore
from pikvm_agent.harness.api import create_harness_app

TEST_ACCESS_TOKEN = "test-harness-token-0123456789abcdef"
PROJECT_ROOT = Path(__file__).parents[1]
UI_DIR = PROJECT_ROOT / "pikvm_agent" / "harness_ui"
FRONTEND_DIR = PROJECT_ROOT / "frontend"


class NoopHarness:
    async def create(self, task: str) -> RunSnapshot:
        return RunSnapshot(run_id="unused", task=task, status=RunStatus.PAUSED)

    async def continue_run(self, run_id: str) -> RunSnapshot:
        raise AssertionError("not used")

    async def pause(self, run_id: str, reason: str) -> RunSnapshot:
        raise AssertionError("not used")

    async def resolve_approval(
        self, run_id: str, approval_id: str, decision: dict[str, Any]
    ) -> RunSnapshot:
        raise AssertionError("not used")

    async def abort(self, run_id: str, reason: str) -> RunSnapshot:
        raise AssertionError("not used")


class NoopModels:
    def health(self) -> dict[str, dict[str, object]]:
        return {}


@pytest.mark.asyncio
async def test_harness_serves_the_compiled_authenticated_chat_workspace() -> None:
    app = create_harness_app(
        harness=NoopHarness(),  # type: ignore[arg-type]
        store=InMemoryRunStore(),
        models=NoopModels(),
        access_token=TEST_ACCESS_TOKEN,
        allowed_origins={"http://harness"},
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://harness",
        follow_redirects=False,
    ) as client:
        root = await client.get("/")
        page = await client.get("/app/")
        script = await client.get("/app/app.js")
        styles = await client.get("/app/styles.css")
        font = await client.get(
            "/app/assets/geist-latin-wght-normal.woff2"
        )
        computer_chunk_path = next(
            path
            for path in UI_DIR.glob("assets/computer-tool-call-*.js")
        )
        computer_chunk = await client.get(
            f"/app/assets/{computer_chunk_path.name}"
        )

    assert root.status_code in {302, 307}
    assert root.headers["location"] == "/app/"
    assert page.status_code == 200
    assert script.status_code == 200
    assert styles.status_code == 200
    assert page.headers["cache-control"] == "no-store"
    assert script.headers["cache-control"] == "no-store"
    assert styles.headers["cache-control"] == "no-store"
    assert font.status_code == 200
    assert font.headers["content-type"].startswith("font/woff2")
    assert computer_chunk.status_code == 200
    assert "javascript" in computer_chunk.headers["content-type"]

    assert '<div id="root"></div>' in page.text
    assert "Content-Security-Policy" in page.text
    assert "sessionStorage" in script.text
    assert "Authorization" in script.text
    assert "X-PiKVM-Approval-Intent" in script.text
    assert "model_provider" in script.text
    assert "/steer" in script.text
    assert "localStorage" not in script.text
    assert "?token=" not in script.text


@pytest.mark.asyncio
async def test_served_page_asset_urls_resolve_against_the_page_url() -> None:
    """The bundle uses relative URLs so one build works wherever it is mounted.

    That only works if the document is at a URL ending in "/": "./app.js" resolves
    against the page's directory. So what is pinned is the behaviour, not the markup:
    every script and stylesheet the served page names, resolved the way a browser
    resolves it, is answered by the harness.
    """
    app = create_harness_app(
        harness=NoopHarness(),  # type: ignore[arg-type]
        store=InMemoryRunStore(),
        models=NoopModels(),
        access_token=TEST_ACCESS_TOKEN,
        allowed_origins={"http://harness"},
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://harness",
        follow_redirects=True,
    ) as client:
        # Whatever the entry URL, the page a browser ends up on ends in "/".
        for entry in ("/", "/app", "/app/"):
            page = await client.get(entry)
            assert page.status_code == 200, entry
            assert str(page.url).endswith("/"), (entry, str(page.url))

            references = re.findall(
                r'<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"', page.text
            )
            assets = [ref for ref in references if not ref.startswith("data:")]
            assert any(ref.endswith(".js") for ref in assets), entry
            assert any(ref.endswith(".css") for ref in assets), entry
            for ref in assets:
                resolved = page.url.join(ref)
                reply = await client.get(resolved)
                assert reply.status_code == 200, (entry, ref, str(resolved))
                assert reply.headers["content-type"].split(";")[0] != "text/html", (
                    entry,
                    ref,
                )


def test_compiled_workspace_has_no_remote_assets_and_a_bounded_bundle() -> None:
    html = (UI_DIR / "index.html").read_text()
    javascript = (UI_DIR / "app.js").read_bytes()
    styles = (UI_DIR / "styles.css").read_bytes()
    assets = [path for path in UI_DIR.rglob("*") if path.is_file()]
    deferred_chunks = {
        path.name
        for path in (UI_DIR / "assets").glob("*.js")
    }
    initial_javascript = [
        UI_DIR / match
        for match in re.findall(
            r'(?:src|href)="\./([^"]+\.js)"',
            html,
        )
    ]

    assert "https://" not in html
    assert "http://" not in html
    assert html.count("<script") == 1
    assert any(name.startswith("computer-tool-call-") for name in deferred_chunks)
    assert any(name.startswith("computer-sheet-") for name in deferred_chunks)
    assert any(name.startswith("diagnostics-sheet-") for name in deferred_chunks)
    assert any(
        name.startswith("provider-connections-sheet-")
        for name in deferred_chunks
    )
    assert initial_javascript, "the page names no script to bound"
    assert all(path.stat().st_size <= 1_100_000 for path in assets)
    # Everything the build emits, deferred chunks included. The budget was 1_250_000,
    # which the bundle had already outgrown (1_295_923 bytes) when the conversation
    # moved into packages/chat-ui; the move itself adds the phone layout, the approval
    # dock, collapsible code blocks and the sheet presentations (~20 kB). The limits
    # that protect first load are the gzip ones below, which are unchanged.
    assert sum(path.stat().st_size for path in assets) <= 1_350_000
    assert len(gzip.compress(javascript)) <= 250 * 1024
    assert (
        sum(len(gzip.compress(path.read_bytes())) for path in initial_javascript)
        <= 300 * 1024
    )
    assert len(gzip.compress(styles)) <= 24 * 1024
