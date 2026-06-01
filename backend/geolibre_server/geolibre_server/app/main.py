"""
GeoLibre processing sidecar (FastAPI).

Future integrations (v0.5+):
- GDAL / Rasterio — raster I/O, warping, COG
- GeoPandas — vector operations, reproject, buffer
- DuckDB Spatial — SQL on GeoParquet, spatial joins
- WhiteboxTools — hydrology, terrain analysis
- Leafmap — interactive mapping helpers
- GeoAI / SamGeo — segmentation and ML workflows
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="GeoLibre Server", version="0.6.0")


class RunRequest(BaseModel):
    algorithm_id: str
    parameters: dict = {}


@app.get("/health")
def health():
    return {"status": "ok"}


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
