"""Raster processing worker for 'resample'."""


def main() -> None:
    import json
    import math
    import sys

    import numpy as np
    import rasterio
    from rasterio.enums import ColorInterp
    from rasterio.transform import from_origin
    from rasterio.vrt import WarpedVRT
    from rasterio.warp import Resampling, reproject

    params = json.loads(sys.argv[1])
    input_path = params["input_path"]
    output_path = params["output_path"]
    resolution = float(params.get("resolution", 0) or 0)
    if resolution <= 0:
        raise SystemExit("Target pixel size (resolution) must be > 0")
    resampling_name = str(params.get("resampling", "bilinear"))
    if not hasattr(Resampling, resampling_name):
        raise SystemExit(f"Unsupported resampling method: {resampling_name}")
    method = getattr(Resampling, resampling_name)

    with rasterio.open(input_path) as src:
        bounds = src.bounds
        width = max(1, int(math.ceil((bounds.right - bounds.left) / resolution - 1e-9)))
        height = max(1, int(math.ceil((bounds.top - bounds.bottom) / resolution - 1e-9)))
        transform = from_origin(bounds.left, bounds.top, resolution, resolution)
        profile = src.profile.copy()
        profile.update(transform=transform, width=width, height=height, compress="deflate")
        with rasterio.open(output_path, "w", **profile) as dst:
            if src.nodata is None and ColorInterp.alpha not in src.colorinterp:
                # Stream data and warp validity mask block-by-block via WarpedVRT
                # so memory stays bounded on large rasters and validity matches
                # the selected resampling method (marking uncovered borders invalid
                # while keeping valid source zeros valid).
                data_indexes = list(range(1, src.count + 1))
                with WarpedVRT(
                    src,
                    crs=src.crs,
                    transform=transform,
                    width=width,
                    height=height,
                    resampling=method,
                    add_alpha=True,
                ) as vrt:
                    alpha_index = vrt.count
                    for _, window in dst.block_windows(1):
                        dst.write(vrt.read(data_indexes, window=window), window=window)
                        alpha = vrt.read(alpha_index, window=window)
                        mask = np.where(alpha > 0, 255, 0).astype("uint8")
                        dst.write_mask(mask, window=window)
            else:
                for i in range(1, src.count + 1):
                    reproject(
                        source=rasterio.band(src, i),
                        destination=rasterio.band(dst, i),
                        src_transform=src.transform,
                        src_crs=src.crs,
                        dst_transform=transform,
                        dst_crs=src.crs,
                        resampling=method,
                    )
    print(f"Resampled to {resolution} units/pixel ({width}x{height}) -> {output_path}")
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
