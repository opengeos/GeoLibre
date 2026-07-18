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
        except Exception as exc:
            print(
                f"Warning: could not parse mask CRS '{name}' "
                f"({exc}); assuming WGS84 (EPSG:4326)",
                file=sys.stderr,
            )
    elif name:
        # Consistent with the zones/interpolate sections: warn on a non-empty
        # name we could not interpret, stay silent for an absent/blank field.
        print(
            f"Warning: could not parse mask CRS '{name}'; "
            "assuming WGS84 (EPSG:4326)",
            file=sys.stderr,
        )

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
# silently coerced to the default (0 ** 0 has no useful IDW meaning). The check
# is gated on the method so a kriging request isn't rejected for an unused knob.
_power = params.get("power", 2)
power = float(2 if _power is None else _power)
if method == "idw" and power <= 0:
    raise SystemExit("IDW power must be > 0")
variogram_model = str(params.get("variogram_model", "spherical")).lower()
nodata = -9999.0

# Guards: keep the output grid and (for kriging) the dense linear system within
# memory/time budgets. IDW is cheap, so it tolerates a much larger grid, but a
# point cap still bounds its O(points x cells) work for pathological inputs.
MAX_IDW_POINTS = 200_000
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
if method == "idw" and len(zs) > MAX_IDW_POINTS:
    raise SystemExit(
        f"IDW is capped at {MAX_IDW_POINTS} points (got {len(zs)}). "
        "Thin the layer or aggregate it first."
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
        # digits matches ``(\\d+)$``, so int() can never raise here.
        epsg = int(digits.group(1))
    elif name:
        # Consistent with the mask/zones sections: warn on a non-empty name we
        # could not interpret, stay silent for an absent/blank field.
        print(
            f"Warning: could not parse CRS '{name}'; assuming WGS84 (EPSG:4326)",
            file=sys.stderr,
        )
try:
    crs = CRS.from_epsg(epsg)
except Exception as exc:
    print(
        f"Warning: could not use EPSG:{epsg} ({exc}); "
        "assuming WGS84 (EPSG:4326)",
        file=sys.stderr,
    )
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
    # The clip above maps every pair into [0, nbins-1], so with >= 3 points at
    # least one bin is populated; the guard makes that contract explicit rather
    # than letting an all-empty histogram degenerate the fit silently.
    if not valid.any():
        raise SystemExit("Could not build an empirical semivariogram from the points.")
    rng, sill, nugget = _fit_variogram(centers[valid], emp[valid], variogram_model, hmax)
    print(
        f"Variogram ({variogram_model}): range={rng:.4g}, sill={sill:.4g}, "
        f"nugget={nugget:.4g}"
    )

    def model(hh):
        g = nugget + sill * _variogram_shape(hh / rng, variogram_model)
        return np.where(hh <= 0, 0.0, g)

    # Ordinary-kriging LHS: semivariances among samples with a unit-bias row/col
    # and a zero corner (the Lagrange multiplier). `model` returns 0 for h <= 0,
    # so the self-pair diagonal is 0 (nugget excluded there) and the surface
    # honours the samples exactly — pykrige's default `exact_values` behaviour.
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


_ZONAL_STATS_SCRIPT = """
import json, re, sys

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.errors import RasterioError
from rasterio.mask import mask as rio_mask
from rasterio.warp import transform_geom

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
zones_path = params["zones_path"]
band = int(params.get("band", 1))
# Optional prefix so stats don't clobber existing zone attributes named e.g.
# 'mean'. Empty by default to match QGIS's bare 'min'/'max'/... fields.
prefix = str(params.get("prefix", "") or "")

with open(zones_path) as f:
    gj = json.load(f)
gtype = gj.get("type")
if gtype == "FeatureCollection":
    feats = gj.get("features", [])
elif gtype == "Feature":
    feats = [gj]
else:
    feats = [{"type": "Feature", "properties": {}, "geometry": gj}]
if not feats:
    raise SystemExit("Zones layer has no features")

# Resolve the zones CRS: an explicit GeoJSON ``crs`` member if present, else the
# GeoJSON default of WGS84 (EPSG:4326).
zone_crs = CRS.from_epsg(4326)
crs_member = gj.get("crs")
if isinstance(crs_member, dict):
    name = str(crs_member.get("properties", {}).get("name", ""))
    # Prefer a full parse (handles OGC URNs, ``EPSG:NNNN``, WKT, PROJ strings)
    # so a descriptive name like "Custom Albers zone 2" isn't mis-read as EPSG:2
    # by the trailing-digit fallback.
    try:
        zone_crs = CRS.from_user_input(name)
    except Exception:
        digits = re.search(r"(\\d+)$", name)
        if digits:
            try:
                zone_crs = CRS.from_epsg(int(digits.group(1)))
            except Exception as exc:
                print(
                    f"Warning: could not parse zones CRS '{name}' "
                    f"({exc}); assuming WGS84 (EPSG:4326)",
                    file=sys.stderr,
                )
        elif name:
            # A non-empty name we could not interpret; an absent/blank name is
            # just a missing field, not a parse failure, so stay silent there.
            print(
                f"Warning: could not parse zones CRS '{name}'; "
                "assuming WGS84 (EPSG:4326)",
                file=sys.stderr,
            )

out_features = []
with_data = 0
with rasterio.open(input_path) as src:
    if src.crs is None:
        raise SystemExit(
            "Input raster has no CRS; zonal statistics requires a georeferenced raster."
        )
    if band < 1 or band > src.count:
        raise SystemExit(f"Band {band} out of range (raster has {src.count} band(s))")
    for feat in feats:
        geom = (feat or {}).get("geometry")
        props = dict((feat or {}).get("properties") or {})
        vals = np.array([], dtype="float64")
        if geom:
            shape = geom
            # rio_mask needs shapes in the raster's CRS; reproject when the zone
            # CRS differs so a WGS84 zone layer over a projected raster works.
            if zone_crs != src.crs:
                shape = transform_geom(zone_crs, src.crs, geom)
            try:
                # filled=False returns a masked array combining the dataset
                # nodata mask with the outside-geometry mask, so a missing
                # nodata value can't be mistaken for real data.
                out_img, _ = rio_mask(
                    src, [shape], crop=True, filled=False, indexes=band
                )
                arr = np.ma.filled(out_img.astype("float64"), np.nan)
                valid = (~np.ma.getmaskarray(out_img)) & np.isfinite(arr)
                vals = arr[valid]
            except (ValueError, RasterioError):
                # Geometry falls entirely outside the raster; report empty stats.
                vals = np.array([], dtype="float64")
        n = int(vals.size)
        if n:
            with_data += 1
            props[prefix + "count"] = n
            props[prefix + "min"] = float(vals.min())
            props[prefix + "max"] = float(vals.max())
            props[prefix + "mean"] = float(vals.mean())
            props[prefix + "sum"] = float(vals.sum())
            props[prefix + "std"] = float(vals.std())
            props[prefix + "median"] = float(np.median(vals))
        else:
            props[prefix + "count"] = 0
            for key in ("min", "max", "mean", "sum", "std", "median"):
                props[prefix + key] = None
        out_features.append(
            {"type": "Feature", "properties": props, "geometry": geom}
        )

fc = {"type": "FeatureCollection", "features": out_features}
zone_epsg = zone_crs.to_epsg()
if zone_epsg and zone_epsg != 4326:
    fc["crs"] = {
        "type": "name",
        "properties": {"name": f"urn:ogc:def:crs:EPSG::{zone_epsg}"},
    }
elif zone_epsg is None and zone_crs != CRS.from_epsg(4326):
    # A projected CRS with no EPSG mapping (e.g. custom WKT) would otherwise be
    # silently dropped, leaving consumers to assume WGS84; embed the WKT so the
    # true CRS travels with the output rather than being mislabeled.
    fc["crs"] = {"type": "name", "properties": {"name": zone_crs.to_wkt()}}
with open(output_path, "w") as f:
    json.dump(fc, f)
print(
    f"Computed zonal statistics for {len(out_features)} zone(s) "
    f"({with_data} with data) -> {output_path}"
)
print("{marker}" + json.dumps({"output_path": output_path}))
""".replace("{marker}", _RESULT_MARKER)


_RASTER_CALC_SCRIPT = """
import json, re, sys

import numpy as np
import rasterio

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
expression = str(params.get("expression", "") or "").strip()
if not expression:
    raise SystemExit("Expression is required")
# Dunder access (e.g. ``A.__class__.__bases__[0].__subclasses__()``) is the
# standard way to break out of an ``eval`` with an emptied ``__builtins__``;
# rejecting it keeps band math from reaching arbitrary objects. This check is
# load-bearing alongside the empty ``__builtins__`` and the np-free namespace
# below: do not relax it (e.g. to allow a single ``_``) without replacing it.
if "__" in expression:
    raise SystemExit("Expression may not contain '__'")
b_path = str(params.get("b_path", "") or "").strip()
c_path = str(params.get("c_path", "") or "").strip()
nodata = -9999.0


def load_bands(path, letter, namespace, base):
    # ``base`` is None for raster A, else (shape, crs) of A to validate against.
    with rasterio.open(path) as ds:
        shape = (ds.height, ds.width)
        crs = ds.crs
        if base is not None:
            if shape != base[0]:
                raise SystemExit(
                    f"Raster {letter} ({ds.width}x{ds.height}) must match the "
                    f"dimensions of raster A ({base[0][1]}x{base[0][0]})."
                )
            # Identical dimensions over different CRSs would compute band math on
            # spatially unaligned pixels; reject rather than emit a silent
            # mismatch.
            if crs != base[1]:
                raise SystemExit(
                    f"Raster {letter} CRS ({crs}) does not match raster A "
                    f"({base[1]}); reproject before running the calculator."
                )
        bands = [
            np.ma.filled(ds.read(i, masked=True).astype("float64"), np.nan)
            for i in range(1, ds.count + 1)
        ]
        profile = ds.profile.copy()
    # ``A``/``B``/``C`` reference band 1; ``A1``, ``A2``, ... address each band.
    namespace[letter] = bands[0]
    for i, arr in enumerate(bands, start=1):
        namespace[f"{letter}{i}"] = arr
    return profile, shape, crs


namespace = {}
profile, base_shape, base_crs = load_bands(input_path, "A", namespace, None)
for letter, path in (("B", b_path), ("C", c_path)):
    if path:
        load_bands(path, letter, namespace, (base_shape, base_crs))
    # An expression that references B/C without a supplied path would otherwise
    # fail deep in eval with an opaque "name 'B' is not defined". Catch the
    # common case up front. The word-boundary match avoids false positives from
    # function names that merely contain the letter (e.g. 'abs' has no bare 'B').
    elif re.search(rf"(?<![A-Za-z0-9_]){letter}[0-9]*(?![A-Za-z0-9_])", expression):
        raise SystemExit(
            f"Expression references '{letter}' but no Raster {letter} path was provided."
        )

# Evaluate the expression in a restricted namespace: no builtins, only the band
# arrays and a curated set of NumPy functions. The sidecar is local and confined
# to the conversion roots, but stripping ``__builtins__`` still blocks arbitrary
# attribute/import access from a hand-typed expression. The bare ``np`` module is
# intentionally NOT exposed: it would re-open file I/O (np.load/fromfile/savetxt)
# that bypasses the path allowlist. Every function band math needs is listed here.
safe_funcs = {
    "where": np.where,
    "log": np.log,
    "log10": np.log10,
    "exp": np.exp,
    "sqrt": np.sqrt,
    "abs": np.abs,
    "sin": np.sin,
    "cos": np.cos,
    "tan": np.tan,
    "arctan": np.arctan,
    "minimum": np.minimum,
    "maximum": np.maximum,
    "clip": np.clip,
    "floor": np.floor,
    "ceil": np.ceil,
    "round": np.round,
    "pi": np.pi,
    "e": np.e,
}
namespace.update(safe_funcs)
try:
    with np.errstate(all="ignore"):
        result = eval(expression, {"__builtins__": {}}, namespace)
except SystemExit:
    raise
except Exception as exc:
    # A bare `A<n>` reference past the input's band count surfaces as an opaque
    # NameError; hint at the real cause (e.g. a spectral index whose band layout
    # exceeds the raster) instead of the raw "name 'A4' is not defined".
    band_ref = re.search(r"name '(A\\d+)' is not defined", str(exc))
    if band_ref:
        raise SystemExit(
            f"Expression references band {band_ref.group(1)}, which the input "
            "raster does not have. Check the band layout / sensor preset."
        )
    raise SystemExit(f"Failed to evaluate expression: {exc}")

result = np.asarray(result, dtype="float64")
if result.shape != base_shape:
    # A scalar or single-band broadcast result is fine; anything else is a
    # dimension mismatch the user must fix.
    try:
        result = np.broadcast_to(result, base_shape).astype("float64")
    except ValueError:
        raise SystemExit(
            f"Expression produced a {result.shape} array; expected {base_shape}."
        )

out = np.where(np.isfinite(result), result, nodata).astype("float32")
profile.update(count=1, dtype="float32", nodata=nodata, compress="deflate")
# Drop multiband photometric hints carried over from a multiband input A.
profile.pop("photometric", None)
with rasterio.open(output_path, "w", **profile) as dst:
    dst.write(out, 1)
print(f"Evaluated '{expression}' -> {output_path}")
print("{marker}" + json.dumps({"output_path": output_path}))
""".replace("{marker}", _RESULT_MARKER)


_RECLASSIFY_SCRIPT = """
import json, re, sys

import numpy as np
import rasterio

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
band = int(params.get("band", 1))
table = str(params.get("table", "") or "").strip()
if not table:
    raise SystemExit("Reclassification table is required")
# What to do with values matching no rule: emit nodata (default) or keep the
# original value untouched.
unmatched = str(params.get("unmatched", "nodata")).lower()
nodata = -9999.0

rules = []
for token in re.split(r"[,;\\n]+", table):
    token = token.strip()
    if not token:
        continue
    parts = token.split(":")
    if len(parts) != 3:
        raise SystemExit(
            f"Bad rule '{token}'. Use 'min:max:newvalue' (e.g. '0:10:1')."
        )
    lo_raw, hi_raw, nv_raw = (p.strip() for p in parts)
    lo = -np.inf if lo_raw.lower() in ("", "min", "-inf") else float(lo_raw)
    hi = np.inf if hi_raw.lower() in ("", "max", "inf") else float(hi_raw)
    try:
        nv = float(nv_raw)
    except ValueError:
        raise SystemExit(f"Bad new value in rule '{token}'")
    rules.append((lo, hi, nv))
if not rules:
    raise SystemExit("No reclassification rules parsed")

with rasterio.open(input_path) as src:
    if band < 1 or band > src.count:
        raise SystemExit(f"Band {band} out of range (raster has {src.count} band(s))")
    arr = src.read(band, masked=True).astype("float64")
    profile = src.profile.copy()

data = np.ma.filled(arr, np.nan)
out = np.full(data.shape, np.nan, dtype="float64")
# Earlier rules win on overlap: apply in reverse so the first rule's assignment
# is written last and survives.
for lo, hi, nv in reversed(rules):
    # Half-open [lo, hi): a value equal to a class's upper bound belongs to the
    # next class, avoiding double assignment at shared edges.
    out[(data >= lo) & (data < hi)] = nv
if unmatched == "original":
    keep = np.isnan(out) & np.isfinite(data)
    out[keep] = data[keep]

result = np.where(np.isfinite(out), out, nodata).astype("float32")
profile.update(count=1, dtype="float32", nodata=nodata, compress="deflate")
profile.pop("photometric", None)
with rasterio.open(output_path, "w", **profile) as dst:
    dst.write(result, 1)
print(f"Reclassified band {band} with {len(rules)} rule(s) -> {output_path}")
print("{marker}" + json.dumps({"output_path": output_path}))
""".replace("{marker}", _RESULT_MARKER)


_MOSAIC_SCRIPT = """
import json, sys

import rasterio
from rasterio.merge import merge

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
method = str(params.get("method", "first")).lower()
allowed = {"first", "last", "min", "max"}
if method not in allowed:
    raise SystemExit(f"Unsupported merge method: {method} (use {sorted(allowed)})")

paths = [input_path]
for key in ("raster_2", "raster_3", "raster_4", "raster_5"):
    extra = str(params.get(key, "") or "").strip()
    if extra:
        paths.append(extra)
if len(paths) < 2:
    raise SystemExit("Mosaic needs at least two rasters")

# Open inside the try so a failure on a later path still closes the handles
# opened before it (a list comprehension would raise before ``finally`` is set).
sources = []
try:
    for p in paths:
        sources.append(rasterio.open(p))
    base_crs = sources[0].crs
    if base_crs is None:
        raise SystemExit("First raster has no CRS; mosaic requires georeferenced inputs.")
    base_nodata = sources[0].nodata
    base_count = sources[0].count
    for s in sources[1:]:
        if s.crs != base_crs:
            raise SystemExit(
                "All rasters must share the same CRS; reproject them first."
            )
        if s.count != base_count:
            # merge would otherwise raise an opaque ValueError mid-run; give a
            # clear message (e.g. a 3-band RGB tile mixed with a 1-band DEM).
            raise SystemExit(
                f"All rasters must have the same band count; one has {s.count} "
                f"but the first has {base_count}."
            )
        if s.nodata != base_nodata:
            # merge masks each input by its own nodata, but the output header
            # carries only the first source's value; warn so a mixed-nodata
            # mosaic isn't silently mislabeled.
            print(
                f"Warning: inputs have different nodata values "
                f"({base_nodata} vs {s.nodata}); output nodata will be {base_nodata}."
            )
    mosaic, out_transform = merge(sources, method=method)
    profile = sources[0].profile.copy()
finally:
    for s in sources:
        s.close()

profile.update(
    height=mosaic.shape[1],
    width=mosaic.shape[2],
    transform=out_transform,
    compress="deflate",
)
with rasterio.open(output_path, "w", **profile) as dst:
    dst.write(mosaic)
print(f"Merged {len(paths)} rasters (method={method}) -> {output_path}")
print("{marker}" + json.dumps({"output_path": output_path}))
""".replace("{marker}", _RESULT_MARKER)


_FOCAL_SCRIPT = """
import json, sys

import numpy as np
import rasterio

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
band = int(params.get("band", 1))
size = int(params.get("size", 3))
if size < 3 or size % 2 == 0:
    raise SystemExit("Window size must be an odd integer >= 3")
if size > 25:
    raise SystemExit("Window size is capped at 25")
stat = str(params.get("statistic", "mean")).lower()
allowed = {"mean", "median", "min", "max", "sum", "std", "range"}
if stat not in allowed:
    raise SystemExit(f"Unsupported statistic: {stat}")
nodata = -9999.0

with rasterio.open(input_path) as src:
    if band < 1 or band > src.count:
        raise SystemExit(f"Band {band} out of range (raster has {src.count} band(s))")
    data = np.ma.filled(src.read(band, masked=True).astype("float32"), np.nan)
    profile = src.profile.copy()

height, width = data.shape
radius = size // 2


def neighbor(dy, dx):
    # ``out[i, j] = data[i + dy, j + dx]`` with out-of-bounds neighbours set to
    # NaN (so edge windows aggregate only the cells that exist).
    out = np.roll(np.roll(data, -dy, axis=0), -dx, axis=1)
    if dy > 0:
        out[-dy:, :] = np.nan
    elif dy < 0:
        out[:-dy, :] = np.nan
    if dx > 0:
        out[:, -dx:] = np.nan
    elif dx < 0:
        out[:, :-dx] = np.nan
    return out


offsets = [
    (dy, dx)
    for dy in range(-radius, radius + 1)
    for dx in range(-radius, radius + 1)
]

with np.errstate(all="ignore"):
    if stat == "median":
        # Median has no streaming form, so it stacks the neighbour copies
        # (size*size float32 layers). Cap the stack at ~480 MB so it can't OOM
        # the runtime; the streaming statistics below have no such limit.
        MAX_MEDIAN_CELLS = 120_000_000
        max_pixels = MAX_MEDIAN_CELLS // (size * size)
        if height * width > max_pixels:
            side = int(max_pixels**0.5)
            raise SystemExit(
                f"Focal median with a {size}x{size} window is limited to "
                f"{max_pixels:,} pixels (~{side}x{side}); this raster is "
                f"{width}x{height}. Use a smaller window, crop the raster, or pick "
                "a streaming statistic (mean/min/max/sum/std/range)."
            )
        stack = np.stack([neighbor(dy, dx) for dy, dx in offsets], axis=0)
        res = np.nanmedian(stack, axis=0)
        has_data = np.sum(np.isfinite(stack), axis=0) > 0
    else:
        # Streaming accumulators keep memory at O(cells) regardless of window
        # size, so this scales to full-resolution rasters with large windows.
        count = np.zeros((height, width), dtype="int32")
        total = np.zeros((height, width), dtype="float64")
        sumsq = np.zeros((height, width), dtype="float64")
        vmin = np.full((height, width), np.inf, dtype="float64")
        vmax = np.full((height, width), -np.inf, dtype="float64")
        for dy, dx in offsets:
            nb = neighbor(dy, dx)
            valid = np.isfinite(nb)
            count += valid
            contrib = np.where(valid, nb, 0.0)
            total += contrib
            sumsq += contrib * contrib
            vmin = np.fmin(vmin, nb)
            vmax = np.fmax(vmax, nb)
        has_data = count > 0
        safe_count = np.where(count == 0, 1, count)
        if stat == "mean":
            res = total / safe_count
        elif stat == "sum":
            res = total
        elif stat == "min":
            res = vmin
        elif stat == "max":
            res = vmax
        elif stat == "range":
            res = vmax - vmin
        else:  # std (population)
            mean_ = total / safe_count
            res = np.sqrt(np.maximum(sumsq / safe_count - mean_ * mean_, 0.0))

# Windows with no valid cells get nodata uniformly (rather than 0 or inf).
res = np.where(has_data, res, np.nan)
out = np.where(np.isfinite(res), res, nodata).astype("float32")
profile.update(count=1, dtype="float32", nodata=nodata, compress="deflate")
profile.pop("photometric", None)
with rasterio.open(output_path, "w", **profile) as dst:
    dst.write(out, 1)
print(f"Focal {stat} ({size}x{size}) -> {output_path}")
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
    "zonal": _ZONAL_STATS_SCRIPT,
    "raster-calc": _RASTER_CALC_SCRIPT,
    # The Spectral Index tool compiles to a band-math expression on the client
    # and reuses the raster calculator to evaluate it over the input's bands.
    "spectral-index": _RASTER_CALC_SCRIPT,
    "reclassify": _RECLASSIFY_SCRIPT,
    "mosaic": _MOSAIC_SCRIPT,
    "focal": _FOCAL_SCRIPT,
}

# Output kind per tool, used only as the key under ``JobState.outputs``.
_OUTPUT_NAMES: dict[str, str] = {
    "polygonize": "vector",
    "contour": "vector",
    "zonal": "vector",
}

_GEOJSON_EXTS = {".geojson", ".json"}
_GEOTIFF_EXTS = {".tif", ".tiff"}

# Secondary file-path parameters per tool, validated (path + allowlist +
# extension) before the job starts. Each entry is
# ``(param_name, label, allowed_extensions, required)``; an empty optional value
# is passed through to the script as ``""``.
_EXTRA_INPUTS: dict[str, list[tuple[str, str, set[str], bool]]] = {
    "clip-mask": [("mask_path", "Mask layer", _GEOJSON_EXTS, True)],
    "zonal": [("zones_path", "Zones layer", _GEOJSON_EXTS, True)],
    "raster-calc": [
        ("b_path", "Raster B", _GEOTIFF_EXTS, False),
        ("c_path", "Raster C", _GEOTIFF_EXTS, False),
    ],
    # Spectral index is single-input in the UI (the compiled expression only
    # references A<n> bands), but it reuses _RASTER_CALC_SCRIPT, which opens
    # b_path/c_path whenever they are present in the request. These entries are a
    # defense-in-depth guard: a hand-crafted request to the local sidecar that
    # smuggles in b_path/c_path still has those paths checked against the
    # allowlist/extensions, rather than opened unvalidated. Not multi-raster.
    "spectral-index": [
        ("b_path", "Raster B", _GEOTIFF_EXTS, False),
        ("c_path", "Raster C", _GEOTIFF_EXTS, False),
    ],
    "mosaic": [
        ("raster_2", "Second raster", _GEOTIFF_EXTS, True),
        ("raster_3", "Third raster", _GEOTIFF_EXTS, False),
        ("raster_4", "Fourth raster", _GEOTIFF_EXTS, False),
        ("raster_5", "Fifth raster", _GEOTIFF_EXTS, False),
    ],
}


def _validate_extra_input(path: str, label: str, allowed_extensions: set[str] | None = None) -> str:
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
            detail=(f"{label} must be one of {sorted(allowed_extensions)}, got '{source.suffix}'"),
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
            f"{python_executable}: import timed out after {RUNTIME_DISCOVERY_TIMEOUT_SECS} seconds"
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
        raise HTTPException(status_code=400, detail=f"Unknown raster tool: {request.tool_id}")

    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    params: dict[str, Any] = {
        **request.parameters,
        "input_path": input_path,
        "output_path": output_path,
    }

    # Validate any secondary file-path parameters (clip mask, zonal zones,
    # raster-calc operands, mosaic inputs) against the path allowlist and the
    # expected extension. An empty optional value is passed through as "".
    for name, label, exts, required in _EXTRA_INPUTS.get(request.tool_id, []):
        raw = str(request.parameters.get(name, "") or "").strip()
        if not raw:
            if required:
                raise HTTPException(status_code=400, detail=f"{label} is required")
            params[name] = ""
            continue
        params[name] = _validate_extra_input(raw, label, allowed_extensions=exts)

    # Interpolation reads a point GeoJSON (every other raster tool takes a
    # GeoTIFF). Reject a non-JSON primary input here with a clear 400 instead of
    # letting json.load fail with an opaque JSONDecodeError inside the job.
    if request.tool_id == "interpolate" and Path(input_path).suffix.lower() not in {
        ".geojson",
        ".json",
    }:
        raise HTTPException(
            status_code=400,
            detail="Interpolation input must be a GeoJSON (.geojson/.json) file",
        )

    output_name = _OUTPUT_NAMES.get(request.tool_id, "raster")
    return _start_job(request.tool_id, script, params, output_name)
