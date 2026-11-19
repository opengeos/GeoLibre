/**
 * Reproject a rendered GeoPDF frame into Web Mercator when placing it by its
 * four corners would bend it (GH #3523).
 *
 * The map draws an image layer as a quad between its corners in Web Mercator,
 * which is exact only when the frame's pixels are an affine view of Mercator.
 * A Web Mercator GeoPDF always is, and a city-scale UTM sheet nearly is, but a
 * geographic (lat/lon) sheet spanning tens of degrees is not: its interior
 * would drift by many pixels. Such a frame is resampled into a north-up
 * Mercator raster, so its corners describe it exactly.
 *
 * Pure (no DOM), so it is unit tested under node.
 */

const R = 6378137;
const MAX_LAT = 85.0511287798066;

/** Longitude/latitude to Web Mercator metres. */
export function lngLatToMercator(lng: number, lat: number): [number, number] {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return [
    (R * lng * Math.PI) / 180,
    R * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)),
  ];
}

/** Web Mercator metres to longitude/latitude. */
export function mercatorToLngLat(x: number, y: number): [number, number] {
  return [
    (x / R) * (180 / Math.PI),
    (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI),
  ];
}

/**
 * Whether an image's pixels are an affine view of Web Mercator, to within
 * `tolerancePx`: the corner-placed quad then shows every pixel in place.
 *
 * Args:
 *   width: Image width in pixels.
 *   height: Image height in pixels.
 *   toLngLat: Longitude/latitude of an image pixel.
 *   tolerancePx: How far, in image pixels, an interior point may miss.
 *
 * Returns:
 *   True when corner placement is exact enough.
 */
export function isAffineInMercator(
  width: number,
  height: number,
  toLngLat: (px: number, py: number) => [number, number],
  tolerancePx = 0.5,
): boolean {
  const merc = (px: number, py: number) => lngLatToMercator(...toLngLat(px, py));
  const o = merc(0, 0);
  const r = merc(width, 0);
  const d = merc(0, height);
  const b = [(r[0] - o[0]) / width, (r[1] - o[1]) / width];
  const c = [(d[0] - o[0]) / height, (d[1] - o[1]) / height];
  const det = b[0] * c[1] - c[0] * b[1];
  if (!Number.isFinite(det) || det === 0) return false;
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const px = (i / steps) * width;
      const py = (j / steps) * height;
      const [x, y] = merc(px, py);
      const dx = x - o[0];
      const dy = y - o[1];
      // Back into pixels through the inverse of the corner-fitted affine.
      const backX = (c[1] * dx - c[0] * dy) / det;
      const backY = (-b[1] * dx + b[0] * dy) / det;
      if (!Number.isFinite(backX) || Math.hypot(backX - px, backY - py) > tolerancePx) return false;
    }
  }
  return true;
}

/** A north-up Web Mercator raster a frame is resampled into. */
export interface MercatorWarpPlan {
  width: number;
  height: number;
  /** `[minX, minY, maxX, maxY]` in Web Mercator metres. */
  extent: [number, number, number, number];
}

/**
 * The Mercator raster that holds a frame: the extent of its outline (sampled
 * along every edge, since edges bend) at about the source's resolution.
 *
 * Args:
 *   width: Source width in pixels.
 *   height: Source height in pixels.
 *   toLngLat: Longitude/latitude of a source pixel.
 *   maxSide: The longest side the output may have.
 *
 * Returns:
 *   The output raster's size and extent.
 */
export function planMercatorWarp(
  width: number,
  height: number,
  toLngLat: (px: number, py: number) => [number, number],
  maxSide: number,
): MercatorWarpPlan {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (px: number, py: number) => {
    const [x, y] = lngLatToMercator(...toLngLat(px, py));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  const steps = 64;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    add(t * width, 0);
    add(t * width, height);
    add(0, t * height);
    add(width, t * height);
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  // Keep about the source's pixel count, capped by maxSide.
  const sourceSide = Math.max(width, height);
  const scale = Math.min(maxSide, sourceSide) / Math.max(spanX, spanY);
  return {
    width: Math.max(1, Math.round(spanX * scale)),
    height: Math.max(1, Math.round(spanY * scale)),
    extent: [minX, minY, maxX, maxY],
  };
}

/** RGBA pixels and their size, as in `ImageData`. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Resample a frame into a Mercator raster by inverse mapping: each output
 * pixel looks up the source pixel it came from. The exact (projection-heavy)
 * mapping runs on a coarse grid and is interpolated bilinearly between grid
 * nodes, which keeps a 16-megapixel warp well under a second.
 *
 * Args:
 *   source: The rendered frame.
 *   plan: The output raster.
 *   lngLatToSource: The source pixel at a longitude/latitude, or null when
 *     it falls outside the CRS's domain.
 *   grid: Grid cells along the longer output side.
 *
 * Returns:
 *   The output pixels; transparent where no source pixel maps.
 */
export function warpToMercator(
  source: RgbaImage,
  plan: MercatorWarpPlan,
  lngLatToSource: (lng: number, lat: number) => [number, number] | null,
  grid = 64,
): RgbaImage & { data: Uint8ClampedArray<ArrayBuffer> } {
  const { width, height, extent } = plan;
  const [minX, minY, maxX, maxY] = extent;
  const cols = Math.max(2, Math.round((grid * width) / Math.max(width, height)));
  const rows = Math.max(2, Math.round((grid * height) / Math.max(width, height)));
  // Source coordinates at each grid node (NaN where unmappable).
  const gx = new Float64Array((cols + 1) * (rows + 1));
  const gy = new Float64Array((cols + 1) * (rows + 1));
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const x = minX + ((maxX - minX) * i) / cols;
      const y = maxY - ((maxY - minY) * j) / rows;
      const src = lngLatToSource(...mercatorToLngLat(x, y));
      const k = j * (cols + 1) + i;
      gx[k] = src ? src[0] : NaN;
      gy[k] = src ? src[1] : NaN;
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const { data: src, width: sw, height: sh } = source;
  for (let py = 0; py < height; py++) {
    const fy = ((py + 0.5) / height) * rows;
    const j = Math.min(rows - 1, Math.floor(fy));
    const ty = fy - j;
    for (let px = 0; px < width; px++) {
      const fx = ((px + 0.5) / width) * cols;
      const i = Math.min(cols - 1, Math.floor(fx));
      const tx = fx - i;
      const k00 = j * (cols + 1) + i;
      const k10 = k00 + 1;
      const k01 = k00 + cols + 1;
      const k11 = k01 + 1;
      const sx =
        (gx[k00] * (1 - tx) + gx[k10] * tx) * (1 - ty) + (gx[k01] * (1 - tx) + gx[k11] * tx) * ty;
      const sy =
        (gy[k00] * (1 - tx) + gy[k10] * tx) * (1 - ty) + (gy[k01] * (1 - tx) + gy[k11] * tx) * ty;
      // Nearest source pixel; NaN (unmappable) and out-of-frame stay transparent.
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      if (!(ix >= 0 && iy >= 0 && ix < sw && iy < sh)) continue;
      const s = (iy * sw + ix) * 4;
      const o = (py * width + px) * 4;
      out[o] = src[s];
      out[o + 1] = src[s + 1];
      out[o + 2] = src[s + 2];
      out[o + 3] = src[s + 3];
    }
  }
  return { width, height, data: out };
}

/**
 * The image corners of a warped raster as `[lng, lat]`: top-left, top-right,
 * bottom-right, bottom-left.
 *
 * Args:
 *   plan: The output raster.
 *
 * Returns:
 *   The corners.
 */
export function warpCorners(
  plan: MercatorWarpPlan,
): [[number, number], [number, number], [number, number], [number, number]] {
  const [minX, minY, maxX, maxY] = plan.extent;
  return [
    mercatorToLngLat(minX, maxY),
    mercatorToLngLat(maxX, maxY),
    mercatorToLngLat(maxX, minY),
    mercatorToLngLat(minX, minY),
  ];
}
