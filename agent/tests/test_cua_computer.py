"""PiKVMComputer driven through cua's own action dispatch.

Each test maps to a numbered failure mode in ``docs/CUA.md``. Actions go
through ``ComputerAgent._handle_item`` (the code cua runs for every model
action) so a signature cua cannot call fails here, not on a live target. No
model is called.
"""

from __future__ import annotations

import base64
import io

import pytest
from PIL import Image

pytest.importorskip("cua_agent")

from cua_agent import ComputerAgent  # noqa: E402
from cua_agent.computers import make_computer_handler  # noqa: E402

from pikvm_agent.cua.computer import PiKVMComputer  # noqa: E402
from pikvm_agent.pikvm.fake import FakeBackend  # noqa: E402


class _Backend(FakeBackend):
    """FakeBackend plus the exact-print path PiKVMBackend has.

    Kept out of FakeBackend itself: WatchedTyper changes transport when a
    backend has ``print_exact_text``, which would change other suites.
    """

    async def print_exact_text(self, text: str) -> None:
        self._record("print_exact_text", text=text)


def _agent(computer: PiKVMComputer) -> ComputerAgent:
    return ComputerAgent(
        model="anthropic/claude-sonnet-4-5",
        tools=[computer],
        telemetry_enabled=False,
        screenshot_delay=0,
    )


async def _act(computer: PiKVMComputer, action: dict) -> list[dict]:
    handler = await make_computer_handler(computer)
    return await _agent(computer)._handle_item(
        {"type": "computer_call", "call_id": "c1", "action": action},
        computer=handler,
    )


def _hid(backend: FakeBackend) -> list[tuple[str, dict]]:
    return [call for call in backend.calls if call[0] != "release_all"]


@pytest.fixture
def backend() -> FakeBackend:
    return _Backend(width=1280, height=720)


@pytest.fixture
def computer(backend: FakeBackend) -> PiKVMComputer:
    return PiKVMComputer(backend)


async def test_is_a_cua_computer(computer: PiKVMComputer) -> None:
    assert await make_computer_handler(computer) is computer


# 1, 2, 3


async def test_screenshot_is_png_and_matches_dimensions(computer: PiKVMComputer) -> None:
    assert await computer.get_dimensions() == (1280, 720)
    image = Image.open(io.BytesIO(base64.b64decode(await computer.screenshot())))
    assert image.format == "PNG"
    assert image.size == await computer.get_dimensions()


async def test_action_result_carries_a_png_screenshot(computer: PiKVMComputer) -> None:
    [output] = await _act(computer, {"type": "click", "x": 10, "y": 20, "button": "left"})
    url = output["output"]["image_url"]
    assert url.startswith("data:image/png;base64,")
    assert Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))).format == "PNG"


# 4


async def test_click_is_clamped_to_the_frame(
    computer: PiKVMComputer, backend: FakeBackend
) -> None:
    await _act(computer, {"type": "click", "x": 5000, "y": -40, "button": "right"})
    assert _hid(backend) == [("click", {"x": 1279, "y": 0, "button": "right"})]


async def test_double_click(computer: PiKVMComputer, backend: FakeBackend) -> None:
    await _act(computer, {"type": "double_click", "x": 100, "y": 200})
    assert _hid(backend) == [("double_click", {"x": 100, "y": 200, "button": "left"})]


# 5


@pytest.mark.parametrize(
    ("keys", "expected"),
    [
        (["ctrl", "s"], ["ControlLeft", "KeyS"]),
        ("ctrl+shift+t", ["ControlLeft", "ShiftLeft", "KeyT"]),
        (["Return"], ["Enter"]),
        ("Page_Down", ["PageDown"]),
        (["super"], ["MetaLeft"]),
        (["cmd", "space"], ["MetaLeft", "Space"]),
        (["KP_Enter"], ["NumpadEnter"]),
        (["ctrl", "A"], ["ControlLeft", "KeyA"]),
        (["alt", "F4"], ["AltLeft", "F4"]),
        (["ArrowUp"], ["ArrowUp"]),
    ],
)
async def test_key_names_map_to_pikvm_codes(
    computer: PiKVMComputer, backend: FakeBackend, keys: object, expected: list[str]
) -> None:
    await _act(computer, {"type": "keypress", "keys": keys})
    assert _hid(backend) == [("keypress", {"keys": expected})]


async def test_unknown_key_is_a_tool_error_not_a_no_op(
    computer: PiKVMComputer, backend: FakeBackend
) -> None:
    [output] = await _act(computer, {"type": "keypress", "keys": ["hyperspace"]})
    assert "hyperspace" in str(output)
    assert _hid(backend) == []


# 6, 7


async def test_type_presses_enter_between_lines(
    computer: PiKVMComputer, backend: FakeBackend
) -> None:
    await _act(computer, {"type": "type", "text": "ls -la\ncd /tmp\n"})
    assert _hid(backend) == [
        ("print_exact_text", {"text": "ls -la"}),
        ("press_key", {"code": "Enter"}),
        ("print_exact_text", {"text": "cd /tmp"}),
        ("press_key", {"code": "Enter"}),
    ]


async def test_type_without_newline_never_presses_enter(
    computer: PiKVMComputer, backend: FakeBackend
) -> None:
    await _act(computer, {"type": "type", "text": "hello world"})
    assert _hid(backend) == [("print_exact_text", {"text": "hello world"})]


# 8


class _FailingBackend(_Backend):
    async def move_mouse(self, x: int, y: int) -> None:
        raise RuntimeError("websocket dropped")


async def test_failed_drag_releases_buttons_and_modifiers() -> None:
    backend = _FailingBackend()
    computer = PiKVMComputer(backend)
    with pytest.raises(RuntimeError):
        await computer.drag([{"x": 1, "y": 1}, {"x": 50, "y": 50}])
    assert backend.calls[-1] == ("release_all", {})


# 9, 10


@pytest.mark.parametrize(
    ("scroll_x", "scroll_y", "dx", "dy"),
    [
        (0, 3, 0, -3),  # Anthropic: 3 clicks down
        (0, -5, 0, 5),  # Anthropic: 5 clicks up
        (0, 600, 0, -6),  # OpenAI: pixels down
        (-200, 0, -2, 0),  # OpenAI: pixels left
        (0, 9000, 0, -15),  # capped
    ],
)
async def test_scroll_moves_first_and_normalises_units(
    computer: PiKVMComputer,
    backend: FakeBackend,
    scroll_x: int,
    scroll_y: int,
    dx: int,
    dy: int,
) -> None:
    await _act(
        computer,
        {"type": "scroll", "x": 300, "y": 400, "scroll_x": scroll_x, "scroll_y": scroll_y},
    )
    assert _hid(backend) == [
        ("move_mouse", {"x": 300, "y": 400}),
        ("scroll", {"dx": dx, "dy": dy}),
    ]


# 11


async def test_drag_follows_the_path(computer: PiKVMComputer, backend: FakeBackend) -> None:
    await _act(
        computer,
        {"type": "drag", "path": [{"x": 10, "y": 10}, {"x": 20, "y": 30}, {"x": 40, "y": 50}]},
    )
    assert _hid(backend) == [
        ("move_mouse", {"x": 10, "y": 10}),
        ("mouse_button", {"button": "left", "down": True}),
        ("move_mouse", {"x": 20, "y": 30}),
        ("move_mouse", {"x": 40, "y": 50}),
        ("mouse_button", {"button": "left", "down": False}),
    ]


@pytest.mark.parametrize("path", [[], [{"x": 10, "y": 10}]])
async def test_drag_without_two_points_is_a_tool_error(
    computer: PiKVMComputer, backend: FakeBackend, path: list
) -> None:
    [output] = await _act(computer, {"type": "drag", "path": path})
    assert "drag" in str(output)
    assert _hid(backend) == []


async def test_anthropic_mouse_down_and_up(
    computer: PiKVMComputer, backend: FakeBackend
) -> None:
    await _act(computer, {"type": "left_mouse_down", "x": 5, "y": 6})
    await _act(computer, {"type": "left_mouse_up"})
    assert _hid(backend) == [
        ("move_mouse", {"x": 5, "y": 6}),
        ("mouse_button", {"button": "left", "down": True}),
        ("mouse_button", {"button": "left", "down": False}),
    ]


# 12


class _CountingBackend(_Backend):
    connects = 0

    async def connect(self) -> None:
        self.connects += 1


async def test_connects_once_before_the_first_action() -> None:
    backend = _CountingBackend()
    computer = PiKVMComputer(backend)
    await computer.click(1, 1)
    await computer.keypress(["a"])
    assert backend.connects == 1


# 13


async def test_environment_is_configurable(backend: FakeBackend) -> None:
    assert await PiKVMComputer(backend).get_environment() == "windows"
    assert await PiKVMComputer(backend, environment="mac").get_environment() == "mac"


# 14


async def test_refused_action_never_reaches_hid(backend: FakeBackend) -> None:
    seen: list[tuple[str, dict]] = []

    async def refuse(action: str, args: dict) -> bool:
        seen.append((action, args))
        return False

    computer = PiKVMComputer(backend, confirm=refuse)
    [output] = await _act(computer, {"type": "type", "text": "rm -rf /\n"})
    assert "refused" in str(output)
    assert seen == [("type", {"text": "rm -rf /\n"})]
    assert _hid(backend) == []
