/**
 * Framing a lng/lat extent on a map drawn in a custom CRS (issue #3516).
 *
 * A map in another CRS lays its tiles on a finite square grid over the CRS
 * plane (`MapCrsTileMatrixSet`), and MapLibre keeps the camera center on that
 * grid. A layer whose extent projects off the grid (Knoxville on the Arctic
 * polar stereographic grid, which stops near 40°N there) cannot be framed:
 * `fitBounds` computes the right camera, MapLibre clamps its center to the grid
 * edge, and the view lands hundreds of kilometres away with half the canvas
 * off the grid. These helpers project the extent into the CRS first, so the
 * map can frame the part on the grid, or say the layer is out of reach.
 *
 * Pure: the caller passes the CRS converter (proj4, loaded lazily with the CRS
 * itself), so this module adds nothing to the boot bundle.
 */

import type { MapCrsTileMatrixSet } from "@geolibre/core";

/** A lng/lat <-> CRS converter, as `proj4(definition)` returns. */
export interface MapCrsConverter {
  forward(point: [number, number]): number[];
  inverse(point: [number, number]): number[];
}

/** `[minX, minY, maxX, maxY]` in CRS units. */
export type CrsBox = [number, number, number, number];

/** Where a lng/lat extent lies relative to a CRS's tile grid. */
export type MapCrsExtentPlacement =
  /** Wholly on the grid: an ordinary `fitBounds` frames it. */
  | { kind: "inside" }
  /** Wholly off the grid: nothing of it can be shown in this CRS. */
  | { kind: "outside" }
  /** Partly on the grid: `box` is the part on it, in CRS units. */
  | { kind: "clipped"; box: CrsBox };

/** Samples per edge of the lng/lat box; polar grids bend its edges into arcs. */
const SAMPLES_PER_EDGE = 16;

/**
 * The grid square of a tile matrix set, `[minX, minY, maxX, maxY]` in CRS
 * units.
 *
 * Args:
 *   tileMatrixSet: The CRS's tile grid.
 *
 * Returns:
 *   The square tile 0/0/0 covers.
 */
export function mapCrsGridBox(tileMatrixSet: MapCrsTileMatrixSet): CrsBox {
  const [originX, originY] = tileMatrixSet.origin;
  const extent = tileMatrixSet.extentAtZoom0;
  return [originX, originY - extent, originX + extent, originY];
}

/**
 * The CRS-plane box around a lng/lat extent, from points sampled over it.
 *
 * Args:
 *   bounds: `[west, south, east, north]` in degrees.
 *   converter: The CRS converter.
 *
 * Returns:
 *   The box, or null when no sample projects to a finite point.
 */
export function projectBoundsToCrs(
  bounds: [number, number, number, number],
  converter: MapCrsConverter,
): CrsBox | null {
  const [west, south, east, north] = bounds;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i <= SAMPLES_PER_EDGE; i++) {
    const lng = west + ((east - west) * i) / SAMPLES_PER_EDGE;
    for (let j = 0; j <= SAMPLES_PER_EDGE; j++) {
      const lat = south + ((north - south) * j) / SAMPLES_PER_EDGE;
      let point: number[];
      try {
        point = converter.forward([lng, lat]);
      } catch {
        continue;
      }
      const [x, y] = point;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/**
 * Place a lng/lat extent on a CRS's tile grid.
 *
 * Args:
 *   bounds: `[west, south, east, north]` in degrees.
 *   converter: The CRS converter.
 *   tileMatrixSet: The CRS's tile grid.
 *
 * Returns:
 *   Whether the extent is on, off, or partly on the grid; null when it does
 *   not project at all (the caller then fits as it would on the default map).
 */
export function placeExtentInMapCrs(
  bounds: [number, number, number, number],
  converter: MapCrsConverter,
  tileMatrixSet: MapCrsTileMatrixSet,
): MapCrsExtentPlacement | null {
  const box = projectBoundsToCrs(bounds, converter);
  if (!box) return null;
  const grid = mapCrsGridBox(tileMatrixSet);
  // A sliver of float noise along the grid edge is still "on" it.
  const tolerance = tileMatrixSet.extentAtZoom0 * 1e-9;
  const clipped: CrsBox = [
    Math.max(box[0], grid[0]),
    Math.max(box[1], grid[1]),
    Math.min(box[2], grid[2]),
    Math.min(box[3], grid[3]),
  ];
  if (clipped[0] > clipped[2] + tolerance || clipped[1] > clipped[3] + tolerance) {
    return { kind: "outside" };
  }
  const inside =
    box[0] >= grid[0] - tolerance &&
    box[1] >= grid[1] - tolerance &&
    box[2] <= grid[2] + tolerance &&
    box[3] <= grid[3] + tolerance;
  return inside ? { kind: "inside" } : { kind: "clipped", box: clipped };
}

/**
 * The camera that frames a CRS-plane box, north up.
 *
 * MapLibre draws the whole grid square 512 px wide at zoom 0 and doubles it
 * per zoom level, so the zoom follows from the box's share of the grid.
 *
 * Args:
 *   box: The box to frame, in CRS units.
 *   converter: The CRS converter.
 *   tileMatrixSet: The CRS's tile grid.
 *   viewport: The canvas size in CSS pixels.
 *   padding: Padding on every side, in CSS pixels.
 *
 * Returns:
 *   The center and zoom, or null when the center does not unproject.
 */
export function cameraForMapCrsBox(
  box: CrsBox,
  converter: MapCrsConverter,
  tileMatrixSet: MapCrsTileMatrixSet,
  viewport: { width: number; height: number },
  padding: number,
): { center: [number, number]; zoom: number } | null {
  let center: number[];
  try {
    center = converter.inverse([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
  } catch {
    return null;
  }
  const [lng, lat] = center;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const extent = tileMatrixSet.extentAtZoom0;
  const width = Math.max(1, viewport.width - 2 * padding);
  const height = Math.max(1, viewport.height - 2 * padding);
  // Pixels the box spans at zoom 0; a zero-size side does not limit the zoom.
  const boxWidth = ((box[2] - box[0]) / extent) * 512;
  const boxHeight = ((box[3] - box[1]) / extent) * 512;
  const scales = [
    boxWidth > 0 ? width / boxWidth : Infinity,
    boxHeight > 0 ? height / boxHeight : Infinity,
  ];
  const scale = Math.min(...scales);
  const zoom = Number.isFinite(scale) ? Math.max(0, Math.log2(scale)) : 14;
  return { center: [lng, lat], zoom };
}
