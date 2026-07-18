import bboxPolygon from "@turf/bbox-polygon";
import bbox from "@turf/bbox";
import buffer from "@turf/buffer";
import centroid from "@turf/centroid";
import convex from "@turf/convex";
import mask from "@turf/mask";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
} from "geojson";
import type { GeometryGeneratorType, LayerStyle } from "@geolibre/core";
import { styleValue } from "@geolibre/core";

/**
 * Derived feature collections for the symbology pack (#1323): the inverted
 * polygon mask and the per-feature geometry generator. Both are pure
 * geometry→geometry transforms rendered through companion GeoJSON sources, so
 * they are computed here (DOM-free, unit-testable) and memoized per source
 * collection — syncs fire rapidly (opacity drags) and the store replaces the
 * collection object on every data mutation, making a WeakMap the natural cache
 * key, mirroring the deduped-label cache in layer-sync.
 */

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

// Bound the per-collection generator cache: buffer distances are free-typed,
// so every distinct value would otherwise pin a full derived collection for
// the lifetime of the source geojson object.
const MAX_GENERATOR_CACHE_ENTRIES = 8;

// One cache entry per (collection, params) pair. The params key is tiny
// (renderer type + buffer distance), so per-collection Maps stay small.
const maskCache = new WeakMap<
  FeatureCollection,
  FeatureCollection<Polygon | MultiPolygon> | null
>();
const generatorCache = new WeakMap<
  FeatureCollection,
  Map<string, FeatureCollection>
>();

function polygonFeatures(
  collection: FeatureCollection,
): Feature<Polygon | MultiPolygon>[] {
  return collection.features.filter(
    (feature): feature is Feature<Polygon | MultiPolygon> =>
      feature.geometry?.type === "Polygon" ||
      feature.geometry?.type === "MultiPolygon",
  );
}

/**
 * Build the inverted-fill mask for a layer: one polygon covering the world
 * with every source polygon cut out as a hole (QGIS "Inverted polygons").
 * Returns null when the collection has no polygon features or the mask
 * cannot be computed (e.g. invalid rings), in which case the caller renders
 * the normal fill instead of silently dropping it.
 *
 * @param collection - The layer's feature collection.
 * @returns A single-feature collection holding the mask, or null.
 */
export function buildInvertedMask(
  collection: FeatureCollection,
): FeatureCollection<Polygon | MultiPolygon> | null {
  if (maskCache.has(collection)) return maskCache.get(collection) ?? null;
  const result = computeInvertedMask(collection);
  maskCache.set(collection, result);
  return result;
}

function computeInvertedMask(
  collection: FeatureCollection,
): FeatureCollection<Polygon | MultiPolygon> | null {
  const polygons = polygonFeatures(collection);
  if (polygons.length === 0) return null;
  try {
    // turf mask unions the features (polygon-clipping), so overlapping
    // polygons still produce a clean even-odd-free mask.
    const masked = mask({ type: "FeatureCollection", features: polygons });
    return { type: "FeatureCollection", features: [masked] };
  } catch {
    // Degenerate rings (self-intersections the clipper rejects) must not
    // break layer sync; the caller falls back to the normal fill.
    return null;
  }
}

/**
 * Build the geometry generator's derived collection: one derived feature per
 * source feature, preserving the source properties (so popups and filters
 * keep working against the derived symbols).
 *
 * - `"centroid"`: a point per feature (any geometry kind).
 * - `"bounding-box"`: the feature's axis-aligned bbox polygon.
 * - `"convex-hull"`: the feature's convex hull (needs ≥3 distinct vertices).
 * - `"buffer"`: a polygon buffer of `bufferDistance` meters.
 *
 * Features whose derived geometry cannot be computed (e.g. the hull of a
 * single point, a negative buffer that consumes the polygon) are skipped
 * rather than failing the whole collection.
 *
 * @param collection - The layer's feature collection.
 * @param type - The generator preset.
 * @param bufferDistance - Buffer distance in meters (buffer preset only).
 * @returns The derived collection (possibly empty), or null when the
 *   generator is `"none"`.
 */
export function buildGeneratedGeometry(
  collection: FeatureCollection,
  type: GeometryGeneratorType,
  bufferDistance: number,
): FeatureCollection | null {
  if (type === "none") return null;
  const distance =
    type === "buffer" && Number.isFinite(bufferDistance) ? bufferDistance : 0;
  if (type === "buffer" && distance === 0) return EMPTY;
  const key = type === "buffer" ? `buffer:${distance}` : type;
  let byKey = generatorCache.get(collection);
  if (!byKey) {
    byKey = new Map();
    generatorCache.set(collection, byKey);
  }
  const cached = byKey.get(key);
  if (cached) return cached;
  const result = computeGeneratedGeometry(collection, type, distance);
  // The buffer key space is user-typed and unbounded, so cap the
  // per-collection cache (oldest evicted first) — unlike the sibling caches
  // whose key cardinality is naturally small.
  if (byKey.size >= MAX_GENERATOR_CACHE_ENTRIES) {
    const oldest = byKey.keys().next().value;
    if (oldest !== undefined) byKey.delete(oldest);
  }
  byKey.set(key, result);
  return result;
}

function computeGeneratedGeometry(
  collection: FeatureCollection,
  type: Exclude<GeometryGeneratorType, "none">,
  bufferDistance: number,
): FeatureCollection {
  const features: Feature[] = [];
  for (const feature of collection.features) {
    if (!feature.geometry) continue;
    const derived = deriveFeature(feature, type, bufferDistance);
    if (derived) {
      features.push({
        type: "Feature",
        properties: feature.properties ?? {},
        geometry: derived.geometry,
      });
    }
  }
  return { type: "FeatureCollection", features };
}

function deriveFeature(
  feature: Feature,
  type: Exclude<GeometryGeneratorType, "none">,
  bufferDistance: number,
): Feature | null {
  try {
    switch (type) {
      case "centroid":
        return centroid(feature);
      case "bounding-box": {
        const box = bbox(feature);
        if (!box.every((value) => Number.isFinite(value))) return null;
        // A point's bbox is degenerate (zero area) and would render nothing.
        if (box[0] === box[2] && box[1] === box[3]) return null;
        return bboxPolygon(box as [number, number, number, number]);
      }
      case "convex-hull":
        return convex({ type: "FeatureCollection", features: [feature] });
      case "buffer":
        return (
          buffer(feature, bufferDistance, { units: "meters" }) ?? null
        );
    }
  } catch {
    // Per-feature failures (invalid geometry) skip that feature only.
    return null;
  }
}

/**
 * The geometry kinds present in a generated collection, used by layer sync to
 * decide which companion render layers (fill/line vs circle) to create.
 */
export function generatedGeometryKinds(collection: FeatureCollection): {
  hasPoint: boolean;
  hasPolygon: boolean;
} {
  let hasPoint = false;
  let hasPolygon = false;
  for (const feature of collection.features) {
    const kind = feature.geometry?.type;
    if (kind === "Point" || kind === "MultiPoint") hasPoint = true;
    if (kind === "Polygon" || kind === "MultiPolygon") hasPolygon = true;
    if (hasPoint && hasPolygon) break;
  }
  return { hasPoint, hasPolygon };
}

/**
 * Resolve the decoration color: an unset (empty) color inherits the stroke
 * color so decorations follow the line by default.
 */
export function lineDecorationColorValue(style: LayerStyle): string {
  const color = styleValue(style, "lineDecorationColor").trim();
  return color || styleValue(style, "strokeColor");
}
