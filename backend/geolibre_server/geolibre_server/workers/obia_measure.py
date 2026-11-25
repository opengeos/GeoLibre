"""Measure OBIA segment attributes against bands."""


def main() -> None:
    import json
    import os
    import sys
    import time

    import numpy as np
    import rasterio

    from geolibre_server.workers.obia_common import read_area as _read_area
    from geolibre_server.workers.obia_common import segment as _segment

    params = json.loads(sys.argv[1])
    seg = params["segmentation"]
    out_dir = params["out_dir"]
    MAX_PIXELS = params["max_pixels"]

    def read_area():
        return _read_area(seg, MAX_PIXELS)

    def segment(data, valid):
        return _segment(seg, data, valid)

    from scipy import ndimage

    started = time.time()
    data, valid, transform, crs = read_area()
    labels_path = params.get("labels_path")
    if labels_path and os.path.exists(labels_path):
        with rasterio.open(labels_path) as src:
            labels = src.read(1)
        if labels.shape != data.shape[1:]:
            raise SystemExit("The objects no longer match the image. Segment again.")
    else:
        print("Re-segmenting: the segmentation's files are gone", flush=True)
        labels = segment(data, valid)
    n = int(labels.max())
    ids = np.arange(1, n + 1)
    flat = labels.ravel()
    count = np.bincount(flat, minlength=n + 1).astype("float64")
    present = count[1:] > 0
    columns = {}
    options = params["options"]
    band_names = seg["bands"]

    if options.get("spectral"):
        for b, band in zip(band_names, data):
            # One band at a time, freeing its temporaries: at the pixel limit each
            # float64 copy is about a gigabyte.
            values = band.ravel().astype("float64")
            total = np.bincount(flat, weights=values, minlength=n + 1)
            np.multiply(values, values, out=values)
            squares = np.bincount(flat, weights=values, minlength=n + 1)
            del values
            with np.errstate(invalid="ignore", divide="ignore"):
                mean = total / count
                std = np.sqrt(np.maximum(squares / count - mean * mean, 0))
            columns[f"mean_b{b}"] = mean[1:]
            columns[f"std_b{b}"] = std[1:]
            columns[f"min_b{b}"] = np.asarray(ndimage.minimum(band, labels, ids))
            columns[f"max_b{b}"] = np.asarray(ndimage.maximum(band, labels, ids))
            del total, squares, mean, std
        if not options.get("shape"):
            columns["area_px"] = count[1:]

    # Pixel edges between differing labels, both ways, for perimeter and context.
    pairs = []
    for a, c in ((labels[:, :-1], labels[:, 1:]), (labels[:-1, :], labels[1:, :])):
        differ = a != c
        pairs.append((a[differ], c[differ]))

    if options.get("shape"):
        # Perimeter in pixel edges: edges to another label or to the image border.
        perimeter = np.zeros(n + 1)
        for a, c in pairs:
            perimeter += np.bincount(a, minlength=n + 1) + np.bincount(c, minlength=n + 1)
        for edge in (labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]):
            perimeter += np.bincount(edge, minlength=n + 1)
        width = np.zeros(n)
        height = np.zeros(n)
        for i, box in enumerate(ndimage.find_objects(labels, max_label=n)):
            if box is not None:
                height[i] = box[0].stop - box[0].start
                width[i] = box[1].stop - box[1].start
        area = count[1:]
        with np.errstate(invalid="ignore", divide="ignore"):
            columns["area_px"] = area
            columns["perimeter_px"] = perimeter[1:]
            columns["compactness"] = 4 * np.pi * area / (perimeter[1:] ** 2)
            columns["bbox_width_px"] = width
            columns["bbox_height_px"] = height
            columns["elongation"] = np.maximum(width, height) / np.minimum(width, height)

    if options.get("context"):
        # Shared edges between two objects (not with NoData).
        a = np.concatenate([p[0] for p in pairs])
        c = np.concatenate([p[1] for p in pairs])
        keep = (a > 0) & (c > 0)
        a, c = a[keep].astype("int64"), c[keep].astype("int64")
        shared = np.bincount(a, minlength=n + 1) + np.bincount(c, minlength=n + 1)
        lo, hi = np.minimum(a, c), np.maximum(a, c)
        unique = np.unique(lo * (n + 1) + hi)
        neighbors = np.bincount(unique // (n + 1), minlength=n + 1) + np.bincount(
            unique % (n + 1), minlength=n + 1
        )
        with np.errstate(invalid="ignore", divide="ignore"):
            columns["neighbor_count"] = neighbors[1:].astype("float64")
            columns["shared_boundary_total"] = shared[1:].astype("float64")
            columns["mean_shared_boundary"] = np.where(
                neighbors[1:] > 0, shared[1:] / np.maximum(neighbors[1:], 1), 0.0
            )

    names = list(columns)
    with open(os.path.join(out_dir, "features.csv"), "w", encoding="utf-8") as out:
        out.write(",".join(["segment_id", *names]) + "\n")
        for i in np.flatnonzero(present):
            cells = []
            for name in names:
                value = float(columns[name][i])
                cells.append("" if not np.isfinite(value) else format(value, ".10g"))
            out.write(f"{i + 1}," + ",".join(cells) + "\n")

    result = {
        "object_count": int(present.sum()),
        "fields": names,
        "seconds": round(time.time() - started, 1),
    }
    print(f"Measured {len(names)} features for {int(present.sum())} objects", flush=True)
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps(result))


if __name__ == "__main__":
    main()
