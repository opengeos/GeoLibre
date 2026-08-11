import type { Feature, FeatureCollection, Geometry, Polygon, Position } from "geojson";
import { geojson as s2geojson, s1, s2 } from "s2js";
import { unwrapAntimeridianGeometry } from "./antimeridian";

/**
 * Approximate average S2 cell area (km²) at levels 0..30.
 * Six level-0 faces, each subdividing 4× per level (earth ≈ 5.101×10⁸ km²).
 */
export const S2_AVG_AREA_KM2: number[] = Array.from({ length: 31 }, (_, level) => {
  return 510_065_621.724 / (6 * 4 ** level);
});

/** Soft target used when auto-suggesting a resolution. */
export const S2_TARGET_CELLS = 10_000;
/** Finest resolution the auto-suggester will pick. */
export const S2_MAX_SUGGESTED_RES = 12;
/** Hard ceiling: a grid larger than this aborts rather than running away. */
export const S2_HARD_CAP = 200_000;
/** Max S2 level offered in the processing dialog (0–30). */
export const S2_MAX_TOOL_RES = 30;

/**
 * Max longitude span (degrees) per RegionCoverer call. Wider rings are
 * ambiguous in GeoJSON / s2js, so bounds are chunked and cells deduplicated.
 */
const MAX_COVER_SPAN_DEGREES = 120;

/** Estimated number of S2 cells covering `areaKm2` at `res`. */
export function estimateS2CellCount(areaKm2: number, res: number): number {
  const cellArea = S2_AVG_AREA_KM2[res];
  if (cellArea === undefined) return Number.POSITIVE_INFINITY;
  return areaKm2 / cellArea;
}

/** Finest resolution whose estimated cell count stays <= the target. */
export function suggestS2Resolution(
  areaKm2: number,
  targetCells = S2_TARGET_CELLS,
  maxRes = S2_MAX_SUGGESTED_RES,
): number {
  const capped = Math.min(maxRes, S2_MAX_TOOL_RES);
  for (let res = capped; res >= 0; res -= 1) {
    if (estimateS2CellCount(areaKm2, res) <= targetCells) return res;
  }
  return 0;
}

function cellIdFromToken(token: string): bigint {
  return s2.cellid.fromToken(token);
}

function cellCenter(id: bigint): [number, number] {
  const latLng = s2.cellid.latLng(id);
  return [s1.angle.degrees(latLng.lng), s1.angle.degrees(latLng.lat)];
}

/** S2 cell token at `level` containing lon/lat (lon first, matching GeoJSON). */
export function s2CellAtLonLat(lng: number, lat: number, level: number): string {
  const leaf = s2.cellid.fromLatLng(s2.LatLng.fromDegrees(lat, lng));
  return s2.cellid.toToken(s2.cellid.parent(leaf, level));
}

/**
 * Four corners as a closed lon/lat ring. When `unwrap` is true, vertices are
 * shifted relative to the first so dateline-straddling cells stay contiguous
 * for MapLibre (same idea as {@link unwrapAntimeridianGeometry}).
 */
function cellRing(id: bigint, unwrap: boolean): [number, number][] {
  const cell = s2.Cell.fromCellID(id);
  const ring: [number, number][] = [];
  for (let i = 0; i <= 4; i += 1) {
    const vertex = s2.LatLng.fromPoint(cell.vertex(i % 4));
    let lng = s1.angle.degrees(vertex.lng);
    const lat = s1.angle.degrees(vertex.lat);
    if (unwrap && ring.length > 0) {
      const reference = ring[0]![0]!;
      if (lng - reference > 180) lng -= 360;
      if (lng - reference < -180) lng += 360;
    }
    ring.push([lng, lat]);
  }
  return ring;
}

/** Convert an S2 token to a GeoJSON polygon feature. */
export function s2CellFeature(token: string, unwrap = true): Feature<Polygon> {
  const id = cellIdFromToken(token);
  const [lng, lat] = cellCenter(id);
  let geometry: Geometry = { type: "Polygon", coordinates: [cellRing(id, unwrap)] };
  // Belt-and-braces: if the ring was built without per-vertex unwrap, still
  // offer the shared antimeridian helper when the caller asked for fix-on.
  if (unwrap) geometry = unwrapAntimeridianGeometry(geometry);
  return {
    type: "Feature",
    id: token,
    properties: {
      s2: token,
      resolution: s2.cellid.level(id),
      center_lat: lat,
      center_lng: lng,
    },
    geometry: geometry as Polygon,
  };
}

/** Longitude chunks in [-180, 180] covering `west`+`span` (handles wrap). */
function lonChunks(west: number, span: number): Array<[number, number]> {
  const chunks: Array<[number, number]> = [];
  let cursor = (((west % 360) + 540) % 360) - 180;
  let remaining = Math.min(360, Math.max(0, span));
  while (remaining > 1e-9) {
    const step = Math.min(remaining, MAX_COVER_SPAN_DEGREES, 180 - cursor);
    chunks.push([cursor, cursor + step]);
    cursor = cursor + step >= 180 ? -180 : cursor + step;
    remaining -= step;
  }
  return chunks;
}

function coverPolygonTokens(
  polygon: Polygon,
  level: number,
  limit: number,
  into: Set<string>,
): void {
  const coverer = new s2geojson.RegionCoverer({ minLevel: level, maxLevel: level });
  for (const id of coverer.covering(polygon)) {
    into.add(s2.cellid.toToken(id));
    if (into.size > limit) {
      throw new RangeError(`S2 cell limit exceeded: ${limit}`);
    }
  }
}

/** Build polygon features from S2 tokens (property field `s2`). */
export function s2TokensToFeatureCollection(
  tokens: Iterable<string>,
  unwrap = true,
): FeatureCollection<Polygon> {
  return {
    type: "FeatureCollection",
    features: [...tokens].map((token) => s2CellFeature(token, unwrap)),
  };
}

/**
 * Fill a WGS84 bounding box with S2 cells at one level. Mirrors the maplibre-s2
 * plugin covering (chunked longitude, token dedupe).
 */
export function s2GridFromBbox(
  bounds: [number, number, number, number],
  level: number,
  options: { limit?: number; unwrap?: boolean; compact?: boolean } = {},
): FeatureCollection<Polygon> {
  const limit = options.limit ?? S2_HARD_CAP;
  const unwrap = options.unwrap !== false;
  const [west, southRaw, east, northRaw] = bounds;
  const south = Math.max(-89.999999, Math.min(89.999999, southRaw));
  const north = Math.max(-89.999999, Math.min(89.999999, northRaw));
  const span = Math.min(360, east >= west ? east - west : east + 360 - west);

  const cells = new Set<string>();
  for (const [left, right] of lonChunks(west, span)) {
    const polygon: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [left, south],
          [right, south],
          [right, north],
          [left, north],
          [left, south],
        ],
      ],
    };
    coverPolygonTokens(polygon, level, limit, cells);
  }
  const tokens = options.compact ? compactS2Tokens(cells) : [...cells];
  return s2TokensToFeatureCollection(tokens, unwrap);
}

/**
 * Polyfill polygon / multipolygon features with S2 cells at `level`.
 * Non-polygonal geometries are skipped.
 */
export function s2GridFromFeatureCollection(
  fc: FeatureCollection,
  level: number,
  options: { limit?: number; unwrap?: boolean; compact?: boolean } = {},
): FeatureCollection<Polygon> {
  const limit = options.limit ?? S2_HARD_CAP;
  const unwrap = options.unwrap !== false;
  const cells = new Set<string>();
  for (const feature of fc.features) {
    const g = feature.geometry;
    if (!g) continue;
    if (g.type === "Polygon") {
      coverPolygonTokens(g, level, limit, cells);
    } else if (g.type === "MultiPolygon") {
      for (const coords of g.coordinates) {
        coverPolygonTokens({ type: "Polygon", coordinates: coords }, level, limit, cells);
      }
    }
  }
  const tokens = options.compact ? compactS2Tokens(cells) : [...cells];
  return s2TokensToFeatureCollection(tokens, unwrap);
}

/** Collect S2 cell tokens from a feature property (default `s2`). */
export function tokensFromS2Layer(fc: FeatureCollection, cellField = "s2"): string[] {
  const out: string[] = [];
  for (const feature of fc.features) {
    const raw = feature.properties?.[cellField];
    if (raw === undefined || raw === null) continue;
    const token = String(raw).trim();
    if (token) out.push(token);
  }
  return out;
}

/**
 * Compact S2 tokens with {@link s2.CellUnion.normalize}: complete sets of four
 * siblings become their parent (mixed levels).
 */
export function compactS2Tokens(tokens: Iterable<string>): string[] {
  const ids: bigint[] = [];
  for (const token of tokens) {
    ids.push(cellIdFromToken(token));
  }
  if (ids.length === 0) return [];
  const union = new s2.CellUnion(...ids);
  union.normalize();
  const out: string[] = [];
  for (let i = 0; i < union.length; i += 1) {
    out.push(s2.cellid.toToken(union[i]!));
  }
  return out;
}

/**
 * Expand (denormalize) S2 tokens to a uniform `level`. Cells already finer than
 * `level` throw; use {@link estimateS2ExpandCount} for the hard-cap guard.
 */
export function expandS2Tokens(tokens: Iterable<string>, level: number): string[] {
  const ids: bigint[] = [];
  for (const token of tokens) {
    const id = cellIdFromToken(token);
    if (s2.cellid.level(id) > level) {
      throw new RangeError(
        `S2 cell ${token} is finer than target level ${level}; choose a finer target or compact first`,
      );
    }
    ids.push(id);
  }
  if (ids.length === 0) return [];
  const union = new s2.CellUnion(...ids);
  union.normalize();
  union.denormalize(level, 1);
  const out: string[] = [];
  for (let i = 0; i < union.length; i += 1) {
    out.push(s2.cellid.toToken(union[i]!));
  }
  return out;
}

/** Exact cell count after expanding `tokens` to `level` (4× per level). */
export function estimateS2ExpandCount(tokens: Iterable<string>, level: number): number {
  let n = 0;
  for (const token of tokens) {
    const id = cellIdFromToken(token);
    const L = s2.cellid.level(id);
    if (L > level) return 0;
    n += 4 ** (level - L);
  }
  return n;
}

/** Compact a polygon cell layer's `s2` (or other) ID field. */
export function compactS2FeatureCollection(
  fc: FeatureCollection,
  options: { cellField?: string; unwrap?: boolean } = {},
): FeatureCollection<Polygon> {
  const unwrap = options.unwrap !== false;
  const tokens = compactS2Tokens(tokensFromS2Layer(fc, options.cellField ?? "s2"));
  return s2TokensToFeatureCollection(tokens, unwrap);
}

/** Expand a polygon cell layer to a uniform S2 level. */
export function expandS2FeatureCollection(
  fc: FeatureCollection,
  level: number,
  options: { cellField?: string; unwrap?: boolean } = {},
): FeatureCollection<Polygon> {
  const unwrap = options.unwrap !== false;
  const tokens = expandS2Tokens(tokensFromS2Layer(fc, options.cellField ?? "s2"), level);
  return s2TokensToFeatureCollection(tokens, unwrap);
}

/** Supported point-binning aggregate operations (same set as H3). */
export type S2AggOp = "count" | "sum" | "mean" | "min" | "max";

function eachPointCoord(
  geometry: Geometry | null | undefined,
  visit: (pos: Position) => void,
): void {
  if (!geometry) return;
  if (geometry.type === "Point") {
    visit(geometry.coordinates);
    return;
  }
  if (geometry.type === "MultiPoint") {
    for (const c of geometry.coordinates) visit(c);
  }
}

/**
 * Aggregate point geometry into S2 cells (client-side; no DuckDB).
 */
export function binPointsToS2(
  fc: FeatureCollection,
  level: number,
  op: S2AggOp,
  field?: string,
  options: { unwrap?: boolean } = {},
): FeatureCollection<Polygon> {
  const unwrap = options.unwrap !== false;
  type Acc = { count: number; sum: number; min: number; max: number };
  const byCell = new Map<string, Acc>();

  for (const feature of fc.features) {
    eachPointCoord(feature.geometry, (pos) => {
      const lng = pos[0];
      const lat = pos[1];
      if (
        lng === undefined ||
        lat === undefined ||
        !Number.isFinite(lng) ||
        !Number.isFinite(lat)
      ) {
        return;
      }
      const token = s2CellAtLonLat(lng, lat, level);
      let acc = byCell.get(token);
      if (!acc) {
        acc = { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
        byCell.set(token, acc);
      }
      acc.count += 1;
      if (op !== "count" && field) {
        const raw = feature.properties?.[field];
        const n = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(n)) return;
        acc.sum += n;
        if (n < acc.min) acc.min = n;
        if (n > acc.max) acc.max = n;
      }
    });
  }

  const features: Feature<Polygon>[] = [];
  for (const [token, acc] of byCell) {
    const feature = s2CellFeature(token, unwrap);
    const properties: Record<string, unknown> = { ...feature.properties, count: acc.count };
    if (op === "sum") properties.value = acc.sum;
    else if (op === "mean") properties.value = acc.count > 0 ? acc.sum / acc.count : 0;
    else if (op === "min") properties.value = Number.isFinite(acc.min) ? acc.min : null;
    else if (op === "max") properties.value = Number.isFinite(acc.max) ? acc.max : null;
    features.push({ ...feature, properties });
  }
  return { type: "FeatureCollection", features };
}
