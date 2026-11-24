/**
 * A coarse longitude/latitude grid sampled over a print capture, for views
 * that have no affine georeference (globe, pitch, a CRS without an EPSG code).
 *
 * It is too approximate for a GeoPDF, but it is enough to locate the main map
 * on the overview / inset map and to trace its footprint there (GH #3551).
 */

/** Longitude/latitude sampled at `(cols + 1) x (rows + 1)` capture pixels. */
export interface CaptureLngLatGrid {
  /** Cells across; samples per row is `cols + 1`. */
  cols: number;
  /** Cells down; samples per column is `rows + 1`. */
  rows: number;
  /** Capture width in image pixels. */
  width: number;
  /** Capture height in image pixels. */
  height: number;
  /** Longitudes, row-major, unwrapped so neighbours never jump by 360. */
  lngs: number[];
  /** Latitudes, row-major. */
  lats: number[];
}

/** Grid cells along each axis; 16 x 16 keeps a globe's horizon smooth. */
const GRID_CELLS = 16;

/**
 * Sample a capture's longitude/latitude on a regular grid.
 *
 * @param width - Capture width in image pixels.
 * @param height - Capture height in image pixels.
 * @param locate - Longitude/latitude at an image pixel, or null off the map.
 * @param cells - Grid cells along each axis.
 * @returns The grid, or null when any sample cannot be located.
 */
export function sampleCaptureLngLatGrid(
  width: number,
  height: number,
  locate: (px: number, py: number) => { lng: number; lat: number } | null,
  cells = GRID_CELLS,
): CaptureLngLatGrid | null {
  if (!(width > 0) || !(height > 0) || !(cells >= 1)) return null;
  const cols = cells;
  const rows = cells;
  const lngs: number[] = [];
  const lats: number[] = [];
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= cols; col++) {
      const ll = locate((width * col) / cols, (height * row) / rows);
      if (!ll || !Number.isFinite(ll.lng) || !Number.isFinite(ll.lat)) return null;
      // Unwrap against the left neighbour (the one above for a row's first
      // sample), so interpolation never averages across the antimeridian.
      const index = row * (cols + 1) + col;
      const ref = col > 0 ? lngs[index - 1] : row > 0 ? lngs[index - cols - 1] : undefined;
      const lng = ref === undefined ? ll.lng : ll.lng + 360 * Math.round((ref - ll.lng) / 360);
      lngs.push(lng);
      lats.push(Math.max(-90, Math.min(90, ll.lat)));
    }
  }
  return { cols, rows, width, height, lngs, lats };
}

/**
 * Longitude/latitude at a capture pixel, interpolated bilinearly within the
 * grid cell that holds it (pixels outside the capture clamp to its edge).
 *
 * @param grid - The sampled grid.
 * @param px - Image x in pixels.
 * @param py - Image y in pixels.
 * @returns `[lng, lat]`.
 */
export function gridLngLat(grid: CaptureLngLatGrid, px: number, py: number): [number, number] {
  const { cols, rows, width, height, lngs, lats } = grid;
  const fx = (Math.max(0, Math.min(width, px)) / width) * cols;
  const fy = (Math.max(0, Math.min(height, py)) / height) * rows;
  const col = Math.min(cols - 1, Math.floor(fx));
  const row = Math.min(rows - 1, Math.floor(fy));
  const tx = fx - col;
  const ty = fy - row;
  const i00 = row * (cols + 1) + col;
  const i10 = i00 + 1;
  const i01 = i00 + cols + 1;
  const i11 = i01 + 1;
  const lerp = (a: number, b: number, c: number, d: number) =>
    (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  // Rows are unwrapped independently, so around a visible pole two rows can
  // sit 360 apart: bring the cell's corners next to its first one.
  const near = (lng: number) => lng + 360 * Math.round((lngs[i00] - lng) / 360);
  return [
    lerp(lngs[i00], near(lngs[i10]), near(lngs[i01]), near(lngs[i11])),
    lerp(lats[i00], lats[i10], lats[i01], lats[i11]),
  ];
}
