"""Raster processing worker for 'aspect'."""


def main() -> None:
    import json
    import sys

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
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
