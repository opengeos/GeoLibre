import pytest
from fastapi import HTTPException

from geolibre_server import vector_ops
from geolibre_server.app import conversion
from geolibre_server.app.vector import (
    VectorToolRequest,
    WriteVectorRequest,
    vector_run,
    vector_status,
    vector_write,
)
from geolibre_server.vector_ops import _DISPATCH

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
        "spatial-join",
        "attribute-join",
        "select-by-value",
        "select-by-location",
        "reproject",
        "explode",
        "aggregate",
        "smooth",
        "voronoi",
        "check-validity",
        "fix-geometries",
    }
    assert set(_DISPATCH) == expected


def test_status_returns_availability_shape() -> None:
    status = vector_status()
    assert set(status) == {"available", "message"}
    assert isinstance(status["available"], bool)
    assert isinstance(status["message"], str)


def test_run_without_geopandas_raises_503(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vector_ops, "geopandas_import_error", lambda: "No module named 'geopandas'")
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
    result = vector_run(VectorToolRequest(tool_id="intersection", geojson=SQUARE, overlay=OVERLAP))
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
    result = vector_run(VectorToolRequest(tool_id=tool_id, geojson=SQUARE, overlay=OVERLAP))
    fc = result["geojson"]
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) >= 1


@requires_geopandas
def test_union_dissolves_to_single_feature() -> None:
    # The sidecar union must match the client engine (one merged geometry).
    result = vector_run(VectorToolRequest(tool_id="union", geojson=SQUARE, overlay=OVERLAP))
    assert len(result["geojson"]["features"]) == 1


@requires_geopandas
def test_buffer_rejects_negative_distance() -> None:
    with pytest.raises(HTTPException) as exc:
        vector_run(VectorToolRequest(tool_id="buffer", geojson=SQUARE, parameters={"distance": -1}))
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
            VectorToolRequest(tool_id="dissolve", geojson=SQUARE, parameters={"field": "missing"})
        )
    assert exc.value.status_code == 400


@requires_geopandas
def test_run_rejects_oversized_input(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vector_ops, "MAX_FEATURES", 2)
    big = {"type": "FeatureCollection", "features": [{}, {}, {}]}
    with pytest.raises(HTTPException) as exc:
        vector_run(VectorToolRequest(tool_id="buffer", geojson=big))
    assert exc.value.status_code == 413


# --- Write-back (POST /vector/write) ---------------------------------------


def _edited(name: str) -> dict:
    """A one-feature FeatureCollection standing in for an edited layer (WGS84)."""
    return _square(name)


def test_write_without_geopandas_raises_503(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vector_ops, "geopandas_import_error", lambda: "No module named 'geopandas'")
    with pytest.raises(HTTPException) as exc:
        vector_write(WriteVectorRequest(path="/tmp/x.gpkg", geojson=_edited("a")))
    assert exc.value.status_code == 503


@requires_geopandas
def test_write_rejects_unsupported_extension(tmp_path) -> None:
    src = tmp_path / "data.shp"
    src.write_bytes(b"stub")
    with pytest.raises(HTTPException) as exc:
        vector_write(WriteVectorRequest(path=str(src), geojson=_edited("a")))
    assert exc.value.status_code == 400


@requires_geopandas
def test_write_rejects_missing_file(tmp_path) -> None:
    missing = tmp_path / "nope.geojson"
    with pytest.raises(HTTPException) as exc:
        vector_write(WriteVectorRequest(path=str(missing), geojson=_edited("a")))
    assert exc.value.status_code == 400


@requires_geopandas
def test_write_rejects_empty_features(tmp_path) -> None:
    src = tmp_path / "data.geojson"
    src.write_text('{"type":"FeatureCollection","features":[]}')
    with pytest.raises(HTTPException) as exc:
        vector_write(
            WriteVectorRequest(
                path=str(src),
                geojson={"type": "FeatureCollection", "features": []},
            )
        )
    assert exc.value.status_code == 400


@requires_geopandas
def test_write_rejects_oversized_input(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    src = tmp_path / "data.geojson"
    src.write_text('{"type":"FeatureCollection","features":[]}')
    monkeypatch.setattr(vector_ops, "MAX_FEATURES", 1)
    big = {"type": "FeatureCollection", "features": [_edited("a")["features"][0]] * 3}
    with pytest.raises(HTTPException) as exc:
        vector_write(WriteVectorRequest(path=str(src), geojson=big))
    assert exc.value.status_code == 413


@requires_geopandas
def test_write_geojson_overwrites_in_place(tmp_path) -> None:
    import geopandas as gpd

    src = tmp_path / "layer.geojson"
    gpd.GeoDataFrame.from_features(_edited("original")["features"], crs="EPSG:4326").to_file(
        src, driver="GeoJSON"
    )

    result = vector_write(WriteVectorRequest(path=str(src), geojson=_edited("edited")))
    assert result["feature_count"] == 1
    reread = gpd.read_file(src)
    assert list(reread["name"]) == ["edited"]


@requires_geopandas
def test_write_geopackage_single_layer_round_trips(tmp_path) -> None:
    import geopandas as gpd

    src = tmp_path / "layer.gpkg"
    gpd.GeoDataFrame.from_features(_edited("original")["features"], crs="EPSG:4326").to_file(
        src, layer="places", driver="GPKG"
    )

    result = vector_write(WriteVectorRequest(path=str(src), geojson=_edited("edited")))
    assert result["feature_count"] == 1
    assert result["layer"] == "places"
    reread = gpd.read_file(src, layer="places")
    assert list(reread["name"]) == ["edited"]


@requires_geopandas
def test_write_geopackage_preserves_sibling_layers(tmp_path) -> None:
    import geopandas as gpd

    src = tmp_path / "multi.gpkg"
    gpd.GeoDataFrame.from_features(_square("keep")["features"], crs="EPSG:4326").to_file(
        src, layer="untouched", driver="GPKG"
    )
    gpd.GeoDataFrame.from_features(_square("before")["features"], crs="EPSG:4326").to_file(
        src, layer="target", driver="GPKG"
    )

    result = vector_write(
        WriteVectorRequest(path=str(src), geojson=_edited("after"), layer="target")
    )
    assert result["layer"] == "target"
    # The written layer changed and the sibling table survived untouched.
    assert list(gpd.read_file(src, layer="target")["name"]) == ["after"]
    assert list(gpd.read_file(src, layer="untouched")["name"]) == ["keep"]


@requires_geopandas
def test_write_geopackage_rejects_unknown_layer(tmp_path) -> None:
    import geopandas as gpd

    src = tmp_path / "layer.gpkg"
    gpd.GeoDataFrame.from_features(_edited("a")["features"], crs="EPSG:4326").to_file(
        src, layer="places", driver="GPKG"
    )

    with pytest.raises(HTTPException) as exc:
        vector_write(WriteVectorRequest(path=str(src), geojson=_edited("b"), layer="ghost"))
    assert exc.value.status_code == 404


@requires_geopandas
def test_write_geopackage_defaults_to_first_feature_layer(tmp_path) -> None:
    # With no layer specified, write-back targets the first feature layer, the
    # same layer the reader loads — leaving later layers untouched.
    import geopandas as gpd

    src = tmp_path / "multi.gpkg"
    gpd.GeoDataFrame.from_features(_square("a")["features"], crs="EPSG:4326").to_file(
        src, layer="one", driver="GPKG"
    )
    gpd.GeoDataFrame.from_features(_square("b")["features"], crs="EPSG:4326").to_file(
        src, layer="two", driver="GPKG"
    )

    result = vector_write(WriteVectorRequest(path=str(src), geojson=_edited("c")))
    assert result["layer"] == "one"
    assert list(gpd.read_file(src, layer="one")["name"]) == ["c"]
    assert list(gpd.read_file(src, layer="two")["name"]) == ["b"]


@requires_geopandas
def test_write_geopackage_preserves_source_crs(tmp_path) -> None:
    import geopandas as gpd

    src = tmp_path / "proj.gpkg"
    # A source stored in Web Mercator: the app would display it reprojected to
    # WGS84, and the edits come back as WGS84 — write-back must restore 3857.
    gpd.GeoDataFrame.from_features(_square("a")["features"], crs="EPSG:4326").to_crs(
        "EPSG:3857"
    ).to_file(src, layer="places", driver="GPKG")

    vector_write(WriteVectorRequest(path=str(src), geojson=_edited("edited")))
    reread = gpd.read_file(src, layer="places")
    assert reread.crs.to_epsg() == 3857


@requires_geopandas
def test_write_respects_conversion_allowlist(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    import geopandas as gpd

    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    src = outside / "layer.geojson"
    gpd.GeoDataFrame.from_features(_edited("a")["features"], crs="EPSG:4326").to_file(
        src, driver="GeoJSON"
    )

    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(allowed.resolve())])
    with pytest.raises(HTTPException) as exc:
        vector_write(WriteVectorRequest(path=str(src), geojson=_edited("b")))
    assert exc.value.status_code == 403
