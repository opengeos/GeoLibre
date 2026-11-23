"""List vector layers inside a multi-layer dataset via DuckDB."""


def main() -> None:
    import json
    import os
    import sys

    import duckdb

    params = json.loads(sys.argv[1])
    input_path = params["input_path"]

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

    low = input_path.lower()
    if low.endswith(".zip"):
        meta_target = "/vsizip/" + input_path
    elif os.path.isdir(input_path):
        # st_read_meta globs for files and returns no rows for a bare directory
        # dataset, so a .gdb folder is enumerated per .gdbtable file instead; each
        # one reports the single layer it stores. Forward-slash join (not
        # os.path.join): GDAL/DuckDB accept "/" on every platform, while a
        # backslash-joined glob is untested on a Windows sidecar.
        meta_target = input_path.replace("\\", "/") + "/*.gdbtable"
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
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"layers": layers}))


if __name__ == "__main__":
    main()
