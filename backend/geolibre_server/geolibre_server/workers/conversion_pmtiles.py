"""Build vector PMTiles via freestiler/DuckDB."""


def main() -> None:
    import json
    import os
    import shutil
    import sys
    import tempfile
    import uuid

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
    ext_dir = os.environ.get("DUCKDB_EXTENSION_DIRECTORY", "").strip()
    if ext_dir:
        con.execute(f"SET extension_directory = {quote(ext_dir)};")
    try:
        con.execute("LOAD spatial;")
    except Exception:
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
        con.execute(f"COPY (SELECT * FROM {relation}) TO {quote(tmp_parquet)} (FORMAT PARQUET)")

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
        "__GEOLIBRE_CONVERSION_RESULT__"
        + json.dumps({"output_path": output_path, "layer_name": layer_name})
    )


if __name__ == "__main__":
    main()
