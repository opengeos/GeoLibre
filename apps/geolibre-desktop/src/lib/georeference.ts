/**
 * Pure georeferencing math for the Raster Georeferencer: fit an affine transform
 * from ground control points (GCPs) that link image pixels to map coordinates,
 * then project the image's corners to map space for a corner-pinned overlay.
 *
 * Side-effect free so it can be unit tested without a DOM or the map. The dialog
 * (GeoreferencerDialog.tsx) handles file loading, GCP placement, and adding the
 * resulting `image` overlay layer to the store.
 *
 * An affine fit (6 parameters, >= 3 non-collinear GCPs) maps a parallelogram, so
 * MapLibre's 4-corner `image` source renders it exactly. Polynomial/TPS warps
 * (which need true raster resampling) are a rasterio-sidecar follow-up.
 */

/** A ground control point: image pixel (px, py) ↔ map coordinate (lng, lat). */
export interface GCP {
  px: number;
  py: number;
  lng: number;
  lat: number;
}

/**
 * Affine transform mapping image pixels to map coordinates:
 *   lng = a·px + b·py + c
 *   lat = d·px + e·py + f
 */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export type LngLat = [number, number];

/** The minimum GCPs needed to fit an affine transform. */
export const MIN_GCPS = 3;

/** Invert a 3×3 matrix; returns null when (near-)singular. */
function invert3x3(m: number[][]): number[][] | null {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  // Relative singularity test: the determinant of a 3×3 scales as (matrix
  // magnitude)³, so an absolute epsilon misses near-collinear configs when the
  // pixel coordinates are large. Scale the threshold by the matrix norm.
  const scale = Math.max(
    Math.abs(a),
    Math.abs(b),
    Math.abs(c),
    Math.abs(d),
    Math.abs(e),
    Math.abs(f),
    Math.abs(g),
    Math.abs(h),
    Math.abs(i),
    1,
  );
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12 * scale ** 3) return null;
  const inv = 1 / det;
  return [
    [A * inv, (c * h - b * i) * inv, (b * f - c * e) * inv],
    [B * inv, (a * i - c * g) * inv, (c * d - a * f) * inv],
    [C * inv, (b * g - a * h) * inv, (a * e - b * d) * inv],
  ];
}

/**
 * Least-squares fit of one coordinate axis: solve the 3×3 normal equations
 * (AᵀA)·[p,q,r] = Aᵀ·t for rows [px, py, 1]. Shared `ata`/`ataInv` come from the
 * caller so both axes reuse the same (already-inverted) normal matrix.
 */
function solveAxis(gcps: GCP[], ataInv: number[][], target: (g: GCP) => number) {
  const atb = [0, 0, 0];
  for (const g of gcps) {
    const t = target(g);
    atb[0] += g.px * t;
    atb[1] += g.py * t;
    atb[2] += t;
  }
  return [
    ataInv[0][0] * atb[0] + ataInv[0][1] * atb[1] + ataInv[0][2] * atb[2],
    ataInv[1][0] * atb[0] + ataInv[1][1] * atb[1] + ataInv[1][2] * atb[2],
    ataInv[2][0] * atb[0] + ataInv[2][1] * atb[1] + ataInv[2][2] * atb[2],
  ];
}

/**
 * Fit an affine transform from GCPs by least squares. Returns null with fewer
 * than {@link MIN_GCPS} points or when they're collinear/degenerate (singular
 * normal matrix).
 */
export function solveAffine(gcps: GCP[]): Affine | null {
  if (gcps.length < MIN_GCPS) return null;
  // AᵀA for rows [px, py, 1] — symmetric 3×3.
  let sxx = 0;
  let sxy = 0;
  let sx = 0;
  let syy = 0;
  let sy = 0;
  const n = gcps.length;
  for (const g of gcps) {
    sxx += g.px * g.px;
    sxy += g.px * g.py;
    sx += g.px;
    syy += g.py * g.py;
    sy += g.py;
  }
  const ata = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const ataInv = invert3x3(ata);
  if (!ataInv) return null;
  const [a, b, c] = solveAxis(gcps, ataInv, (g) => g.lng);
  const [d, e, f] = solveAxis(gcps, ataInv, (g) => g.lat);
  if (![a, b, c, d, e, f].every(Number.isFinite)) return null;
  return { a, b, c, d, e, f };
}

/** Apply an affine transform to an image pixel, returning [lng, lat]. */
export function applyAffine(t: Affine, px: number, py: number): LngLat {
  return [t.a * px + t.b * py + t.c, t.d * px + t.e * py + t.f];
}

/** True when every corner is a finite [lng, lat] within world bounds. */
export function cornersInRange(corners: LngLat[]): boolean {
  return corners.every(
    ([lng, lat]) =>
      Number.isFinite(lng) &&
      Number.isFinite(lat) &&
      lng >= -180 &&
      lng <= 180 &&
      lat >= -90 &&
      lat <= 90,
  );
}

/**
 * Project the four image corners to map space, in the order MapLibre's `image`
 * source expects: top-left, top-right, bottom-right, bottom-left. Image pixel
 * (0,0) is the top-left; y increases downward.
 */
export function imageCornersToMap(
  t: Affine,
  width: number,
  height: number,
): { tl: LngLat; tr: LngLat; br: LngLat; bl: LngLat } {
  return {
    tl: applyAffine(t, 0, 0),
    tr: applyAffine(t, width, 0),
    br: applyAffine(t, width, height),
    bl: applyAffine(t, 0, height),
  };
}

/** Great-circle distance between two lng/lat points, in metres. */
export function haversineMeters(a: LngLat, b: LngLat): number {
  const R = 6371008.8; // mean Earth radius (metres)
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface ResidualReport {
  /** Per-GCP residual in metres (same order as the input GCPs). */
  perPoint: number[];
  /** Root-mean-square residual in metres. */
  rms: number;
}

/**
 * Residual of each GCP against the fitted transform: the ground distance between
 * where the transform places the pixel and the GCP's actual map point, in metres.
 */
export function gcpResidualsMeters(t: Affine, gcps: GCP[]): ResidualReport {
  const perPoint = gcps.map((g) => haversineMeters(applyAffine(t, g.px, g.py), [g.lng, g.lat]));
  const rms = perPoint.length
    ? Math.sqrt(perPoint.reduce((sum, r) => sum + r * r, 0) / perPoint.length)
    : 0;
  return { perPoint, rms };
}

/** Axis-aligned bounds [west, south, east, north] enclosing the corners. */
export function cornersToBounds(corners: LngLat[]): [number, number, number, number] {
  const lngs = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

/** Warp method for GeoTIFF export. */
export type GeoTransform = "affine" | "polynomial" | "tps";

/**
 * Minimum GCPs a warp method needs to be well-posed: affine needs 3, GDAL's
 * order-2 polynomial needs 6, and a thin plate spline needs at least 4 to avoid
 * a degenerate system. Below these, gdalwarp errors.
 */
export function minGcpsForTransform(transform: GeoTransform): number {
  if (transform === "polynomial") return 6;
  if (transform === "tps") return 4;
  return MIN_GCPS;
}

/**
 * gdal_translate args that stamp the GCPs (in EPSG:4326) onto the source raster.
 * GDAL's `-gcp` order is `<pixelX> <pixelY> <X> <Y>` = px, py, lng, lat.
 */
export function buildGcpTranslateArgs(gcps: GCP[]): string[] {
  // `-of GTiff` is required: gdal3.js derives the output file's driver/extension
  // from it (without it the intermediate becomes `*.unknown` and GDAL errors).
  const args = ["-of", "GTiff", "-a_srs", "EPSG:4326"];
  for (const g of gcps) {
    args.push("-gcp", String(g.px), String(g.py), String(g.lng), String(g.lat));
  }
  return args;
}

/** gdalwarp args for a GCP-based warp to a Cloud-Optimized GeoTIFF. */
export function warpArgsForTransform(transform: GeoTransform): string[] {
  const method =
    transform === "tps" ? ["-tps"] : transform === "polynomial" ? ["-order", "2"] : ["-order", "1"];
  return [...method, "-t_srs", "EPSG:4326", "-r", "bilinear", "-of", "COG"];
}

/** Header for the GCP CSV exchange format. */
export const GCP_CSV_HEADER = "pixelX,pixelY,lng,lat";

/** Serialize GCPs to a CSV string (pixelX,pixelY,lng,lat) for export. */
export function gcpsToCsv(gcps: GCP[]): string {
  const rows = gcps.map((g) => `${g.px},${g.py},${g.lng},${g.lat}`);
  return [GCP_CSV_HEADER, ...rows].join("\n") + "\n";
}

/**
 * Parse a GCP CSV (as written by {@link gcpsToCsv}). Tolerant: skips a header
 * row, blank lines, `#` comments, and any row that isn't four valid numbers or
 * whose lng/lat fall outside world bounds.
 */
export function parseGcpsCsv(text: string): GCP[] {
  const out: GCP[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(",");
    if (parts.length < 4) continue;
    const [px, py, lng, lat] = parts.map((p) => Number(p.trim()));
    if (![px, py, lng, lat].every(Number.isFinite)) continue; // skips the header
    if (px < 0 || py < 0) continue; // pixel coords can't be negative
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) continue;
    out.push({ px, py, lng, lat });
  }
  return out;
}
