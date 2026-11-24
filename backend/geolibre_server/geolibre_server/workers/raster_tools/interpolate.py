"""Raster processing worker for 'interpolate'."""


def main() -> None:
    import json
    import re
    import sys

    import numpy as np
    import rasterio
    from rasterio.crs import CRS
    from rasterio.transform import from_origin

    params = json.loads(sys.argv[1])
    input_path = params["input_path"]
    output_path = params["output_path"]
    field = str(params.get("field", "") or "").strip()
    if not field:
        raise SystemExit("Value field is required")
    method = str(params.get("method", "idw")).lower()
    resolution = float(params.get("resolution", 0) or 0)
    if resolution <= 0:
        raise SystemExit("Output pixel size (resolution) must be > 0")
    # Default to 2 only when absent/None; an explicit 0 must error rather than be
    # silently coerced to the default (0 ** 0 has no useful IDW meaning). The check
    # is gated on the method so a kriging request isn't rejected for an unused knob.
    _power = params.get("power", 2)
    power = float(2 if _power is None else _power)
    if method == "idw" and power <= 0:
        raise SystemExit("IDW power must be > 0")
    variogram_model = str(params.get("variogram_model", "spherical")).lower()
    nodata = -9999.0

    # Guards: keep the output grid and (for kriging) the dense linear system within
    # memory/time budgets. IDW is cheap, so it tolerates a much larger grid, but a
    # point cap still bounds its O(points x cells) work for pathological inputs.
    MAX_IDW_POINTS = 200_000
    MAX_CELLS_IDW = 6_000_000
    MAX_CELLS_KRIGE = 1_000_000
    MAX_KRIGE_POINTS = 1500

    # --- Load points -----------------------------------------------------------
    with open(input_path) as f:
        gj = json.load(f)
    gtype = gj.get("type")
    if gtype == "FeatureCollection":
        feats = gj.get("features", [])
    elif gtype == "Feature":
        feats = [gj]
    else:
        raise SystemExit("Input must be a GeoJSON Feature or FeatureCollection of points")

    xs, ys, zs = [], [], []
    skipped = 0
    for feat in feats:
        geom = (feat or {}).get("geometry") or {}
        if geom.get("type") != "Point":
            skipped += 1
            continue
        coords = geom.get("coordinates") or []
        if len(coords) < 2:
            skipped += 1
            continue
        val = ((feat or {}).get("properties") or {}).get(field)
        try:
            z = float(val)
        except (TypeError, ValueError):
            skipped += 1
            continue
        if not np.isfinite(z):
            skipped += 1
            continue
        xs.append(float(coords[0]))
        ys.append(float(coords[1]))
        zs.append(z)

    if len(zs) < 3:
        raise SystemExit(
            "Interpolation needs at least 3 point features with a numeric "
            f"'{field}' value (found {len(zs)})."
        )
    if method == "idw" and len(zs) > MAX_IDW_POINTS:
        raise SystemExit(
            f"IDW is capped at {MAX_IDW_POINTS} points (got {len(zs)}). "
            "Thin the layer or aggregate it first."
        )
    if skipped:
        print(f"Skipped {skipped} feature(s) without a Point geometry or numeric '{field}'.")

    px = np.asarray(xs, dtype="float64")
    py = np.asarray(ys, dtype="float64")
    pz = np.asarray(zs, dtype="float64")

    # --- Resolve CRS (explicit GeoJSON member, else WGS84 default) --------------
    epsg = 4326
    crs_member = gj.get("crs")
    if isinstance(crs_member, dict):
        name = crs_member.get("properties", {}).get("name", "")
        digits = re.search(r"(\d+)$", str(name))
        if digits:
            # digits matches ``(\d+)$``, so int() can never raise here.
            epsg = int(digits.group(1))
        elif name:
            # Consistent with the mask/zones sections: warn on a non-empty name we
            # could not interpret, stay silent for an absent/blank field.
            print(
                f"Warning: could not parse CRS '{name}'; assuming WGS84 (EPSG:4326)",
                file=sys.stderr,
            )
    try:
        crs = CRS.from_epsg(epsg)
    except Exception as exc:
        print(
            f"Warning: could not use EPSG:{epsg} ({exc}); assuming WGS84 (EPSG:4326)",
            file=sys.stderr,
        )
        crs = CRS.from_epsg(4326)

    # --- Build the output grid from the points' extent -------------------------
    minx, maxx = float(px.min()), float(px.max())
    miny, maxy = float(py.min()), float(py.max())
    # A degenerate extent (all points share an x or y) still needs a 1-cell span.
    if maxx <= minx:
        maxx = minx + resolution
    if maxy <= miny:
        maxy = miny + resolution
    width = max(1, int(np.ceil((maxx - minx) / resolution)))
    height = max(1, int(np.ceil((maxy - miny) / resolution)))
    cells = width * height
    cap = MAX_CELLS_KRIGE if method == "kriging" else MAX_CELLS_IDW
    if cells > cap:
        raise SystemExit(
            f"Output grid is {width}x{height} = {cells} cells, above the {cap} limit "
            f"for {method}. Increase the pixel size."
        )

    transform = from_origin(minx, maxy, resolution, resolution)
    gx = minx + (np.arange(width) + 0.5) * resolution
    gy = maxy - (np.arange(height) + 0.5) * resolution
    mesh_x, mesh_y = np.meshgrid(gx, gy)
    grid = np.column_stack([mesh_x.ravel(), mesh_y.ravel()])  # (M, 2)

    def interpolate_idw(grid_pts):
        out = np.empty(grid_pts.shape[0], dtype="float64")
        half_power = power / 2.0
        # Each chunk broadcasts several (chunk, n) float64 matrices. Size the chunk
        # so their combined peak stays near ~256 MB regardless of the sample count,
        # so a large point layer cannot OOM (unlike a fixed chunk). Capped at
        # 100_000 cells so small point sets still run in one or few passes.
        n = px.shape[0]
        chunk = max(1, min(100_000, 256_000_000 // (5 * 8 * n)))
        for i in range(0, grid_pts.shape[0], chunk):
            gp = grid_pts[i : i + chunk]
            dx = gp[:, 0:1] - px[None, :]
            dy = gp[:, 1:2] - py[None, :]
            d2 = dx * dx + dy * dy
            hit = d2 == 0
            hit_rows = hit.any(axis=1)
            # Normalize squared distances by each row's minimum nonzero distance
            # before exponentiation so high power values cannot overflow/underflow.
            nonzero_d2 = np.where(hit, np.inf, d2)
            row_scale = np.min(nonzero_d2, axis=1, keepdims=True)
            row_scale = np.where(np.isfinite(row_scale) & (row_scale > 0), row_scale, 1.0)
            scaled_d2 = d2 / row_scale
            with np.errstate(divide="ignore", over="ignore"):
                w = np.where(hit, 0.0, 1.0 / np.power(scaled_d2, half_power))
            wsum = w.sum(axis=1)
            safe_wsum = np.where(wsum > 0, wsum, 1.0)
            res = np.where(wsum > 0, (w * pz[None, :]).sum(axis=1) / safe_wsum, np.nan)
            # Cells coinciding with a sample assign the (first) coincident sample exactly.
            if hit_rows.any():
                res[hit_rows] = pz[np.argmax(hit[hit_rows], axis=1)]
            out[i : i + chunk] = res
        return out

    def _variogram_shape(h_over_r, name):
        """Normalised variogram shape (sill = 1) as a function of h / range."""
        if name == "exponential":
            return 1.0 - np.exp(-3.0 * h_over_r)
        if name == "gaussian":
            return 1.0 - np.exp(-3.0 * h_over_r * h_over_r)
        t = np.minimum(h_over_r, 1.0)
        if name == "linear":
            return t
        # spherical (default)
        return np.where(h_over_r >= 1.0, 1.0, 1.5 * t - 0.5 * t**3)

    def _fit_variogram(h, gamma, name, hmax):
        """Least-squares fit of nugget/sill/range over a coarse range sweep."""
        best = None
        for r in np.linspace(hmax * 0.1, hmax * 1.5, 25):
            shape = _variogram_shape(h / r, name)
            design = np.column_stack([np.ones_like(shape), shape])
            coef, *_ = np.linalg.lstsq(design, gamma, rcond=None)
            nugget = max(0.0, float(coef[0]))
            sill = max(1e-12, float(coef[1]))
            sse = float((((nugget + sill * shape) - gamma) ** 2).sum())
            # Keep the smallest range among (near-)equal fits: once every bin
            # sits below the range (e.g. a linear model), the SSE is flat in r
            # and floating-point noise alone would pick the winner, which the
            # browser engine could not reproduce.
            if best is None or sse < best[0] * (1.0 - 1e-9):
                best = (sse, float(r), sill, nugget)
        return best[1], best[2], best[3]

    def interpolate_kriging(grid_pts):
        n = px.shape[0]
        if n > MAX_KRIGE_POINTS:
            raise SystemExit(
                f"Ordinary kriging is capped at {MAX_KRIGE_POINTS} points (got {n}). "
                "Use IDW for larger point sets."
            )
        pts = np.column_stack([px, py])
        diff = pts[:, None, :] - pts[None, :, :]
        dist = np.sqrt((diff * diff).sum(axis=2))  # (n, n)

        iu = np.triu_indices(n, k=1)
        h = dist[iu]
        gamma = 0.5 * (pz[iu[0]] - pz[iu[1]]) ** 2
        hmax = float(h.max())
        if hmax <= 0:
            raise SystemExit("All points are coincident; cannot krige.")
        nbins = 12
        edges = np.linspace(0.0, hmax, nbins + 1)
        centers = 0.5 * (edges[:-1] + edges[1:])
        which = np.clip(np.digitize(h, edges) - 1, 0, nbins - 1)
        emp = np.array(
            [gamma[which == b].mean() if np.any(which == b) else np.nan for b in range(nbins)]
        )
        valid = ~np.isnan(emp)
        # The clip above maps every pair into [0, nbins-1], so with >= 3 points at
        # least one bin is populated; the guard makes that contract explicit rather
        # than letting an all-empty histogram degenerate the fit silently.
        if not valid.any():
            raise SystemExit("Could not build an empirical semivariogram from the points.")
        rng, sill, nugget = _fit_variogram(centers[valid], emp[valid], variogram_model, hmax)
        print(
            f"Variogram ({variogram_model}): range={rng:.4g}, sill={sill:.4g}, nugget={nugget:.4g}"
        )

        def model(hh):
            g = nugget + sill * _variogram_shape(hh / rng, variogram_model)
            return np.where(hh <= 0, 0.0, g)

        # Ordinary-kriging LHS: semivariances among samples with a unit-bias row/col
        # and a zero corner (the Lagrange multiplier). `model` returns 0 for h <= 0,
        # so the self-pair diagonal is 0 (nugget excluded there) and the surface
        # honours the samples exactly — pykrige's default `exact_values` behaviour.
        big = np.ones((n + 1, n + 1), dtype="float64")
        big[:n, :n] = model(dist)
        big[n, n] = 0.0
        big_inv = np.linalg.pinv(big)

        out = np.empty(grid_pts.shape[0], dtype="float64")
        chunk = 4096
        for i in range(0, grid_pts.shape[0], chunk):
            gp = grid_pts[i : i + chunk]
            dxt = gp[:, 0:1] - px[None, :]
            dyt = gp[:, 1:2] - py[None, :]
            dt = np.sqrt(dxt * dxt + dyt * dyt)  # (m, n)
            rhs = np.empty((n + 1, gp.shape[0]), dtype="float64")
            rhs[:n, :] = model(dt).T
            rhs[n, :] = 1.0
            weights = big_inv @ rhs  # (n + 1, m)
            predicted = pz @ weights[:n, :]
            # Keep exact-values semantics when a Gaussian system loses
            # precision in the pseudoinverse. As with IDW, the first sample
            # wins when several observations share the output coordinate.
            hit = dt == 0
            hit_rows = hit.any(axis=1)
            if hit_rows.any():
                predicted[hit_rows] = pz[np.argmax(hit[hit_rows], axis=1)]
            out[i : i + chunk] = predicted
        return out

    if method == "kriging":
        values = interpolate_kriging(grid)
    elif method == "idw":
        values = interpolate_idw(grid)
    else:
        raise SystemExit(f"Unknown interpolation method: {method}")

    surface = values.reshape(height, width).astype("float32")
    surface = np.where(np.isfinite(surface), surface, nodata).astype("float32")

    profile = {
        "driver": "GTiff",
        "height": height,
        "width": width,
        "count": 1,
        "dtype": "float32",
        "crs": crs,
        "transform": transform,
        "nodata": nodata,
        "compress": "deflate",
    }
    with rasterio.open(output_path, "w", **profile) as dst:
        dst.write(surface, 1)
    print(
        f"Interpolated {len(zs)} points ({method}) into a {width}x{height} raster -> {output_path}"
    )
    print("__GEOLIBRE_CONVERSION_RESULT__" + json.dumps({"output_path": output_path}))


if __name__ == "__main__":
    main()
