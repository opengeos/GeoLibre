"""Shared raster reading, segmentation, and label writing for OBIA workers."""

from __future__ import annotations

import numpy as np
import rasterio
from rasterio.windows import Window


def read_area(seg: dict, max_pixels: int):
    """Read requested bands over the configured area window and return validity mask."""
    path = seg["input_path"]
    bands = seg["bands"]
    with rasterio.open(path) as full:
        width, height, count = full.width, full.height, full.count
        nodata = full.nodata
        if full.crs is None:
            # Objects are written in WGS84: without a CRS they cannot be placed.
            # Checked before any pixels are read.
            raise SystemExit("The image has no coordinate reference system.")
    missing = [b for b in bands if b < 1 or b > count]
    if missing:
        raise SystemExit(f"The image has no band {missing[0]}.")
    area = seg.get("area") or {"level": 0, "window": [0, 0, width, height]}
    level = area["level"]
    x0, y0, x1, y1 = area["window"]
    # Overview n of the file is level n; GDAL numbers overviews from 0.
    opener = {"overview_level": level - 1} if level > 0 else {}
    try:
        src = rasterio.open(path, **opener)
    except Exception:
        raise SystemExit(f"The image has no overview level {level}.") from None
    with src:
        sx = width / src.width
        sy = height / src.height
        wx0 = max(0, int(np.floor(x0 / sx)))
        wy0 = max(0, int(np.floor(y0 / sy)))
        wx1 = min(src.width, int(np.ceil(x1 / sx)))
        wy1 = min(src.height, int(np.ceil(y1 / sy)))
        if wx1 <= wx0 or wy1 <= wy0:
            raise SystemExit("The area to read does not overlap the image.")
        if (wx1 - wx0) * (wy1 - wy0) > max_pixels:
            raise SystemExit(
                f"The area has {wx1 - wx0} x {wy1 - wy0} pixels, over the native limit "
                f"of {max_pixels:,} pixels. Zoom in or use a coarser overview."
            )
        window = Window(wx0, wy0, wx1 - wx0, wy1 - wy0)
        data = src.read(bands, window=window, out_dtype="float32")
        transform = src.window_transform(window)
        crs = src.crs
    valid = np.all(np.isfinite(data), axis=0)
    if nodata is not None:
        # Compare in the data's precision: a NoData value such as 0.1 has no
        # exact float32 form, and a float64 comparison would match nothing.
        valid &= np.all(data != np.float32(nodata), axis=0)
    return data, valid, transform, crs


def segment(seg: dict, data, valid):
    """Standardize valid pixels and segment with SLIC or Felzenszwalb."""
    from skimage.segmentation import felzenszwalb, relabel_sequential, slic

    # Standardize each band over the valid pixels, so no band dominates.
    image = np.empty(data.shape[1:] + (data.shape[0],), dtype="float32")
    for i, band in enumerate(data):
        values = band[valid]
        mean = float(values.mean()) if values.size else 0.0
        std = float(values.std()) if values.size else 1.0
        image[..., i] = (band - mean) / (std or 1.0)
    image[~valid] = 0
    if seg["method"] == "slic":
        p = seg["slic"]
        n = max(1, int(valid.sum() / p["size"]))
        # No mask: with one, SLIC seeds by k-means over every masked pixel,
        # which takes hours at this size even for a handful of NoData pixels.
        # NoData is zero after standardizing, and its labels are cleared below.
        labels = slic(
            image,
            n_segments=n,
            compactness=p["compactness"],
            channel_axis=-1,
            start_label=1,
            convert2lab=False,
            enforce_connectivity=True,
        )
    else:
        p = seg["felzenszwalb"]
        labels = (
            felzenszwalb(
                image,
                scale=p["scale"],
                sigma=p["sigma"],
                min_size=p["min_size"],
                channel_axis=-1,
            )
            + 1
        )
    labels = labels.astype("int32")
    labels[~valid] = 0
    labels, _, _ = relabel_sequential(labels)
    return labels.astype("int32")


def write_labels(labels, transform, crs, path: str) -> None:
    """Write an int32 segmentation label raster to disk."""
    profile = {
        "driver": "GTiff",
        "width": labels.shape[1],
        "height": labels.shape[0],
        "count": 1,
        "dtype": "int32",
        "crs": crs,
        "transform": transform,
        "nodata": 0,
        "compress": "deflate",
        "tiled": labels.shape[1] >= 256 and labels.shape[0] >= 256,
    }
    if profile["tiled"]:
        profile.update(blockxsize=256, blockysize=256)
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(labels, 1)
