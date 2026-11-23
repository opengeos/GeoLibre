"""Raster processing worker for 'zonal'."""


def main() -> None:
    import json
    import re
    import sys

    import numpy as np
    import rasterio
    from rasterio.crs import CRS
    from rasterio.errors import RasterioError
    from rasterio.mask import mask as rio_mask
    from rasterio.warp import transform_geom

    params = json.loads(sys.argv[1])
    input_path = params["input_path"]
    output_path = params["output_path"]
    zones_path = params["zones_path"]
    band = int(params.get("band", 1))
    # Optional prefix so stats don't clobber existing zone attributes named e.g.
    # 'mean'. Empty by default to match QGIS's bare 'min'/'max'/... fields.
    prefix = str(params.get("prefix", "") or "")

    with open(zones_path) as f:
        gj = json.load(f)
    gtype = gj.get("type")
    if gtype == "FeatureCollection":
        feats = gj.get("features", [])
    elif gtype == "Feature":
        feats = [gj]
    else:
        feats = [{"type": "Feature", "properties": {}, "geometry": gj}]
    if not feats:
        raise SystemExit("Zones layer has no features")

    # Resolve the zones CRS: an explicit GeoJSON ``crs`` member if present, else the
    # GeoJSON default of WGS84 (EPSG:4326).
    zone_crs = CRS.from_epsg(4326)
    crs_member = gj.get("crs")
    if isinstance(crs_member, dict):
        name = str(crs_member.get("properties", {}).get("name", ""))
        # Prefer a full parse (handles OGC URNs, ``EPSG:NNNN``, WKT, PROJ strings)
        # so a descriptive name like "Custom Albers zone 2" isn't mis-read as EPSG:2
        # by the trailing-digit fallback.
        try:
            zone_crs = CRS.from_user_input(name)
        except Exception:
            digits = re.search(r"(\d+)$", name)
            if digits:
                try:
                    zone_crs = CRS.from_epsg(int(digits.group(1)))
                except Exception as exc:
                    print(
                        f"Warning: could not parse zones CRS '{name}' "
                        f"({exc}); assuming WGS84 (EPSG:4326)",
                        file=sys.stderr,
                    )
            elif name:
                # A non-empty name we could not interpret; an absent/blank name is
                # just a missing field, not a parse failure, so stay silent there.
                print(
                    f"Warning: could not parse zones CRS '{name}'; assuming WGS84 (EPSG:4326)",
                    file=sys.stderr,
                )

    out_features = []
    with_data = 0
    with rasterio.open(input_path) as src:
        if src.crs is None:
            raise SystemExit(
                "Input raster has no CRS; zonal statistics requires a georeferenced raster."
            )
        if band < 1 or band > src.count:
            raise SystemExit(f"Band {band} out of range (raster has {src.count} band(s))")
        for feat in feats:
            geom = (feat or {}).get("geometry")
            props = dict((feat or {}).get("properties") or {})
            vals = np.array([], dtype="float64")
            if geom:
                shape = geom
                # rio_mask needs shapes in the raster's CRS; reproject when the zone
                # CRS differs so a WGS84 zone layer over a projected raster works.
                if zone_crs != src.crs:
                    shape = transform_geom(zone_crs, src.crs, geom)
                try:
                    # filled=False returns a masked array combining the dataset
                    # nodata mask with the outside-geometry mask, so a missing
                    # nodata value can't be mistaken for real data.
                    out_img, _ = rio_mask(src, [shape], crop=True, filled=False, indexes=band)
                    arr = np.ma.filled(out_img.astype("float64"), np.nan)
                    valid = (~np.ma.getmaskarray(out_img)) & np.isfinite(arr)
                    vals = arr[valid]
                except (ValueError, RasterioError):
                    # Geometry falls entirely outside the raster; report empty stats.
                    vals = np.array([], dtype="float64")
            n = int(vals.size)
            if n:
                with_data += 1
                props[prefix + "count"] = n
                props[prefix + "min"] = float(vals.min())
                props[prefix + "max"] = float(vals.max())
                props[prefix + "mean"] = float(vals.mean())
                props[prefix + "sum"] = float(vals.sum())
                props[prefix + "std"] = float(vals.std())
                props[prefix + "median"] = float(np.median(vals))
            else:
                props[prefix + "count"] = 0
                for key in ("min", "max", "mean", "sum", "std", "median"):
                    props[prefix + key] = None
            out_features.append({"type": "Feature", "properties": props, "geometry": geom})

    fc = {"type": "FeatureCollection", "features": out_features}
    zone_epsg = zone_crs.to_epsg()
    if zone_epsg and zone_epsg != 4326:
        fc["crs"] = {
            "type": "name",
            "properties": {"name": f"urn:ogc:def:crs:EPSG::{zone_epsg}"},
        }
    elif zone_epsg is None and zone_crs != CRS.from_epsg(4326):
        # A projected CRS with no EPSG mapping (e.g. custom WKT) would otherwise be
        # silently dropped, leaving consumers to assume WGS84; embed the WKT so the
        # true CRS travels with the output rather than being mislabeled.
        fc["crs"] = {"type": "name", "properties": {"name": zone_crs.to_wkt()}}
    with open(output_path, "w") as f:
        json.dump(fc, f)
    print(
        f"Computed zonal statistics for {len(out_features)} zone(s) "
        f"({with_data} with data) -> {output_path}"
    )
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
