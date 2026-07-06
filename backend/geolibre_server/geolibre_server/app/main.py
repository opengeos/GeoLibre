"""
GeoLibre processing sidecar (FastAPI).

Future integrations (v0.9+):
- GDAL / Rasterio — raster I/O, warping, COG
- GeoPandas — vector operations, reproject, buffer
- WhiteboxTools — hydrology, terrain analysis
- Leafmap — interactive mapping helpers
- GeoAI / SamGeo — segmentation and ML workflows

Spatial SQL is served by the ``/sql`` router (Apache Sedona / SedonaDB).
"""

from __future__ import annotations

import signal
import threading
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .conversion import router as conversion_router
from .ml import router as ml_router
from .ml import stop_child_server
from .postgis import router as postgis_router
from .raster import router as raster_router
from .sql import router as sql_router
from .vector import router as vector_router
from .whitebox import router as whitebox_router

app = FastAPI(title="GeoLibre Server", version="0.8.0")
# Restrict CORS to the Tauri webview origins and the pinned Vite dev server
# (vite.config.ts sets strictPort on 5173) rather than any localhost port, so a
# stray local web app cannot reach the Whitebox endpoints from a browser.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=(
        r"^(http://localhost:5173|http://127\.0\.0\.1:5173"
        r"|tauri://localhost|http://tauri\.localhost)$"
    ),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
app.include_router(whitebox_router)
app.include_router(conversion_router)
app.include_router(raster_router)
app.include_router(vector_router)
app.include_router(postgis_router)
app.include_router(sql_router)
app.include_router(ml_router)


class RunRequest(BaseModel):
    algorithm_id: str
    parameters: dict = {}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/shutdown")
def shutdown():
    """Request graceful shutdown of the local sidecar process."""
    # Stop the launched samgeo-api child (if any) so the heavy model server
    # does not outlive this sidecar.
    stop_child_server()
    threading.Thread(target=_terminate_current_process, daemon=True).start()
    return {"status": "shutting_down"}


def _terminate_current_process() -> None:
    """Terminate the current process after the response is returned.

    Raises ``SIGINT`` rather than ``SIGTERM`` so uvicorn runs its graceful
    shutdown on every platform. On Windows ``os.kill`` with ``SIGTERM`` maps to
    an uncatchable ``TerminateProcess`` that would bypass lifespan shutdown.
    """
    time.sleep(0.2)
    signal.raise_signal(signal.SIGINT)


@app.get("/algorithms")
def algorithms():
    return {
        "algorithms": [
            {
                "id": "calculate-bounds",
                "name": "Calculate layer bounds",
                "description": "GDAL/GeoPandas-backed bounds (placeholder)",
            },
            {
                "id": "buffer",
                "name": "Buffer",
                "description": "GeoPandas buffer (placeholder)",
            },
            {
                "id": "reproject",
                "name": "Reproject",
                "description": "GDAL warp (placeholder)",
            },
        ]
    }


@app.post("/run")
def run_algorithm(req: RunRequest):
    # TODO(v0.5): Dispatch to GDAL, GeoPandas, WhiteboxTools, etc.
    raise HTTPException(
        status_code=501,
        detail={
            "message": "Sidecar /run not implemented yet",
            "algorithm_id": req.algorithm_id,
            "planned": [
                "GDAL",
                "Rasterio",
                "GeoPandas",
                "DuckDB Spatial",
                "WhiteboxTools",
                "Leafmap",
                "GeoAI",
                "SamGeo",
            ],
        },
    )


def run():
    import uvicorn

    uvicorn.run("geolibre_server.app.main:app", host="127.0.0.1", port=8765, reload=True)


if __name__ == "__main__":
    run()
