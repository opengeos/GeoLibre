"""Raster processing worker for 'reclassify'."""


def main() -> None:
    import json
    import re
    import sys

    import numpy as np
    import rasterio

    params = json.loads(sys.argv[1])
    input_path = params["input_path"]
    output_path = params["output_path"]
    band = int(params.get("band", 1))
    table = str(params.get("table", "") or "").strip()
    if not table:
        raise SystemExit("Reclassification table is required")
    # What to do with values matching no rule: emit nodata (default) or keep the
    # original value untouched.
    unmatched = str(params.get("unmatched", "nodata")).lower()
    nodata = -9999.0

    rules = []
    for token in re.split(r"[,;\n]+", table):
        token = token.strip()
        if not token:
            continue
        parts = token.split(":")
        if len(parts) != 3:
            raise SystemExit(f"Bad rule '{token}'. Use 'min:max:newvalue' (e.g. '0:10:1').")
        lo_raw, hi_raw, nv_raw = (p.strip() for p in parts)
        lo = -np.inf if lo_raw.lower() in ("", "min", "-inf") else float(lo_raw)
        hi = np.inf if hi_raw.lower() in ("", "max", "inf") else float(hi_raw)
        try:
            nv = float(nv_raw)
        except ValueError:
            raise SystemExit(f"Bad new value in rule '{token}'")
        rules.append((lo, hi, nv))
    if not rules:
        raise SystemExit("No reclassification rules parsed")

    with rasterio.open(input_path) as src:
        if band < 1 or band > src.count:
            raise SystemExit(f"Band {band} out of range (raster has {src.count} band(s))")
        arr = src.read(band, masked=True).astype("float64")
        profile = src.profile.copy()

    data = np.ma.filled(arr, np.nan)
    out = np.full(data.shape, np.nan, dtype="float64")
    # Earlier rules win on overlap: apply in reverse so the first rule's assignment
    # is written last and survives.
    for lo, hi, nv in reversed(rules):
        # Half-open [lo, hi): a value equal to a class's upper bound belongs to the
        # next class, avoiding double assignment at shared edges.
        out[(data >= lo) & (data < hi)] = nv
    if unmatched == "original":
        keep = np.isnan(out) & np.isfinite(data)
        out[keep] = data[keep]

    result = np.where(np.isfinite(out), out, nodata).astype("float32")
    profile.update(count=1, dtype="float32", nodata=nodata, compress="deflate")
    profile.pop("photometric", None)
    with rasterio.open(output_path, "w", **profile) as dst:
        dst.write(result, 1)
    print(f"Reclassified band {band} with {len(rules)} rule(s) -> {output_path}")
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
