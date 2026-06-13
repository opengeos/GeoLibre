"""Raster processing sidecar endpoints (rasterio / numpy / contourpy).

QGIS-inspired raster tools that run on the managed conversion runtime with a
file path in and a file path out, mirroring the ``/conversion`` jobs. They reuse
the conversion job store and background runner, so the client polls results with
the same ``GET /conversion/jobs/{id}`` endpoint.

rasterio and numpy already ship in the managed runtime (pulled in transitively
by ``rio-cogeo``); ``contourpy`` is added for the Contour tool. When the runtime
cannot be resolved, ``/raster/status`` reports ``available: false`` and the
desktop app disables the Run button.
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

# These helpers are reused as-is from the conversion module so raster jobs share
# the same job store, runtime, and path-allowlist behavior. They are treated as a
# stable internal interface; a future refactor could lift them into a shared
# `_job_helpers` module.
from .conversion import (
    _RESULT_MARKER,
    _is_within_roots,
    _runtime_python,
    _start_job,
    _validate_paths,
)
from .runtime import (
    RUNTIME_DISCOVERY_TIMEOUT_SECS,
    RuntimeBootstrapError,
    _clean_env,
    _subprocess_startup_kwargs,
)

router = APIRouter(prefix="/raster", tags=["raster"])
logger = logging.getLogger(__name__)


class RasterToolRequest(BaseModel):
    tool_id: str
    input_path: str
    output_path: str
    parameters: dict[str, Any] = {}


# --- Embedded tool scripts -------------------------------------------------
#
# Each script reads ``json.loads(sys.argv[1])`` for its parameters, prints
# progress lines, and ends with ``_RESULT_MARKER + json.dumps({...})``. The
# scripts use ``.replace("{marker}", _RESULT_MARKER)`` (not ``str.format``) so
# the dict/f-string braces inside them are left untouched.

_HILLSHADE_SCRIPT = """
import json, sys

import numpy as np
import rasterio

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
azimuth = float(params.get("azimuth", 315))
altitude = float(params.get("altitude", 45))
# Default to 1 only when absent/None; an explicit 0 is honored (flat result).
_z = params.get("z_factor", 1)
z_factor = float(1 if _z is None else _z)

with rasterio.open(input_path) as src:
    elev = src.read(1, masked=True).astype("float64")
    xres, yres = src.res
    profile = src.profile.copy()

elev = np.ma.filled(elev, np.nan) * z_factor
dy, dx = np.gradient(elev, yres, xres)
slope = np.pi / 2.0 - np.arctan(np.sqrt(dx * dx + dy * dy))
aspect = np.arctan2(-dx, dy)
az = np.radians(360.0 - azimuth + 90.0)
alt = np.radians(altitude)
shaded = np.sin(alt) * np.sin(slope) + np.cos(alt) * np.cos(slope) * np.cos(az - aspect)
# Match the GDAL/QGIS convention: clip back-facing (negative) illumination to
# black and scale [0, 1] -> [0, 255], rather than a symmetric [-1, 1] remap.
shaded = np.clip(shaded * 255.0, 0, 255)
shaded = np.where(np.isnan(shaded), 0, shaded).astype("uint8")

profile.update(dtype="uint8", count=1, nodata=0, compress="deflate")
with rasterio.open(output_path, "w", **profile) as dst:
    dst.write(shaded, 1)
print(f"Wrote hillshade to {output_path}")
print("{marker}" + json.dumps({"output_path": output_path}))
""".replace("{marker}", _RESULT_MARKER)


_SLOPE_SCRIPT = """
import json, sys

import numpy as np
import rasterio

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
units = str(params.get("units", "degrees"))
# Default to 1 only when absent/None; an explicit 0 is honored (flat result).
_z = params.get("z_factor", 1)
z_factor = float(1 if _z is None else _z)
nodata = -9999.0

with rasterio.open(input_path) as src:
    elev = src.read(1, masked=True).astype("float64")
    xres, yres = src.res
    profile = src.profile.copy()

elev = np.ma.filled(elev, np.nan) * z_factor
dy, dx = np.gradient(elev, yres, xres)
rise_run = np.sqrt(dx * dx + dy * dy)
if units == "percent":
    out = rise_run * 100.0
else:
    out = np.degrees(np.arctan(rise_run))
out = np.where(np.isnan(out), nodata, out).astype("float32")

profile.update(dtype="float32", count=1, nodata=nodata, compress="deflate")
with rasterio.open(output_path, "w", **profile) as dst:
    dst.write(out, 1)
print(f"Wrote slope ({units}) to {output_path}")
print("{marker}" + json.dumps({"output_path": output_path}))
""".replace("{marker}", _RESULT_MARKER)


_ASPECT_SCRIPT = """
import json, sys

import numpy as np
import rasterio

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
nodata = -9999.0

with rasterio.open(input_path) as src:
    elev = src.read(1, masked=True).astype("float64")
    xres, yres = src.res
    profile = src.profile.copy()

# Aspect is a direction, so a z_factor would cancel inside arctan2; it is
# intentionally not applied here (and not exposed as a parameter).
elev = np.ma.filled(elev, np.nan)
dy, dx = np.gradient(elev, yres, xres)
aspect = np.degrees(np.arctan2(dy, -dx))
aspect = np.where(
    aspect < 0,
    90.0 - aspect,
    np.where(aspect > 90.0, 360.0 - aspect + 90.0, 90.0 - aspect),
)
# Flat cells (no appreciable gradient) have an undefined aspect; flag them with
# nodata. A small tolerance catches float32 interpolation artifacts too.
flat = np.hypot(dx, dy) < 1e-10
aspect = np.where(flat | np.isnan(aspect), nodata, aspect).astype("float32")

profile.update(dtype="float32", count=1, nodata=nodata, compress="deflate")
with rasterio.open(output_path, "w", **profile) as dst:
    dst.write(aspect, 1)
print(f"Wrote aspect to {output_path}")
print("{marker}" + json.dumps({"output_path": output_path}))
""".replace("{marker}", _RESULT_MARKER)


_REPROJECT_SCRIPT = """
import json, sys

import rasterio
from rasterio.warp import Resampling, calculate_default_transform, reproject

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
dst_crs = str(params.get("dst_crs", "") or "").strip()
if not dst_crs:
    raise SystemExit("Target CRS (dst_crs) is required")
resampling_name = str(params.get("resampling", "nearest"))
if not hasattr(Resampling, resampling_name):
    raise SystemExit(f"Unsupported resampling method: {resampling_name}")
method = getattr(Resampling, resampling_name)

with rasterio.open(input_path) as src:
    transform, width, height = calculate_default_transform(
        src.crs, dst_crs, src.width, src.height, *src.bounds
    )
    profile = src.profile.copy()
    profile.update(
        crs=dst_crs, transform=transform, width=width, height=height, compress="deflate"
    )
    with rasterio.open(output_path, "w", **profile) as dst:
        for i in range(1, src.count + 1):
            reproject(
                source=rasterio.band(src, i),
                destination=rasterio.band(dst, i),
                src_transform=src.transform,
                src_crs=src.crs,
                dst_transform=transform,
                dst_crs=dst_crs,
                resampling=method,
            )
print(f"Reprojected to {dst_crs} -> {output_path}")
print("{marker}" + json.dumps({"output_path": output_path}))
""".replace("{marker}", _RESULT_MARKER)


_RESAMPLE_SCRIPT = """
import json, sys

import rasterio
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
resolution = float(params.get("resolution", 0) or 0)
if resolution <= 0:
    raise SystemExit("Target pixel size (resolution) must be > 0")
resampling_name = str(params.get("resampling", "bilinear"))
if not hasattr(Resampling, resampling_name):
    raise SystemExit(f"Unsupported resampling method: {resampling_name}")
method = getattr(Resampling, resampling_name)

with rasterio.open(input_path) as src:
    bounds = src.bounds
    width = max(1, int(round((bounds.right - bounds.left) / resolution)))
    height = max(1, int(round((bounds.top - bounds.bottom) / resolution)))
    transform = from_origin(bounds.left, bounds.top, resolution, resolution)
    profile = src.profile.copy()
    profile.update(transform=transform, width=width, height=height, compress="deflate")
    with rasterio.open(output_path, "w", **profile) as dst:
        for i in range(1, src.count + 1):
            reproject(
                source=rasterio.band(src, i),
                destination=rasterio.band(dst, i),
                src_transform=src.transform,
                src_crs=src.crs,
                dst_transform=transform,
                dst_crs=src.crs,
                resampling=method,
            )
print(f"Resampled to {resolution} units/pixel ({width}x{height}) -> {output_path}")
print("{marker}" + json.dumps({"output_path": output_path}))
""".replace("{marker}", _RESULT_MARKER)


_CLIP_EXTENT_SCRIPT = """
import json, sys

import rasterio
from rasterio.errors import WindowError
from rasterio.windows import Window, from_bounds

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
minx = float(params["minx"])
miny = float(params["miny"])
maxx = float(params["maxx"])
maxy = float(params["maxy"])
if minx >= maxx or miny >= maxy:
    raise SystemExit("Extent must satisfy minx < maxx and miny < maxy")

with rasterio.open(input_path) as src:
    window = from_bounds(minx, miny, maxx, maxy, src.transform)
    window = window.round_offsets().round_lengths()
    # Independent rounding can push the window past the raster edge (negative
    # offsets or beyond width/height); clamp it to the valid extent.
    try:
        window = window.intersection(Window(0, 0, src.width, src.height))
    except WindowError:
        raise SystemExit("Extent does not overlap the raster")
    data = src.read(window=window)
    if data.shape[1] == 0 or data.shape[2] == 0:
        raise SystemExit("Extent does not overlap the raster")
    transform = src.window_transform(window)
    profile = src.profile.copy()
    profile.update(
        height=data.shape[1], width=data.shape[2], transform=transform, compress="deflate"
    )
    with rasterio.open(output_path, "w", **profile) as dst:
        dst.write(data)
print(f"Clipped to extent -> {output_path}")
print("{marker}" + json.dumps({"output_path": output_path}))
""".replace("{marker}", _RESULT_MARKER)


_CLIP_MASK_SCRIPT = """
import json, re, sys

import rasterio
from rasterio.crs import CRS
from rasterio.mask import mask as rio_mask
from rasterio.warp import transform_geom

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
mask_path = params["mask_path"]
crop = bool(params.get("crop", True))
all_touched = bool(params.get("all_touched", False))

with open(mask_path) as f:
    gj = json.load(f)
gtype = gj.get("type")
if gtype == "FeatureCollection":
    shapes = [feat["geometry"] for feat in gj.get("features", []) if feat.get("geometry")]
elif gtype == "Feature":
    shapes = [gj["geometry"]] if gj.get("geometry") else []
else:
    shapes = [gj]
if not shapes:
    raise SystemExit("Mask layer has no geometries")

# Resolve the mask CRS: an explicit GeoJSON ``crs`` member if present, else the
# GeoJSON default of WGS84 (EPSG:4326).
mask_crs = CRS.from_epsg(4326)
crs_member = gj.get("crs")
if isinstance(crs_member, dict):
    name = crs_member.get("properties", {}).get("name", "")
    digits = re.search(r"(\\d+)$", str(name))
    if digits:
        try:
            mask_crs = CRS.from_epsg(int(digits.group(1)))
        except Exception:
            pass

with rasterio.open(input_path) as src:
    if src.crs is None:
        # Without a raster CRS the mask coordinates cannot be aligned; passing
        # them through would crop in raw raster units. Fail with a clear error.
        raise SystemExit(
            "Input raster has no CRS; clip-by-mask requires a georeferenced raster."
        )
    # rio_mask needs shapes in the raster's CRS; reproject the geometries when
    # the mask CRS differs so a WGS84 mask over a projected raster still works.
    if mask_crs != src.crs:
        shapes = [transform_geom(mask_crs, src.crs, geom) for geom in shapes]
    out_image, out_transform = rio_mask(
        src, shapes, crop=crop, all_touched=all_touched
    )
    profile = src.profile.copy()
    profile.update(
        height=out_image.shape[1],
        width=out_image.shape[2],
        transform=out_transform,
        compress="deflate",
    )
    with rasterio.open(output_path, "w", **profile) as dst:
        dst.write(out_image)
print(f"Clipped by {len(shapes)} mask geometry(ies) -> {output_path}")
print("{marker}" + json.dumps({"output_path": output_path}))
""".replace("{marker}", _RESULT_MARKER)


_POLYGONIZE_SCRIPT = """
import json, math, sys

import numpy as np
import rasterio
from rasterio.features import shapes as rio_shapes

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
band = int(params.get("band", 1))
connectivity = int(params.get("connectivity", 4))
field = str(params.get("field", "value"))

with rasterio.open(input_path) as src:
    arr = src.read(band)
    valid = None
    if src.nodata is not None:
        # NaN nodata needs np.isnan: ``arr != nan`` is True for every pixel
        # (NaN != NaN), which would otherwise mask nothing. rio_shapes wants a
        # uint8/bool mask.
        if isinstance(src.nodata, float) and math.isnan(src.nodata):
            valid = (~np.isnan(arr)).astype("uint8")
        else:
            valid = (arr != src.nodata).astype("uint8")
    transform = src.transform
    crs = src.crs

if np.issubdtype(arr.dtype, np.floating):
    print(
        "Warning: rasterio.features.shapes floor-truncates float bands to int32, "
        "so sub-integer values are merged. Polygonize is best suited to "
        "categorical (integer) rasters."
    )

features = []
for geom, value in rio_shapes(
    arr, mask=valid, connectivity=connectivity, transform=transform
):
    features.append(
        {"type": "Feature", "properties": {field: value}, "geometry": geom}
    )
fc = {"type": "FeatureCollection", "features": features}
if crs is not None and crs.to_epsg() and crs.to_epsg() != 4326:
    fc["crs"] = {
        "type": "name",
        "properties": {"name": f"urn:ogc:def:crs:EPSG::{crs.to_epsg()}"},
    }
with open(output_path, "w") as f:
    json.dump(fc, f)
print(f"Polygonized into {len(features)} feature(s) -> {output_path}")
print("{marker}" + json.dumps({"output_path": output_path}))
""".replace("{marker}", _RESULT_MARKER)


_CONTOUR_SCRIPT = """
import json, sys

import numpy as np
import rasterio
from contourpy import contour_generator

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
band = int(params.get("band", 1))
interval = float(params.get("interval", 0) or 0)
if interval <= 0:
    raise SystemExit("Contour interval must be > 0")
base = float(params.get("base", 0) or 0)
attribute = str(params.get("attribute", "elev"))

with rasterio.open(input_path) as src:
    arr = src.read(band, masked=True).astype("float64")
    transform = src.transform
    crs = src.crs

data = np.ma.masked_invalid(np.ma.filled(arr, np.nan))
# Evaluate finiteness on the plain filled array: ``MaskedArray.any()`` returns
# ``np.ma.masked`` (not False) when every cell is masked, and ``not masked``
# raises an ambiguous-truth-value error.
filled = data.filled(np.nan)
if not np.isfinite(filled).any():
    raise SystemExit("Raster band has no valid data to contour")
zmin = float(np.nanmin(filled))
zmax = float(np.nanmax(filled))
start = base + np.ceil((zmin - base) / interval) * interval
# Index-based generation avoids float drift from repeated ``+= interval`` that
# could skip the final level or append a spurious one.
n_levels = int(np.floor((zmax - start) / interval + 1e-9)) + 1
levels = [round(start + i * interval, 6) for i in range(max(0, n_levels))]
if not levels:
    raise SystemExit(
        f"No contour levels fall within the data range [{zmin:.6g}, {zmax:.6g}] "
        f"for interval={interval} and base={base}."
    )

gen = contour_generator(z=data, line_type="Separate")
features = []
for value in levels:
    for line in gen.lines(value):
        coords = []
        for col, row in line:
            x, y = transform * (float(col), float(row))
            coords.append([x, y])
        if len(coords) >= 2:
            features.append(
                {
                    "type": "Feature",
                    "properties": {attribute: value},
                    "geometry": {"type": "LineString", "coordinates": coords},
                }
            )
fc = {"type": "FeatureCollection", "features": features}
if crs is not None and crs.to_epsg() and crs.to_epsg() != 4326:
    fc["crs"] = {
        "type": "name",
        "properties": {"name": f"urn:ogc:def:crs:EPSG::{crs.to_epsg()}"},
    }
with open(output_path, "w") as f:
    json.dump(fc, f)
print(
    f"Generated {len(features)} contour line(s) across {len(levels)} level(s) -> {output_path}"
)
print("{marker}" + json.dumps({"output_path": output_path}))
""".replace("{marker}", _RESULT_MARKER)


_INTERPOLATE_SCRIPT = """
import json, re, sys

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
field = str(params.get("field", "") or "").strip()
if not field:
    raise SystemExit("Value field is required")
method = str(params.get("method", "idw")).lower()
resolution = float(params.get("resolution", 0) or 0)
if resolution <= 0:
    raise SystemExit("Output pixel size (resolution) must be > 0")
# Default to 2 only when absent/None; an explicit 0 must error rather than be
# silently coerced to the default (0 ** 0 has no useful IDW meaning).
_power = params.get("power", 2)
power = float(2 if _power is None else _power)
if power <= 0:
    raise SystemExit("IDW power must be > 0")
variogram_model = str(params.get("variogram_model", "spherical")).lower()
nodata = -9999.0

# Guards: keep the output grid and (for kriging) the dense linear system within
# memory/time budgets. IDW is cheap, so it tolerates a much larger grid.
MAX_CELLS_IDW = 6_000_000
MAX_CELLS_KRIGE = 1_000_000
MAX_KRIGE_POINTS = 1500

# --- Load points -----------------------------------------------------------
with open(input_path) as f:
    gj = json.load(f)
gtype = gj.get("type")
if gtype == "FeatureCollection":
    feats = gj.get("features", [])
elif gtype == "Feature":
    feats = [gj]
else:
    raise SystemExit("Input must be a GeoJSON Feature or FeatureCollection of points")

xs, ys, zs = [], [], []
skipped = 0
for feat in feats:
    geom = (feat or {}).get("geometry") or {}
    if geom.get("type") != "Point":
        skipped += 1
        continue
    coords = geom.get("coordinates") or []
    if len(coords) < 2:
        skipped += 1
        continue
    val = ((feat or {}).get("properties") or {}).get(field)
    try:
        z = float(val)
    except (TypeError, ValueError):
        skipped += 1
        continue
    if not np.isfinite(z):
        skipped += 1
        continue
    xs.append(float(coords[0]))
    ys.append(float(coords[1]))
    zs.append(z)

if len(zs) < 3:
    raise SystemExit(
        "Interpolation needs at least 3 point features with a numeric "
        f"'{field}' value (found {len(zs)})."
    )
if skipped:
    print(f"Skipped {skipped} feature(s) without a Point geometry or numeric '{field}'.")

px = np.asarray(xs, dtype="float64")
py = np.asarray(ys, dtype="float64")
pz = np.asarray(zs, dtype="float64")

# --- Resolve CRS (explicit GeoJSON member, else WGS84 default) --------------
epsg = 4326
crs_member = gj.get("crs")
if isinstance(crs_member, dict):
    name = crs_member.get("properties", {}).get("name", "")
    digits = re.search(r"(\\d+)$", str(name))
    if digits:
        try:
            epsg = int(digits.group(1))
        except ValueError:
            pass
try:
    crs = CRS.from_epsg(epsg)
except Exception:
    crs = CRS.from_epsg(4326)

# --- Build the output grid from the points' extent -------------------------
minx, maxx = float(px.min()), float(px.max())
miny, maxy = float(py.min()), float(py.max())
# A degenerate extent (all points share an x or y) still needs a 1-cell span.
if maxx <= minx:
    maxx = minx + resolution
if maxy <= miny:
    maxy = miny + resolution
width = max(1, int(np.ceil((maxx - minx) / resolution)))
height = max(1, int(np.ceil((maxy - miny) / resolution)))
cells = width * height
cap = MAX_CELLS_KRIGE if method == "kriging" else MAX_CELLS_IDW
if cells > cap:
    raise SystemExit(
        f"Output grid is {width}x{height} = {cells} cells, above the {cap} limit "
        f"for {method}. Increase the pixel size."
    )

transform = from_origin(minx, maxy, resolution, resolution)
gx = minx + (np.arange(width) + 0.5) * resolution
gy = maxy - (np.arange(height) + 0.5) * resolution
mesh_x, mesh_y = np.meshgrid(gx, gy)
grid = np.column_stack([mesh_x.ravel(), mesh_y.ravel()])  # (M, 2)


def interpolate_idw(grid_pts):
    out = np.empty(grid_pts.shape[0], dtype="float64")
    half_power = power / 2.0
    # Each chunk broadcasts several (chunk, n) float64 matrices. Size the chunk
    # so their combined peak stays near ~256 MB regardless of the sample count,
    # so a large point layer cannot OOM (unlike a fixed chunk). Capped at
    # 100_000 cells so small point sets still run in one or few passes.
    n = px.shape[0]
    chunk = max(1, min(100_000, 256_000_000 // (5 * 8 * n)))
    for i in range(0, grid_pts.shape[0], chunk):
        gp = grid_pts[i : i + chunk]
        dx = gp[:, 0:1] - px[None, :]
        dy = gp[:, 1:2] - py[None, :]
        d2 = dx * dx + dy * dy
        with np.errstate(divide="ignore"):
            w = 1.0 / np.power(d2, half_power)
        wsum = w.sum(axis=1)
        res = (w * pz[None, :]).sum(axis=1) / wsum
        # Cells coinciding with a sample produce inf/inf -> NaN; assign the
        # value of the (first) coincident sample exactly.
        hit = d2 == 0
        hit_rows = hit.any(axis=1)
        if hit_rows.any():
            res[hit_rows] = pz[np.argmax(hit[hit_rows], axis=1)]
        out[i : i + chunk] = res
    return out


def _variogram_shape(h_over_r, name):
    \"\"\"Normalised variogram shape (sill = 1) as a function of h / range.\"\"\"
    if name == "exponential":
        return 1.0 - np.exp(-3.0 * h_over_r)
    if name == "gaussian":
        return 1.0 - np.exp(-3.0 * h_over_r * h_over_r)
    t = np.minimum(h_over_r, 1.0)
    if name == "linear":
        return t
    # spherical (default)
    return np.where(h_over_r >= 1.0, 1.0, 1.5 * t - 0.5 * t ** 3)


def _fit_variogram(h, gamma, name, hmax):
    \"\"\"Least-squares fit of nugget/sill/range over a coarse range sweep.\"\"\"
    best = None
    for r in np.linspace(hmax * 0.1, hmax * 1.5, 25):
        shape = _variogram_shape(h / r, name)
        design = np.column_stack([np.ones_like(shape), shape])
        coef, *_ = np.linalg.lstsq(design, gamma, rcond=None)
        nugget = max(0.0, float(coef[0]))
        sill = max(1e-12, float(coef[1]))
        sse = float((((nugget + sill * shape) - gamma) ** 2).sum())
        if best is None or sse < best[0]:
            best = (sse, float(r), sill, nugget)
    return best[1], best[2], best[3]


def interpolate_kriging(grid_pts):
    n = px.shape[0]
    if n > MAX_KRIGE_POINTS:
        raise SystemExit(
            f"Ordinary kriging is capped at {MAX_KRIGE_POINTS} points (got {n}). "
            "Use IDW for larger point sets."
        )
    pts = np.column_stack([px, py])
    diff = pts[:, None, :] - pts[None, :, :]
    dist = np.sqrt((diff * diff).sum(axis=2))  # (n, n)

    iu = np.triu_indices(n, k=1)
    h = dist[iu]
    gamma = 0.5 * (pz[iu[0]] - pz[iu[1]]) ** 2
    hmax = float(h.max())
    if hmax <= 0:
        raise SystemExit("All points are coincident; cannot krige.")
    nbins = 12
    edges = np.linspace(0.0, hmax, nbins + 1)
    centers = 0.5 * (edges[:-1] + edges[1:])
    which = np.clip(np.digitize(h, edges) - 1, 0, nbins - 1)
    emp = np.array(
        [gamma[which == b].mean() if np.any(which == b) else np.nan for b in range(nbins)]
    )
    valid = ~np.isnan(emp)
    rng, sill, nugget = _fit_variogram(centers[valid], emp[valid], variogram_model, hmax)
    print(
        f"Variogram ({variogram_model}): range={rng:.4g}, sill={sill:.4g}, "
        f"nugget={nugget:.4g}"
    )

    def model(hh):
        g = nugget + sill * _variogram_shape(hh / rng, variogram_model)
        return np.where(hh <= 0, 0.0, g)

    # Ordinary-kriging LHS: semivariances among samples with a unit-bias row/col
    # and a zero corner (the Lagrange multiplier). The diagonal stays 0 so the
    # surface honours the samples exactly.
    big = np.ones((n + 1, n + 1), dtype="float64")
    big[:n, :n] = model(dist)
    big[n, n] = 0.0
    big_inv = np.linalg.pinv(big)

    out = np.empty(grid_pts.shape[0], dtype="float64")
    chunk = 4096
    for i in range(0, grid_pts.shape[0], chunk):
        gp = grid_pts[i : i + chunk]
        dxt = gp[:, 0:1] - px[None, :]
        dyt = gp[:, 1:2] - py[None, :]
        dt = np.sqrt(dxt * dxt + dyt * dyt)  # (m, n)
        rhs = np.empty((n + 1, gp.shape[0]), dtype="float64")
        rhs[:n, :] = model(dt).T
        rhs[n, :] = 1.0
        weights = big_inv @ rhs  # (n + 1, m)
        out[i : i + chunk] = pz @ weights[:n, :]
    return out


if method == "kriging":
    values = interpolate_kriging(grid)
elif method == "idw":
    values = interpolate_idw(grid)
else:
    raise SystemExit(f"Unknown interpolation method: {method}")

surface = values.reshape(height, width).astype("float32")
surface = np.where(np.isfinite(surface), surface, nodata).astype("float32")

profile = {
    "driver": "GTiff",
    "height": height,
    "width": width,
    "count": 1,
    "dtype": "float32",
    "crs": crs,
    "transform": transform,
    "nodata": nodata,
    "compress": "deflate",
}
with rasterio.open(output_path, "w", **profile) as dst:
    dst.write(surface, 1)
print(
    f"Interpolated {len(zs)} points ({method}) into a {width}x{height} raster "
    f"-> {output_path}"
)
print("{marker}" + json.dumps({"output_path": output_path}))
""".replace("{marker}", _RESULT_MARKER)


_RASTER_TOOL_SCRIPTS: dict[str, str] = {
    "hillshade": _HILLSHADE_SCRIPT,
    "slope": _SLOPE_SCRIPT,
    "aspect": _ASPECT_SCRIPT,
    "reproject": _REPROJECT_SCRIPT,
    "resample": _RESAMPLE_SCRIPT,
    "clip-extent": _CLIP_EXTENT_SCRIPT,
    "clip-mask": _CLIP_MASK_SCRIPT,
    "polygonize": _POLYGONIZE_SCRIPT,
    "contour": _CONTOUR_SCRIPT,
    "interpolate": _INTERPOLATE_SCRIPT,
}

# Output kind per tool, used only as the key under ``JobState.outputs``.
_OUTPUT_NAMES: dict[str, str] = {
    "polygonize": "vector",
    "contour": "vector",
}


def _validate_extra_input(
    path: str, label: str, allowed_extensions: set[str] | None = None
) -> str:
    """Validate a secondary input file path (e.g. a clip mask)."""
    if not path.strip():
        raise HTTPException(status_code=400, detail=f"{label} is required")
    source = Path(path).expanduser()
    if not source.is_file():
        raise HTTPException(status_code=400, detail=f"{label} not found: {path}")
    if not _is_within_roots(source):
        raise HTTPException(
            status_code=403,
            detail="Path is outside the allowed conversion directories",
        )
    if allowed_extensions and source.suffix.lower() not in allowed_extensions:
        # Catch a wrong file type here with a clear 400 rather than letting
        # json.load fail inside the job with an opaque error.
        raise HTTPException(
            status_code=400,
            detail=(
                f"{label} must be one of {sorted(allowed_extensions)}, "
                f"got '{source.suffix}'"
            ),
        )
    return str(source.resolve())


def _check_raster_import(python_executable: str) -> None:
    """Raise if the runtime cannot import the raster processing stack."""
    try:
        completed = subprocess.run(
            [python_executable, "-c", "import rasterio, numpy, contourpy"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_clean_env(),
            timeout=RUNTIME_DISCOVERY_TIMEOUT_SECS,
            **_subprocess_startup_kwargs(),
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeBootstrapError(
            f"{python_executable}: import timed out after "
            f"{RUNTIME_DISCOVERY_TIMEOUT_SECS} seconds"
        ) from exc
    if completed.returncode != 0:
        detail = (
            completed.stderr.strip()
            or completed.stdout.strip()
            or "rasterio / contourpy import failed"
        )
        raise RuntimeBootstrapError(f"{python_executable}: {detail}")


@router.get("/status")
def raster_status():
    """Return raster (rasterio + contourpy) runtime availability."""
    try:
        python = _runtime_python()
        _check_raster_import(python)
        return {
            "available": True,
            "message": "Raster runtime (rasterio + contourpy) is available.",
        }
    except RuntimeBootstrapError as exc:
        logger.warning("Raster runtime unavailable: %s", exc)
        return {
            "available": False,
            "message": "Raster runtime is unavailable. Check the sidecar logs.",
        }
    except Exception:
        logger.exception("Unexpected error while checking raster runtime")
        return {
            "available": False,
            "message": "Raster runtime status check failed.",
        }


@router.post("/run")
def raster_run(request: RasterToolRequest):
    """Run a single raster processing tool as a background job.

    Reuses the conversion job store and runner, so the result is polled via
    ``GET /conversion/jobs/{job_id}``.
    """
    script = _RASTER_TOOL_SCRIPTS.get(request.tool_id)
    if script is None:
        raise HTTPException(
            status_code=400, detail=f"Unknown raster tool: {request.tool_id}"
        )

    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    params: dict[str, Any] = {
        **request.parameters,
        "input_path": input_path,
        "output_path": output_path,
    }

    if request.tool_id == "clip-mask":
        params["mask_path"] = _validate_extra_input(
            str(request.parameters.get("mask_path", "")),
            "Mask layer",
            allowed_extensions={".geojson", ".json"},
        )

    output_name = _OUTPUT_NAMES.get(request.tool_id, "raster")
    return _start_job(request.tool_id, script, params, output_name)
