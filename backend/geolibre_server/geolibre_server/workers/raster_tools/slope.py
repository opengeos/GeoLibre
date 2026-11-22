"""Raster processing worker for 'slope'."""


def main() -> None:
    import json
    import sys

    import numpy as np
    import rasterio

    params = json.loads(sys.argv[1])
    input_path = params["input_path"]
    output_path = params["output_path"]
    units = str(params.get("units", "degrees"))
    # Default to 1 only when absent/None; an explicit 0 is honored (flat result).
    _z = params.get("z_factor", 1)
    z_factor = float(1 if _z is None else _z)
    nodata = -9999.0

    with rasterio.open(input_path) as src:
        elev = src.read(1, masked=True).astype("float64")
        xres, yres = src.res
        profile = src.profile.copy()

    input_invalid = np.ma.getmaskarray(elev) | ~np.isfinite(np.ma.filled(elev, np.nan))
    elev = np.ma.filled(elev, np.nan) * z_factor
    dy, dx = np.gradient(elev, yres, xres)
    rise_run = np.sqrt(dx * dx + dy * dy)
    if units == "percent":
        out = rise_run * 100.0
    else:
        out = np.degrees(np.arctan(rise_run))
    out = np.where(input_invalid | np.isnan(out), nodata, out).astype("float32")

    profile.update(dtype="float32", count=1, nodata=nodata, compress="deflate")
    with rasterio.open(output_path, "w", **profile) as dst:
        dst.write(out, 1)
    print(f"Wrote slope ({units}) to {output_path}")
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
