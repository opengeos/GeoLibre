export interface IdentifyRenderedFeatureIdentity {
  source: string;
  sourceLayer?: string;
  geometry: { type: string };
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
