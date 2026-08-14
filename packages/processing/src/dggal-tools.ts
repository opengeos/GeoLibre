import type { Feature, FeatureCollection, Geometry, Polygon, Position } from "geojson";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point as turfPoint } from "@turf/helpers";

/**
 * Named DGGAL DGGRS types for DGGS Generator / Binning. Keys are stable UI
 * values; `className` is passed to `dggal.createDGGRS(...)`.
 */
export const DGGAL_TYPES = {
  gnosis: {
    minRes: 0,
    maxRes: 28,
    defaultRes: 16,
    className: "GNOSISGlobalGrid",
  },
  isea4r: { minRes: 0, maxRes: 25, defaultRes: 12, className: "ISEA4R" },
  isea9r: { minRes: 0, maxRes: 16, defaultRes: 10, className: "ISEA9R" },
  isea3h: { minRes: 0, maxRes: 33, defaultRes: 21, className: "ISEA3H" },
  isea7h: { minRes: 0, maxRes: 19, defaultRes: 11, className: "ISEA7H" },
  isea7h_z7: { minRes: 0, maxRes: 19, defaultRes: 11, className: "ISEA7H_Z7" },
  ivea4r: { minRes: 0, maxRes: 25, defaultRes: 12, className: "IVEA4R" },
  ivea9r: { minRes: 0, maxRes: 16, defaultRes: 10, className: "IVEA9R" },
  ivea3h: { minRes: 0, maxRes: 33, defaultRes: 21, className: "IVEA3H" },
  ivea7h: { minRes: 0, maxRes: 19, defaultRes: 11, className: "IVEA7H" },
  ivea7h_z7: { minRes: 0, maxRes: 19, defaultRes: 11, className: "IVEA7H_Z7" },
  rtea4r: { minRes: 0, maxRes: 25, defaultRes: 12, className: "RTEA4R" },
  rtea9r: { minRes: 0, maxRes: 16, defaultRes: 10, className: "RTEA9R" },
  rtea3h: { minRes: 0, maxRes: 33, defaultRes: 21, className: "RTEA3H" },
  rtea7h: { minRes: 0, maxRes: 19, defaultRes: 11, className: "RTEA7H" },
  rtea7h_z7: { minRes: 0, maxRes: 19, defaultRes: 11, className: "RTEA7H_Z7" },
  healpix: { minRes: 0, maxRes: 26, defaultRes: 18, className: "HEALPix" },
  rhealpix: { minRes: 0, maxRes: 16, defaultRes: 10, className: "rHEALPix" },
} as const;

export type DggalGridType = keyof typeof DGGAL_TYPES;

export const DGGAL_GRID_TYPES = Object.keys(DGGAL_TYPES) as DggalGridType[];

export const DEFAULT_DGGAL_GRID_TYPE: DggalGridType = "isea3h";

export type DggalGridSpec = (typeof DGGAL_TYPES)[DggalGridType];

/** Labels shown in the processing dialog (engine class names). */
export const DGGAL_GRID_TYPE_OPTIONS: { value: DggalGridType; label: string }[] =
  DGGAL_GRID_TYPES.map((value) => ({ value, label: DGGAL_TYPES[value].className }));

export function resolveDggalGridType(raw: unknown): DggalGridType {
  if (typeof raw === "string" && Object.hasOwn(DGGAL_TYPES, raw)) {
    return raw as DggalGridType;
  }
  return DEFAULT_DGGAL_GRID_TYPE;
}

export function maxResolutionForDggal(gridType: DggalGridType = DEFAULT_DGGAL_GRID_TYPE): number {
  return DGGAL_TYPES[gridType].maxRes;
}

/** Soft target used when auto-suggesting a resolution. */
export const DGGAL_TARGET_CELLS = 10_000;
/** Finest resolution the auto-suggester will pick. */
export const DGGAL_MAX_SUGGESTED_RES = 12;
/** Hard ceiling: a grid larger than this aborts rather than running away. */
export const DGGAL_HARD_CAP = 200_000;
/** Absolute finest resolution across exposed DGGAL types (ISEA3H / IVEA3H / RTEA3H). */
export const DGGAL_MAX_TOOL_RES = Math.max(...DGGAL_GRID_TYPES.map((t) => DGGAL_TYPES[t].maxRes));

const EARTH_AREA_KM2 = 510_065_621.724;
const DEG_PER_RAD = 180 / Math.PI;
const RAD_PER_DEG = Math.PI / 180;

/** Approximate global zone count at `res` (for suggest / pre-cap without WASM). */
export function dggalApproxGlobalCount(res: number, gridType: DggalGridType): number {
  const name = DGGAL_TYPES[gridType].className;
  if (name === "HEALPix" || name === "rHEALPix") return 12 * 4 ** res;
  if (name.endsWith("3H")) return 10 * 3 ** res + 2;
  if (name.endsWith("7H") || name.endsWith("7H_Z7")) return 10 * 7 ** res + 2;
  if (name.endsWith("9R")) return 10 * 9 ** res + 2;
  if (name.endsWith("4R")) return 10 * 4 ** res + 2;
  // GNOSISGlobalGrid and fallbacks: treat like aperture-4.
  return 10 * 4 ** res + 2;
}

export function estimateDggalCellCount(
  areaKm2: number,
  res: number,
  gridType: DggalGridType = DEFAULT_DGGAL_GRID_TYPE,
): number {
  const global = dggalApproxGlobalCount(res, gridType);
  if (!Number.isFinite(global) || global <= 0) return Number.POSITIVE_INFINITY;
  return (areaKm2 / EARTH_AREA_KM2) * global;
}

export function suggestDggalResolution(
  areaKm2: number,
  targetCells = DGGAL_TARGET_CELLS,
  maxRes = DGGAL_MAX_SUGGESTED_RES,
  gridType: DggalGridType = DEFAULT_DGGAL_GRID_TYPE,
): number {
  const capped = Math.min(maxRes, DGGAL_TYPES[gridType].maxRes);
  for (let res = capped; res >= 0; res -= 1) {
    if (estimateDggalCellCount(areaKm2, res, gridType) <= targetCells) return res;
  }
  return 0;
}

/** Geographic point in radians (DGGAL native). */
interface GeoPoint {
  lat: number;
  lon: number;
}

/** Subset of a DGGAL DGGRS instance used by the processing tools. */
export interface DggalDggrs {
  getZoneFromTextID(zoneId: string): bigint;
  getZoneTextID(zone: bigint): string;
  getZoneLevel(zone: bigint): number;
  getZoneWGS84Centroid(zone: bigint): GeoPoint;
  getZoneRefinedWGS84Vertices(zone: bigint, edgeRefinement: number): GeoPoint[];
  listZones(level: number, bbox: { ll: GeoPoint; ur: GeoPoint }): bigint[];
  getZoneFromWGS84Centroid(level: number, geoPoint: GeoPoint): bigint;
  countZones(level: number): bigint;
  /** Recursively replace full child sets with parents (mutates conceptually; returns new list). */
  compactZones(zones: bigint[]): bigint[];
  /** Sub-zones of `zone` at relative `depth` (1 = immediate children). */
  getSubZones(zone: bigint, depth: number): bigint[];
  /** Number of sub-zones at relative `depth` (bigint from WASM). */
  countSubZones(zone: bigint, depth: number): bigint | number;
  delete(): void;
}

export interface DggalEngine {
  createDGGRS(name: string): DggalDggrs;
}

let dggalPromise: Promise<DggalEngine> | null = null;

/** Load the DGGAL WASM module once (dynamic import keeps it out of cold paths). */
export function loadDggal(): Promise<DggalEngine> {
  dggalPromise ??= import("dggal")
    .then((module) => module.DGGAL.init() as unknown as Promise<DggalEngine>)
    .catch((error) => {
      dggalPromise = null;
      throw error;
    });
  return dggalPromise;
}

/** Run `fn` with a short-lived DGGRS for `gridType`, always deleting the instance. */
export async function withDggalDggrs<T>(
  gridType: DggalGridType,
  fn: (engine: DggalDggrs) => T | Promise<T>,
): Promise<T> {
  const dggal = await loadDggal();
  const engine = dggal.createDGGRS(DGGAL_TYPES[gridType].className);
  try {
    return await fn(engine);
  } finally {
    engine.delete();
  }
}

function normalizeLon(lon: number): number {
  let x = lon;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

function zoneRing(engine: DggalDggrs, zone: bigint): number[][] {
  const ring = engine
    .getZoneRefinedWGS84Vertices(zone, 0)
    .map(({ lat, lon }): number[] => [lon * DEG_PER_RAD, lat * DEG_PER_RAD]);
  if (ring.length > 0) {
    const [firstLng, firstLat] = ring[0]!;
    const [lastLng, lastLat] = ring[ring.length - 1]!;
    if (firstLng !== lastLng || firstLat !== lastLat) ring.push([firstLng!, firstLat!]);
  }
  return ring;
}

/** Convert a DGGAL zone text ID to a GeoJSON polygon feature. */
export function dggalZoneFeature(engine: DggalDggrs, cell: string): Feature<Polygon> {
  const zone = engine.getZoneFromTextID(cell);
  const centroid = engine.getZoneWGS84Centroid(zone);
  return {
    type: "Feature",
    id: cell,
    properties: {
      dggal: cell,
      resolution: engine.getZoneLevel(zone),
      center_lat: centroid.lat * DEG_PER_RAD,
      center_lng: centroid.lon * DEG_PER_RAD,
    },
    geometry: { type: "Polygon", coordinates: [zoneRing(engine, zone)] },
  };
}

/** Build polygon features from DGGAL zone text IDs. */
export function dggalTokensToFeatureCollection(
  engine: DggalDggrs,
  tokens: Iterable<string>,
): FeatureCollection<Polygon> {
  return {
    type: "FeatureCollection",
    features: [...tokens].map((token) => dggalZoneFeature(engine, token)),
  };
}

/** Drop null / unreadable zone handles from WASM array paddings. */
function validZones(engine: DggalDggrs, zones: Iterable<bigint>): bigint[] {
  const out: bigint[] = [];
  for (const zone of zones) {
    if (zone === 0n) continue;
    try {
      engine.getZoneLevel(zone);
      out.push(zone);
    } catch {
      // Padding / invalid handle.
    }
  }
  return out;
}

/**
 * Fill a WGS84 bounding box with DGGAL zones via `listZones` (same approach as
 * the maplibre-dggal plugin).
 */
export function dggalGridFromBbox(
  engine: DggalDggrs,
  bounds: [number, number, number, number],
  resolution: number,
  limit = DGGAL_HARD_CAP,
  options: { compact?: boolean } = {},
): FeatureCollection<Polygon> {
  let [west, south, east, north] = bounds;
  south = Math.max(-90, Math.min(90, south));
  north = Math.max(-90, Math.min(90, north));
  if (south > north) [south, north] = [north, south];
  if (east - west >= 360) {
    west = -180;
    east = 180;
  } else {
    west = normalizeLon(west);
    east = normalizeLon(east);
  }
  if (east < west) {
    // Cover each side without compacting, then compact once over the union so
    // sibling sets that straddle the antimeridian can still merge.
    const left = dggalGridFromBbox(engine, [west, south, 180, north], resolution, limit);
    const right = dggalGridFromBbox(engine, [-180, south, east, north], resolution, limit);
    const seen = new Set<string>();
    const features: Feature<Polygon>[] = [];
    for (const feature of [...left.features, ...right.features]) {
      const id = String(feature.properties?.dggal ?? feature.id);
      if (seen.has(id)) continue;
      seen.add(id);
      features.push(feature);
      if (features.length > limit) {
        throw new RangeError(`DGGAL zone limit exceeded: ${limit}`);
      }
    }
    if (options.compact) {
      const tokens = compactDggalTokens(
        engine,
        features.map((f) => String(f.properties?.dggal ?? f.id)),
      );
      return dggalTokensToFeatureCollection(engine, tokens);
    }
    return { type: "FeatureCollection", features };
  }

  let zones = validZones(
    engine,
    engine.listZones(resolution, {
      ll: { lat: south * RAD_PER_DEG, lon: west * RAD_PER_DEG },
      ur: { lat: north * RAD_PER_DEG, lon: east * RAD_PER_DEG },
    }),
  );
  if (zones.length > limit) {
    throw new RangeError(`DGGAL zone limit exceeded: ${limit}`);
  }
  if (options.compact) {
    zones = validZones(engine, engine.compactZones(zones));
  }
  return {
    type: "FeatureCollection",
    features: zones.map((zone) => dggalZoneFeature(engine, engine.getZoneTextID(zone))),
  };
}

/**
 * Polyfill polygon geometry: list zones over each feature's bbox, keep those
 * whose centroid falls inside the polygon (DGGAL has no native polyfill).
 */
export function dggalGridFromFeatureCollection(
  engine: DggalDggrs,
  fc: FeatureCollection,
  resolution: number,
  limit = DGGAL_HARD_CAP,
  options: { compact?: boolean } = {},
): FeatureCollection<Polygon> {
  const seen = new Set<string>();
  const features: Feature<Polygon>[] = [];

  const consider = (poly: Polygon) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ring of poly.coordinates) {
      for (const pos of ring) {
        const x = pos[0];
        const y = pos[1];
        if (x === undefined || y === undefined) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (!Number.isFinite(minX) || minX >= maxX || minY >= maxY) return;
    const candidates = dggalGridFromBbox(engine, [minX, minY, maxX, maxY], resolution, limit);
    for (const feature of candidates.features) {
      const id = String(feature.properties?.dggal ?? feature.id);
      if (seen.has(id)) continue;
      const lng = Number(feature.properties?.center_lng);
      const lat = Number(feature.properties?.center_lat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      if (!booleanPointInPolygon(turfPoint([lng, lat]), poly)) continue;
      seen.add(id);
      features.push(feature);
      if (features.length > limit) {
        throw new RangeError(`DGGAL zone limit exceeded: ${limit}`);
      }
    }
  };

  for (const feature of fc.features) {
    const g = feature.geometry;
    if (!g) continue;
    if (g.type === "Polygon") consider(g);
    else if (g.type === "MultiPolygon") {
      for (const coords of g.coordinates) {
        consider({ type: "Polygon", coordinates: coords });
      }
    }
  }
  if (options.compact) {
    const tokens = compactDggalTokens(
      engine,
      features.map((f) => String(f.properties?.dggal ?? f.id)),
    );
    return dggalTokensToFeatureCollection(engine, tokens);
  }
  return { type: "FeatureCollection", features };
}

/** Collect DGGAL zone text IDs from a feature property (default `dggal`). */
export function tokensFromDggalLayer(fc: FeatureCollection, cellField = "dggal"): string[] {
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
 * Compact zone text IDs with {@link DggalDggrs.compactZones}: complete child
 * sets become their parents (mixed resolutions; behaviour is DGGRS-specific).
 */
export function compactDggalTokens(engine: DggalDggrs, tokens: Iterable<string>): string[] {
  const zones: bigint[] = [];
  for (const token of tokens) {
    zones.push(engine.getZoneFromTextID(token));
  }
  if (zones.length === 0) return [];
  return validZones(engine, engine.compactZones(zones)).map((z) => engine.getZoneTextID(z));
}

/**
 * Expand zone text IDs to a uniform `level` via {@link DggalDggrs.getSubZones}.
 * Cells finer than `level` throw.
 */
export function expandDggalTokens(
  engine: DggalDggrs,
  tokens: Iterable<string>,
  level: number,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    const zone = engine.getZoneFromTextID(token);
    const L = engine.getZoneLevel(zone);
    if (L > level) {
      throw new RangeError(
        `DGGAL cell ${token} is finer than target level ${level}; choose a finer target or compact first`,
      );
    }
    if (L === level) {
      const id = engine.getZoneTextID(zone);
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
      continue;
    }
    for (const sub of validZones(engine, engine.getSubZones(zone, level - L))) {
      const id = engine.getZoneTextID(sub);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Exact cell count after expanding `tokens` to `level`. */
export function estimateDggalExpandCount(
  engine: DggalDggrs,
  tokens: Iterable<string>,
  level: number,
): number {
  let n = 0;
  for (const token of tokens) {
    const zone = engine.getZoneFromTextID(token);
    const L = engine.getZoneLevel(zone);
    if (L > level) return 0;
    if (L === level) {
      n += 1;
      continue;
    }
    n += Number(engine.countSubZones(zone, level - L));
  }
  return n;
}

/** Compact a polygon cell layer's `dggal` (or other) ID field. */
export function compactDggalFeatureCollection(
  engine: DggalDggrs,
  fc: FeatureCollection,
  options: { cellField?: string } = {},
): FeatureCollection<Polygon> {
  const tokens = compactDggalTokens(engine, tokensFromDggalLayer(fc, options.cellField ?? "dggal"));
  return dggalTokensToFeatureCollection(engine, tokens);
}

/** Expand a polygon cell layer to a uniform DGGAL level. */
export function expandDggalFeatureCollection(
  engine: DggalDggrs,
  fc: FeatureCollection,
  level: number,
  options: { cellField?: string } = {},
): FeatureCollection<Polygon> {
  const tokens = expandDggalTokens(
    engine,
    tokensFromDggalLayer(fc, options.cellField ?? "dggal"),
    level,
  );
  return dggalTokensToFeatureCollection(engine, tokens);
}

/** Supported point-binning aggregate operations (same set as H3). */
export type DggalAggOp = "count" | "sum" | "mean" | "min" | "max";

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

/** Aggregate point geometry into DGGAL zones (client-side). */
export function binPointsToDggal(
  engine: DggalDggrs,
  fc: FeatureCollection,
  resolution: number,
  op: DggalAggOp,
  field?: string,
): FeatureCollection<Polygon> {
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
      const zone = engine.getZoneFromWGS84Centroid(resolution, {
        lat: lat * RAD_PER_DEG,
        lon: lng * RAD_PER_DEG,
      });
      const token = engine.getZoneTextID(zone);
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
    const feature = dggalZoneFeature(engine, token);
    const properties: Record<string, unknown> = { ...feature.properties, count: acc.count };
    if (op === "sum") properties.value = acc.sum;
    else if (op === "mean") properties.value = acc.count > 0 ? acc.sum / acc.count : 0;
    else if (op === "min") properties.value = Number.isFinite(acc.min) ? acc.min : null;
    else if (op === "max") properties.value = Number.isFinite(acc.max) ? acc.max : null;
    features.push({ ...feature, properties });
  }
  return { type: "FeatureCollection", features };
}
