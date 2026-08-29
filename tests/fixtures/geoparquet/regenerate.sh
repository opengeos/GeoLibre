#!/usr/bin/env bash
# Regenerate the committed GeoParquet fixtures in this directory.
#
# Unlike most fixtures these ARE committed: they are small (a few kB each) and
# they are the only place the app's GeoParquet reading is exercised against real
# Parquet footers rather than hand-written JSON. Regenerate them only when a
# variant is added or a writer's output changes, and re-run the suites after.
#
# Requirements:
#   duckdb CLI 1.5+ with the spatial extension (writes the Parquet files), and
#   uv (runs pyarrow to patch `geo` metadata DuckDB cannot itself write).
#
# Ported from GeoPQ Workbench's testdata/regenerate.sh.
#
# Usage: ./regenerate.sh
set -euo pipefail
cd "$(dirname "$0")"

command -v duckdb >/dev/null || { echo "duckdb CLI required"; exit 1; }
command -v uv >/dev/null || { echo "uv required (for pyarrow)"; exit 1; }

mkdir -p geo-metadata

echo "== wkb_1_0.parquet (DuckDB default: GeoParquet 1.0.0, WKB, no covering) =="
duckdb -c "
INSTALL spatial; LOAD spatial;
COPY (
  SELECT ST_Point(-71.2 + 0.4 * (i % 20) / 20.0, 42.2 + 0.3 * (i % 17) / 17.0) AS geometry,
         i AS id,
         'point_' || i AS name
  FROM range(200) t(i)
) TO 'wkb_1_0.parquet' (FORMAT PARQUET);"

echo "== native_2_0.parquet (GeoParquet 2.0 + Parquet GEOMETRY logical type) =="
duckdb -c "
LOAD spatial;
COPY (
  SELECT ST_Point(-71.2 + 0.4 * (i % 20) / 20.0, 42.2 + 0.3 * (i % 17) / 17.0) AS geometry,
         i AS id
  FROM range(200) t(i)
) TO 'native_2_0.parquet' (FORMAT PARQUET, GEOPARQUET_VERSION 'V2');"

echo "== wkb_1_1_covering.parquet (1.1, bbox struct + covering, Hilbert, EPSG:26986) =="
# Squares on the NAD83 / Massachusetts Mainland grid, in metres. Hilbert-sorted
# so the row-group bounding boxes are actually clustered, and carrying the
# per-feature bbox struct that a `covering` member points at. DuckDB writes the
# struct but never declares the covering, so the `geo` block is rewritten below.
duckdb -c "
LOAD spatial;
COPY (
  WITH pts AS (
    SELECT ST_Buffer(ST_Point(220000 + 40 * (i % 45), 890000 + 40 * (i // 45)), 15, 1) AS geometry,
           i AS id, 'parcel_' || i AS loc_id
    FROM range(300) t(i)
  ), ext AS (
    SELECT min(ST_XMin(geometry)) xa, min(ST_YMin(geometry)) ya,
           max(ST_XMax(geometry)) xb, max(ST_YMax(geometry)) yb FROM pts
  )
  SELECT p.geometry,
         {'xmin': ST_XMin(p.geometry), 'ymin': ST_YMin(p.geometry),
          'xmax': ST_XMax(p.geometry), 'ymax': ST_YMax(p.geometry)} AS bbox,
         p.id, p.loc_id
  FROM pts p, ext
  ORDER BY ST_Hilbert(p.geometry,
    {'min_x': ext.xa, 'min_y': ext.ya, 'max_x': ext.xb, 'max_y': ext.yb}::BOX_2D)
) TO 'covering_raw.parquet' (FORMAT PARQUET, ROW_GROUP_SIZE 100);"

echo "== bbox_3d.parquet (1.0, 3D geometry, 6-element geo.bbox) =="
duckdb -c "
LOAD spatial;
COPY (
  SELECT ST_GeomFromText('POINT Z (' || (-71.2 + 0.4 * (i % 20) / 20.0) || ' ' ||
                         (42.2 + 0.3 * (i % 17) / 17.0) || ' ' || (i % 50) || ')') AS geometry,
         i AS id
  FROM range(120) t(i)
) TO 'bbox_3d_raw.parquet' (FORMAT PARQUET);"

echo "== crs_null.parquet (1.1, explicit \"crs\": null) =="
# A local site grid in no known CRS: metres from an arbitrary origin. The spec
# says an explicit null means the CRS is undefined, NOT the CRS84 default.
duckdb -c "
LOAD spatial;
COPY (
  SELECT ST_Point(100.0 * (i % 25), 100.0 * (i // 25)) AS geometry,
         i AS id
  FROM range(150) t(i)
) TO 'crs_null_raw.parquet' (FORMAT PARQUET);"

echo "== no_geo_metadata_wkb.parquet (plain Parquet, WKB blob named 'geom') =="
duckdb -c "
LOAD spatial;
COPY (
  SELECT ST_AsWKB(ST_Point(-71.2 + 0.4 * (i % 20) / 20.0,
                           42.2 + 0.3 * (i % 17) / 17.0)) AS geom,
         i AS id
  FROM range(200) t(i)
) TO 'no_geo_raw.parquet' (FORMAT PARQUET);"

echo "== lonlat_columns.parquet (no geometry at all, lon/lat doubles) =="
duckdb -c "
COPY (
  SELECT (-71.2 + 0.4 * (i % 20) / 20.0)::DOUBLE AS lon,
         (42.2 + 0.3 * (i % 17) / 17.0)::DOUBLE AS lat,
         i AS id, 'station_' || i AS name
  FROM range(200) t(i)
) TO 'lonlat_columns.parquet' (FORMAT PARQUET);"

echo "== patching geo metadata with pyarrow =="
uv run --with pyarrow python3 - <<'PY'
import json
import pyarrow.parquet as pq

MASS_MAINLAND = {
    "type": "ProjectedCRS",
    "name": "NAD83 / Massachusetts Mainland",
    "id": {"authority": "EPSG", "code": 26986},
}


def patch(src, dst, geo, **write_kwargs):
    table = pq.read_table(src)
    metadata = dict(table.schema.metadata or {})
    if geo is None:
        metadata.pop(b"geo", None)
    else:
        metadata[b"geo"] = json.dumps(geo).encode()
    pq.write_table(table.replace_schema_metadata(metadata), dst, **write_kwargs)


patch(
    "covering_raw.parquet",
    "wkb_1_1_covering.parquet",
    {
        "version": "1.1.0",
        "primary_column": "geometry",
        "columns": {
            "geometry": {
                "encoding": "WKB",
                "geometry_types": ["Polygon"],
                "crs": MASS_MAINLAND,
                "edges": "planar",
                "orientation": "counterclockwise",
                "bbox": [219985.0, 889985.0, 221775.0, 890175.0],
                "covering": {
                    "bbox": {
                        "xmin": ["bbox", "xmin"],
                        "ymin": ["bbox", "ymin"],
                        "xmax": ["bbox", "xmax"],
                        "ymax": ["bbox", "ymax"],
                    }
                },
            }
        },
    },
    row_group_size=100,
)

patch(
    "bbox_3d_raw.parquet",
    "bbox_3d.parquet",
    {
        "version": "1.0.0",
        "primary_column": "geometry",
        "columns": {
            "geometry": {
                "encoding": "WKB",
                "geometry_types": ["Point Z"],
                # 3D per spec: [xmin, ymin, zmin, xmax, ymax, zmax]. A reader
                # that takes the first four gets [xmin, ymin, zmin, xmax].
                "bbox": [-71.2, 42.2, 0.0, -70.82, 42.48235294117647, 49.0],
            }
        },
    },
)

patch(
    "crs_null_raw.parquet",
    "crs_null.parquet",
    {
        "version": "1.1.0",
        "primary_column": "geometry",
        "columns": {
            "geometry": {
                "encoding": "WKB",
                "geometry_types": ["Point"],
                "crs": None,
                "bbox": [0.0, 0.0, 2400.0, 500.0],
            }
        },
    },
)

patch("no_geo_raw.parquet", "no_geo_metadata_wkb.parquet", None)
PY
rm -f covering_raw.parquet bbox_3d_raw.parquet crs_null_raw.parquet no_geo_raw.parquet

echo "== extracting the geo documents for the pure TypeScript tests =="
# The parser tests must not need a Parquet reader, so each file's `geo` block is
# written out beside it as plain JSON and asserted from there.
uv run --with pyarrow python3 - <<'PY'
import json
import pathlib

import pyarrow.parquet as pq

out = pathlib.Path("geo-metadata")
for path in sorted(pathlib.Path(".").glob("*.parquet")):
    geo = (pq.read_schema(path).metadata or {}).get(b"geo")
    target = out / f"{path.stem}.json"
    if geo is None:
        target.unlink(missing_ok=True)
        print(f"{path.name}: no geo key")
        continue
    target.write_text(json.dumps(json.loads(geo), indent=2) + "\n", encoding="utf-8")
    print(f"{path.name}: {len(geo)} bytes of geo metadata")
PY

echo "== verifying with the DuckDB CLI =="
for f in *.parquet; do
  echo "-- $f"
  duckdb -c "SELECT name, type, logical_type, duckdb_type FROM parquet_schema('$f');"
done

echo "done:"
ls -lh ./*.parquet geo-metadata/*.json
