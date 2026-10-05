"""PiKVMComputer: cua's computer protocol on top of a PiKVM backend.

cua's ``ComputerAgent`` calls ``getattr(computer, action_type)(**args)`` for
every model action, then takes a screenshot. This class is that computer. It
is deliberately thin: cua owns the loop and the per-model action formats, and
``PiKVMBackend`` owns HID timing, keyboard layout and Caps-Lock handling. This
file only converts between the two. The numbered failure modes it guards
against are in ``docs/CUA.md``.

The class satisfies ``cua_agent.computers.base.AsyncComputerHandler`` by shape
(the protocol is ``runtime_checkable``), so this module does not import cua at
load time, except for ``ToolError`` inside :func:`_tool_error`.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
from typing import Any, Awaitable, Callable, Literal

from PIL import Image

from pikvm_agent.executor.burst import BurstError, normalize_key
from pikvm_agent.pikvm import keyboard_state as ks

log = logging.getLogger("pikvm_agent.cua")

Environment = Literal["windows", "mac", "linux", "browser"]
Confirm = Callable[[str, dict[str, Any]], Awaitable[bool]]

# X11 / xdotool and Anthropic names that burst.normalize_key does not know.
_KEY_ALIASES = {
    "KPENTER": "NumpadEnter",
    "SUPERL": "MetaLeft",
    "SUPERR": "MetaRight",
    "COMMAND": "MetaLeft",
    "CONTROLL": "ControlLeft",
    "CONTROLR": "ControlRight",
    "SHIFTL": "ShiftLeft",
    "SHIFTR": "ShiftRight",
    "ALTL": "AltLeft",
    "ALTR": "AltRight",
    "PRIOR": "PageUp",
    "NEXT": "PageDown",
    "PRINT": "PrintScreen",
    "GRAVE": "Backquote",
}

# OpenAI sends scroll amounts in pixels, Anthropic in wheel clicks. Values at
# or above this are treated as pixels; one wheel click is about 100 px.
_PIXEL_SCROLL_THRESHOLD = 50
_PIXELS_PER_CLICK = 100
_MAX_SCROLL_CLICKS = 15


def _tool_error(message: str) -> Exception:
    """cua returns a ToolError to the model as a tool result, not a crash."""
    from cua_agent.types import ToolError

    return ToolError(message)


def _scroll_clicks(amount: int) -> int:
    if amount == 0:
        return 0
    clicks = abs(amount)
    if clicks >= _PIXEL_SCROLL_THRESHOLD:
        clicks = max(1, round(clicks / _PIXELS_PER_CLICK))
    clicks = min(clicks, _MAX_SCROLL_CLICKS)
    return clicks if amount > 0 else -clicks


class PiKVMComputer:
    """A cua computer backed by ``PiKVMBackend`` (or ``FakeBackend``)."""

    def __init__(
        self,
        backend: Any,
        *,
        environment: Environment = "windows",
        confirm: Confirm | None = None,
    ) -> None:
        self._backend = backend
        self._environment = environment
        self._confirm = confirm
        self._size: tuple[int, int] | None = None
        self._connected = False
        self._connect_lock = asyncio.Lock()

    # ---- plumbing ----------------------------------------------------------- #

    async def _ensure_connected(self) -> None:
        if self._connected:
            return
        async with self._connect_lock:
            if not self._connected:
                await self._backend.connect()
                self._connected = True

    async def _guard(self, action: str, args: dict[str, Any]) -> None:
        """Connect, log, and ask the confirm hook before any HID."""
        await self._ensure_connected()
        shown = dict(args)
        if "text" in shown:
            shown["text"] = f"<{len(str(shown['text']))} chars>"
        log.info("[cua] %s %s", action, shown)
        if self._confirm is not None and not await self._confirm(action, args):
            log.info("[cua] %s refused by operator", action)
            raise _tool_error(f"{action} was refused by the operator; choose another approach")

    def _point(self, x: float, y: float) -> tuple[int, int]:
        width, height = self._size or (
            self._backend.dims["width"],
            self._backend.dims["height"],
        )
        return (
            min(max(int(round(x)), 0), width - 1),
            min(max(int(round(y)), 0), height - 1),
        )

    def _chord(self, keys: list[str] | str) -> list[str]:
        tokens = [keys] if isinstance(keys, str) else list(keys)
        parts: list[str] = []
        for token in tokens:
            token = str(token).strip()
            parts.extend([token] if token == "+" else [p for p in token.split("+") if p])
        if not parts:
            raise _tool_error("keypress needs at least one key")
        codes: list[str] = []
        for part in parts:
            codes.extend(self._key_codes(part))
        return codes

    def _key_codes(self, name: str) -> list[str]:
        if len(name) == 1 and not name.isalnum():
            info = ks.key_for(name, self._backend.layout)
            if info is not None:
                return ["ShiftLeft", info.code] if info.shift else [info.code]
        alias = _KEY_ALIASES.get(name.upper().replace("_", ""))
        if alias:
            return [alias]
        try:
            code = normalize_key(name if len(name) == 1 else name.replace("_", ""))
        except BurstError:
            code = None
        if code is None:
            raise _tool_error(f"unknown key {name!r}")
        return [code]

    async def _release_after_failure(self) -> None:
        try:
            await self._backend.release_all()
        except Exception:  # noqa: BLE001 - best effort, the first error matters
            log.exception("[cua] release_all failed")

    # ---- screen ------------------------------------------------------------- #

    async def get_environment(self) -> Environment:
        return self._environment

    async def get_dimensions(self) -> tuple[int, int]:
        if self._size is None:
            await self.screenshot()
        assert self._size is not None
        return self._size

    async def screenshot(self, text: str | None = None) -> str:
        """Return the frame as base64 PNG. cua labels every image image/png."""
        await self._ensure_connected()
        frame = await self._backend.screenshot()
        png = await asyncio.to_thread(_to_png, frame.data)
        self._size = (frame.width, frame.height)
        return base64.b64encode(png).decode("ascii")

    async def get_current_url(self) -> str:
        return ""

    # ---- mouse -------------------------------------------------------------- #

    async def click(self, x: int, y: int, button: str = "left") -> None:
        px, py = self._point(x, y)
        await self._guard("click", {"x": px, "y": py, "button": button})
        await self._backend.click(px, py, button)

    async def right_click(self, x: int, y: int) -> None:
        await self.click(x, y, "right")

    async def double_click(self, x: int, y: int) -> None:
        px, py = self._point(x, y)
        await self._guard("double_click", {"x": px, "y": py})
        await self._backend.double_click(px, py, "left")

    async def move(self, x: int, y: int) -> None:
        px, py = self._point(x, y)
        await self._guard("move", {"x": px, "y": py})
        await self._backend.move_mouse(px, py)

    async def scroll(self, x: int, y: int, scroll_x: int, scroll_y: int) -> None:
        px, py = self._point(x, y)
        dx, dy = _scroll_clicks(int(scroll_x)), _scroll_clicks(int(scroll_y))
        await self._guard("scroll", {"x": px, "y": py, "dx": dx, "dy": dy})
        await self._backend.move_mouse(px, py)
        # cua: scroll_y > 0 is down. PiKVMBackend: dy > 0 is up.
        await self._backend.scroll(dx=dx, dy=-dy)

    async def drag(self, path: list[dict[str, int]]) -> None:
        if len(path) < 2:
            raise _tool_error("drag needs a path of at least two points")
        points = [self._point(p["x"], p["y"]) for p in path]
        await self._guard("drag", {"path": points})
        try:
            await self._backend.move_mouse(*points[0])
            await self._backend.mouse_button("left", True)
            for point in points[1:]:
                await self._backend.move_mouse(*point)
            await self._backend.mouse_button("left", False)
        except BaseException:
            await self._release_after_failure()
            raise

    async def left_mouse_down(self, x: int | None = None, y: int | None = None) -> None:
        point = self._point(x, y) if x is not None and y is not None else None
        await self._guard("left_mouse_down", {"point": point})
        if point is not None:
            await self._backend.move_mouse(*point)
        await self._backend.mouse_button("left", True)

    async def left_mouse_up(self, x: int | None = None, y: int | None = None) -> None:
        point = self._point(x, y) if x is not None and y is not None else None
        await self._guard("left_mouse_up", {"point": point})
        try:
            if point is not None:
                await self._backend.move_mouse(*point)
        finally:
            await self._backend.mouse_button("left", False)

    # ---- keyboard ----------------------------------------------------------- #

    async def keypress(self, keys: list[str] | str) -> None:
        codes = self._chord(keys)
        await self._guard("keypress", {"keys": codes})
        try:
            await self._backend.keypress(codes)
        except BaseException:
            await self._release_after_failure()
            raise

    async def type(self, text: str) -> None:
        """Type exact text. Each newline is a real Enter, as cua models expect."""
        await self._guard("type", {"text": text})
        try:
            lines = text.replace("\r\n", "\n").split("\n")
            for index, line in enumerate(lines):
                if line:
                    await self._backend.print_exact_text(line)
                if index < len(lines) - 1:
                    await self._backend.press_key("Enter")
        except BaseException:
            await self._release_after_failure()
            raise

    # ---- control ------------------------------------------------------------ #

    async def wait(self, ms: int = 1000) -> None:
        await asyncio.sleep(max(0, int(ms)) / 1000.0)

    async def terminate(self, status: str = "success") -> dict[str, Any]:
        log.info("[cua] terminate status=%s", status)
        return {"success": True, "status": status, "terminated": True}


def _to_png(data: bytes) -> bytes:
    image = Image.open(io.BytesIO(data))
    if image.format == "PNG":
        return data
    out = io.BytesIO()
    image.convert("RGB").save(out, format="PNG", optimize=False)
    return out.getvalue()
