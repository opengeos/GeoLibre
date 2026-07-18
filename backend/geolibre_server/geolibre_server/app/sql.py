"""Spatial SQL sidecar endpoints (Apache Sedona / SedonaDB).

These endpoints back the "Apache Sedona" engine of the SQL Workspace. They run
Sedona spatial SQL on SedonaDB (``apache-sedona[db]``), the single-node Rust
engine, registering each loaded layer as a named view. SedonaDB is an optional
dependency (the ``sedona`` extra): when it is not installed, ``/sql/status``
reports ``available: false`` and the desktop app falls back to the in-browser
CereusDB (WebAssembly) engine.

The query logic lives in :mod:`geolibre_server.sedona_ops`; this module is only
the HTTP boundary, mapping its exceptions to HTTP status codes.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from geolibre_server import sedona_ops
from geolibre_server.sedona_ops import SqlInputTooLarge

router = APIRouter(prefix="/sql", tags=["sql"])
logger = logging.getLogger(__name__)


class SqlLayer(BaseModel):
    name: str
    geojson: Optional[dict] = None


class SqlRunRequest(BaseModel):
    sql: str
    layers: list[SqlLayer] = []


@router.get("/status")
def sql_status() -> dict[str, Any]:
    """Return spatial-SQL (SedonaDB) runtime availability."""
    import_error = sedona_ops.sedonadb_import_error()
    if import_error is None:
        return {
            "available": True,
            "message": "Spatial SQL runtime (SedonaDB) is available.",
        }
    logger.info("SedonaDB runtime unavailable: %s", import_error)
    return {
        "available": False,
        "message": "Spatial SQL runtime (SedonaDB) is not installed.",
    }


@router.post("/run")
def sql_run(request: SqlRunRequest) -> dict[str, Any]:
    """Run a single Sedona spatial SQL statement and return rows + GeoJSON.

    Intentionally a plain ``def``: SedonaDB query execution is CPU-bound and
    synchronous, so FastAPI dispatches this to its thread pool and the event
    loop is not blocked. The ``MAX_FEATURES`` cap in :mod:`sedona_ops` bounds the
    per-layer registration cost.
    """
    import_error = sedona_ops.sedonadb_import_error()
    if import_error is not None:
        logger.info("SedonaDB runtime unavailable: %s", import_error)
        raise HTTPException(
            status_code=503,
            detail="SedonaDB is not installed in the sidecar.",
        )

    if not request.sql or not request.sql.strip():
        raise HTTPException(status_code=400, detail="A SQL statement is required.")

    try:
        return sedona_ops.run_sql(
            request.sql,
            [{"name": layer.name, "geojson": layer.geojson} for layer in request.layers],
        )
    except SqlInputTooLarge as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - surface a stable error to the client
        logger.exception("Sedona SQL failed")
        raise HTTPException(status_code=400, detail=f"Spatial SQL failed: {exc}") from exc
