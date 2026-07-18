"""Format conversion sidecar endpoints (GeoParquet and Cloud Optimized GeoTIFF)."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .runtime import (
    RUNTIME_DISCOVERY_TIMEOUT_SECS,
    RUNTIME_SETUP_TIMEOUT_SECS,
    JobState,
    RuntimeBootstrapError,
    _clean_env,
    _runtime_cache_root,
    _runtime_setup_env,
    _subprocess_startup_kwargs,
    _utc_now,
    _uv_executable,
    _venv_python,
)

router = APIRouter(prefix="/conversion", tags=["conversion"])
logger = logging.getLogger(__name__)

CONVERSION_RUN_TIMEOUT_SECS = 3600
CONVERSION_PYTHON_VERSION = os.environ.get("GEOLIBRE_CONVERSION_PYTHON_VERSION", "3.12")
# Whitespace-separated so a single requirement may carry a comma-joined version
# range (e.g. "duckdb>=1.1.0,<2.0.0") without being split into two tokens.
# rasterio + numpy already arrive transitively via rio-cogeo; they are listed
# explicitly so the Raster processing tools' dependency is intentional, and
# contourpy is added for the Contour tool.
CONVERSION_RUNTIME_PACKAGES = os.environ.get(
    "GEOLIBRE_CONVERSION_PACKAGES",
    "duckdb>=1.1.0 rio-cogeo>=5.0.0 freestiler>=0.1.0 rasterio>=1.3.0 numpy>=1.24 contourpy>=1.2.0",
).split()

VECTOR_COMPRESSIONS = {"zstd", "snappy", "gzip", "lz4", "uncompressed"}
DEFAULT_VECTOR_COMPRESSION = "zstd"
DEFAULT_ROW_GROUP_SIZE = 30000

# Output extensions written through DuckDB's native Parquet writer (FORMAT
# PARQUET) rather than a GDAL driver.
PARQUET_OUTPUT_EXTENSIONS = {"parquet", "geoparquet"}

# Map an output file extension to the canonical GDAL driver that writes it. The
# *set* of usable drivers is not hardcoded here: the conversion script validates
# the chosen driver against ``ST_Drivers()`` at runtime, so whatever the
# installed DuckDB spatial build can create is supported. This map only resolves
# an extension to its driver name, since extensions and driver names differ.
VECTOR_OUTPUT_DRIVERS = {
    "geojson": "GeoJSON",
    "json": "GeoJSON",
    "geojsonl": "GeoJSONSeq",
    "geojsons": "GeoJSONSeq",
    "ndjson": "GeoJSONSeq",
    "fgb": "FlatGeobuf",
    "gpkg": "GPKG",
    "shp": "ESRI Shapefile",
    "zip": "ESRI Shapefile",
    "gml": "GML",
    "kml": "KML",
    "csv": "CSV",
    "sqlite": "SQLite",
    "db": "SQLite",
    "gmt": "OGR_GMT",
    "dxf": "DXF",
    "tab": "MapInfo File",
    "mif": "MapInfo File",
    "jml": "JML",
    "gpx": "GPX",
    # NOTE: directory-based formats (e.g. FileGDB `.gdb/`) are intentionally
    # excluded — `_validate_paths` treats inputs/outputs as files, and the
    # failure cleanup unlinks a single file, so a `.gdb` directory would break
    # both validation and cleanup. They need dedicated directory handling.
}


def _output_extension(path: str) -> str:
    """Return the lowercased file extension (without the dot) of a path."""
    name = Path(path).name
    index = name.rfind(".")
    return name[index + 1 :].lower() if index >= 0 else ""


COG_COMPRESSIONS = {"deflate", "zstd", "lzw", "webp", "jpeg", "packbits", "raw"}
DEFAULT_COG_COMPRESSION = "deflate"

_RESULT_MARKER = "__GEOLIBRE_CONVERSION_RESULT__"

# Single source of truth for the Shapefile field-warning helper. Each conversion
# script is a self-contained subprocess source string and cannot import from the
# module, so this definition is interpolated into both _VECTOR_SCRIPT and
# _VECTOR_TO_VECTOR_SCRIPT via the `{shapefile_field_warnings}` token (the
# scripts use `.replace`, not f-strings, so the literal `{}` inside are safe).
_SHAPEFILE_FIELD_WARNINGS_FN = """
def shapefile_field_warnings(column_names):
    # The Shapefile format caps field names at 10 characters and silently
    # truncates longer ones, which can also collapse distinct fields into one
    # name. Surface both so attribute renames/merges on write are not a surprise.
    long_names = [name for name in column_names if len(name) > 10]
    messages = []
    if long_names:
        messages.append(
            "Shapefile truncates field names to 10 characters: "
            + ", ".join(long_names)
        )
    truncated = {}
    for name in column_names:
        truncated.setdefault(name[:10].lower(), []).append(name)
    collisions = [group for group in truncated.values() if len(group) > 1]
    if collisions:
        messages.append(
            "Truncating to 10 characters produces duplicate field names: "
            + "; ".join(", ".join(group) for group in collisions)
        )
    return messages
"""

# Optional allowlist of directories that conversion inputs/outputs must live
# under, set via GEOLIBRE_CONVERSION_ROOTS (os.pathsep-separated). Unset means
# no restriction (the default for the desktop app, where paths are the user's
# own filesystem). The bundled Docker image sets this so the sidecar — which is
# reachable same-origin through the nginx proxy — cannot read or overwrite
# arbitrary container paths.
_CONVERSION_ROOTS = [
    str(Path(root).expanduser().resolve())
    for root in os.environ.get("GEOLIBRE_CONVERSION_ROOTS", "").split(os.pathsep)
    if root.strip()
]

_JOBS: dict[str, JobState] = {}
_JOBS_LOCK = threading.Lock()
_RUNTIME_SETUP_LOCK = threading.Lock()
MAX_RETAINED_JOBS = 100


class VectorToVectorRequest(BaseModel):
    """Request body for a generic vector-to-vector conversion.

    The input and output formats are inferred from the file extensions, so a
    single endpoint covers every vector format DuckDB's spatial extension can
    read and write — no per-format request type or hardcoded format list.

    ``input_layer`` selects one layer of a multi-layer dataset (a File
    Geodatabase or GeoPackage); ``target_srs`` reprojects the geometry to the
    given CRS (e.g. ``EPSG:4326``) before writing. ``source_srs`` declares the
    CRS to reproject *from* when set, overriding (or standing in for) the CRS
    the dataset itself declares — for layers whose spatial reference GDAL
    cannot resolve to an authority code.
    """

    input_path: str
    output_path: str
    input_layer: str | None = None
    target_srs: str | None = None
    source_srs: str | None = None


class VectorLayersRequest(BaseModel):
    """Request body for listing the layers of a multi-layer vector dataset."""

    input_path: str


class VectorToGeoParquetRequest(BaseModel):
    """Request body for a vector to GeoParquet conversion."""

    input_path: str
    output_path: str
    compression: str = DEFAULT_VECTOR_COMPRESSION
    row_group_size: int = DEFAULT_ROW_GROUP_SIZE


class VectorToFlatGeobufRequest(BaseModel):
    """Request body for a vector to FlatGeobuf conversion."""

    input_path: str
    output_path: str


class VectorToShapefileRequest(BaseModel):
    """Request body for a vector to zipped Shapefile conversion."""

    input_path: str
    output_path: str


class VectorToGeoPackageRequest(BaseModel):
    """Request body for a vector to GeoPackage conversion."""

    input_path: str
    output_path: str


class CsvToGeoParquetRequest(BaseModel):
    """Request body for a CSV (with lon/lat columns) to GeoParquet conversion."""

    input_path: str
    output_path: str
    lon_column: str
    lat_column: str
    compression: str = DEFAULT_VECTOR_COMPRESSION
    row_group_size: int = DEFAULT_ROW_GROUP_SIZE


class VectorToPmtilesRequest(BaseModel):
    """Request body for a vector to PMTiles conversion."""

    input_path: str
    output_path: str
    layer_name: str = "data"
    min_zoom: int = 0
    max_zoom: int = 14


class RasterToCogRequest(BaseModel):
    """Request body for a raster to Cloud Optimized GeoTIFF conversion."""

    input_path: str
    output_path: str
    compression: str = DEFAULT_COG_COMPRESSION


# Hilbert-sorting the rows before writing produces spatially clustered output
# (row groups for Parquet, the packed R-tree for FlatGeobuf) so range requests
# stay local. The geometry column is rebuilt from WKB or from CSV lon/lat
# columns when needed so ST_Hilbert and the writer both receive a GEOMETRY
# column. `output_format` selects the Parquet or FlatGeobuf writer.
_VECTOR_SCRIPT = """
import glob, json, os, shutil, sys, tempfile, zipfile

import duckdb

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
output_format = params.get("output_format", "parquet")
source_kind = params.get("source_kind", "auto")
compression = params.get("compression", "zstd")
row_group_size = int(params.get("row_group_size", 30000))

def quote(value):
    return "'" + str(value).replace("'", "''") + "'"

def quote_ident(value):
    return '"' + str(value).replace('"', '""') + '"'

con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial;")

if source_kind == "csv":
    lon = params["lon_column"]
    lat = params["lat_column"]
    relation = f"read_csv_auto({quote(input_path)}, header=true)"
    geometry_column = "geometry"
    quoted_geometry = quote_ident(geometry_column)
    point = (
        f"ST_Point(CAST({quote_ident(lon)} AS DOUBLE), "
        f"CAST({quote_ident(lat)} AS DOUBLE))"
    )
    source = f"SELECT *, {point} AS {quoted_geometry} FROM {relation}"
    # CSV lon/lat are WGS84. DuckDB has no ST_SetSRID, but the GeoParquet spec
    # treats an absent CRS as OGC:CRS84 (WGS84 lon/lat), so the Parquet output
    # is correct. output_srs only tags the FlatGeobuf writer below.
    output_srs = "EPSG:4326"
else:
    if input_path.lower().endswith((".parquet", ".geoparquet")):
        relation = f"read_parquet({quote(input_path)})"
    else:
        relation = f"ST_Read({quote(input_path)})"

    columns = con.execute(f"DESCRIBE SELECT * FROM {relation}").fetchall()
    # DuckDB Spatial reports CRS-annotated geometry types such as
    # GEOMETRY('EPSG:4326'), so match on the prefix rather than equality.
    def is_geometry_type(column_type):
        return str(column_type).upper().startswith("GEOMETRY")

    geometry_column = None
    geometry_is_native = True
    for name, column_type, *_ in columns:
        if is_geometry_type(column_type):
            geometry_column = name
            break
    if geometry_column is None:
        # Plain Parquet may carry geometry as a WKB blob; rebuild it as GEOMETRY.
        for name, column_type, *_ in columns:
            if name.lower() in {"geometry", "geom", "wkb_geometry"}:
                geometry_column, geometry_is_native = name, False
                break
    if geometry_column is None:
        raise SystemExit("No geometry column found in the input dataset.")

    quoted_geometry = quote_ident(geometry_column)
    if geometry_is_native:
        source = f"SELECT * FROM {relation}"
    else:
        source = (
            f"SELECT * REPLACE (ST_GeomFromWKB({quoted_geometry}) AS {quoted_geometry}) "
            f"FROM {relation}"
        )
    # GeoJSON is WGS84 by spec (RFC 7946) but carries no CRS on the GEOMETRY
    # column, so a GDAL writer would emit no .prj/SRS; tag it explicitly. Other
    # formats keep the CRS embedded in their geometry and need no override.
    if input_path.lower().endswith((".geojson", ".json")):
        output_srs = "EPSG:4326"
    else:
        output_srs = None

# GDAL-backed writers share a single COPY path; the SRS clause tags the output
# CRS (CSV lon/lat are WGS84; other sources keep the geometry's embedded CRS).
GDAL_DRIVERS = {
    "flatgeobuf": "FlatGeobuf",
    "geopackage": "GPKG",
    "shapefile": "ESRI Shapefile",
}

{shapefile_field_warnings}

if output_format in GDAL_DRIVERS:
    srs_clause = f", SRS {quote(output_srs)}" if output_srs else ""
    to_clause = f"(FORMAT GDAL, DRIVER '{GDAL_DRIVERS[output_format]}'{srs_clause})"
else:
    to_clause = (
        f"(FORMAT PARQUET, COMPRESSION {quote(compression)}, "
        f"ROW_GROUP_SIZE {row_group_size})"
    )

warnings = []
tmp_dir = None
if output_format == "shapefile":
    # source_kind for shapefile output is always "auto", so `columns` (from the
    # DESCRIBE above) is defined here.
    warnings = shapefile_field_warnings(
        [name for name, *_ in columns if name != geometry_column]
    )
    for message in warnings:
        print(f"Warning: {message}")
    # The Shapefile driver writes a .shp plus .shx/.dbf/.prj/.cpg sidecars, so
    # write into a temp directory and zip them into the requested output path.
    tmp_dir = tempfile.mkdtemp(prefix="geolibre-shapefile-")
    stem = os.path.splitext(os.path.basename(output_path))[0] or "layer"
    copy_target = os.path.join(tmp_dir, stem + ".shp")
else:
    copy_target = output_path

print(f"Converting {input_path} -> {output_path} ({output_format})")

try:
    # COPY returns the number of rows written, so the feature count comes for
    # free rather than costing a second full scan of the dataset.
    copy_result = con.execute(
        f\"\"\"
        COPY (
          WITH src AS ({source}),
          b AS (SELECT ST_Extent(ST_Extent_Agg({quoted_geometry})) AS box FROM src)
          SELECT * FROM src
          ORDER BY ST_Hilbert({quoted_geometry}, (SELECT box FROM b))
        ) TO {quote(copy_target)} {to_clause};
        \"\"\"
    ).fetchone()
    count = copy_result[0] if copy_result else None
    if output_format == "shapefile":
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for sidecar in sorted(glob.glob(os.path.join(tmp_dir, stem + ".*"))):
                archive.write(sidecar, os.path.basename(sidecar))
finally:
    if tmp_dir:
        shutil.rmtree(tmp_dir, ignore_errors=True)

print(f"Wrote {count} Hilbert-sorted features to {output_path}")
print(
    "{marker}"
    + json.dumps(
        {
            "feature_count": count,
            "geometry_column": geometry_column,
            "output_path": output_path,
            "warnings": warnings,
        }
    )
)
""".replace("{shapefile_field_warnings}", _SHAPEFILE_FIELD_WARNINGS_FN).replace(
    "{marker}", _RESULT_MARKER
)


# Generic vector-to-vector conversion. The input format is detected by ST_Read
# (or read_parquet) and the output format is whatever GDAL driver the caller
# resolved from the output extension. The driver is validated against
# ST_Drivers() so the supported set is exactly what this DuckDB spatial build
# can create, not a hardcoded list. Rows are Hilbert-sorted before writing for
# spatial locality, mirroring _VECTOR_SCRIPT.
_VECTOR_TO_VECTOR_SCRIPT = """
import glob, json, os, re, shutil, sys, tempfile, zipfile

import duckdb

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
output_kind = params["output_kind"]  # "parquet" or "gdal"
output_driver = params.get("output_driver", "")
zip_shapefile = bool(params.get("zip_shapefile", False))
input_layer = params.get("input_layer") or None
target_srs = params.get("target_srs") or None
source_srs_override = params.get("source_srs") or None

def quote(value):
    return "'" + str(value).replace("'", "''") + "'"

def quote_ident(value):
    return '"' + str(value).replace('"', '""') + '"'

{shapefile_field_warnings}

con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial;")

# Confirm the requested driver can actually be created by this spatial build so
# an unsupported format fails with a clear, listed error instead of a raw GDAL
# message. read_parquet output skips this (it is not a GDAL driver).
if output_kind == "gdal":
    creatable = {
        row[0]
        for row in con.execute(
            "SELECT short_name FROM ST_Drivers() WHERE can_create"
        ).fetchall()
    }
    if output_driver not in creatable:
        raise SystemExit(
            f"DuckDB spatial cannot write the '{output_driver}' driver in this "
            f"build. Creatable drivers: {', '.join(sorted(creatable))}"
        )

low = input_path.lower()
layer_arg = f", layer={quote(input_layer)}" if input_layer else ""
if low.endswith((".parquet", ".geoparquet")):
    relation = f"read_parquet({quote(input_path)})"
elif low.endswith(".zip"):
    # A zipped vector dataset (a zipped Shapefile or File Geodatabase) is read
    # through GDAL's /vsizip/ virtual filesystem; a bare path fails to open.
    relation = f"ST_Read({quote('/vsizip/' + input_path)}{layer_arg})"
else:
    # A bare path covers single files and directory datasets (a .gdb folder);
    # GDAL detects the format either way.
    relation = f"ST_Read({quote(input_path)}{layer_arg})"

columns = con.execute(f"DESCRIBE SELECT * FROM {relation}").fetchall()

def is_geometry_type(column_type):
    return str(column_type).upper().startswith("GEOMETRY")

geometry_column = None
geometry_is_native = True
for name, column_type, *_ in columns:
    if is_geometry_type(column_type):
        geometry_column = name
        break
if geometry_column is None:
    # Plain Parquet may carry geometry as a WKB blob; rebuild it as GEOMETRY.
    for name, column_type, *_ in columns:
        if name.lower() in {"geometry", "geom", "wkb_geometry"}:
            geometry_column, geometry_is_native = name, False
            break
if geometry_column is None:
    raise SystemExit("No geometry column found in the input dataset.")

quoted_geometry = quote_ident(geometry_column)
geometry_expr = quoted_geometry
if not geometry_is_native:
    geometry_expr = f"ST_GeomFromWKB({geometry_expr})"

is_geojson_input = low.endswith(
    (".geojson", ".json", ".geojsonl", ".geojsons", ".ndjson")
)

if target_srs:
    # An explicit source_srs wins; otherwise DuckDB spatial annotates the
    # geometry's CRS in its DESCRIBE type, e.g. GEOMETRY('EPSG:4326') — that
    # is the only place the dataset's own CRS is exposed.
    source_srs = source_srs_override
    if source_srs is None:
        for name, column_type, *_ in columns:
            if name == geometry_column:
                match = re.search(r"GEOMETRY\\('([^']+)'\\)", str(column_type))
                if match:
                    source_srs = match.group(1)
                break
    if source_srs is None and is_geojson_input:
        # GeoJSON carries no CRS annotation but is WGS84 by spec (RFC 7946).
        source_srs = "EPSG:4326"
    if source_srs is None and input_layer and not low.endswith((".parquet", ".geoparquet")):
        # Last resort: GDAL's layer metadata. The DESCRIBE annotation and
        # st_read_meta's geometry_fields[].crs are two different surfaces, and
        # the layer-listing endpoint resolves CRS from the latter — falling
        # back to the same surface here keeps the two paths agreeing on
        # whether a layer's CRS is resolvable. Only attempted for an explicit
        # layer (exact name match); a metadata failure just leaves the clear
        # error below.
        if low.endswith(".zip"):
            meta_target = "/vsizip/" + input_path
        elif os.path.isdir(input_path):
            # Forward-slash join (not os.path.join): GDAL/DuckDB accept "/" on
            # every platform, while a backslash-joined glob is untested on a
            # Windows sidecar.
            meta_target = input_path.replace("\\\\", "/") + "/*.gdbtable"
        else:
            meta_target = input_path
        try:
            for (layer_list,) in con.execute(
                f"SELECT layers FROM st_read_meta({quote(meta_target)})"
            ).fetchall():
                for meta_layer in layer_list or []:
                    if meta_layer.get("name") != input_layer:
                        continue
                    fields = meta_layer.get("geometry_fields") or []
                    crs = (fields[0].get("crs") or {}) if fields else {}
                    auth_name = crs.get("auth_name")
                    auth_code = crs.get("auth_code")
                    if auth_name and auth_code:
                        source_srs = f"{auth_name}:{auth_code}"
                    break
        except Exception:
            pass
    if source_srs is None:
        raise SystemExit(
            "Cannot reproject: the input dataset does not declare a CRS."
        )
    if source_srs != target_srs:
        geometry_expr = (
            f"ST_Transform({geometry_expr}, {quote(source_srs)}, "
            f"{quote(target_srs)}, always_xy := true)"
        )

if geometry_expr == quoted_geometry:
    source = f"SELECT * FROM {relation}"
else:
    source = (
        f"SELECT * REPLACE ({geometry_expr} AS {quoted_geometry}) "
        f"FROM {relation}"
    )

# When reprojecting, tag the output with the requested CRS. Otherwise GeoJSON /
# GeoJSONSeq inputs are WGS84 by spec (RFC 7946) but carry no CRS on the
# GEOMETRY column, so a GDAL writer would emit no .prj/SRS; tag them explicitly.
# Parquet is NOT always WGS84 (GeoParquet embeds its own CRS, e.g. a projected
# dataset), so it is left untagged like every other input and the GDAL writer
# uses whatever CRS the geometry carries rather than a hardcoded one.
if target_srs:
    output_srs = target_srs
elif is_geojson_input:
    output_srs = "EPSG:4326"
else:
    output_srs = None

if output_kind == "parquet":
    to_clause = "(FORMAT PARQUET, COMPRESSION 'zstd', ROW_GROUP_SIZE 30000)"
else:
    srs_clause = f", SRS {quote(output_srs)}" if output_srs else ""
    # The CSV driver drops geometry unless told how to write it; emit it as a
    # WKT column so the conversion is lossless rather than failing with
    # "Could not set geometry".
    lco = (
        ", LAYER_CREATION_OPTIONS 'GEOMETRY=AS_WKT'"
        if output_driver == "CSV"
        else ""
    )
    to_clause = f"(FORMAT GDAL, DRIVER {quote(output_driver)}{srs_clause}{lco})"

# Surface Shapefile field-name truncation for any Shapefile output (bare .shp or
# zipped .zip), where GDAL silently caps field names at 10 characters.
warnings = []
if output_driver == "ESRI Shapefile":
    warnings = shapefile_field_warnings(
        [name for name, *_ in columns if name != geometry_column]
    )
    for message in warnings:
        print(f"Warning: {message}")

tmp_dir = None
is_shapefile = output_driver == "ESRI Shapefile"
if is_shapefile:
    # The Shapefile driver writes a .shp plus .shx/.dbf/.prj/.cpg sidecars. Write
    # the whole set into a temp directory first so a mid-write failure leaves
    # nothing behind in the user's directory (the outer cleanup only unlinks
    # output_path, not the sidecars). On success the bundle is zipped into
    # output_path (.zip) or moved next to it (.shp).
    tmp_dir = tempfile.mkdtemp(prefix="geolibre-shapefile-")
    stem = os.path.splitext(os.path.basename(output_path))[0] or "layer"
    copy_target = os.path.join(tmp_dir, stem + ".shp")
else:
    copy_target = output_path

print(f"Converting {input_path} -> {output_path} ({output_driver or 'Parquet'})")

try:
    # COPY returns the number of rows written, so the feature count comes for
    # free rather than costing a second full scan of the dataset.
    copy_result = con.execute(
        f\"\"\"
        COPY (
          WITH src AS ({source}),
          b AS (SELECT ST_Extent(ST_Extent_Agg({quoted_geometry})) AS box FROM src)
          SELECT * FROM src
          ORDER BY ST_Hilbert({quoted_geometry}, (SELECT box FROM b))
        ) TO {quote(copy_target)} {to_clause};
        \"\"\"
    ).fetchone()
    count = copy_result[0] if copy_result else None
    if is_shapefile:
        produced = sorted(glob.glob(os.path.join(tmp_dir, stem + ".*")))
        if zip_shapefile:
            with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as archive:
                for sidecar in produced:
                    archive.write(sidecar, os.path.basename(sidecar))
        else:
            # Move the .shp and every sidecar next to output_path, keeping the
            # output's basename stem. Only happens after a successful COPY, so a
            # failure never scatters partial sidecars in the user's directory.
            out_dir = os.path.dirname(output_path) or "."
            for sidecar in produced:
                ext = os.path.splitext(sidecar)[1]
                shutil.move(sidecar, os.path.join(out_dir, stem + ext))
finally:
    if tmp_dir:
        shutil.rmtree(tmp_dir, ignore_errors=True)

print(f"Wrote {count} Hilbert-sorted features to {output_path}")
print(
    "{marker}"
    + json.dumps(
        {
            "feature_count": count,
            "geometry_column": geometry_column,
            "output_path": output_path,
            "warnings": warnings,
        }
    )
)
""".replace("{shapefile_field_warnings}", _SHAPEFILE_FIELD_WARNINGS_FN).replace(
    "{marker}", _RESULT_MARKER
)


# List the layers of a multi-layer vector dataset (a File Geodatabase or
# GeoPackage) without reading any features, so the frontend can offer a layer
# picker before converting. GDB_* system tables are FileGDB's internal catalog;
# they are filtered out here because reading one through ST_Read crashes DuckDB
# spatial, so they must never be offered as a choice.
_VECTOR_LAYERS_SCRIPT = """
import json, os, sys

import duckdb

params = json.loads(sys.argv[1])
input_path = params["input_path"]

def quote(value):
    return "'" + str(value).replace("'", "''") + "'"

con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial;")

low = input_path.lower()
if low.endswith(".zip"):
    meta_target = "/vsizip/" + input_path
elif os.path.isdir(input_path):
    # st_read_meta globs for files and returns no rows for a bare directory
    # dataset, so a .gdb folder is enumerated per .gdbtable file instead; each
    # one reports the single layer it stores. Forward-slash join (not
    # os.path.join): GDAL/DuckDB accept "/" on every platform, while a
    # backslash-joined glob is untested on a Windows sidecar.
    meta_target = input_path.replace("\\\\", "/") + "/*.gdbtable"
else:
    meta_target = input_path

layers = []
seen = set()
# ORDER BY file_name: the glob's match order is not guaranteed, and without it
# the "first" layer of a per-file-enumerated .gdb could vary run to run.
for (layer_list,) in con.execute(
    f"SELECT layers FROM st_read_meta({quote(meta_target)}) ORDER BY file_name"
).fetchall():
    for layer in layer_list or []:
        name = layer.get("name")
        if not name or name in seen or name.startswith("GDB_"):
            continue
        seen.add(name)
        geometry_fields = layer.get("geometry_fields") or []
        first_geometry = geometry_fields[0] if geometry_fields else {}
        crs = first_geometry.get("crs") or {}
        auth_name = crs.get("auth_name")
        auth_code = crs.get("auth_code")
        layers.append(
            {
                "name": name,
                "feature_count": layer.get("feature_count"),
                "geometry_type": first_geometry.get("type"),
                "crs": f"{auth_name}:{auth_code}" if auth_name and auth_code else None,
            }
        )

print(f"Found {len(layers)} layer(s)")
print("{marker}" + json.dumps({"layers": layers}))
""".replace("{marker}", _RESULT_MARKER)


# Vector to PMTiles via freestiler (pip-installable Rust engine). The input is
# first materialized to a temporary GeoParquet through DuckDB so any vector
# format ST_Read understands is accepted, then freestiler tiles it.
_PMTILES_SCRIPT = """
import json, os, shutil, sys, tempfile, uuid

import duckdb
try:
    import freestiler
except ImportError:
    raise SystemExit(
        "freestiler is not installed. PMTiles tiling requires freestiler, "
        "which has no linux/arm64 wheel; it is available on amd64."
    )

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
layer_name = params.get("layer_name") or "data"
min_zoom = int(params.get("min_zoom", 0))
max_zoom = int(params.get("max_zoom", 14))

def quote(value):
    return "'" + str(value).replace("'", "''") + "'"

con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial;")

if input_path.lower().endswith((".parquet", ".geoparquet")):
    relation = f"read_parquet({quote(input_path)})"
else:
    relation = f"ST_Read({quote(input_path)})"

tmp_dir = tempfile.mkdtemp(prefix="geolibre-pmtiles-")
tmp_parquet = os.path.join(tmp_dir, uuid.uuid4().hex + ".parquet")
# try/finally so the temp dir is removed even if tiling raises or is killed.
try:
    print(f"Preparing {input_path} for tiling")
    con.execute(
        f"COPY (SELECT * FROM {relation}) TO {quote(tmp_parquet)} (FORMAT PARQUET)"
    )

    print(f"Tiling to PMTiles (z{min_zoom}-{max_zoom}) as layer {layer_name}")
    freestiler.freestile_file(
        tmp_parquet,
        output_path,
        layer_name=layer_name,
        min_zoom=min_zoom,
        max_zoom=max_zoom,
        quiet=True,
    )
finally:
    shutil.rmtree(tmp_dir, ignore_errors=True)

print(f"Wrote PMTiles to {output_path}")
print(
    "{marker}"
    + json.dumps({"output_path": output_path, "layer_name": layer_name})
)
""".replace("{marker}", _RESULT_MARKER)


_RASTER_SCRIPT = """
import json, sys

from rio_cogeo.cogeo import cog_translate, cog_validate
from rio_cogeo.profiles import cog_profiles

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
compression = params["compression"]

profile = cog_profiles.get(compression)
print(f"Converting {input_path} using the {compression} COG profile")
cog_translate(
    input_path,
    output_path,
    profile,
    in_memory=False,
    quiet=True,
    use_cog_driver=False,
)
valid, errors, warnings = cog_validate(output_path, quiet=True)
for message in warnings:
    print(f"Warning: {message}")
for message in errors:
    print(f"Error: {message}")
if not valid:
    raise SystemExit("Output failed COG validation: " + "; ".join(errors))
print(f"Wrote valid Cloud Optimized GeoTIFF to {output_path}")
print(
    "{marker}"
    + json.dumps({"valid": valid, "warnings": warnings, "output_path": output_path})
)
""".replace("{marker}", _RESULT_MARKER)


def _managed_runtime_dir() -> Path:
    """Return the managed conversion runtime environment directory."""
    configured = os.environ.get("GEOLIBRE_CONVERSION_ENV")
    if configured:
        return Path(configured).expanduser()
    return _runtime_cache_root() / "conversion-runtime"


def _check_runtime_import(python_executable: str) -> None:
    """Raise if a Python executable cannot import the core conversion stack.

    Only ``duckdb`` and ``rio_cogeo`` are required for the runtime to be
    "available" (both ship linux/arm64 wheels). ``freestiler`` powers PMTiles
    only and is checked when that job runs, so an arm64 container without it can
    still serve the GeoParquet/FlatGeobuf/COG conversions.
    """
    try:
        completed = subprocess.run(
            [python_executable, "-c", "import duckdb, rio_cogeo"],
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
            or "duckdb / rio-cogeo import failed"
        )
        raise RuntimeBootstrapError(f"{python_executable}: {detail}")


def _run_runtime_setup_command(command: list[str]) -> None:
    """Run a uv command used to create or update the conversion runtime."""
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_runtime_setup_env(),
        timeout=RUNTIME_SETUP_TIMEOUT_SECS,
        **_subprocess_startup_kwargs(),
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeBootstrapError(
            f"Conversion runtime setup failed while running {' '.join(command)}. {detail}"
        )


def _ensure_managed_runtime() -> str:
    """Create or update the managed conversion runtime and return its Python."""
    env_dir = _managed_runtime_dir()
    python = _venv_python(env_dir)
    with _RUNTIME_SETUP_LOCK:
        if python.exists():
            try:
                _check_runtime_import(str(python))
                return str(python)
            except RuntimeBootstrapError:
                pass

        uv = _uv_executable()
        env_dir.parent.mkdir(parents=True, exist_ok=True)
        if not python.exists():
            _run_runtime_setup_command(
                [uv, "venv", "--python", CONVERSION_PYTHON_VERSION, str(env_dir)]
            )
        _run_runtime_setup_command(
            [
                uv,
                "pip",
                "install",
                "--python",
                str(python),
                *CONVERSION_RUNTIME_PACKAGES,
            ]
        )
        _check_runtime_import(str(python))
        return str(python)


_CHECKED_RUNTIME_PYTHON: str | None = None
_CHECKED_RUNTIME_PYTHON_LOCK = threading.Lock()


def _runtime_python() -> str:
    """Return the Python executable used for conversions.

    The import check spawns a subprocess, so the verified interpreter is cached
    to avoid that cost on every status poll and job start. Double-checked
    locking keeps concurrent cold-start callers (FastAPI runs sync handlers in
    a thread pool) from each spawning that subprocess.
    """
    global _CHECKED_RUNTIME_PYTHON
    cached = _CHECKED_RUNTIME_PYTHON
    # Drop a cached interpreter whose file has since disappeared (e.g. the
    # managed venv was wiped) so the next call re-bootstraps cleanly.
    if cached is not None and os.path.isfile(cached):
        return cached
    with _CHECKED_RUNTIME_PYTHON_LOCK:
        cached = _CHECKED_RUNTIME_PYTHON
        if cached is not None and os.path.isfile(cached):
            return cached
        _CHECKED_RUNTIME_PYTHON = None
        configured = os.environ.get("GEOLIBRE_CONVERSION_PYTHON")
        if configured:
            resolved = str(Path(configured).expanduser())
            if os.path.isfile(resolved) and os.access(resolved, os.X_OK):
                _check_runtime_import(resolved)
                _CHECKED_RUNTIME_PYTHON = resolved
                return resolved
            raise RuntimeBootstrapError(
                f"Configured conversion Python is not executable: {configured}"
            )
        resolved = _ensure_managed_runtime()
        _CHECKED_RUNTIME_PYTHON = resolved
        return resolved


def _is_within_roots(path: Path) -> bool:
    """Return whether a resolved path lives under an allowlisted root.

    Uses ``Path.is_relative_to`` so filesystem roots (``/``, a Windows drive)
    work — naive ``startswith(root + sep)`` would produce ``//`` and reject
    valid descendants.
    """
    if not _CONVERSION_ROOTS:
        return True
    resolved = path.resolve()
    return any(
        resolved == Path(root) or resolved.is_relative_to(root) for root in _CONVERSION_ROOTS
    )


def _validate_input_path(input_path: str) -> str:
    """Validate a conversion input path and return it resolved.

    Accepts a regular file or an Esri File Geodatabase, which is a directory
    with a ``.gdb`` suffix rather than a single file. Other directories are
    rejected — no other supported input format is directory-based.
    """
    if not input_path.strip():
        raise HTTPException(status_code=400, detail="input_path is required")
    source = Path(input_path).expanduser()
    # When an allowlist is configured, confine reads to those roots so a
    # same-origin caller cannot probe arbitrary files. Checked BEFORE the
    # existence test so out-of-root paths always get the same 403 — a 400/403
    # split would otherwise leak whether a path outside the sandbox exists.
    if not _is_within_roots(source):
        raise HTTPException(
            status_code=403,
            detail="Path is outside the allowed conversion directories",
        )
    is_gdb_directory = source.is_dir() and source.suffix.lower() == ".gdb"
    if not source.is_file() and not is_gdb_directory:
        raise HTTPException(status_code=400, detail=f"Input file not found: {input_path}")
    return str(source.resolve())


def _validate_paths(input_path: str, output_path: str) -> tuple[str, str]:
    """Validate conversion input/output paths and return them normalized."""
    resolved_input = _validate_input_path(input_path)
    source = Path(resolved_input)
    if not output_path.strip():
        raise HTTPException(status_code=400, detail="output_path is required")
    target = Path(output_path).expanduser()
    # The input was already confined by _validate_input_path; the output (and
    # the failure-cleanup unlink) must live under the same allowlisted roots.
    # Checked BEFORE the existence test for the same reason as the input: a
    # 400/403 split would leak whether a directory outside the sandbox exists.
    if not _is_within_roots(target):
        raise HTTPException(
            status_code=403,
            detail="Path is outside the allowed conversion directories",
        )
    if not target.parent.is_dir():
        raise HTTPException(
            status_code=400,
            detail=f"Output folder does not exist: {target.parent}",
        )
    # Reading from and writing to the same file would truncate the input.
    if source.resolve() == target.resolve():
        raise HTTPException(
            status_code=400,
            detail="input_path and output_path must be different files",
        )
    # Return canonical paths so the subprocess and the failure-cleanup unlink
    # operate on the same resolved paths the allowlist check approved.
    return str(source.resolve()), str(target.resolve())


def _job_update(job_id: str, **patch: Any) -> None:
    """Update an in-memory conversion job."""
    with _JOBS_LOCK:
        job = _JOBS[job_id]
        # model_copy(update=...) mirrors _append_job_message and skips the full
        # re-validation that model_dump() + JobState(**data) would incur.
        _JOBS[job_id] = job.model_copy(update={**patch, "updated_at": _utc_now()})


def _append_job_message(job_id: str, message: str) -> None:
    """Append a progress line to a job message log."""
    with _JOBS_LOCK:
        job = _JOBS[job_id]
        _JOBS[job_id] = job.model_copy(
            update={"messages": [*job.messages, message], "updated_at": _utc_now()}
        )


def _evict_finished_jobs_locked() -> None:
    """Drop the oldest finished jobs once the retention cap is exceeded.

    The caller must hold ``_JOBS_LOCK``. Running and pending jobs are never
    evicted; only ``succeeded``/``failed`` jobs are removed, oldest first.
    """
    excess = len(_JOBS) - MAX_RETAINED_JOBS
    if excess <= 0:
        return
    # Sort by creation time so the genuinely oldest finished jobs are evicted;
    # dict order is UUID-keyed insertion order, not chronological.
    finished = sorted(
        (
            (job.created_at, job_id)
            for job_id, job in _JOBS.items()
            if job.status in {"succeeded", "failed"}
        ),
    )
    for _created_at, job_id in finished[:excess]:
        _JOBS.pop(job_id, None)


def _run_conversion_job(
    job_id: str,
    script: str,
    params: dict[str, Any],
    output_name: str,
) -> None:
    """Run a conversion script in the managed runtime and record the result."""
    process: subprocess.Popen[str] | None = None
    timed_out = threading.Event()
    try:
        _job_update(job_id, status="running")
        python = _runtime_python()
        process = subprocess.Popen(
            [python, "-c", script, json.dumps(params)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_clean_env(),
            bufsize=1,
            **_subprocess_startup_kwargs(),
        )
        # A watchdog kills the subprocess if it exceeds the deadline. Reading
        # process.stdout blocks until the pipe closes, so without this a hung
        # DuckDB or cog_translate call (one that emits no further output) would
        # tie up this background thread indefinitely; process.wait()'s own
        # timeout cannot fire because the loop has already drained stdout.
        watchdog = threading.Timer(
            CONVERSION_RUN_TIMEOUT_SECS,
            lambda: (timed_out.set(), process.kill()),
        )
        watchdog.daemon = True
        watchdog.start()
        result: Any = None
        if process.stdout is None:
            raise RuntimeError("Conversion subprocess stdout is unexpectedly None")
        try:
            for line in process.stdout:
                line = line.rstrip("\r\n")
                if not line:
                    continue
                if line.startswith(_RESULT_MARKER):
                    try:
                        result = json.loads(line[len(_RESULT_MARKER) :])
                    except json.JSONDecodeError:
                        result = line[len(_RESULT_MARKER) :]
                else:
                    _append_job_message(job_id, line)
            returncode = process.wait()
        finally:
            watchdog.cancel()
        if timed_out.is_set():
            raise RuntimeError(f"Conversion timed out after {CONVERSION_RUN_TIMEOUT_SECS} seconds")
        if returncode != 0:
            with _JOBS_LOCK:
                messages = list(_JOBS[job_id].messages)
            raise RuntimeError(messages[-1] if messages else f"Conversion exited with {returncode}")
        # Metadata-only jobs (layer listing) have no output file to report.
        output_path = params.get("output_path")
        _job_update(
            job_id,
            status="succeeded",
            result=result,
            outputs={output_name: {"path": output_path}} if output_path else {},
        )
    except Exception as exc:
        _job_update(job_id, status="failed", error=str(exc))
        # Remove a partial output so a retry starts clean and stale bytes do not
        # confuse downstream tools.
        output_path = params.get("output_path")
        if output_path:
            try:
                Path(output_path).unlink(missing_ok=True)
            except OSError:
                pass
    finally:
        # Guard against leaking a still-running subprocess if an exception is
        # raised before it exits (e.g. during streaming or a job-state update).
        if process is not None and process.poll() is None:
            process.kill()


def _start_job(
    tool_id: str,
    script: str,
    params: dict[str, Any],
    output_name: str,
) -> JobState:
    """Register a conversion job and run it in a background thread."""
    job_id = str(uuid.uuid4())
    now = _utc_now()
    with _JOBS_LOCK:
        _JOBS[job_id] = JobState(
            id=job_id,
            status="pending",
            tool_id=tool_id,
            created_at=now,
            updated_at=now,
        )
        _evict_finished_jobs_locked()
    thread = threading.Thread(
        target=_run_conversion_job,
        args=(job_id, script, params, output_name),
        daemon=True,
    )
    thread.start()
    # The worker may have already flipped the job to "running" by the time this
    # lock is re-acquired, so callers must not assume the response is "pending".
    with _JOBS_LOCK:
        return _JOBS[job_id]


@router.get("/status")
def conversion_status():
    """Return conversion runtime availability."""
    try:
        # Resolve the runtime to confirm availability, but do not return the
        # interpreter path — the frontend only needs available/message, and the
        # absolute path is needless filesystem recon for a caller.
        _runtime_python()
        return {
            "available": True,
            "message": "Conversion runtime (DuckDB + rio-cogeo) is available.",
        }
    except RuntimeBootstrapError as exc:
        # Log the detailed bootstrap error server-side but return a stable
        # message rather than leaking local runtime/setup specifics.
        logger.warning("Conversion runtime unavailable: %s", exc)
        return {
            "available": False,
            "message": "Conversion runtime is unavailable. Check the sidecar logs.",
        }
    except Exception:
        logger.exception("Unexpected error while checking conversion runtime")
        return {
            "available": False,
            "message": "Conversion runtime status check failed.",
        }


@router.post("/vector-layers")
def vector_layers(request: VectorLayersRequest):
    """List the layers of a multi-layer vector dataset without reading features.

    Supports every input ``ST_Read`` understands, including a File Geodatabase
    (a ``.gdb`` directory or a zipped one). Returns a job whose result carries
    ``layers``: name, feature count, geometry type, and CRS per layer.

    The feature counts come from ``st_read_meta``, i.e. whatever the GDAL
    driver reports. FileGDB stores row counts in its catalog so the primary
    ``.gdb`` case is metadata-only, but a driver without a fast feature count
    (e.g. a GeoPackage with stale ``gpkg_ogr_contents``) may scan the layer to
    produce it, making this probe slower than "metadata-only" suggests.
    """
    input_path = _validate_input_path(request.input_path)
    return _start_job("vector-layers", _VECTOR_LAYERS_SCRIPT, {"input_path": input_path}, "layers")


@router.post("/vector-to-vector")
def vector_to_vector(request: VectorToVectorRequest):
    """Convert any vector format to another, inferring both from file extensions.

    The output format is resolved from the output file's extension: Parquet
    extensions use DuckDB's native writer, everything else maps to a GDAL driver
    validated against ``ST_Drivers()`` inside the job. Input format detection is
    handled entirely by ``ST_Read`` (or ``read_parquet``), so no input format
    needs to be declared.
    """
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    extension = _output_extension(output_path)
    if not extension:
        raise HTTPException(
            status_code=400,
            detail="Output path needs a file extension to select the format.",
        )

    if extension in PARQUET_OUTPUT_EXTENSIONS:
        params = {
            "input_path": input_path,
            "output_path": output_path,
            "output_kind": "parquet",
            "output_driver": "",
            "zip_shapefile": False,
            "input_layer": request.input_layer,
            "target_srs": request.target_srs,
            "source_srs": request.source_srs,
        }
        output_name = "geoparquet"
    else:
        driver = VECTOR_OUTPUT_DRIVERS.get(extension)
        if not driver:
            supported = ", ".join(sorted(set(VECTOR_OUTPUT_DRIVERS) | PARQUET_OUTPUT_EXTENSIONS))
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Unsupported output extension '.{extension}'. "
                    f"Supported extensions: {supported}"
                ),
            )
        params = {
            "input_path": input_path,
            "output_path": output_path,
            "output_kind": "gdal",
            "output_driver": driver,
            # A .zip output is delivered as a zipped Shapefile bundle; a bare
            # .shp writes the .shp plus its sidecars in place.
            "zip_shapefile": extension == "zip",
            "input_layer": request.input_layer,
            "target_srs": request.target_srs,
            "source_srs": request.source_srs,
        }
        output_name = extension

    return _start_job("vector-to-vector", _VECTOR_TO_VECTOR_SCRIPT, params, output_name)


@router.post("/vector-to-geoparquet")
def vector_to_geoparquet(request: VectorToGeoParquetRequest):
    """Convert a vector dataset to a Hilbert-sorted, compressed GeoParquet."""
    compression = request.compression.strip().lower() or DEFAULT_VECTOR_COMPRESSION
    if compression not in VECTOR_COMPRESSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported Parquet compression: {request.compression}",
        )
    if request.row_group_size <= 0:
        raise HTTPException(status_code=400, detail="row_group_size must be a positive integer")
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "vector-to-geoparquet",
        _VECTOR_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "output_format": "parquet",
            "source_kind": "auto",
            "compression": compression,
            "row_group_size": request.row_group_size,
        },
        "geoparquet",
    )


@router.post("/vector-to-flatgeobuf")
def vector_to_flatgeobuf(request: VectorToFlatGeobufRequest):
    """Convert a vector dataset to a Hilbert-sorted FlatGeobuf."""
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "vector-to-flatgeobuf",
        _VECTOR_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "output_format": "flatgeobuf",
            "source_kind": "auto",
        },
        "flatgeobuf",
    )


@router.post("/vector-to-shapefile")
def vector_to_shapefile(request: VectorToShapefileRequest):
    """Convert a vector dataset to a Hilbert-sorted, zipped ESRI Shapefile."""
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "vector-to-shapefile",
        _VECTOR_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "output_format": "shapefile",
            "source_kind": "auto",
        },
        "shapefile",
    )


@router.post("/vector-to-geopackage")
def vector_to_geopackage(request: VectorToGeoPackageRequest):
    """Convert a vector dataset to a Hilbert-sorted GeoPackage."""
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "vector-to-geopackage",
        _VECTOR_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "output_format": "geopackage",
            "source_kind": "auto",
        },
        "geopackage",
    )


@router.post("/csv-to-geoparquet")
def csv_to_geoparquet(request: CsvToGeoParquetRequest):
    """Convert a CSV with lon/lat columns to a Hilbert-sorted GeoParquet."""
    compression = request.compression.strip().lower() or DEFAULT_VECTOR_COMPRESSION
    if compression not in VECTOR_COMPRESSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported Parquet compression: {request.compression}",
        )
    if request.row_group_size <= 0:
        raise HTTPException(status_code=400, detail="row_group_size must be a positive integer")
    if not request.lon_column.strip() or not request.lat_column.strip():
        raise HTTPException(status_code=400, detail="lon_column and lat_column are required")
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "csv-to-geoparquet",
        _VECTOR_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "output_format": "parquet",
            "source_kind": "csv",
            "lon_column": request.lon_column.strip(),
            "lat_column": request.lat_column.strip(),
            "compression": compression,
            "row_group_size": request.row_group_size,
        },
        "geoparquet",
    )


@router.post("/vector-to-pmtiles")
def vector_to_pmtiles(request: VectorToPmtilesRequest):
    """Convert a vector dataset to PMTiles vector tiles via freestiler."""
    if not 0 <= request.min_zoom <= request.max_zoom <= 24:
        raise HTTPException(
            status_code=400,
            detail="Zoom levels must satisfy 0 <= min_zoom <= max_zoom <= 24",
        )
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "vector-to-pmtiles",
        _PMTILES_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "layer_name": request.layer_name.strip() or "data",
            "min_zoom": request.min_zoom,
            "max_zoom": request.max_zoom,
        },
        "pmtiles",
    )


@router.post("/raster-to-cog")
def raster_to_cog(request: RasterToCogRequest):
    """Convert a raster dataset to a valid, compressed Cloud Optimized GeoTIFF."""
    compression = request.compression.strip().lower() or DEFAULT_COG_COMPRESSION
    if compression not in COG_COMPRESSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported COG compression: {request.compression}",
        )
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "raster-to-cog",
        _RASTER_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "compression": compression,
        },
        "cog",
    )


@router.get("/jobs/{job_id}")
def conversion_job(job_id: str):
    """Return state for a conversion background job."""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job
