"""Generate rasterio parity fixtures for the in-browser raster engine.

Runs the real sidecar raster workers (``backend/geolibre_server``) on small
synthetic inputs and records each input and output in
``tests/fixtures/raster-client-parity.json``. ``tests/raster-client-parity.test.ts``
replays the same inputs through the client engine and asserts the results
match, so a drift between the browser fallback and the rasterio path fails CI
without needing Python there.

Usage (needs the backend ``raster`` extra plus pyproj):

    pip install -e 'backend/geolibre_server[raster]' pyproj
    python scripts/gen-raster-parity-fixtures.py
"""

from __future__ import annotations

import contextlib
import importlib
import io
import json
import math
import sys
import tempfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "fixtures" / "raster-client-parity.json"
sys.path.insert(0, str(ROOT / "backend" / "geolibre_server"))

NODATA = -9999.0


def run_worker(name: str, params: dict) -> str:
    """Run one sidecar raster worker in-process and return its stdout.

    Args:
        name: Worker module name under ``geolibre_server.workers.raster_tools``.
        params: The JSON parameters the worker reads from ``sys.argv[1]``.

    Returns:
        Everything the worker printed.
    """
    module = importlib.import_module(f"geolibre_server.workers.raster_tools.{name}")
    argv = sys.argv
    sys.argv = [name, json.dumps(params)]
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            module.main()
    finally:
        sys.argv = argv
    return buf.getvalue()


def dem(width: int, height: int) -> np.ndarray:
    """Build a smooth synthetic elevation surface with a little texture.

    Args:
        width: Columns.
        height: Rows.

    Returns:
        A float32 array of shape ``(height, width)``.
    """
    rows, cols = np.mgrid[0:height, 0:width]
    z = (
        200
        + 4.0 * cols
        - 3.0 * rows
        + 15.0 * np.sin(cols / 2.5) * np.cos(rows / 3.0)
        + 0.37 * ((cols * 7 + rows * 13) % 5)
    )
    return z.astype("float32")


def write_tif(path: Path, data: np.ndarray, transform, crs: str, nodata) -> None:
    """Write a single- or multi-band GeoTIFF.

    Args:
        path: Output path.
        data: ``(rows, cols)`` or ``(bands, rows, cols)`` array.
        transform: Affine geotransform.
        crs: CRS string.
        nodata: NoData value or None.
    """
    arr = data if data.ndim == 3 else data[None, ...]
    profile = {
        "driver": "GTiff",
        "width": arr.shape[2],
        "height": arr.shape[1],
        "count": arr.shape[0],
        "dtype": str(arr.dtype),
        "crs": crs,
        "transform": transform,
    }
    if nodata is not None:
        profile["nodata"] = nodata
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(arr)


def raster_record(data: np.ndarray, transform, crs: str, nodata) -> dict:
    """Describe an input raster so the TS test can rebuild a ``RasterData``.

    Args:
        data: ``(rows, cols)`` or ``(bands, rows, cols)`` array.
        transform: Affine geotransform (north-up).
        crs: EPSG string.
        nodata: NoData value or None.

    Returns:
        A JSON-serializable dict.
    """
    arr = data if data.ndim == 3 else data[None, ...]
    return {
        "width": int(arr.shape[2]),
        "height": int(arr.shape[1]),
        "originX": transform.c,
        "originY": transform.f,
        "resX": transform.a,
        "resY": -transform.e,
        "epsg": int(crs.split(":")[1]),
        "nodata": nodata,
        # Shortest round-trip repr of each float32, so the TS side's
        # Float32Array.from() rebuilds the exact same samples.
        "bands": [[float(str(np.float32(v))) for v in band.ravel()] for band in arr],
    }


def read_output(path: Path) -> dict:
    """Read a worker's GeoTIFF output: values, validity, grid.

    Args:
        path: GeoTIFF path.

    Returns:
        A JSON-serializable dict; invalid pixels hold ``null``.
    """
    with rasterio.open(path) as src:
        arr = src.read().astype("float64")
        masks = src.read_masks()
        t = src.transform
        bands = []
        for b in range(src.count):
            valid = masks[b] > 0
            band = [None if not ok else float(v) for v, ok in zip(arr[b].ravel(), valid.ravel())]
            bands.append(band)
        return {
            "width": src.width,
            "height": src.height,
            "originX": t.c,
            "originY": t.f,
            "resX": t.a,
            "resY": -t.e,
            "epsg": src.crs.to_epsg() if src.crs else None,
            "bands": bands,
        }


def compact(value):
    """Round floats to 10 significant digits to keep the fixture small.

    Args:
        value: Any JSON-serializable value.

    Returns:
        The same structure with every float rounded.
    """
    if isinstance(value, float):
        return float(f"{value:.10g}")
    if isinstance(value, list):
        return [compact(v) for v in value]
    if isinstance(value, dict):
        return {k: compact(v) for k, v in value.items()}
    return value


def main() -> None:
    """Generate every parity case and write the fixture file."""
    from pyproj import Transformer

    tmp = Path(tempfile.mkdtemp())
    cases: list[dict] = []

    # --- Inputs -------------------------------------------------------------
    utm_t = from_origin(500000.0, 4100000.0, 30.0, 30.0)
    dem_utm = dem(16, 12)
    dem_utm[5, 3] = NODATA
    dem_utm[2, 10] = NODATA
    utm_path = tmp / "dem_utm.tif"
    write_tif(utm_path, dem_utm, utm_t, "EPSG:32617", NODATA)
    utm_rec = raster_record(dem_utm, utm_t, "EPSG:32617", NODATA)

    dem_clean = dem(16, 12)
    clean_path = tmp / "dem_clean.tif"
    write_tif(clean_path, dem_clean, utm_t, "EPSG:32617", None)
    clean_rec = raster_record(dem_clean, utm_t, "EPSG:32617", None)

    ll_t = from_origin(-84.0, 36.0, 0.01, 0.01)
    dem_ll = dem(16, 12)
    dem_ll[7, 9] = NODATA
    ll_path = tmp / "dem_ll.tif"
    write_tif(ll_path, dem_ll, ll_t, "EPSG:4326", NODATA)
    ll_rec = raster_record(dem_ll, ll_t, "EPSG:4326", NODATA)

    inputs = {
        "dem_utm": (utm_path, utm_rec),
        "dem_clean": (clean_path, clean_rec),
        "dem_ll": (ll_path, ll_rec),
    }

    # --- Resample -----------------------------------------------------------
    for src_name, res, method in [
        ("dem_utm", 45.0, "nearest"),
        ("dem_utm", 45.0, "bilinear"),
        ("dem_utm", 45.0, "cubic"),
        ("dem_utm", 20.0, "nearest"),
        ("dem_utm", 20.0, "bilinear"),
        ("dem_utm", 20.0, "cubic"),
        ("dem_utm", 60.0, "bilinear"),
        ("dem_utm", 75.0, "cubic"),
        ("dem_clean", 45.0, "bilinear"),
        ("dem_clean", 20.0, "cubic"),
        ("dem_clean", 60.0, "nearest"),
    ]:
        out = tmp / f"resample_{src_name}_{res}_{method}.tif"
        params = {"resolution": res, "resampling": method}
        run_worker(
            "resample", {**params, "input_path": str(inputs[src_name][0]), "output_path": str(out)}
        )
        cases.append(
            {"tool": "resample", "input": src_name, "params": params, "expected": read_output(out)}
        )

    # --- Reproject ----------------------------------------------------------
    for src_name, dst, method in [
        ("dem_ll", "EPSG:3857", "nearest"),
        ("dem_ll", "EPSG:3857", "bilinear"),
        ("dem_ll", "EPSG:3857", "cubic"),
        ("dem_utm", "EPSG:4326", "nearest"),
        ("dem_utm", "EPSG:4326", "bilinear"),
        ("dem_ll", "EPSG:32617", "bilinear"),
        ("dem_clean", "EPSG:3857", "bilinear"),
    ]:
        out = tmp / f"reproject_{src_name}_{dst.replace(':', '')}_{method}.tif"
        params = {"dst_crs": dst, "resampling": method}
        run_worker(
            "reproject", {**params, "input_path": str(inputs[src_name][0]), "output_path": str(out)}
        )
        cases.append(
            {"tool": "reproject", "input": src_name, "params": params, "expected": read_output(out)}
        )

    # --- Clip by mask -------------------------------------------------------
    to_ll = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True)
    ring_utm = [
        (500047.0, 4099931.0),
        (500311.0, 4099911.0),
        (500402.0, 4099757.0),
        (500199.0, 4099713.0),
        (500083.0, 4099781.0),
        (500047.0, 4099931.0),
    ]
    hole_utm = [
        (500170.0, 4099868.0),
        (500242.0, 4099860.0),
        (500232.0, 4099806.0),
        (500170.0, 4099868.0),
    ]
    poly_ll = {
        "type": "Polygon",
        "coordinates": [
            [list(to_ll.transform(x, y)) for x, y in ring_utm],
            [list(to_ll.transform(x, y)) for x, y in hole_utm],
        ],
    }
    mask_ll = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": poly_ll}],
    }
    mask_utm = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::32617"}},
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "Polygon", "coordinates": [[list(p) for p in ring_utm]]},
            },
            {
                "type": "Feature",
                "properties": {},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [500391.0, 4099853.0],
                            [500459.0, 4099853.0],
                            [500459.0, 4099790.0],
                            [500391.0, 4099853.0],
                        ]
                    ],
                },
            },
        ],
    }
    for mask_name, mask in [("mask_ll", mask_ll), ("mask_utm", mask_utm)]:
        mask_path = tmp / f"{mask_name}.geojson"
        mask_path.write_text(json.dumps(mask))
        for crop in (True, False):
            for all_touched in (False, True):
                out = tmp / f"clip_{mask_name}_{crop}_{all_touched}.tif"
                params = {"crop": crop, "all_touched": all_touched}
                run_worker(
                    "clip_mask",
                    {
                        **params,
                        "mask_path": str(mask_path),
                        "input_path": str(utm_path),
                        "output_path": str(out),
                    },
                )
                cases.append(
                    {
                        "tool": "clip-mask",
                        "input": "dem_utm",
                        "params": params,
                        "vector": mask,
                        "expected": read_output(out),
                    }
                )

    # --- Polygonize ---------------------------------------------------------
    classes = np.array(
        [
            [1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4],
            [1, 2, 1, 2, 9, 2, 3, 5, 5, 3, 4, 4],
            [1, 1, 1, 2, 2, 2, 3, 5, 5, 3, 4, 7],
            [6, 6, 1, 1, 7, 7, 3, 3, 3, 3, 7, 4],
            [6, 0, 0, 1, 7, 6, 6, 6, 6, 3, 4, 4],
            [6, 0, 0, 1, 1, 6, 8, 8, 6, 3, 3, 3],
            [6, 6, 6, 6, 1, 6, 8, 6, 6, 6, 6, 3],
            [2, 2, 6, 7, 1, 6, 6, 6, 9, 9, 6, 3],
            [2, 7, 2, 2, 7, 1, 1, 9, 6, 9, 6, 3],
            [2, 2, 2, 2, 2, 1, 1, 9, 9, 9, 6, 3],
        ],
        dtype="uint8",
    )
    cls_t = from_origin(500000.0, 4100000.0, 30.0, 30.0)
    cls_path = tmp / "classes.tif"
    write_tif(cls_path, classes, cls_t, "EPSG:32617", 0)
    cls_rec = raster_record(classes, cls_t, "EPSG:32617", 0)
    inputs["classes"] = (cls_path, cls_rec)
    for conn in ("4", "8"):
        out = tmp / f"poly_{conn}.geojson"
        params = {"band": 1, "connectivity": conn, "field": "value"}
        run_worker("polygonize", {**params, "input_path": str(cls_path), "output_path": str(out)})
        cases.append(
            {
                "tool": "polygonize",
                "input": "classes",
                "params": params,
                "expected": json.loads(out.read_text()),
            }
        )

    # --- Contour ------------------------------------------------------------
    for src_name, interval, base in [
        ("dem_utm", 10.0, 0.0),
        ("dem_utm", 7.5, 3.0),
        ("dem_clean", 12.0, 0.0),
    ]:
        out = tmp / f"contour_{src_name}_{interval}.geojson"
        params = {"band": 1, "interval": interval, "base": base, "attribute": "elev"}
        run_worker(
            "contour", {**params, "input_path": str(inputs[src_name][0]), "output_path": str(out)}
        )
        cases.append(
            {
                "tool": "contour",
                "input": src_name,
                "params": params,
                "expected": json.loads(out.read_text()),
            }
        )

    # --- Interpolate --------------------------------------------------------
    rng = np.random.default_rng(3530)
    pts = []
    for i in range(24):
        x = -84.0 + float(rng.uniform(0, 0.2))
        y = 36.0 + float(rng.uniform(0, 0.15))
        val = 50 + 120 * (x + 84.0) - 80 * (y - 36.0) + 10 * math.sin(i)
        pts.append(
            {
                "type": "Feature",
                "properties": {"z": round(val, 4), "id": i},
                "geometry": {"type": "Point", "coordinates": [x, y]},
            }
        )
    pts.append(
        {
            "type": "Feature",
            "properties": {"z": "n/a"},
            "geometry": {"type": "Point", "coordinates": [-83.9, 36.1]},
        }
    )
    points = {"type": "FeatureCollection", "features": pts}
    pts_path = tmp / "points.geojson"
    pts_path.write_text(json.dumps(points))
    interp_cases = [
        {"field": "z", "method": "idw", "resolution": 0.01, "power": 2},
        {"field": "z", "method": "idw", "resolution": 0.015, "power": 1.5},
        {"field": "z", "method": "kriging", "resolution": 0.02, "variogram_model": "spherical"},
        {"field": "z", "method": "kriging", "resolution": 0.02, "variogram_model": "exponential"},
        {"field": "z", "method": "kriging", "resolution": 0.02, "variogram_model": "gaussian"},
        {"field": "z", "method": "kriging", "resolution": 0.02, "variogram_model": "linear"},
    ]
    for i, params in enumerate(interp_cases):
        out = tmp / f"interp_{i}.tif"
        run_worker("interpolate", {**params, "input_path": str(pts_path), "output_path": str(out)})
        cases.append(
            {
                "tool": "interpolate",
                "params": params,
                "vector": points,
                "expected": read_output(out),
            }
        )

    # --- Zonal statistics ---------------------------------------------------
    def ll_ring(coords):
        return [list(to_ll.transform(x, y)) for x, y in coords]

    zones = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "a"},
                "geometry": {"type": "Polygon", "coordinates": [ll_ring(ring_utm)]},
            },
            {
                "type": "Feature",
                "properties": {"name": "edge"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        ll_ring(
                            [
                                (500391, 4099853),
                                (500559, 4099853),
                                (500559, 4099690),
                                (500391, 4099690),
                                (500391, 4099853),
                            ]
                        )
                    ],
                },
            },
            {
                "type": "Feature",
                "properties": {"name": "outside"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        ll_ring(
                            [
                                (501000, 4099000),
                                (501100, 4099000),
                                (501100, 4098900),
                                (501000, 4099000),
                            ]
                        )
                    ],
                },
            },
            {
                "type": "Feature",
                "properties": {"name": "multi"},
                "geometry": {
                    "type": "MultiPolygon",
                    "coordinates": [
                        [
                            ll_ring(
                                [
                                    (500020, 4099700),
                                    (500110, 4099700),
                                    (500110, 4099650),
                                    (500020, 4099700),
                                ]
                            )
                        ],
                        [
                            ll_ring(
                                [
                                    (500300, 4099690),
                                    (500380, 4099690),
                                    (500380, 4099660),
                                    (500300, 4099660),
                                    (500300, 4099690),
                                ]
                            )
                        ],
                    ],
                },
            },
        ],
    }
    zones_path = tmp / "zones.geojson"
    zones_path.write_text(json.dumps(zones))
    for prefix in ("", "dem_"):
        out = tmp / f"zonal_{prefix}.geojson"
        params = {"band": 1, "prefix": prefix}
        run_worker(
            "zonal_stats",
            {
                **params,
                "zones_path": str(zones_path),
                "input_path": str(utm_path),
                "output_path": str(out),
            },
        )
        cases.append(
            {
                "tool": "zonal",
                "input": "dem_utm",
                "params": params,
                "vector": zones,
                "expected": json.loads(out.read_text()),
            }
        )

    # --- Mosaic -------------------------------------------------------------
    tiles = []
    for i, (dc, dr) in enumerate([(0, 0), (6, 0), (3, 5)]):
        t = from_origin(500000.0 + dc * 30.0, 4100000.0 - dr * 30.0, 30.0, 30.0)
        arr = (dem(10, 8) + 100 * i).astype("float32")
        arr[(i + 1) % 8, (i * 3) % 10] = NODATA
        arr[4, 7 - i] = NODATA
        p = tmp / f"tile_{i}.tif"
        write_tif(p, arr, t, "EPSG:32617", NODATA)
        name = f"tile_{i}"
        inputs[name] = (p, raster_record(arr, t, "EPSG:32617", NODATA))
        tiles.append((name, p))
    for method in ("first", "last", "min", "max"):
        out = tmp / f"mosaic_{method}.tif"
        params = {"method": method}
        run_worker(
            "mosaic",
            {
                **params,
                "input_path": str(tiles[0][1]),
                "raster_2": str(tiles[1][1]),
                "raster_3": str(tiles[2][1]),
                "output_path": str(out),
            },
        )
        cases.append(
            {
                "tool": "mosaic",
                "input": "tile_0",
                "extra": ["tile_1", "tile_2"],
                "params": params,
                "expected": read_output(out),
            }
        )

    fixture = {
        "generator": "scripts/gen-raster-parity-fixtures.py",
        "rasterio": rasterio.__version__,
        "gdal": rasterio.__gdal_version__,
        "inputs": {name: rec for name, (_, rec) in inputs.items()},
        "cases": [{**c, "expected": compact(c["expected"])} for c in cases],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fixture, separators=(",", ":")) + "\n")
    print(f"Wrote {len(cases)} parity cases -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
