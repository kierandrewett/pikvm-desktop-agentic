"""A torch-free stand-in for ``qwen_vl_utils.smart_resize``.

cua's Qwen, generic-VLM, OpenCUA and Fara loops do
``from qwen_vl_utils import smart_resize`` to work out the image size the
model sees, so they can map its coordinates back to the screenshot. That
function is plain arithmetic, but ``qwen_vl_utils`` imports torch and
torchvision at load time, which is several GB of wheels for this one call.

:func:`install` registers a module with only ``smart_resize`` when the real
package cannot be imported. If the real package imports (torch installed),
it is left alone. cua itself copies the same function into its GTA1, UI-Ins
and Gelato loops.

``smart_resize`` and its helpers are copied from qwen-vl-utils 0.0.14,
``qwen_vl_utils/vision_process.py`` (Apache-2.0, Alibaba Qwen team).
"""

from __future__ import annotations

import logging
import math
import sys
import types

log = logging.getLogger("pikvm_agent.cua")

MAX_RATIO = 200


def _round_by_factor(number: float, factor: int) -> int:
    return round(number / factor) * factor


def _ceil_by_factor(number: float, factor: int) -> int:
    return math.ceil(number / factor) * factor


def _floor_by_factor(number: float, factor: int) -> int:
    return math.floor(number / factor) * factor


def smart_resize(
    height: int,
    width: int,
    factor: int,
    min_pixels: int | None = None,
    max_pixels: int | None = None,
) -> tuple[int, int]:
    """Same contract as upstream: both sides divisible by ``factor``, pixel
    count within ``[min_pixels, max_pixels]``, aspect ratio kept."""
    max_pixels = max_pixels if max_pixels is not None else 16384 * factor**2
    min_pixels = min_pixels if min_pixels is not None else 4 * factor**2
    if max_pixels < min_pixels:
        raise ValueError("max_pixels must be greater than or equal to min_pixels")
    if max(height, width) / min(height, width) > MAX_RATIO:
        raise ValueError(
            f"absolute aspect ratio must be smaller than {MAX_RATIO}, "
            f"got {max(height, width) / min(height, width)}"
        )
    h_bar = max(factor, _round_by_factor(height, factor))
    w_bar = max(factor, _round_by_factor(width, factor))
    if h_bar * w_bar > max_pixels:
        beta = math.sqrt((height * width) / max_pixels)
        h_bar = _floor_by_factor(height / beta, factor)
        w_bar = _floor_by_factor(width / beta, factor)
    elif h_bar * w_bar < min_pixels:
        beta = math.sqrt(min_pixels / (height * width))
        h_bar = _ceil_by_factor(height * beta, factor)
        w_bar = _ceil_by_factor(width * beta, factor)
    return h_bar, w_bar


def install() -> bool:
    """Make ``from qwen_vl_utils import smart_resize`` work. Returns True when
    the shim was installed, False when the real package is usable."""
    current = sys.modules.get("qwen_vl_utils")
    if current is not None:
        return getattr(current, "__pikvm_shim__", False)
    try:
        import qwen_vl_utils  # noqa: F401
    except ImportError as exc:
        sys.modules.pop("qwen_vl_utils", None)
        sys.modules.pop("qwen_vl_utils.vision_process", None)
        module = types.ModuleType("qwen_vl_utils")
        module.smart_resize = smart_resize  # type: ignore[attr-defined]
        module.__pikvm_shim__ = True  # type: ignore[attr-defined]
        sys.modules["qwen_vl_utils"] = module
        log.info("[cua] qwen_vl_utils unavailable (%s); using the torch-free smart_resize", exc)
        return True
    return False
