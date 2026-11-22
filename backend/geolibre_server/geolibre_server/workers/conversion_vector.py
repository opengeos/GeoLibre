"""Convert vector files to GeoParquet or FlatGeobuf via DuckDB."""

from geolibre_server.workers.conversion_helpers import shapefile_field_warnings


def main() -> None:
    import glob
    import json
    import os
    import shutil
    import sys
    import tempfile
    import zipfile

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
    # DuckDB 2.0 refuses a GDAL COPY with an SRS until the axis order is chosen
    # explicitly. GEOMETRY is always [lon, lat] here (ST_Transform uses always_xy),
    # so tell GDAL the same; older DuckDB without the setting already behaves so.
    try:
        con.execute("SET geometry_always_xy = true")
    except duckdb.Error:
        pass

    if source_kind == "csv":
        lon = params["lon_column"]
        lat = params["lat_column"]
        relation = f"read_csv_auto({quote(input_path)}, header=true)"
        geometry_column = "geometry"
        quoted_geometry = quote_ident(geometry_column)
        point = f"ST_Point(CAST({quote_ident(lon)} AS DOUBLE), CAST({quote_ident(lat)} AS DOUBLE))"
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

    if output_format in GDAL_DRIVERS:
        srs_clause = f", SRS {quote(output_srs)}" if output_srs else ""
        to_clause = f"(FORMAT GDAL, DRIVER '{GDAL_DRIVERS[output_format]}'{srs_clause})"
    else:
        to_clause = (
            f"(FORMAT PARQUET, COMPRESSION {quote(compression)}, ROW_GROUP_SIZE {row_group_size})"
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
            f"""
            COPY (
              WITH src AS ({source}),
              b AS (SELECT ST_Extent(ST_Extent_Agg({quoted_geometry})) AS box FROM src)
              SELECT * FROM src
              ORDER BY ST_Hilbert({quoted_geometry}, (SELECT box FROM b))
            ) TO {quote(copy_target)} {to_clause};
            """
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
        "__GEOLIBRE_CONVERSION_RESULT__"
        + json.dumps(
            {
                "feature_count": count,
                "geometry_column": geometry_column,
                "output_path": output_path,
                "warnings": warnings,
            }
        )
    )


if __name__ == "__main__":
    main()
