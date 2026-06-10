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
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from geolibre_server import vector_ops
from geolibre_server.vector_ops import VectorInputTooLarge

router = APIRouter(prefix="/vector", tags=["vector"])
logger = logging.getLogger(__name__)


class VectorToolRequest(BaseModel):
    tool_id: str
    geojson: Optional[dict] = None
    overlay: Optional[dict] = None
    parameters: dict[str, Any] = {}


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
