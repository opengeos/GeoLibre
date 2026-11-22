"""Convert between vector formats via DuckDB spatial."""

from geolibre_server.workers.conversion_helpers import shapefile_field_warnings


def main() -> None:
    import glob
    import json
    import os
    import re
    import shutil
    import sys
    import tempfile
    import zipfile

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

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    # DuckDB 2.0 refuses a GDAL COPY with an SRS until the axis order is chosen
    # explicitly. GEOMETRY is always [lon, lat] here (ST_Transform uses always_xy),
    # so tell GDAL the same; older DuckDB without the setting already behaves so.
    try:
        con.execute("SET geometry_always_xy = true")
    except duckdb.Error:
        pass

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

    is_geojson_input = low.endswith((".geojson", ".json", ".geojsonl", ".geojsons", ".ndjson"))

    if target_srs:
        # An explicit source_srs wins; otherwise DuckDB spatial annotates the
        # geometry's CRS in its DESCRIBE type, e.g. GEOMETRY('EPSG:4326') — that
        # is the only place the dataset's own CRS is exposed.
        source_srs = source_srs_override
        if source_srs is None:
            for name, column_type, *_ in columns:
                if name == geometry_column:
                    match = re.search(r"GEOMETRY\('([^']+)'\)", str(column_type))
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
                meta_target = input_path.replace("\\", "/") + "/*.gdbtable"
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
            raise SystemExit("Cannot reproject: the input dataset does not declare a CRS.")
        if source_srs != target_srs:
            geometry_expr = (
                f"ST_Transform({geometry_expr}, {quote(source_srs)}, "
                f"{quote(target_srs)}, always_xy := true)"
            )

    if geometry_expr == quoted_geometry:
        source = f"SELECT * FROM {relation}"
    else:
        source = f"SELECT * REPLACE ({geometry_expr} AS {quoted_geometry}) FROM {relation}"

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
        lco = ", LAYER_CREATION_OPTIONS 'GEOMETRY=AS_WKT'" if output_driver == "CSV" else ""
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
        if is_shapefile:
            pattern = glob.escape(os.path.join(tmp_dir, stem)) + ".*"
            produced = sorted(glob.glob(pattern))
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
