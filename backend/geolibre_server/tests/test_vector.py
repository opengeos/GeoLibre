from typing import NoReturn

import pytest
from fastapi import HTTPException

from geolibre_server.app import vector
from geolibre_server.app.vector import (
    _DISPATCH,
    VectorToolRequest,
    vector_run,
    vector_status,
)

try:
    import geopandas  # noqa: F401

    HAS_GEOPANDAS = True
except Exception:  # pragma: no cover - depends on the optional extra
    HAS_GEOPANDAS = False

requires_geopandas = pytest.mark.skipif(
    not HAS_GEOPANDAS, reason="geopandas optional extra not installed"
)


def _square(name: str, x: float = 0.0, y: float = 0.0) -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": name},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [x, y],
                            [x, y + 1],
                            [x + 1, y + 1],
                            [x + 1, y],
                            [x, y],
                        ]
                    ],
                },
            }
        ],
    }


SQUARE = _square("a")
OVERLAP = _square("b", x=0.5, y=0.5)


def test_dispatch_covers_all_tools() -> None:
    """The backend must implement every client-side vector tool id."""
    expected = {
        "buffer",
        "centroids",
        "convex-hull",
        "dissolve",
        "bounding-box",
        "simplify",
        "clip",
        "intersection",
        "difference",
        "union",
    }
    assert set(_DISPATCH) == expected


def test_status_returns_availability_shape() -> None:
    status = vector_status()
    assert set(status) == {"available", "message"}
    assert isinstance(status["available"], bool)
    assert isinstance(status["message"], str)


def test_run_without_geopandas_raises_503(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom() -> NoReturn:
        raise ImportError("geopandas missing")

    monkeypatch.setattr(vector, "_import_geopandas", _boom)
    with pytest.raises(HTTPException) as exc:
        vector_run(VectorToolRequest(tool_id="buffer", geojson=SQUARE))
    assert exc.value.status_code == 503


@requires_geopandas
def test_buffer_returns_feature_collection() -> None:
    result = vector_run(
        VectorToolRequest(
            tool_id="buffer",
            geojson=SQUARE,
            parameters={"distance": 1, "units": "kilometers"},
        )
    )
    fc = result["geojson"]
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) == 1
    assert result["messages"]


@requires_geopandas
def test_intersection_overlay() -> None:
    result = vector_run(
        VectorToolRequest(tool_id="intersection", geojson=SQUARE, overlay=OVERLAP)
    )
    fc = result["geojson"]
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) >= 1


@requires_geopandas
def test_unknown_tool_returns_400() -> None:
    with pytest.raises(HTTPException) as exc:
        vector_run(VectorToolRequest(tool_id="nonsense", geojson=SQUARE))
    assert exc.value.status_code == 400


@requires_geopandas
@pytest.mark.parametrize(
    "tool_id",
    ["centroids", "convex-hull", "dissolve", "bounding-box", "simplify"],
)
def test_single_layer_tools_return_feature_collection(tool_id: str) -> None:
    result = vector_run(VectorToolRequest(tool_id=tool_id, geojson=SQUARE))
    fc = result["geojson"]
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) >= 1


@requires_geopandas
@pytest.mark.parametrize("tool_id", ["clip", "difference", "union"])
def test_overlay_tools_return_feature_collection(tool_id: str) -> None:
    result = vector_run(
        VectorToolRequest(tool_id=tool_id, geojson=SQUARE, overlay=OVERLAP)
    )
    fc = result["geojson"]
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) >= 1


@requires_geopandas
def test_union_dissolves_to_single_feature() -> None:
    # The sidecar union must match the client engine (one merged geometry).
    result = vector_run(
        VectorToolRequest(tool_id="union", geojson=SQUARE, overlay=OVERLAP)
    )
    assert len(result["geojson"]["features"]) == 1


@requires_geopandas
def test_buffer_rejects_negative_distance() -> None:
    with pytest.raises(HTTPException) as exc:
        vector_run(
            VectorToolRequest(
                tool_id="buffer", geojson=SQUARE, parameters={"distance": -1}
            )
        )
    assert exc.value.status_code == 400


@requires_geopandas
def test_buffer_rejects_unknown_unit() -> None:
    with pytest.raises(HTTPException) as exc:
        vector_run(
            VectorToolRequest(
                tool_id="buffer",
                geojson=SQUARE,
                parameters={"distance": 1, "units": "furlongs"},
            )
        )
    assert exc.value.status_code == 400


@requires_geopandas
def test_dissolve_rejects_unknown_field() -> None:
    with pytest.raises(HTTPException) as exc:
        vector_run(
            VectorToolRequest(
                tool_id="dissolve", geojson=SQUARE, parameters={"field": "missing"}
            )
        )
    assert exc.value.status_code == 400


@requires_geopandas
def test_run_rejects_oversized_input(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vector, "MAX_FEATURES", 2)
    big = {"type": "FeatureCollection", "features": [{}, {}, {}]}
    with pytest.raises(HTTPException) as exc:
        vector_run(VectorToolRequest(tool_id="buffer", geojson=big))
    assert exc.value.status_code == 413
