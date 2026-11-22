"""Raster processing worker for 'polygonize'."""


def main() -> None:
    import json
    import math
    import sys

    import numpy as np
    import rasterio
    from rasterio.features import shapes as rio_shapes

    params = json.loads(sys.argv[1])
    input_path = params["input_path"]
    output_path = params["output_path"]
    band = int(params.get("band", 1))
    connectivity = int(params.get("connectivity", 4))
    field = str(params.get("field", "value"))

    with rasterio.open(input_path) as src:
        arr = src.read(band)
        valid = None
        if src.nodata is not None:
            # NaN nodata needs np.isnan: ``arr != nan`` is True for every pixel
            # (NaN != NaN), which would otherwise mask nothing. rio_shapes wants a
            # uint8/bool mask.
            if isinstance(src.nodata, float) and math.isnan(src.nodata):
                valid = (~np.isnan(arr)).astype("uint8")
            else:
                valid = (arr != src.nodata).astype("uint8")
        transform = src.transform
        crs = src.crs

    if np.issubdtype(arr.dtype, np.floating):
        print(
            "Warning: rasterio.features.shapes floor-truncates float bands to int32, "
            "so sub-integer values are merged. Polygonize is best suited to "
            "categorical (integer) rasters."
        )

    def _outer_ring_area(geom):
        # Shoelace area of the exterior ring, holes ignored: a polygon's exterior
        # encloses every island sitting in its holes, so it is always larger.
        # Coordinates are taken relative to the first vertex: raw projected values
        # (UTM northings near 4e6) would cancel most digits in the cross-products.
        ring = geom["coordinates"][0]
        x_origin, y_origin = ring[0]
        total = 0.0
        for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
            total += (x0 - x_origin) * (y1 - y_origin) - (x1 - x_origin) * (y0 - y_origin)
        return abs(total) / 2.0

    features = []
    for geom, value in rio_shapes(arr, mask=valid, connectivity=connectivity, transform=transform):
        features.append({"type": "Feature", "properties": {field: value}, "geometry": geom})
    # GDAL emits a region once the scan finishes it, so a large polygon lands after
    # the small islands in its holes. Map renderers (MapLibre included) draw an
    # antialiased edge along every ring, holes too, so a container drawn last
    # paints its hole edges over one-pixel islands and they vanish when zoomed out
    # (issue #3335). Largest first keeps every enclosed region drawn on top.
    features.sort(key=lambda feature: _outer_ring_area(feature["geometry"]), reverse=True)
    fc = {"type": "FeatureCollection", "features": features}
    if crs is not None and crs.to_epsg() and crs.to_epsg() != 4326:
        fc["crs"] = {
            "type": "name",
            "properties": {"name": f"urn:ogc:def:crs:EPSG::{crs.to_epsg()}"},
        }
    with open(output_path, "w") as f:
        json.dump(fc, f)
    print(f"Polygonized into {len(features)} feature(s) -> {output_path}")
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
