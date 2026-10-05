"""The torch-free smart_resize must give the same sizes as qwen-vl-utils.

A wrong size here moves every click a Qwen-family model makes, because cua
maps the model's coordinates back through it. The upstream functions are
loaded from the installed qwen-vl-utils source with ``ast``, so torch is not
needed to compare against them.
"""

from __future__ import annotations

import ast
import importlib.util
import math
import sys
from pathlib import Path

import pytest

from pikvm_agent.cua import qwen_shim

_UPSTREAM_NAMES = {"round_by_factor", "ceil_by_factor", "floor_by_factor", "smart_resize"}


def _upstream_smart_resize():
    spec = importlib.util.find_spec("qwen_vl_utils")
    if spec is None or not spec.submodule_search_locations:
        pytest.skip("qwen-vl-utils is not installed")
    source = Path(next(iter(spec.submodule_search_locations)), "vision_process.py").read_text()
    tree = ast.parse(source)
    keep = [
        node
        for node in tree.body
        if (isinstance(node, ast.FunctionDef) and node.name in _UPSTREAM_NAMES)
        or (
            isinstance(node, ast.Assign)
            and all(isinstance(t, ast.Name) and t.id.isupper() for t in node.targets)
            and isinstance(node.value, ast.Constant)
        )
    ]
    namespace: dict = {"math": math, "Optional": None, "Tuple": tuple}
    module = ast.Module(body=keep, type_ignores=[])
    exec(compile(module, "vision_process.py", "exec"), namespace)  # noqa: S102 - trusted local source
    return namespace["smart_resize"]


SIZES = [
    (720, 1280), (1080, 1920), (768, 1024), (900, 1440), (1440, 2560),
    (2160, 3840), (600, 800), (1050, 1680), (1200, 1920), (10, 10),
    (12000, 12000), (1, 150), (333, 777),
]


@pytest.mark.parametrize("factor", [28, 32])
@pytest.mark.parametrize(("height", "width"), SIZES)
def test_matches_upstream(height: int, width: int, factor: int) -> None:
    upstream = _upstream_smart_resize()
    kwargs = {"min_pixels": 3136, "max_pixels": 12845056}
    assert qwen_shim.smart_resize(height, width, factor, **kwargs) == upstream(
        height, width, factor, **kwargs
    )
    assert qwen_shim.smart_resize(height, width, factor) == upstream(height, width, factor)


def test_extreme_aspect_ratio_is_refused() -> None:
    with pytest.raises(ValueError):
        qwen_shim.smart_resize(1, 500, 32)


def test_install_provides_smart_resize_when_torch_is_missing(monkeypatch) -> None:
    monkeypatch.delitem(sys.modules, "qwen_vl_utils", raising=False)
    monkeypatch.setitem(sys.modules, "torch", None)  # import torch -> ImportError
    assert qwen_shim.install() is True
    from qwen_vl_utils import smart_resize

    assert smart_resize is qwen_shim.smart_resize
    assert qwen_shim.install() is True
    monkeypatch.delitem(sys.modules, "qwen_vl_utils")
