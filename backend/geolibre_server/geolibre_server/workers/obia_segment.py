"""Run OBIA segmentation and write segment polygons."""


def main() -> None:
    import json
    import os
    import sys
    import time

    from geolibre_server.workers.obia_common import read_area as _read_area
    from geolibre_server.workers.obia_common import segment as _segment
    from geolibre_server.workers.obia_common import write_labels

    params = json.loads(sys.argv[1])
    seg = params["segmentation"]
    out_dir = params["out_dir"]
    MAX_PIXELS = params["max_pixels"]

    def read_area():
        return _read_area(seg, MAX_PIXELS)

    def segment(data, valid):
        return _segment(seg, data, valid)

    from rasterio.features import shapes
    from rasterio.warp import transform as warp_transform

    started = time.time()
    data, valid, transform, crs = read_area()
    print(f"Read {data.shape[2]} x {data.shape[1]} pixels, {data.shape[0]} bands", flush=True)
    labels = segment(data, valid)
    count = int(labels.max())
    print(f"Segmented into {count} objects in {time.time() - started:.1f} s", flush=True)
    write_labels(labels, transform, crs, os.path.join(out_dir, "segments.tif"))

    # One feature per object: the pieces of a label (an object can touch itself
    # only diagonally) gathered into one geometry, in WGS84 like the browser's.
    pieces = {}
    for geometry, value in shapes(labels, mask=labels > 0, connectivity=4, transform=transform):
        pieces.setdefault(int(value), []).append(geometry["coordinates"])
    print(f"Polygonized {len(pieces)} objects", flush=True)

    # Reproject every vertex in one call: per-geometry reprojection rebuilds the
    # transformation each time and dominates the run for tens of thousands of
    # objects.
    if crs is not None and crs.to_epsg() != 4326:
        xs, ys = [], []
        for polygons in pieces.values():
            for polygon in polygons:
                for ring in polygon:
                    for x, y in ring:
                        xs.append(x)
                        ys.append(y)
        lons, lats = warp_transform(crs, "EPSG:4326", xs, ys)
        position = 0
        for polygons in pieces.values():
            for polygon in polygons:
                for r, ring in enumerate(polygon):
                    n = len(ring)
                    polygon[r] = list(
                        zip(lons[position : position + n], lats[position : position + n])
                    )
                    position += n

    def rounded(coords):
        return [[[round(x, 7), round(y, 7)] for x, y in ring] for ring in coords]

    with open(os.path.join(out_dir, "objects.geojson"), "w", encoding="utf-8") as out:
        out.write('{"type":"FeatureCollection","features":[')
        first = True
        for label in sorted(pieces):
            polygons = pieces[label]
            geometry = (
                {"type": "Polygon", "coordinates": rounded(polygons[0])}
                if len(polygons) == 1
                else {"type": "MultiPolygon", "coordinates": [rounded(p) for p in polygons]}
            )
            feature = {
                "type": "Feature",
                "id": label,
                "properties": {"segment_id": label},
                "geometry": geometry,
            }
            out.write(("" if first else ",") + json.dumps(feature, separators=(",", ":")))
            first = False
        out.write("]}")

    result = {
        "object_count": count,
        "width": int(labels.shape[1]),
        "height": int(labels.shape[0]),
        "pixel_size": abs(float(transform.a)),
        "seconds": round(time.time() - started, 1),
    }
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps(result))


if __name__ == "__main__":
    main()
