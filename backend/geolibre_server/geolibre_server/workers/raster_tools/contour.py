"""Raster processing worker for 'contour'."""


def main() -> None:
    import json
    import sys

    import numpy as np
    import rasterio
    from contourpy import contour_generator

    params = json.loads(sys.argv[1])
    input_path = params["input_path"]
    output_path = params["output_path"]
    band = int(params.get("band", 1))
    interval = float(params.get("interval", 0) or 0)
    if interval <= 0:
        raise SystemExit("Contour interval must be > 0")
    base = float(params.get("base", 0) or 0)
    attribute = str(params.get("attribute", "elev"))

    with rasterio.open(input_path) as src:
        arr = src.read(band, masked=True).astype("float64")
        transform = src.transform
        crs = src.crs

    data = np.ma.masked_invalid(np.ma.filled(arr, np.nan))
    # Evaluate finiteness on the plain filled array: ``MaskedArray.any()`` returns
    # ``np.ma.masked`` (not False) when every cell is masked, and ``not masked``
    # raises an ambiguous-truth-value error.
    filled = data.filled(np.nan)
    if not np.isfinite(filled).any():
        raise SystemExit("Raster band has no valid data to contour")
    zmin = float(np.nanmin(filled))
    zmax = float(np.nanmax(filled))
    start = base + np.ceil((zmin - base) / interval) * interval
    # Index-based generation avoids float drift from repeated ``+= interval`` that
    # could skip the final level or append a spurious one.
    n_levels = int(np.floor((zmax - start) / interval + 1e-9)) + 1
    levels = [round(start + i * interval, 6) for i in range(max(0, n_levels))]
    if not levels:
        raise SystemExit(
            f"No contour levels fall within the data range [{zmin:.6g}, {zmax:.6g}] "
            f"for interval={interval} and base={base}."
        )

    gen = contour_generator(z=data, line_type="Separate")
    features = []
    for value in levels:
        for line in gen.lines(value):
            coords = []
            for col, row in line:
                x, y = transform * (float(col), float(row))
                coords.append([x, y])
            if len(coords) >= 2:
                features.append(
                    {
                        "type": "Feature",
                        "properties": {attribute: value},
                        "geometry": {"type": "LineString", "coordinates": coords},
                    }
                )
    fc = {"type": "FeatureCollection", "features": features}
    if crs is not None and crs.to_epsg() and crs.to_epsg() != 4326:
        fc["crs"] = {
            "type": "name",
            "properties": {"name": f"urn:ogc:def:crs:EPSG::{crs.to_epsg()}"},
        }
    with open(output_path, "w") as f:
        json.dump(fc, f)
    print(
        f"Generated {len(features)} contour line(s) across {len(levels)} level(s) -> {output_path}"
    )
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
