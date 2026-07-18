import type { LabelDedupe } from "@geolibre/core";

/**
 * Pull a representative `[x, y]` from a point geometry, or null for any other
 * geometry type (only points participate in label deduplication).
 */
function pointCoordinates(geometry: GeoJSON.Geometry | null): [number, number] | null {
  if (!geometry) return null;
  if (geometry.type === "Point") {
    const [x, y] = geometry.coordinates;
    return typeof x === "number" && typeof y === "number" ? [x, y] : null;
  }
  if (geometry.type === "MultiPoint") {
    // Group a MultiPoint by its first sub-point; the remaining sub-points are
    // not separate label anchors here (dedup targets single co-located points).
    const first = geometry.coordinates[0];
    if (!Array.isArray(first)) return null;
    const [x, y] = first;
    return typeof x === "number" && typeof y === "number" ? [x, y] : null;
  }
  return null;
}

/**
 * Build a point FeatureCollection carrying one aggregated `__geolibre_label` per location
 * for the unique/concatenate label modes (see {@link LabelDedupe}).
 *
 * Point features are grouped by their coordinate (rounded to 7 decimals, ~1 cm).
 * For `"unique"` the first non-empty {@link field} value at a location becomes
 * the label, so co-located points (e.g. several antennas at one cell site) show
 * a single label instead of overlapping text. For `"concatenate"` the distinct
 * non-empty values at a location are joined one per line. Groups with no usable
 * value are dropped, and non-point geometries are ignored.
 *
 * @param geojson - The layer's source features.
 * @param field - The attribute whose value labels each feature.
 * @param mode - `"unique"` or `"concatenate"`; `"off"` returns null.
 * @returns A point FeatureCollection of aggregated labels, or null when the mode
 *   is off, the field is empty, or nothing is left to label.
 */
export function buildDedupedLabelFeatures(
  geojson: GeoJSON.FeatureCollection,
  field: string,
  mode: LabelDedupe,
): GeoJSON.FeatureCollection | null {
  if (mode === "off" || !field) return null;
  const groups = new Map<string, { coordinates: [number, number]; values: Set<string> }>();
  for (const feature of geojson.features) {
    const point = pointCoordinates(feature.geometry ?? null);
    if (!point) continue;
    const raw = feature.properties?.[field];
    const value = raw == null ? "" : String(raw);
    const key = `${point[0].toFixed(7)},${point[1].toFixed(7)}`;
    let group = groups.get(key);
    if (!group) {
      group = { coordinates: point, values: new Set() };
      groups.set(key, group);
    }
    // A Set keeps distinct values in first-seen insertion order with O(1) adds;
    // "unique" uses the first and "concatenate" joins them all.
    if (value !== "") group.values.add(value);
  }
  const features: GeoJSON.Feature[] = [];
  for (const group of groups.values()) {
    if (group.values.size === 0) continue;
    const values = [...group.values];
    const label = mode === "concatenate" ? values.join("\n") : values[0];
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: group.coordinates },
      // A namespaced key avoids clobbering a real source field named "label".
      properties: { __geolibre_label: label },
    });
  }
  if (features.length === 0) return null;
  return { type: "FeatureCollection", features };
}
