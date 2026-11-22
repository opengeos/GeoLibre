"""Raster processing worker for 'focal'."""


def main() -> None:
    import json
    import sys

    import numpy as np
    import rasterio

    params = json.loads(sys.argv[1])
    input_path = params["input_path"]
    output_path = params["output_path"]
    band = int(params.get("band", 1))
    size = int(params.get("size", 3))
    if size < 3 or size % 2 == 0:
        raise SystemExit("Window size must be an odd integer >= 3")
    if size > 25:
        raise SystemExit("Window size is capped at 25")
    stat = str(params.get("statistic", "mean")).lower()
    allowed = {"mean", "median", "min", "max", "sum", "std", "range"}
    if stat not in allowed:
        raise SystemExit(f"Unsupported statistic: {stat}")
    nodata = -9999.0

    with rasterio.open(input_path) as src:
        if band < 1 or band > src.count:
            raise SystemExit(f"Band {band} out of range (raster has {src.count} band(s))")
        data = np.ma.filled(src.read(band, masked=True).astype("float32"), np.nan)
        profile = src.profile.copy()

    height, width = data.shape
    radius = size // 2

    def neighbor(dy, dx):
        # ``out[i, j] = data[i + dy, j + dx]`` with out-of-bounds neighbours set to
        # NaN (so edge windows aggregate only the cells that exist).
        out = np.roll(np.roll(data, -dy, axis=0), -dx, axis=1)
        if dy > 0:
            out[-dy:, :] = np.nan
        elif dy < 0:
            out[:-dy, :] = np.nan
        if dx > 0:
            out[:, -dx:] = np.nan
        elif dx < 0:
            out[:, :-dx] = np.nan
        return out

    offsets = [(dy, dx) for dy in range(-radius, radius + 1) for dx in range(-radius, radius + 1)]

    with np.errstate(all="ignore"):
        if stat == "median":
            # Median has no streaming form, so it stacks the neighbour copies
            # (size*size float32 layers). Cap the stack at ~480 MB so it can't OOM
            # the runtime; the streaming statistics below have no such limit.
            MAX_MEDIAN_CELLS = 120_000_000
            max_pixels = MAX_MEDIAN_CELLS // (size * size)
            if height * width > max_pixels:
                side = int(max_pixels**0.5)
                raise SystemExit(
                    f"Focal median with a {size}x{size} window is limited to "
                    f"{max_pixels:,} pixels (~{side}x{side}); this raster is "
                    f"{width}x{height}. Use a smaller window, crop the raster, or pick "
                    "a streaming statistic (mean/min/max/sum/std/range)."
                )
            stack = np.stack([neighbor(dy, dx) for dy, dx in offsets], axis=0)
            res = np.nanmedian(stack, axis=0)
            has_data = np.sum(np.isfinite(stack), axis=0) > 0
        else:
            # Streaming accumulators keep memory at O(cells) regardless of window
            # size, so this scales to full-resolution rasters with large windows.
            count = np.zeros((height, width), dtype="int32")
            total = np.zeros((height, width), dtype="float64")
            sumsq = np.zeros((height, width), dtype="float64")
            vmin = np.full((height, width), np.inf, dtype="float64")
            vmax = np.full((height, width), -np.inf, dtype="float64")
            for dy, dx in offsets:
                nb = neighbor(dy, dx)
                valid = np.isfinite(nb)
                count += valid
                contrib = np.where(valid, nb, 0.0)
                total += contrib
                sumsq += contrib * contrib
                vmin = np.fmin(vmin, nb)
                vmax = np.fmax(vmax, nb)
            has_data = count > 0
            safe_count = np.where(count == 0, 1, count)
            if stat == "mean":
                res = total / safe_count
            elif stat == "sum":
                res = total
            elif stat == "min":
                res = vmin
            elif stat == "max":
                res = vmax
            elif stat == "range":
                res = vmax - vmin
            else:  # std (population)
                mean_ = total / safe_count
                res = np.sqrt(np.maximum(sumsq / safe_count - mean_ * mean_, 0.0))

    # Windows with no valid cells get nodata uniformly (rather than 0 or inf).
    res = np.where(has_data, res, np.nan)
    out = np.where(np.isfinite(res), res, nodata).astype("float32")
    profile.update(count=1, dtype="float32", nodata=nodata, compress="deflate")
    profile.pop("photometric", None)
    with rasterio.open(output_path, "w", **profile) as dst:
        dst.write(out, 1)
    print(f"Focal {stat} ({size}x{size}) -> {output_path}")
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
