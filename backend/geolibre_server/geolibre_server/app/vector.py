"""Vector geometry processing sidecar endpoints (GeoPandas).

These endpoints mirror the client-side Turf.js tools in ``@geolibre/processing``
but run on GeoPandas/Shapely, giving projection-aware results (notably buffers
in real-world distance units). GeoPandas is an optional dependency: when it is
not installed, ``/vector/status`` reports ``available: false`` and the desktop
app falls back to the client engine.

The actual geometry operations live in :mod:`geolibre_server.vector_ops`, a
framework-free module shared with the in-browser Pyodide engine so both produce
identical results. This module is only the HTTP boundary: it unpacks the
request, calls :func:`vector_ops.run_vector_tool`, and maps its exceptions to
HTTP status codes.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from geolibre_server import vector_ops
from geolibre_server.vector_ops import VectorInputTooLarge

from .conversion import _is_within_roots

router = APIRouter(prefix="/vector", tags=["vector"])
logger = logging.getLogger(__name__)

# Source formats whose write-back is supported today: single-file, GeoPandas
# (OGR) writable, and whose source CRS and — for a multi-layer GeoPackage — the
# sibling tables we can preserve on an in-place overwrite. Kept in sync with the
# client-side gate in ``LayerPanel.tsx`` (WRITEBACK_EXTENSIONS). Shapefile,
# FlatGeobuf and GeoParquet write-back are deliberately deferred (issue #1070).
_WRITABLE_EXTENSIONS = {".gpkg", ".geojson", ".json"}


class VectorToolRequest(BaseModel):
    tool_id: str
    geojson: Optional[dict] = None
    overlay: Optional[dict] = None
    parameters: dict[str, Any] = {}


class WriteVectorRequest(BaseModel):
    """Request body for committing an edited layer back to its source file."""

    path: str
    geojson: dict
    # Optional target table within a multi-layer GeoPackage. When omitted, a
    # GeoPackage with a single feature layer writes back to that layer.
    layer: Optional[str] = None


@router.get("/status")
def vector_status():
    """Return vector (GeoPandas) runtime availability."""
    import_error = vector_ops.geopandas_import_error()
    if import_error is None:
        return {
            "available": True,
            "message": "Vector runtime (GeoPandas) is available.",
        }
    logger.info("GeoPandas runtime unavailable: %s", import_error)
    return {
        "available": False,
        "message": "Vector runtime (GeoPandas) is not installed.",
    }


@router.post("/run")
def vector_run(request: VectorToolRequest):
    """Run a single vector geometry operation and return the result GeoJSON.

    Intentionally a plain ``def``: GeoPandas/Shapely are CPU-bound and
    synchronous, so FastAPI dispatches this to its thread pool and the event
    loop is not blocked. Do not convert this to ``async def`` without moving the
    work to an executor. The ``MAX_FEATURES`` cap in :mod:`vector_ops` bounds the
    per-request cost.
    """
    import_error = vector_ops.geopandas_import_error()
    if import_error is not None:
        logger.info("GeoPandas runtime unavailable: %s", import_error)
        raise HTTPException(
            status_code=503,
            detail="GeoPandas is not installed in the sidecar.",
        )

    try:
        geojson, messages = vector_ops.run_vector_tool(
            request.tool_id,
            request.geojson,
            request.overlay,
            request.parameters,
        )
    except VectorInputTooLarge as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except ValueError as exc:
        # Unknown tool id, missing features, or invalid parameters.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - surface a stable error to the client
        logger.exception("Vector tool %s failed", request.tool_id)
        raise HTTPException(
            status_code=400, detail=f"Vector tool failed: {exc}"
        ) from exc

    return {"geojson": geojson, "messages": messages}


def _validate_write_path(path: str) -> Path:
    """Validate and normalize a write-back target path.

    Write-back overwrites an existing local source file, so the path must already
    exist, be writable, carry a supported extension, and — when the conversion
    allowlist is configured — live under an allowed root.

    Args:
        path: The absolute local file path persisted on the layer's ``sourcePath``.

    Returns:
        The resolved, canonical target path.

    Raises:
        HTTPException: The path is empty, an unsupported format, missing, not
            writable, or outside the allowlisted roots.
    """
    if not path or not path.strip():
        raise HTTPException(status_code=400, detail="path is required")
    target = Path(path).expanduser()
    if target.suffix.lower() not in _WRITABLE_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Write-back is not supported for '{target.suffix}' files yet.",
        )
    if not target.is_file():
        raise HTTPException(status_code=400, detail=f"Source file not found: {path}")
    resolved = target.resolve()
    # Confine writes (and the temp files beside the target) to the allowlisted
    # roots so a same-origin caller cannot overwrite arbitrary files. Shares the
    # conversion allowlist so both endpoints honor GEOLIBRE_CONVERSION_ROOTS.
    if not _is_within_roots(resolved):
        raise HTTPException(
            status_code=403,
            detail="Path is outside the allowed directories",
        )
    if not os.access(resolved, os.W_OK):
        raise HTTPException(
            status_code=403, detail=f"Source file is not writable: {path}"
        )
    return resolved


def _build_wgs84_gdf(geojson: dict) -> Any:
    """Build a WGS84 GeoDataFrame from an edited GeoJSON FeatureCollection.

    The app stores and edits every vector layer as WGS84 GeoJSON (RFC 7946), so
    the incoming features are always lon/lat regardless of the source file's CRS.

    Args:
        geojson: A GeoJSON FeatureCollection dict with a non-empty ``features``.

    Returns:
        A GeoPandas GeoDataFrame in EPSG:4326.
    """
    gpd = vector_ops._import_geopandas()
    return gpd.GeoDataFrame.from_features(geojson["features"], crs=vector_ops.WGS84)


def _atomic_write(target: Path, write: Any) -> None:
    """Write ``target`` atomically via a temp file beside it, then replace.

    ``write`` receives a temp :class:`Path` to write to; on success it is
    ``os.replace``d onto ``target`` (atomic on the same filesystem, so the
    original is never left half-written). The temp directory is always removed.

    Args:
        target: The destination path to replace.
        write: Callable ``(tmp_path) -> None`` that writes the temp file.
    """
    tmpdir = tempfile.mkdtemp(dir=str(target.parent))
    try:
        tmp = Path(tmpdir) / target.name
        write(tmp)
        os.replace(tmp, target)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _write_geojson(target: Path, geojson: dict) -> int:
    """Overwrite a GeoJSON source file with the edited features (WGS84)."""
    gdf = _build_wgs84_gdf(geojson)
    _atomic_write(target, lambda tmp: gdf.to_file(tmp, driver="GeoJSON"))
    return len(gdf)


def _write_geopackage(
    target: Path, geojson: dict, layer: Optional[str]
) -> tuple[int, str]:
    """Overwrite one layer of a GeoPackage in place, preserving the others.

    Resolves the target table (the given ``layer``, or the sole feature layer of
    a single-layer file), reprojects the WGS84 edits back into that layer's
    stored CRS, and rewrites only that layer so sibling tables survive.

    Args:
        target: The resolved ``.gpkg`` path.
        geojson: The edited GeoJSON FeatureCollection (WGS84).
        layer: The target table name, or None to auto-select a single layer.

    Returns:
        A ``(feature_count, layer_name)`` tuple.

    Raises:
        HTTPException: The named layer is absent, or the file has several feature
            layers and none was specified.
    """
    gpd = vector_ops._import_geopandas()
    layers = gpd.list_layers(str(target))
    names = list(layers["name"])
    # Layers with a geometry type are the writable feature tables; aspatial
    # attribute tables (geometry_type is None) are never a write target.
    spatial = [
        name
        for name, geom in zip(names, layers["geometry_type"])
        if geom is not None
    ]
    if layer:
        if layer not in names:
            raise HTTPException(
                status_code=404,
                detail=f"Layer '{layer}' not found in {target.name}",
            )
        target_layer = layer
    elif spatial:
        # Match the reader's "first feature layer" default (gpkg-reader.ts
        # selectLayer): the app loads and edits that layer, so write-back targets
        # it too. Explicit per-layer targeting for a multi-layer GeoPackage is a
        # follow-up (issue #1070).
        target_layer = spatial[0]
    elif len(names) == 1:
        target_layer = names[0]
    else:
        raise HTTPException(
            status_code=400,
            detail=f"No feature layer to write in {target.name}",
        )

    gdf = _build_wgs84_gdf(geojson)
    # The reader reprojects a non-WGS84 GeoPackage to WGS84 for display; reproject
    # the edits back into the stored CRS so the file keeps its original
    # projection. Reading one row is enough to recover the layer's CRS cheaply.
    head = gpd.read_file(str(target), layer=target_layer, rows=1)
    if head.crs is not None and head.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(head.crs)

    # Work on a copy so a mid-write failure never corrupts the original file, and
    # so writing the single layer preserves the copy's sibling tables.
    def _write(tmp: Path) -> None:
        shutil.copy2(target, tmp)
        gdf.to_file(tmp, layer=target_layer, driver="GPKG")

    _atomic_write(target, _write)
    return len(gdf), target_layer


@router.post("/write")
def vector_write(request: WriteVectorRequest):
    """Commit an edited GeoJSON layer back to its local source file.

    Overwrites the layer's original GeoPackage or GeoJSON file in place,
    preserving the source CRS and (for a multi-layer GeoPackage) sibling tables.
    The write is atomic and confined to ``GEOLIBRE_CONVERSION_ROOTS`` when set.

    A plain ``def`` for the same reason as :func:`vector_run`: GeoPandas/OGR are
    synchronous and CPU/IO-bound, so FastAPI runs this in its thread pool.
    """
    import_error = vector_ops.geopandas_import_error()
    if import_error is not None:
        logger.info("GeoPandas runtime unavailable: %s", import_error)
        raise HTTPException(
            status_code=503,
            detail="GeoPandas is not installed in the sidecar.",
        )

    target = _validate_write_path(request.path)
    features = request.geojson.get("features") if request.geojson else None
    if not features:
        raise HTTPException(status_code=400, detail="No features to write.")
    if len(features) > vector_ops.MAX_FEATURES:
        raise HTTPException(
            status_code=413,
            detail=f"Layer exceeds the {vector_ops.MAX_FEATURES}-feature limit",
        )

    layer_name: Optional[str] = None
    try:
        if target.suffix.lower() == ".gpkg":
            count, layer_name = _write_geopackage(target, request.geojson, request.layer)
        else:
            count = _write_geojson(target, request.geojson)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - surface a stable error to the client
        logger.exception("Write-back to %s failed", target)
        raise HTTPException(
            status_code=400, detail=f"Write-back failed: {exc}"
        ) from exc

    return {
        "path": str(target),
        "layer": layer_name,
        "feature_count": count,
        "messages": [f"Saved {count} feature(s) to {target.name}"],
    }
