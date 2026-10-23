import type { FeatureCollection, Geometry, Position } from "geojson";

/**
 * A spatial index for picking a collection's features at a point, for the
 * synchronous picks that run per pointer frame (the ArcGIS canvas's hover
 * tips and photo pointer, #2629). A uniform grid over the collection's extent
 * holds each feature's bounding box, so a pick tests the few features near
 * the point instead of every vertex of the layer. Built once per collection
 * object and cached: the store replaces the collection on every data change.
 */
export interface FeaturePickIndex {
  /**
   * The indexes, ascending, of the features whose bounding box lies within
   * `tolerance` of `lngLat`: the candidates an exact geometry test decides.
   */
  candidates(lngLat: [number, number], tolerance: number): number[];
}

/** Grid cells along each axis, at most; small collections use fewer. */
const MAX_CELLS_PER_AXIS = 256;

const indexes = new WeakMap<FeatureCollection, FeaturePickIndex>();

/**
 * The pick index for `collection`, built on first use and cached.
 *
 * @param collection - A GeoJSON feature collection.
 * @returns Its index.
 */
export function featurePickIndex(collection: FeatureCollection): FeaturePickIndex {
  let index = indexes.get(collection);
  if (!index) {
    index = buildIndex(collection);
    indexes.set(collection, index);
  }
  return index;
}

/** `[minX, minY, maxX, maxY]` of a geometry, or null when it has no position. */
function geometryBounds(geometry: Geometry | null): [number, number, number, number] | null {
  if (!geometry) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (position: Position) => {
    const [x, y] = position;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  const walk = (value: Geometry) => {
    switch (value.type) {
      case "Point":
        visit(value.coordinates);
        break;
      case "MultiPoint":
      case "LineString":
        value.coordinates.forEach(visit);
        break;
      case "MultiLineString":
      case "Polygon":
        value.coordinates.forEach((line) => line.forEach(visit));
        break;
      case "MultiPolygon":
        value.coordinates.forEach((polygon) => polygon.forEach((ring) => ring.forEach(visit)));
        break;
      case "GeometryCollection":
        value.geometries.forEach(walk);
        break;
    }
  };
  walk(geometry);
  return minX <= maxX ? [minX, minY, maxX, maxY] : null;
}

function buildIndex(collection: FeatureCollection): FeaturePickIndex {
  const count = collection.features.length;
  const bounds = new Float64Array(count * 4);
  const present = new Uint8Array(count);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  collection.features.forEach((feature, i) => {
    const box = geometryBounds(feature.geometry);
    if (!box) return;
    present[i] = 1;
    bounds.set(box, i * 4);
    minX = Math.min(minX, box[0]);
    minY = Math.min(minY, box[1]);
    maxX = Math.max(maxX, box[2]);
    maxY = Math.max(maxY, box[3]);
  });
  if (!(minX <= maxX)) return { candidates: () => [] };
  // About one feature per cell: the pick then reads a handful of cells.
  const cellsPerAxis = Math.max(1, Math.min(MAX_CELLS_PER_AXIS, Math.ceil(Math.sqrt(count))));
  const cellWidth = (maxX - minX) / cellsPerAxis || 1;
  const cellHeight = (maxY - minY) / cellsPerAxis || 1;
  const column = (x: number) =>
    Math.max(0, Math.min(cellsPerAxis - 1, Math.floor((x - minX) / cellWidth)));
  const row = (y: number) =>
    Math.max(0, Math.min(cellsPerAxis - 1, Math.floor((y - minY) / cellHeight)));
  const cells = new Map<number, number[]>();
  // A feature spanning much of the grid is checked on every pick instead of
  // being copied into hundreds of cells.
  const wide: number[] = [];
  for (let i = 0; i < count; i++) {
    if (!present[i]) continue;
    const c0 = column(bounds[i * 4]);
    const c1 = column(bounds[i * 4 + 2]);
    const r0 = row(bounds[i * 4 + 1]);
    const r1 = row(bounds[i * 4 + 3]);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > 64) {
      wide.push(i);
      continue;
    }
    for (let c = c0; c <= c1; c++)
      for (let r = r0; r <= r1; r++) {
        const key = r * cellsPerAxis + c;
        const cell = cells.get(key);
        if (cell) cell.push(i);
        else cells.set(key, [i]);
      }
  }
  return {
    candidates([x, y], tolerance) {
      const t = Math.max(0, tolerance);
      if (x + t < minX || x - t > maxX || y + t < minY || y - t > maxY) return [];
      const found = new Set<number>(wide);
      const c0 = column(x - t);
      const c1 = column(x + t);
      const r0 = row(y - t);
      const r1 = row(y + t);
      for (let c = c0; c <= c1; c++)
        for (let r = r0; r <= r1; r++)
          for (const i of cells.get(r * cellsPerAxis + c) ?? []) found.add(i);
      return [...found]
        .filter(
          (i) =>
            x + t >= bounds[i * 4] &&
            x - t <= bounds[i * 4 + 2] &&
            y + t >= bounds[i * 4 + 1] &&
            y - t <= bounds[i * 4 + 3],
        )
        .sort((a, b) => a - b);
    },
  };
}
