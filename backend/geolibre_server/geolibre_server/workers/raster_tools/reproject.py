"""Raster processing worker for 'reproject'."""


def main() -> None:
    import json
    import sys

    import rasterio
    from rasterio.warp import Resampling, calculate_default_transform, reproject

    params = json.loads(sys.argv[1])
    input_path = params["input_path"]
    output_path = params["output_path"]
    dst_crs = str(params.get("dst_crs", "") or "").strip()
    if not dst_crs:
        raise SystemExit("Target CRS (dst_crs) is required")
    resampling_name = str(params.get("resampling", "nearest"))
    if not hasattr(Resampling, resampling_name):
        raise SystemExit(f"Unsupported resampling method: {resampling_name}")
    method = getattr(Resampling, resampling_name)

    with rasterio.open(input_path) as src:
        transform, width, height = calculate_default_transform(
            src.crs, dst_crs, src.width, src.height, *src.bounds
        )
        profile = src.profile.copy()
        profile.update(
            crs=dst_crs, transform=transform, width=width, height=height, compress="deflate"
        )
        with rasterio.open(output_path, "w", **profile) as dst:
            for i in range(1, src.count + 1):
                reproject(
                    source=rasterio.band(src, i),
                    destination=rasterio.band(dst, i),
                    src_transform=src.transform,
                    src_crs=src.crs,
                    dst_transform=transform,
                    dst_crs=dst_crs,
                    resampling=method,
                )
    print(f"Reprojected to {dst_crs} -> {output_path}")
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
