"""Raster processing worker for 'clip-extent'."""


def main() -> None:
    import json
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
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
