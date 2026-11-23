"""Raster processing worker for 'clip-extent'."""


def main() -> None:
    import json
    import math
    import sys

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
        raw_window = from_bounds(minx, miny, maxx, maxy, src.transform)
        # Intersect before rounding so sub-pixel extents inside a single pixel
        # do not collapse to width/height 0 under round_lengths().
        try:
            clipped = raw_window.intersection(Window(0, 0, src.width, src.height))
        except WindowError:
            raise SystemExit("Extent does not overlap the raster")
        col_off = max(0, math.floor(clipped.col_off + 1e-9))
        row_off = max(0, math.floor(clipped.row_off + 1e-9))
        col_end = min(src.width, math.ceil(clipped.col_off + clipped.width - 1e-9))
        row_end = min(src.height, math.ceil(clipped.row_off + clipped.height - 1e-9))
        if col_end <= col_off or row_end <= row_off:
            raise SystemExit("Extent does not overlap the raster")
        window = Window(col_off, row_off, col_end - col_off, row_end - row_off)
        data = src.read(window=window)
        if data.shape[1] == 0 or data.shape[2] == 0:
            raise SystemExit("Extent does not overlap the raster")
        dataset_mask = src.dataset_mask(window=window)
        has_explicit_mask = src.nodata is None and bool((dataset_mask == 0).any())
        transform = src.window_transform(window)
        profile = src.profile.copy()
        profile.update(
            height=data.shape[1], width=data.shape[2], transform=transform, compress="deflate"
        )
        with rasterio.open(output_path, "w", **profile) as dst:
            dst.write(data)
            if has_explicit_mask:
                dst.write_mask(dataset_mask)
    print(f"Clipped to extent -> {output_path}")
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
