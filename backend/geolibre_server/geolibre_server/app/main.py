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

import hmac
import os
import signal
import threading
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .conversion import router as conversion_router
from .ml import router as ml_router
from .ml import stop_child_server
from .postgis import router as postgis_router
from .raster import router as raster_router
from .sql import router as sql_router
from .vector import router as vector_router
from .whitebox import router as whitebox_router

# A shared secret the caller must present on every request. The desktop shell
# generates a fresh token per launch and passes it via this env var (and to the
# frontend); the Docker image injects it at the nginx proxy. When unset (e.g.
# ``python -m geolibre_server`` for local dev, or the pytest suite) the check is
# skipped so those flows keep working. CORS is *not* a sufficient control on its
# own: a browser can send a simple cross-origin POST without a preflight (CSRF),
# and a DNS-rebinding attacker can read responses too. The token closes both.
SIDECAR_TOKEN = os.environ.get("GEOLIBRE_SIDECAR_TOKEN", "").strip()
# Compared as bytes: Starlette decodes request headers as latin-1, so a header
# with a byte > 0x7F arrives as a non-ASCII ``str`` and ``hmac.compare_digest``
# would raise ``TypeError`` (turning an auth failure into a 500). Encoding both
# sides keeps the comparison constant-time and simply fails to match.
_SIDECAR_TOKEN_BYTES = SIDECAR_TOKEN.encode("utf-8")

# Endpoints reachable without the token: the health probe (used by the Rust
# readiness poll and the frontend before it holds a token) and CORS preflight.
_TOKEN_EXEMPT_PATHS = frozenset({"/health"})

app = FastAPI(title="GeoLibre Server", version="0.8.0")


@app.middleware("http")
async def require_sidecar_token(request: Request, call_next):
    """Reject requests that do not present the per-launch sidecar token.

    The token may be supplied either as ``X-GeoLibre-Token: <token>`` or as
    ``Authorization: Bearer <token>``. ``OPTIONS`` preflights and ``/health`` are
    exempt so CORS and readiness probing keep working. No-ops when
    ``GEOLIBRE_SIDECAR_TOKEN`` is unset.
    """
    if (
        SIDECAR_TOKEN
        and request.method != "OPTIONS"
        and request.url.path not in _TOKEN_EXEMPT_PATHS
    ):
        provided = request.headers.get("x-geolibre-token", "")
        if not provided:
            auth = request.headers.get("authorization", "")
            if auth.lower().startswith("bearer "):
                provided = auth[7:].strip()
        # Constant-time compare (on bytes; see _SIDECAR_TOKEN_BYTES) so a timing
        # side channel cannot leak the token and a non-ASCII header can't crash.
        if not hmac.compare_digest(provided.encode("utf-8"), _SIDECAR_TOKEN_BYTES):
            return JSONResponse(
                status_code=401,
                content={"detail": "Missing or invalid sidecar token"},
            )
    return await call_next(request)


# Reject requests whose Host header is not a loopback name, blocking
# DNS-rebinding attacks that would otherwise let a remote page treat the sidecar
# as same-origin. ``testserver`` is Starlette's TestClient default host. These
# are the IPv4 loopback names uvicorn binds (``--host 127.0.0.1``); no IPv6
# loopback (``::1``) is listed because the server never binds it — and
# TrustedHostMiddleware's ``Host.split(":")[0]`` mis-parses a bracketed
# ``[::1]:port`` anyway, so IPv6 binding would need revisiting here first.
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["localhost", "127.0.0.1", "testserver"],
)
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
