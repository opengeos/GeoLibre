import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

/**
 * One label anchor per polygon feature (GH discussion #3554).
 *
 * MapLibre places a point label on a polygon once per polygon part and again
 * in every tile the polygon is clipped into, so a large country repeats its
 * name all over the map. QGIS labels each feature once, inside its largest
 * part. This module builds that: every Polygon/MultiPolygon feature becomes a
 * Point at the pole of inaccessibility of its largest part (the interior point
 * farthest from the outline, so the label sits well inside even concave or
 * ring-shaped shapes), keeping its id and properties so the label layer's
 * filters and data-defined overrides still evaluate, plus the part's area so
 * larger polygons can be placed first. Other geometries pass through
 * unchanged.
 */

// Labels are drawn in Web Mercator, so the anchor is found there too: in plain
// longitude/latitude a high-latitude polygon is squashed vertically and its
// "center" lands visibly off-center on the map.
const MAX_MERCATOR_LAT = 85.0511287798;
const DEG = Math.PI / 180;

function toMercator([lng, lat]: Position): [number, number] {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  return [lng, Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2)) / DEG];
}

function fromMercator([x, y]: [number, number]): Position {
  return [x, (2 * Math.atan(Math.exp(y * DEG)) - Math.PI / 2) / DEG];
}

type Ring = [number, number][];

/** Absolute planar area of a polygon (outer ring minus holes). */
function polygonArea(rings: Ring[]): number {
  let total = 0;
  rings.forEach((ring, index) => {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    }
    total += index === 0 ? Math.abs(sum) / 2 : -Math.abs(sum) / 2;
  });
  return total;
}

/** Signed distance from a point to the polygon outline: positive inside. */
function signedDistance(x: number, y: number, rings: Ring[]): number {
  let inside = false;
  let minSq = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[j];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
      minSq = Math.min(minSq, segmentDistanceSq(x, y, ax, ay, bx, by));
    }
  }
  return minSq === Infinity ? 0 : (inside ? 1 : -1) * Math.sqrt(minSq);
}

function segmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  let x = ax;
  let y = ay;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = bx;
      y = by;
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  return (px - x) ** 2 + (py - y) ** 2;
}

interface Cell {
  x: number;
  y: number;
  h: number;
  d: number;
  max: number;
}

function cell(x: number, y: number, h: number, rings: Ring[]): Cell {
  const d = signedDistance(x, y, rings);
  return { x, y, h, d, max: d + h * Math.SQRT2 };
}

/** The area-weighted centroid of the outer ring, a good first guess. */
function ringCentroidCell(rings: Ring[]): Cell {
  const ring = rings[0];
  let area = 0;
  let x = 0;
  let y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[j];
    const f = ax * by - bx * ay;
    x += (ax + bx) * f;
    y += (ay + by) * f;
    area += f * 3;
  }
  if (area === 0) return cell(ring[0][0], ring[0][1], 0, rings);
  return cell(x / area, y / area, 0, rings);
}

/**
 * A point inside the polygon on the horizontal line `y`: the middle of the
 * widest stretch of that line lying inside (JTS's InteriorPoint idea). The
 * line is nudged off any vertex so crossings are counted cleanly.
 *
 * @param rings - The polygon's rings, outer ring first.
 * @param y - The scanline, usually the middle of the bounding box.
 * @returns An interior point, or null when the line misses the polygon.
 */
function scanlineInteriorPoint(rings: Ring[], y: number): [number, number] | null {
  for (const ring of rings) {
    for (const [, vy] of ring) {
      if (vy === y) y += 1e-9 * Math.max(1, Math.abs(y));
    }
  }
  const crossings: number[] = [];
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[j];
      if (ay > y !== by > y) crossings.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
    }
  }
  crossings.sort((a, b) => a - b);
  let best: [number, number] | null = null;
  let widest = 0;
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    const span = crossings[i + 1] - crossings[i];
    if (span > widest) {
      widest = span;
      best = [(crossings[i] + crossings[i + 1]) / 2, y];
    }
  }
  return best;
}

/**
 * The pole of inaccessibility of one polygon: Mapbox's polylabel algorithm
 * (grid of cells refined best-first until no cell can beat the best point by
 * more than `precision`).
 *
 * @param rings - The polygon's rings in planar coordinates, outer ring first.
 * @returns The interior point farthest from the outline.
 */
export function poleOfInaccessibility(rings: Ring[]): [number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of rings[0]) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const size = Math.min(width, height);
  if (!Number.isFinite(size) || size === 0) return [minX, minY];
  // The search only needs to put the label comfortably inside, so half a
  // percent of the shape's extent is plenty and keeps huge outlines (10m
  // countries) cheap.
  const precision = Math.max(width, height) / 200;

  const queue: Cell[] = [];
  // Cap the starting grid at 64 cells across, so a long flat sliver cannot
  // allocate millions of cells; best-first refinement converges either way.
  const cellSize = Math.max(size, Math.max(width, height) / 64);
  const h = cellSize / 2;
  for (let x = minX; x < maxX; x += cellSize) {
    for (let y = minY; y < maxY; y += cellSize) queue.push(cell(x + h, y + h, h, rings));
  }
  let best = ringCentroidCell(rings);
  const bboxCenter = cell(minX + width / 2, minY + height / 2, 0, rings);
  if (bboxCenter.d > best.d) best = bboxCenter;
  // A shape thinner than `precision` (a narrow U, a long sliver) can leave
  // both guesses outside and stop the search there, so also seed it with a
  // point known to be inside.
  const scan = scanlineInteriorPoint(rings, minY + height / 2);
  if (scan) {
    const scanCell = cell(scan[0], scan[1], 0, rings);
    if (scanCell.d > best.d) best = scanCell;
  }

  // A simple best-first search: a sorted array is plenty for the few hundred
  // cells a label-precision search visits.
  queue.sort((a, b) => a.max - b.max);
  let guard = 0;
  while (queue.length > 0 && guard++ < 100_000) {
    const current = queue.pop()!;
    if (current.d > best.d) best = current;
    if (current.max - best.d <= precision) continue;
    const half = current.h / 2;
    for (const [dx, dy] of [
      [-half, -half],
      [half, -half],
      [-half, half],
      [half, half],
    ]) {
      const child = cell(current.x + dx, current.y + dy, half, rings);
      if (child.max - best.d <= precision) continue;
      // Insert in order (ascending max) so pop() takes the most promising.
      let lo = 0;
      let hi = queue.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (queue[mid].max < child.max) lo = mid + 1;
        else hi = mid;
      }
      queue.splice(lo, 0, child);
    }
  }
  return [best.x, best.y];
}

/**
 * The label anchor of a Polygon or MultiPolygon: the pole of inaccessibility
 * of its largest part (by ground area), or null for other geometries
 * or degenerate polygons.
 *
 * @param geometry - The feature geometry.
 * @returns The anchor position in longitude/latitude, or null.
 */
export function polygonLabelPoint(geometry: Geometry | null | undefined): Position | null {
  return polygonLabelAnchor(geometry)?.point ?? null;
}

/**
 * Feature property carrying the labeled part's approximate ground area (see
 * groundArea), which the label layer sorts on so a large polygon's single label wins a
 * collision against a small neighbour's.
 */
export const POLYGON_LABEL_AREA_PROPERTY = "__geolibre_label_area";

function polygonLabelAnchor(
  geometry: Geometry | null | undefined,
): { point: Position; area: number } | null {
  if (!geometry) return null;
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : null;
  if (!polygons) return null;
  let largest: Position[][] | null = null;
  let largestArea = -Infinity;
  for (const polygon of polygons) {
    if (!polygon[0] || polygon[0].length < 3) continue;
    const rings = polygon.filter((ring) => ring.length >= 3);
    // A zero-area (collinear) part is degenerate: MapLibre draws nothing
    // there.
    const area = groundArea(rings);
    if (area > 0 && area > largestArea) {
      largestArea = area;
      largest = rings;
    }
  }
  if (!largest) return null;
  // The search runs on a thinned copy of the outline (see thinRing), which can
  // shave off a deep notch; a candidate that lands outside the real outline
  // falls back to a scanline point, which is inside by construction.
  const full = largest.map((ring) => ring.map(toMercator));
  let anchor = poleOfInaccessibility(largest.map((ring) => thinRing(ring).map(toMercator)));
  if (signedDistance(anchor[0], anchor[1], full) <= 0) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of full[0]) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    anchor = scanlineInteriorPoint(full, (minY + maxY) / 2) ?? anchor;
  }
  return { point: fromMercator(anchor), area: largestArea };
}

/**
 * Approximate ground area of a polygon part, in square degrees scaled by the
 * cosine of its latitude, so parts compare by real size: Web Mercator would
 * rank Greenland above Brazil. Computed on the full outline.
 */
function groundArea(rings: Position[][]): number {
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [, lat] of rings[0]) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const cosLat = Math.cos(((minLat + maxLat) / 2) * DEG);
  return Math.max(0, polygonArea(rings as Ring[]) * cosLat);
}

// The search scans every vertex for every cell it scores, so a very detailed
// outline (a 10m-scale coastline) is thinned to this many vertices first. The
// anchor only has to sit well inside the shape, and the pole is far from the
// outline, so dropping fine coastline detail does not move it noticeably.
const MAX_SEARCH_VERTICES = 2000;

/** Every n-th vertex of a long ring (keeping it closed), else the ring itself. */
function thinRing(ring: Position[]): Position[] {
  if (ring.length <= MAX_SEARCH_VERTICES) return ring;
  const step = Math.ceil(ring.length / MAX_SEARCH_VERTICES);
  const thinned: Position[] = [];
  for (let i = 0; i < ring.length - 1; i += step) thinned.push(ring[i]);
  thinned.push(ring[ring.length - 1]);
  return thinned;
}

/**
 * Most polygon features one layer derives label points for. The search costs
 * tens of microseconds per polygon on the main thread, so a 50k-parcel layer
 * would stall its first draw for seconds; past this budget the layer keeps
 * MapLibre's own placement, which suits such layers anyway (parcel-sized
 * polygons rarely span more than one tile).
 */
export const MAX_POLYGON_LABEL_FEATURES = 10_000;

const labelPointCache = new WeakMap<FeatureCollection, FeatureCollection | null>();

/**
 * The collection with each polygon feature replaced by a single label point
 * (see the module comment), memoized by collection reference since it walks
 * every vertex. Features whose polygon is degenerate are dropped, as MapLibre
 * would not label them either.
 *
 * @param collection - The layer's features.
 * @returns A collection safe to feed a point-placed symbol layer, or null when
 *   the layer has more than {@link MAX_POLYGON_LABEL_FEATURES} polygons.
 */
export function polygonLabelPoints(collection: FeatureCollection): FeatureCollection | null {
  if (labelPointCache.has(collection)) return labelPointCache.get(collection)!;
  let polygonCount = 0;
  for (const feature of collection.features) {
    const type = feature.geometry?.type;
    if (type === "Polygon" || type === "MultiPolygon") polygonCount += 1;
  }
  if (polygonCount > MAX_POLYGON_LABEL_FEATURES) {
    labelPointCache.set(collection, null);
    return null;
  }
  const features: Feature[] = [];
  for (const feature of collection.features) {
    const type = feature.geometry?.type;
    if (type !== "Polygon" && type !== "MultiPolygon") {
      features.push(feature);
      continue;
    }
    const anchor = polygonLabelAnchor(feature.geometry);
    if (!anchor) continue;
    features.push({
      ...feature,
      properties: { ...feature.properties, [POLYGON_LABEL_AREA_PROPERTY]: anchor.area },
      geometry: { type: "Point", coordinates: anchor.point },
    });
  }
  const result: FeatureCollection = { type: "FeatureCollection", features };
  labelPointCache.set(collection, result);
  return result;
}
