"""Raster processing worker for 'clip-mask'."""


def main() -> None:
    import json
    import re
    import sys

    import rasterio
    from rasterio.crs import CRS
    from rasterio.mask import mask as rio_mask
    from rasterio.warp import transform_geom

    params = json.loads(sys.argv[1])
    input_path = params["input_path"]
    output_path = params["output_path"]
    mask_path = params["mask_path"]
    crop = bool(params.get("crop", True))
    all_touched = bool(params.get("all_touched", False))

    with open(mask_path) as f:
        gj = json.load(f)
    gtype = gj.get("type")
    if gtype == "FeatureCollection":
        shapes = [feat["geometry"] for feat in gj.get("features", []) if feat.get("geometry")]
    elif gtype == "Feature":
        shapes = [gj["geometry"]] if gj.get("geometry") else []
    else:
        shapes = [gj]
    if not shapes:
        raise SystemExit("Mask layer has no geometries")

    # Resolve the mask CRS: an explicit GeoJSON ``crs`` member if present, else the
    # GeoJSON default of WGS84 (EPSG:4326).
    mask_crs = CRS.from_epsg(4326)
    crs_member = gj.get("crs")
    if isinstance(crs_member, dict):
        name = crs_member.get("properties", {}).get("name", "")
        digits = re.search(r"(\d+)$", str(name))
        if digits:
            try:
                mask_crs = CRS.from_epsg(int(digits.group(1)))
            except Exception as exc:
                print(
                    f"Warning: could not parse mask CRS '{name}' "
                    f"({exc}); assuming WGS84 (EPSG:4326)",
                    file=sys.stderr,
                )
        elif name:
            # Consistent with the zones/interpolate sections: warn on a non-empty
            # name we could not interpret, stay silent for an absent/blank field.
            print(
                f"Warning: could not parse mask CRS '{name}'; assuming WGS84 (EPSG:4326)",
                file=sys.stderr,
            )

    with rasterio.open(input_path) as src:
        if src.crs is None:
            # Without a raster CRS the mask coordinates cannot be aligned; passing
            # them through would crop in raw raster units. Fail with a clear error.
            raise SystemExit(
                "Input raster has no CRS; clip-by-mask requires a georeferenced raster."
            )
        # rio_mask needs shapes in the raster's CRS; reproject the geometries when
        # the mask CRS differs so a WGS84 mask over a projected raster still works.
        if mask_crs != src.crs:
            shapes = [transform_geom(mask_crs, src.crs, geom) for geom in shapes]
        out_image, out_transform = rio_mask(src, shapes, crop=crop, all_touched=all_touched)
        profile = src.profile.copy()
        profile.update(
            height=out_image.shape[1],
            width=out_image.shape[2],
            transform=out_transform,
            compress="deflate",
        )
        with rasterio.open(output_path, "w", **profile) as dst:
            dst.write(out_image)
    print(f"Clipped by {len(shapes)} mask geometry(ies) -> {output_path}")
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
