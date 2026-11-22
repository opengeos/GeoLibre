"""Raster processing worker for 'mosaic'."""


def main() -> None:
    import json
    import sys

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
                raise SystemExit("All rasters must share the same CRS; reproject them first.")
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
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
