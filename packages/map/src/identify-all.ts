export interface IdentifyRenderedFeatureIdentity {
  source: string;
  sourceLayer?: string;
  geometry: { type: string; coordinates?: unknown; geometries?: unknown };
  properties?: Record<string, unknown> | null;
}

/**
 * Build a key that collapses one source feature rendered by several style layers.
 *
 * Stable feature ids are preferred. The fallback deliberately avoids serializing
 * geometry, since a single complex polygon can contain thousands of coordinates;
 * source, source-layer, geometry type, and properties are enough to recognize the
 * duplicate fill/outline copies MapLibre returns for the same rendered feature.
 */
export function globalIdentifyHitKey(
  layerId: string,
  featureId: string | null,
  feature: IdentifyRenderedFeatureIdentity,
): string {
  const sourceKey = `${feature.source}\u0000${feature.sourceLayer ?? ""}`;
  if (featureId !== null) return `${layerId}\u0000${sourceKey}\u0000id:${featureId}`;
  return `${layerId}\u0000${sourceKey}\u0000feature:${feature.geometry.type}:${JSON.stringify(
    feature.properties ?? {},
  )}`;
}

/**
 * Create a per-click filter for duplicate rendered copies of source features.
 *
 * Geometry is only serialized when id-less hits share a base key. That keeps
 * the common polygon path cheap while preserving genuinely distinct features
 * that have the same properties but different coordinates.
 *
 * @returns A predicate that returns true for each distinct identify hit.
 */
export function createGlobalIdentifyHitDeduper(): (
  layerId: string,
  featureId: string | null,
  feature: IdentifyRenderedFeatureIdentity,
) => boolean {
  const stableKeys = new Set<string>();
  const idlessBuckets = new Map<
    string,
    { firstGeometry: IdentifyRenderedFeatureIdentity["geometry"]; geometryKeys?: Set<string> }
  >();

  return (layerId, featureId, feature) => {
    const baseKey = globalIdentifyHitKey(layerId, featureId, feature);
    if (featureId !== null) {
      if (stableKeys.has(baseKey)) return false;
      stableKeys.add(baseKey);
      return true;
    }

    const bucket = idlessBuckets.get(baseKey);
    if (!bucket) {
      idlessBuckets.set(baseKey, { firstGeometry: feature.geometry });
      return true;
    }

    if (!bucket.geometryKeys) {
      bucket.geometryKeys = new Set([JSON.stringify(bucket.firstGeometry)]);
    }
    const geometryKey = JSON.stringify(feature.geometry);
    if (bucket.geometryKeys.has(geometryKey)) return false;
    bucket.geometryKeys.add(geometryKey);
    return true;
  };
}
