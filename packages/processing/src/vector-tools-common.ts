// Shared parameter readers and geometry helpers for the client-side vector tools.

import union from "@turf/union";
import booleanIntersects from "@turf/boolean-intersects";
import booleanContains from "@turf/boolean-contains";
import booleanWithin from "@turf/boolean-within";
import { featureCollection } from "@turf/helpers";
import type {
  BBox,
  Feature,
  FeatureCollection,
  Geometry,
  Point,
  Polygon,
  MultiPolygon,
} from "geojson";
import type { GeoLibreLayer } from "@geolibre/core/worker-safe";
import type { GeometryFamily, ProcessingContext } from "./types";

/** Upper bound on input×overlay pairs for the main-thread pairwise loops. */
export const MAX_CLIENT_PAIRS = 250_000;

export function getLayer(ctx: ProcessingContext, paramId = "layer"): GeoLibreLayer | undefined {
  const layerId = ctx.parameters[paramId] as string | undefined;
  return ctx.layers.find((l) => l.id === layerId);
}

export function requireFeatures(
  ctx: ProcessingContext,
  paramId = "layer",
): FeatureCollection | undefined {
  const layer = getLayer(ctx, paramId);
  if (!layer?.geojson?.features?.length) {
    ctx.log(`Error: parameter "${paramId}" has no GeoJSON features`);
    return undefined;
  }
  return layer.geojson;
}

export function numberParam(ctx: ProcessingContext, id: string, fallback: number): number {
  const raw = ctx.parameters[id];
  const value = typeof raw === "string" ? Number(raw) : (raw as number);
  return Number.isFinite(value) ? value : fallback;
}

/** True when a feature's geometry belongs to the given family. */
export function isFamily(geometry: Geometry | null, family: GeometryFamily): boolean {
  const type = geometry?.type;
  if (!type) return false;
  if (family === "point") return type === "Point" || type === "MultiPoint";
  if (family === "line") return type === "LineString" || type === "MultiLineString";
  return type === "Polygon" || type === "MultiPolygon";
}

/** Collect every polygon/multipolygon feature from a collection. */
export function polygonFeatures(fc: FeatureCollection): Feature<Polygon | MultiPolygon>[] {
  return fc.features.filter((f) => isFamily(f.geometry, "polygon")) as Feature<
    Polygon | MultiPolygon
  >[];
}

/** Merge all polygons of a collection into a single (multi)polygon feature. */
export function mergePolygons(fc: FeatureCollection): Feature<Polygon | MultiPolygon> | null {
  const polys = polygonFeatures(fc);
  if (!polys.length) return null;
  if (polys.length === 1) return polys[0];
  try {
    const batched = union(featureCollection(polys));
    if (batched) return batched as Feature<Polygon | MultiPolygon>;
  } catch {
    // Fall back to pairwise union if a degenerate polygon throws during batching.
  }
  let merged: Feature<Polygon | MultiPolygon> | null = null;
  for (let i = 0; i < polys.length; i += 1) {
    const candidate = polys[i];
    if (!merged) {
      // Probe whether this candidate is valid for Turf before seeding `merged`
      // so an invalid first polygon (e.g. `[[]]`) is skipped instead of being
      // returned as the merged output while dropping later valid polygons.
      try {
        const seeded = union(featureCollection([candidate, candidate]));
        if (seeded) merged = seeded as Feature<Polygon | MultiPolygon>;
      } catch {
        // Skip malformed candidate and try the next polygon as seed.
      }
      continue;
    }
    try {
      const next = union(featureCollection([merged, candidate]));
      // Turf can return null for degenerate/self-intersecting geometry; keep the
      // last good accumulation rather than aborting the whole merge.
      if (next) merged = next as Feature<Polygon | MultiPolygon>;
    } catch {
      // Keep the last good accumulation rather than aborting the whole merge.
    }
  }
  return merged;
}

/** Summary statistics for Aggregate by attribute; kept in sync with the backend. */
export const AGGREGATE_STATS = new Set(["count", "sum", "mean", "min", "max", "median"]);

/**
 * Coerce a property value to a finite number the way pandas' ``to_numeric`` does
 * for the aggregate engine: real numbers pass through, booleans map to 1/0 (as
 * pandas' `to_numeric` does), numeric strings parse (decimal/scientific only —
 * see {@link parseFiniteNumber}), and everything else (null, NaN, text, objects)
 * becomes null and is skipped by the reducers, matching pandas' default skipna
 * behaviour.
 */
export function toNumeric(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = parseFiniteNumber(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Reduce a group's numeric values with one statistic, mirroring pandas:
 * ``sum`` of an empty group is 0 (skipna), while ``mean``/``min``/``max``/
 * ``median`` of an empty group are null (NaN → null in GeoJSON). ``count`` is
 * handled by the caller (it counts features, not numeric values).
 */
export function computeStat(nums: number[], statistic: string): number | null {
  if (statistic === "sum") return nums.reduce((a, b) => a + b, 0);
  if (!nums.length) return null;
  if (statistic === "mean") return nums.reduce((a, b) => a + b, 0) / nums.length;
  // reduce, not Math.min/max(...nums): the spread passes every element as an
  // argument and a tens-of-thousands-element group would exceed the engine's
  // argument-count limit and throw.
  if (statistic === "min") return nums.reduce((a, b) => (a < b ? a : b));
  if (statistic === "max") return nums.reduce((a, b) => (a > b ? a : b));
  if (statistic === "median") {
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return null;
}

/**
 * Values both engines read as a boolean parameter, matched case-insensitively
 * after trimming. Plain truthiness cannot be shared: `Boolean([])` is `true`
 * while Python's `bool([])` is `False`, and a checkbox that reached the tool as
 * the *string* `"false"` (a query string, a CSV batch row, a replayed history
 * entry) is truthy in both languages, which is the opposite of what the caller
 * meant. Spelling the accepted words out keeps the two engines on one reading
 * and turns a typo into an error instead of a silent dissolve.
 */
export const TRUE_STRINGS = new Set(["true", "1", "yes", "on"]);

export const FALSE_STRINGS = new Set(["", "false", "0", "no", "off"]);

/**
 * Read a checkbox parameter the way `vector_ops._boolean_param` does.
 *
 * An absent or null value is the unchecked default; a JSON boolean passes
 * through; a finite number is its zero/non-zero truthiness; a string must be
 * one of {@link TRUE_STRINGS}/{@link FALSE_STRINGS}. Anything else (an array,
 * an object, NaN) returns `null` so the caller can reject it rather than pick a
 * coercion the other engine does not share.
 *
 * @param raw - The raw parameter value as it arrived from the caller.
 * @returns The boolean, or `null` when the value is not a boolean at all.
 */
export function booleanParam(raw: unknown): boolean | null {
  if (raw == null) return false;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw !== 0 : null;
  if (typeof raw === "string") {
    const text = raw.trim().toLowerCase();
    if (TRUE_STRINGS.has(text)) return true;
    if (FALSE_STRINGS.has(text)) return false;
    return null;
  }
  return null;
}

/**
 * Whether a GeoJSON coordinate array holds at least one real position.
 *
 * Zero rings is the shape jsts usually returns for an emptied geometry, but not
 * the only one: a `Polygon` can come back with a single *empty* ring
 * (`[[]]`), and a `MultiPolygon` with several individually degenerate parts —
 * both of which have a non-zero `coordinates.length` while still being
 * undrawable. Recursing to the first number catches every arity.
 *
 * Exported for tests: turf rejects a degenerate geometry on the way *in*
 * ("coordinates must contain numbers"), so this guard's job is to catch one
 * coming back *out* and cannot be reached through the tool's own parameters.
 */
export function hasPositions(coordinates: unknown): boolean {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return false;
  if (typeof coordinates[0] === "number") return true;
  return coordinates.some(hasPositions);
}

/**
 * Shared engine for two-layer polygon overlay operations
 * (clip, intersection, difference). Each input feature is combined with the
 * merged overlay geometry via the supplied Turf operation.
 */
export function overlay(
  ctx: ProcessingContext,
  op: (
    a: Feature<Polygon | MultiPolygon>,
    b: Feature<Polygon | MultiPolygon>,
  ) => Feature<Polygon | MultiPolygon> | null,
  resultName: string,
  keepProperties: boolean,
): void {
  const input = requireFeatures(ctx, "layer");
  const overlayFc = requireFeatures(ctx, "overlay");
  if (!input || !overlayFc) return;
  const inputPolys = polygonFeatures(input);
  const overlayGeom = mergePolygons(overlayFc);
  if (!inputPolys.length || !overlayGeom) {
    ctx.log("Error: both layers must contain polygon features");
    return;
  }
  const results: Feature[] = [];
  for (const feature of inputPolys) {
    const result = op(feature, overlayGeom);
    if (result?.geometry) {
      result.properties = keepProperties ? (feature.properties ?? {}) : {};
      results.push(result);
    }
  }
  ctx.log(`${resultName}: produced ${results.length} feature(s)`);
  ctx.addResultLayer?.(resultName, featureCollection(results));
}

/** Spatial relationship used to match input features against join features. */
export type SpatialPredicate = "intersects" | "within" | "contains";

/**
 * Raw predicate test, mirroring GeoPandas `sjoin(predicate=...)` semantics (the
 * relationship reads left→right): `within` is "input within join", `contains`
 * is "input contains join". Throws on geometries Turf cannot evaluate (e.g. a
 * GeometryCollection).
 */
export function rawPredicate(input: Feature, join: Feature, predicate: SpatialPredicate): boolean {
  if (predicate === "within") return booleanWithin(input, join);
  if (predicate === "contains") return booleanContains(input, join);
  return booleanIntersects(input, join);
}

/** Suffix a join tool gives a join field whose name clashes with an input field. */
export const JOIN_FIELD_SUFFIX = "_right";

/**
 * Map overlay property names for intersection results so neither exact-name nor
 * case-insensitive collisions overwrite input properties.
 */
export function overlayFieldOutputNames(
  inputKeys: Iterable<string>,
  overlayKeys: Iterable<string>,
): Map<string, string> {
  const taken = new Set([...inputKeys].map((key) => key.toLowerCase()));
  const names = new Map<string, string>();
  for (const key of overlayKeys) {
    if (names.has(key)) continue;
    let name = key;
    if (taken.has(name.toLowerCase())) {
      name = `${key}${JOIN_FIELD_SUFFIX}`;
      for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
        name = `${key}${JOIN_FIELD_SUFFIX}_${n}`;
      }
    }
    taken.add(name.toLowerCase());
    names.set(key, name);
  }
  return names;
}

/** Every property name across `features`, in first-seen order. */
export function propertyKeys(features: Feature[]): string[] {
  const keys = new Set<string>();
  for (const feature of features) {
    for (const key of Object.keys(feature.properties ?? {})) keys.add(key);
  }
  return [...keys];
}

/** True when two `[west, south, east, north]` boxes overlap or touch; a missing box never does. */
export function bboxesOverlap(a: BBox | null, b: BBox | null): boolean {
  if (!a || !b) return false;
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** Stable JSON for arrays/objects (sorted keys) so both engines stringify alike. */
export function stableStringify(value: unknown): string {
  // JSON.stringify(undefined) is the value `undefined`, which would join to "" in
  // an array (e.g. "[1,,3]"); emit "null" to match Python's None ("[1,null,3]").
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",");
  return `{${body}}`;
}

/**
 * Parse a string to a finite number accepting exactly the forms Python's
 * `float()` does — decimal/scientific notation only (no hex/octal/binary),
 * surrounding whitespace allowed — so the client and Python numeric coercion
 * agree. (`Number("0x10")` is 16 and `parseFloat("0x10")` is 0, but
 * `float("0x10")` raises, so neither built-in matches.) Returns NaN otherwise.
 */
export function parseFiniteNumber(text: string): number {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text.trim())) return NaN;
  return Number(text);
}

/** Collect every Point (exploding MultiPoint) from a collection as Point features. */
export function collectPoints(fc: FeatureCollection): Feature<Point>[] {
  const points: Feature<Point>[] = [];
  for (const feature of fc.features) {
    const geometry = feature.geometry;
    if (geometry?.type === "Point") {
      points.push(feature as Feature<Point>);
    } else if (geometry?.type === "MultiPoint") {
      for (const coordinates of geometry.coordinates) {
        points.push({
          type: "Feature",
          properties: feature.properties ?? {},
          geometry: { type: "Point", coordinates },
        });
      }
    }
  }
  return points;
}

/** Linear/angular units shared by the sector and proximity tools. */
export const LINEAR_UNITS = new Set(["kilometers", "meters", "miles"]);

export type LinearUnit = "kilometers" | "meters" | "miles";

/** Metres in one of each {@link LINEAR_UNITS} unit (the international mile). */
export const METERS_PER_LINEAR_UNIT: Record<LinearUnit, number> = {
  kilometers: 1000,
  meters: 1,
  miles: 1609.344,
};
