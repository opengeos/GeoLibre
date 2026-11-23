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

import hashlib
import logging
import os
import shutil
import tempfile
import threading
import weakref
from pathlib import Path
from typing import Any, Optional

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore[assignment]

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from geolibre_server import vector_ops
from geolibre_server.vector_ops import VectorInputTooLarge

from .conversion import _is_within_roots

router = APIRouter(prefix="/vector", tags=["vector"])
logger = logging.getLogger(__name__)

# Source formats whose write-back is supported today: GeoPackage, GeoJSON,
# Shapefile, FlatGeobuf, and GeoParquet, preserving source CRS (and sibling
# tables for GeoPackage / sidecars for Shapefile). Kept in sync with the
# client-side gate in ``layer-panel-utils.ts`` (WRITEBACK_EXTENSIONS).
_WRITABLE_EXTENSIONS = {".gpkg", ".geojson", ".json", ".shp", ".fgb", ".parquet", ".geoparquet"}
_SHAPEFILE_SIDECARS = (".shp", ".shx", ".dbf", ".prj", ".cpg")


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
            status_code=400,
            detail="Vector tool failed due to an internal error.",
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
    resolved = target.resolve()
    # Confine writes (and the temp files beside the target) to the allowlisted
    # roots BEFORE checking existence so callers cannot probe files outside
    # GEOLIBRE_CONVERSION_ROOTS, and validate the extension on the resolved path
    # so a symlink cannot bypass the format check.
    if not _is_within_roots(resolved):
        raise HTTPException(
            status_code=403,
            detail="Path is outside the allowed directories",
        )
    if resolved.suffix.lower() not in _WRITABLE_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Write-back is not supported for '{resolved.suffix}' files yet.",
        )
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail=f"Source file not found: {path}")
    if not os.access(resolved, os.W_OK):
        raise HTTPException(status_code=403, detail=f"Source file is not writable: {path}")
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
    original is never left half-written). The target's permission bits are
    copied onto the temp file first, so the replacement does not reset them to
    the umask default (a private 0600 file must not come back 0644). The temp
    directory is always removed.

    Args:
        target: The destination path to replace.
        write: Callable ``(tmp_path) -> None`` that writes the temp file.
    """
    tmpdir = tempfile.mkdtemp(dir=str(target.parent))
    try:
        tmp = Path(tmpdir) / target.name
        write(tmp)
        if target.exists():
            shutil.copymode(target, tmp)
        os.replace(tmp, target)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _write_geojson(target: Path, geojson: dict) -> int:
    """Overwrite a GeoJSON source file with the edited features (WGS84)."""
    gdf = _build_wgs84_gdf(geojson)
    _atomic_write(target, lambda tmp: gdf.to_file(tmp, driver="GeoJSON"))
    return len(gdf)


def _reproject_to_existing_crs(gdf: Any, target: Path, *, is_parquet: bool = False) -> Any:
    """Reproject a WGS84 GeoDataFrame back into ``target``'s stored CRS when non-4326."""
    gpd = vector_ops._import_geopandas()
    head = gpd.read_parquet(str(target)) if is_parquet else gpd.read_file(str(target), rows=1)
    if head.crs is not None and head.crs.to_epsg() != 4326:
        return gdf.to_crs(head.crs)
    return gdf


def _write_flatgeobuf(target: Path, geojson: dict) -> int:
    """Overwrite a FlatGeobuf source file atomically, preserving its source CRS."""
    gdf = _reproject_to_existing_crs(_build_wgs84_gdf(geojson), target)
    _atomic_write(target, lambda tmp: gdf.to_file(tmp, driver="FlatGeobuf"))
    return len(gdf)


def _write_geoparquet(target: Path, geojson: dict) -> int:
    """Overwrite a GeoParquet source file atomically, preserving its source CRS."""
    gdf = _reproject_to_existing_crs(_build_wgs84_gdf(geojson), target, is_parquet=True)
    _atomic_write(target, lambda tmp: gdf.to_parquet(tmp))
    return len(gdf)


_SHAPEFILE_STALE_INDEXES = (".qix", ".sbn", ".sbx")
_SHAPEFILE_LOCKS_GUARD = threading.Lock()


class _ShapefilePathLock:
    """Weak-referenceable lock wrapper so idle per-path locks are reclaimed."""

    def __init__(self) -> None:
        self.lock = threading.Lock()


_SHAPEFILE_PATH_LOCKS: weakref.WeakValueDictionary[Path, _ShapefilePathLock] = (
    weakref.WeakValueDictionary()
)


def _shapefile_path_lock(target: Path) -> _ShapefilePathLock:
    resolved = target.resolve()
    with _SHAPEFILE_LOCKS_GUARD:
        holder = _SHAPEFILE_PATH_LOCKS.get(resolved)
        if holder is None:
            holder = _ShapefilePathLock()
            _SHAPEFILE_PATH_LOCKS[resolved] = holder
        return holder


def _shapefile_flock_path(resolved_target: Path) -> Path:
    digest = hashlib.sha256(str(resolved_target).encode("utf-8")).hexdigest()[:16]
    return Path(tempfile.gettempdir()) / f"geolibre-shp-{digest}.lock"


def _write_shapefile(target: Path, geojson: dict) -> int:
    """Overwrite an ESRI Shapefile and its sidecar files with rollback and per-path locking.

    Preserves existing case-insensitive component filenames (e.g. ``Foo.SHP`` /
    ``Foo.DBF`` on case-sensitive filesystems). Note that ESRI Shapefile DBF
    attributes are subject to the format's 10-character field-name limit and
    column-type coercion.
    """
    gdf = _reproject_to_existing_crs(_build_wgs84_gdf(geojson), target)
    tmpdir = tempfile.mkdtemp(dir=str(target.parent))
    backup_dir = tempfile.mkdtemp(dir=str(target.parent))
    try:
        # Always stage with lowercase `.shp` so GDAL emits predictable lowercase
        # component names, then map each component to the target's on-disk casing.
        tmp_shp = Path(tmpdir) / f"{target.stem}.shp"
        gdf.to_file(tmp_shp, driver="ESRI Shapefile")

        resolved_target = target.resolve()
        holder = _shapefile_path_lock(resolved_target)
        with holder.lock:
            lock_file = None
            try:
                if fcntl is not None:
                    lock_path = _shapefile_flock_path(resolved_target)
                    lock_file = open(lock_path, "a+b")
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            except OSError:
                if lock_file is not None:
                    lock_file.close()
                    lock_file = None

            # Discover existing sibling components case-insensitively so uppercase
            # datasets like `Foo.SHP` / `Foo.DBF` are replaced in place on Linux.
            all_exts = {*_SHAPEFILE_SIDECARS, *_SHAPEFILE_STALE_INDEXES}
            existing_by_ext: dict[str, list[Path]] = {}
            for child in target.parent.iterdir():
                if (
                    child.stem == target.stem
                    and child.suffix.lower() in all_exts
                    and child.is_file()
                ):
                    existing_by_ext.setdefault(child.suffix.lower(), []).append(child)

            use_upper = target.suffix == ".SHP"
            backups: list[tuple[Path, Path]] = []
            created_new: list[Path] = []
            try:
                for paths in existing_by_ext.values():
                    for dst in paths:
                        backup = Path(backup_dir) / dst.name
                        shutil.copy2(dst, backup)
                        backups.append((backup, dst))

                for ext in _SHAPEFILE_SIDECARS:
                    src_sidecar = tmp_shp.with_suffix(ext)
                    if not src_sidecar.exists():
                        continue
                    existing_matches = existing_by_ext.get(ext, [])
                    if ext == ".shp":
                        dst_sidecar = target
                    elif existing_matches:
                        dst_sidecar = existing_matches[0]
                    else:
                        dst_ext = ext.upper() if use_upper else ext
                        dst_sidecar = target.with_suffix(dst_ext)
                    existed = dst_sidecar.exists()
                    if existed:
                        shutil.copymode(dst_sidecar, src_sidecar)
                    elif target.exists():
                        shutil.copymode(target, src_sidecar)
                    os.replace(src_sidecar, dst_sidecar)
                    if not existed:
                        created_new.append(dst_sidecar)
                    # Remove any differently-cased duplicate of the same sidecar.
                    for dup in existing_matches:
                        if dup != dst_sidecar and dup.exists():
                            dup.unlink()

                # Invalidate obsolete spatial indexes (any casing) so GDAL does not
                # read stale bounding trees against the newly written geometries.
                for idx_ext in _SHAPEFILE_STALE_INDEXES:
                    for idx_path in existing_by_ext.get(idx_ext, []):
                        if idx_path.exists():
                            idx_path.unlink()
            except BaseException:
                for backup, dst in backups:
                    try:
                        os.replace(backup, dst)
                    except OSError:
                        pass
                for created in created_new:
                    try:
                        created.unlink(missing_ok=True)
                    except OSError:
                        pass
                raise
            finally:
                if lock_file is not None:
                    try:
                        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                    except OSError:
                        pass
                    lock_file.close()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
        shutil.rmtree(backup_dir, ignore_errors=True)
    return len(gdf)


def _write_geopackage(target: Path, geojson: dict, layer: Optional[str]) -> tuple[int, str]:
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
        HTTPException: The named layer is absent, the named layer is an aspatial
            attribute table, or the file holds no feature layer at all.
    """
    gpd = vector_ops._import_geopandas()
    layers = gpd.list_layers(str(target))
    names = list(layers["name"])
    # Layers with a geometry type are the writable feature tables; aspatial
    # attribute tables (geometry_type is None) are never a write target.
    spatial = layers[layers["geometry_type"].notna()]["name"].tolist()
    if layer:
        if layer not in names:
            raise HTTPException(
                status_code=404,
                detail=f"Layer '{layer}' not found in {target.name}",
            )
        if layer not in spatial:
            raise HTTPException(
                status_code=400,
                detail=f"Layer '{layer}' is an aspatial table and cannot be written",
            )
        target_layer = layer
    elif spatial:
        # Match the reader's "first feature layer" default (gpkg-reader.ts
        # selectLayer): the app loads and edits that layer, so write-back targets
        # it too. Explicit per-layer targeting for a multi-layer GeoPackage is a
        # follow-up (issue #1070).
        target_layer = spatial[0]
    else:
        # Only aspatial tables (or nothing) left: there is no writable target, and
        # falling back to names[0] here would hand OGR the very aspatial table the
        # explicit-layer branch above rejects.
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
    ext = target.suffix.lower()
    try:
        if ext == ".gpkg":
            count, layer_name = _write_geopackage(target, request.geojson, request.layer)
        elif ext == ".shp":
            count = _write_shapefile(target, request.geojson)
        elif ext == ".fgb":
            count = _write_flatgeobuf(target, request.geojson)
        elif ext in {".parquet", ".geoparquet"}:
            count = _write_geoparquet(target, request.geojson)
        else:
            count = _write_geojson(target, request.geojson)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - surface a stable error to the client
        logger.exception("Write-back to %s failed", target)
        raise HTTPException(
            status_code=400,
            detail="Write-back failed due to an internal error.",
        ) from exc

    return {
        "path": str(target),
        "layer": layer_name,
        "feature_count": count,
        "messages": [f"Saved {count} feature(s) to {target.name}"],
    }
