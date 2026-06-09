"""Vector geometry processing sidecar endpoints (GeoPandas).

These endpoints mirror the client-side Turf.js tools in ``@geolibre/processing``
but run on GeoPandas/Shapely, giving projection-aware results (notably buffers
in real-world distance units). GeoPandas is an optional dependency: when it is
not installed, ``/vector/status`` reports ``available: false`` and the desktop
app falls back to the client engine.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/vector", tags=["vector"])
logger = logging.getLogger(__name__)

WGS84 = "EPSG:4326"

# Conversion factors from the requested unit to meters.
_DISTANCE_UNITS = {
    "kilometers": 1000.0,
    "meters": 1.0,
    "miles": 1609.344,
}


class VectorToolRequest(BaseModel):
    tool_id: str
    geojson: Optional[dict] = None
    overlay: Optional[dict] = None
    parameters: dict[str, Any] = {}


def _import_geopandas():
    """Import GeoPandas, raising if the optional dependency is missing."""
    import geopandas as gpd  # noqa: PLC0415

    return gpd


def _load_gdf(geojson: Optional[dict], label: str):
    """Build a WGS84 GeoDataFrame from a GeoJSON FeatureCollection."""
    gpd = _import_geopandas()
    if not geojson or not geojson.get("features"):
        raise HTTPException(status_code=400, detail=f"{label} has no features")
    gdf = gpd.GeoDataFrame.from_features(geojson["features"], crs=WGS84)
    if gdf.empty:
        raise HTTPException(status_code=400, detail=f"{label} has no features")
    return gdf


def _to_feature_collection(gdf) -> dict:
    """Serialize a GeoDataFrame back to a GeoJSON FeatureCollection dict."""
    # GeoPandas only emits valid GeoJSON in WGS84; reproject if needed.
    if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(WGS84)
    return json.loads(gdf.to_json())


def _buffer(request: VectorToolRequest) -> tuple[dict, list[str]]:
    gdf = _load_gdf(request.geojson, "Input layer")
    params = request.parameters
    distance = float(params.get("distance", 1) or 0)
    units = str(params.get("units", "kilometers"))
    meters = distance * _DISTANCE_UNITS.get(units, 1000.0)
    # Buffer in a local metric CRS so the distance is in real-world meters,
    # then reproject the result back to WGS84.
    metric_crs = gdf.estimate_utm_crs()
    projected = gdf.to_crs(metric_crs)
    projected["geometry"] = projected.geometry.buffer(meters)
    return (
        _to_feature_collection(projected),
        [f"Buffered {len(gdf)} feature(s) by {distance} {units}"],
    )


def _centroids(request: VectorToolRequest) -> tuple[dict, list[str]]:
    gdf = _load_gdf(request.geojson, "Input layer")
    result = gdf.copy()
    result["geometry"] = gdf.geometry.centroid
    return _to_feature_collection(result), [f"Computed {len(result)} centroid(s)"]


def _convex_hull(request: VectorToolRequest) -> tuple[dict, list[str]]:
    gpd = _import_geopandas()
    gdf = _load_gdf(request.geojson, "Input layer")
    hull = gdf.geometry.union_all().convex_hull
    result = gpd.GeoDataFrame(geometry=[hull], crs=WGS84)
    return _to_feature_collection(result), ["Computed convex hull"]


def _dissolve(request: VectorToolRequest) -> tuple[dict, list[str]]:
    gdf = _load_gdf(request.geojson, "Input layer")
    field = str(request.parameters.get("field", "") or "").strip()
    if field and field in gdf.columns:
        dissolved = gdf.dissolve(by=field).reset_index()
    else:
        dissolved = gdf.dissolve()
    return (
        _to_feature_collection(dissolved),
        [f"Dissolved {len(gdf)} feature(s) into {len(dissolved)} feature(s)"],
    )


def _bounding_box(request: VectorToolRequest) -> tuple[dict, list[str]]:
    gpd = _import_geopandas()
    from shapely.geometry import box  # noqa: PLC0415

    gdf = _load_gdf(request.geojson, "Input layer")
    minx, miny, maxx, maxy = gdf.total_bounds
    result = gpd.GeoDataFrame(geometry=[box(minx, miny, maxx, maxy)], crs=WGS84)
    return _to_feature_collection(result), ["Computed bounding box"]


def _simplify(request: VectorToolRequest) -> tuple[dict, list[str]]:
    gdf = _load_gdf(request.geojson, "Input layer")
    tolerance = float(request.parameters.get("tolerance", 0.01) or 0)
    result = gdf.copy()
    result["geometry"] = gdf.geometry.simplify(tolerance)
    return (
        _to_feature_collection(result),
        [f"Simplified {len(result)} feature(s) (tolerance {tolerance})"],
    )


def _overlay(request: VectorToolRequest, how: str) -> tuple[dict, list[str]]:
    gpd = _import_geopandas()
    left = _load_gdf(request.geojson, "Input layer")
    right = _load_gdf(request.overlay, "Overlay layer")
    result = gpd.overlay(left, right, how=how, keep_geom_type=False)
    return (
        _to_feature_collection(result),
        [f"{how.capitalize()}: produced {len(result)} feature(s)"],
    )


def _clip(request: VectorToolRequest) -> tuple[dict, list[str]]:
    gpd = _import_geopandas()
    left = _load_gdf(request.geojson, "Input layer")
    right = _load_gdf(request.overlay, "Overlay layer")
    clipped = gpd.clip(left, right)
    return _to_feature_collection(clipped), [f"Clip: produced {len(clipped)} feature(s)"]


_DISPATCH = {
    "buffer": _buffer,
    "centroids": _centroids,
    "convex-hull": _convex_hull,
    "dissolve": _dissolve,
    "bounding-box": _bounding_box,
    "simplify": _simplify,
    "clip": _clip,
    "intersection": lambda r: _overlay(r, "intersection"),
    "difference": lambda r: _overlay(r, "difference"),
    "union": lambda r: _overlay(r, "union"),
}


@router.get("/status")
def vector_status():
    """Return vector (GeoPandas) runtime availability."""
    try:
        _import_geopandas()
        return {
            "available": True,
            "message": "Vector runtime (GeoPandas) is available.",
        }
    except Exception as exc:  # noqa: BLE001 - report any import failure as unavailable
        logger.info("GeoPandas runtime unavailable: %s", exc)
        return {
            "available": False,
            "message": "Vector runtime (GeoPandas) is not installed.",
        }


@router.post("/run")
def vector_run(request: VectorToolRequest):
    """Run a single vector geometry operation and return the result GeoJSON."""
    try:
        _import_geopandas()
    except Exception as exc:  # noqa: BLE001
        logger.info("GeoPandas runtime unavailable: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="GeoPandas is not installed in the sidecar.",
        ) from exc

    handler = _DISPATCH.get(request.tool_id)
    if handler is None:
        raise HTTPException(
            status_code=400, detail=f"Unknown vector tool: {request.tool_id}"
        )

    try:
        geojson, messages = handler(request)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - surface a stable error to the client
        logger.exception("Vector tool %s failed", request.tool_id)
        raise HTTPException(
            status_code=400, detail=f"Vector tool failed: {exc}"
        ) from exc

    return {"geojson": geojson, "messages": messages}
