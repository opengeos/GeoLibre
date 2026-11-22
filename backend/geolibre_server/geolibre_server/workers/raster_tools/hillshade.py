"""Raster processing worker for 'hillshade'."""


def main() -> None:
    import json
    import sys

    import numpy as np
    import rasterio

    params = json.loads(sys.argv[1])
    input_path = params["input_path"]
    output_path = params["output_path"]
    azimuth = float(params.get("azimuth", 315))
    altitude = float(params.get("altitude", 45))
    # Default to 1 only when absent/None; an explicit 0 is honored (flat result).
    _z = params.get("z_factor", 1)
    z_factor = float(1 if _z is None else _z)

    with rasterio.open(input_path) as src:
        elev = src.read(1, masked=True).astype("float64")
        xres, yres = src.res
        profile = src.profile.copy()

    elev = np.ma.filled(elev, np.nan) * z_factor
    dy, dx = np.gradient(elev, yres, xres)
    slope = np.pi / 2.0 - np.arctan(np.sqrt(dx * dx + dy * dy))
    # `az` is the math-convention angle (counter-clockwise from east), so the
    # aspect must use the same convention, as the browser engine's hillshade does.
    # The compass form atan2(-dx, dy) mirrors the light about the NE-SW axis.
    aspect = np.arctan2(dy, -dx)
    az = np.radians(360.0 - azimuth + 90.0)
    alt = np.radians(altitude)
    shaded = np.sin(alt) * np.sin(slope) + np.cos(alt) * np.cos(slope) * np.cos(az - aspect)
    # Match the GDAL/QGIS convention: clip back-facing (negative) illumination to
    # black and scale [0, 1] -> [0, 255], rather than a symmetric [-1, 1] remap.
    shaded = np.clip(shaded * 255.0, 0, 255)
    shaded = np.where(np.isnan(shaded), 0, shaded).astype("uint8")

    profile.update(dtype="uint8", count=1, nodata=0, compress="deflate")
    with rasterio.open(output_path, "w", **profile) as dst:
        dst.write(shaded, 1)
    print(f"Wrote hillshade to {output_path}")
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
