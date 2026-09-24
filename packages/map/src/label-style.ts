import {
  documentLocale,
  formatLabelNumber,
  resolveLabelNumberLocale,
  validateMapExpression,
  type LabelStyle,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { buildDedupedLabelFeatures } from "./label-dedup";

// Label helpers shared by MapLibre's layer-sync and the Mapbox compiler. Both
// style specs read the same expressions, so the aggregated dedup source and
// the validated data-defined overrides are built once here. Kept free of any
// renderer import so the Mapbox bundle never pulls in maplibre-gl.

export { DEDUPED_LABEL_PROPERTY } from "./label-dedup";

/** Geoman's shape value for a Geo Editor text marker. */
export const TEXT_MARKER_SHAPE = "text_marker";
/** The feature property Geoman stores a drawn shape's kind in. */
export const GEOMAN_SHAPE_PROPERTY = "__gm_shape";
/** The feature property a Geo Editor text marker stores its text in. */
export const GEOMAN_TEXT_PROPERTY = "__gm_text";

/**
 * Matches Geo Editor text-marker points (by Geoman's shape property or the
 * plain `shape` one). They carry their own annotation text, so attribute
 * labels and the plain point layers skip them.
 */
export const TEXT_MARKER_SHAPE_FILTER = [
  "any",
  ["==", ["get", GEOMAN_SHAPE_PROPERTY], TEXT_MARKER_SHAPE],
  ["==", ["get", "shape"], TEXT_MARKER_SHAPE],
];

/** A validated data-defined label override: a style-spec expression. */
export type LabelOverrideExpression = unknown[];

// Deduplicated label features are also O(n) over the source, so memoize them by
// collection reference (keyed by the field + mode, since both change the result)
// to avoid rebuilding on every rapid sync.
const dedupedLabelCache = new WeakMap<FeatureCollection, Map<string, FeatureCollection | null>>();

export function getDedupedLabelFeatures(
  collection: FeatureCollection,
  labels: LabelStyle,
): FeatureCollection | null {
  let byKey = dedupedLabelCache.get(collection);
  if (!byKey) {
    byKey = new Map();
    dedupedLabelCache.set(collection, byKey);
  }
  // Number formatting is part of the key: it changes the aggregated label
  // text, and "unique"/"concatenate" group on that text. The key carries the
  // *effective* locale, resolved the same way the formatter resolves it, so a
  // stored tag the formatter rejects (malformed, or one the map cannot draw)
  // does not pin the cache to a locale the labels were never formatted with,
  // and switching the app language reformats labels that follow it
  // (`numberLocale: ""`) instead of serving the previous language's separators.
  const locale = documentLocale();
  const key = [
    labels.dedupe,
    labels.numberFormatEnabled
      ? `${labels.numberDecimals}:${resolveLabelNumberLocale(labels.numberLocale, locale) ?? ""}`
      : "raw",
    labels.field,
  ].join("|");
  if (byKey.has(key)) return byKey.get(key) ?? null;
  // Geo Editor text markers carry their own annotation text and never take an
  // attribute label; the aggregated points drop the shape property the label
  // layer's exclusion filter reads, so leave them out before aggregating.
  const labelled = collection.features.some(isTextMarkerFeature)
    ? { ...collection, features: collection.features.filter((f) => !isTextMarkerFeature(f)) }
    : collection;
  const result = buildDedupedLabelFeatures(labelled, labels.field, labels.dedupe, (value) =>
    formatLabelNumber(value, labels, locale),
  );
  byKey.set(key, result);
  return result;
}

// Data-defined label overrides are re-read on every sync (which can fire per
// frame, e.g. while dragging the opacity slider), and validating through the
// style spec is far more expensive than the reads, so results are memoized by
// expected type + source. Bounded so a pathological stream of distinct
// expressions cannot grow it without limit.
const labelOverrideCache = new Map<string, LabelOverrideExpression | null>();
const LABEL_OVERRIDE_CACHE_MAX = 256;

/**
 * Parses and validates a data-defined label override (a MapLibre expression
 * stored as a JSON string) against its destination's expected result type.
 * Returns null — falling back to the literal control — for anything invalid:
 * malformed JSON, a non-expression value, or a type the destination cannot
 * accept. The `|| ""` guards against a hand-edited project file storing null
 * for an expression field (the type says string, but the value comes from
 * untrusted JSON).
 */
export function parseLabelOverride(
  source: string,
  expectedType: "number" | "color" | "boolean",
): LabelOverrideExpression | null {
  const trimmed = (source || "").trim();
  if (!trimmed) return null;
  const key = `${expectedType}:${trimmed}`;
  const cached = labelOverrideCache.get(key);
  if (cached !== undefined) return cached;
  const validation = validateMapExpression(trimmed, { expectedType });
  const result =
    validation.ok && validation.parsed
      ? (validation.parsed as unknown as LabelOverrideExpression)
      : null;
  if (labelOverrideCache.size >= LABEL_OVERRIDE_CACHE_MAX) {
    labelOverrideCache.clear();
  }
  labelOverrideCache.set(key, result);
  return result;
}

/** Whether a feature is a Geo Editor text marker (see TEXT_MARKER_SHAPE_FILTER). */
export function isTextMarkerFeature(feature: FeatureCollection["features"][number]): boolean {
  const properties = feature.properties;
  return (
    properties?.[GEOMAN_SHAPE_PROPERTY] === TEXT_MARKER_SHAPE ||
    properties?.shape === TEXT_MARKER_SHAPE
  );
}
