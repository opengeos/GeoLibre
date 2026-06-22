import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { GeoLibreExternalNativeLayerRegistration } from "@geolibre/plugins";

/**
 * Build the store layer record for an external plugin's native GeoJSON layer.
 *
 * Merge priority for `style`/`opacity` (highest to lowest):
 *   registration  - plugin always owns the keys it supplies (even over a user edit)
 *   existing       - preserves user edits for keys the registration omits
 *   defaults       - DEFAULT_LAYER_STYLE / opacity 1
 *
 * `addGeoJsonLayer` seeds the layer with `DEFAULT_LAYER_STYLE` and `opacity: 1`
 * before the plugin calls `registerExternalNativeLayer`, so the registration
 * must merge last or the defaults would win and the rendered layer would reset
 * on the next visibility/layer-control change.
 */
export function createExternalNativeStoreLayer(
  registration: GeoLibreExternalNativeLayerRegistration,
  existing?: GeoLibreLayer,
): GeoLibreLayer {
  const sourceIds = registration.sourceIds?.length
    ? registration.sourceIds
    : registration.sourceId
      ? [registration.sourceId]
      : [];
  const sourceId = registration.sourceId ?? sourceIds[0];

  return {
    id: registration.id,
    name: registration.name,
    type: registration.type ?? "geojson",
    // Plugin fully owns its source descriptor; existing.source is not merged.
    source: {
      ...(registration.source ?? { type: "geojson" }),
      ...(sourceId ? { sourceId } : {}),
    },
    visible: existing?.visible ?? true,
    opacity: registration.opacity ?? existing?.opacity ?? 1,
    style: {
      ...DEFAULT_LAYER_STYLE,
      ...(existing?.style ?? {}),
      ...(registration.style ?? {}),
    } as GeoLibreLayer["style"],
    metadata: {
      ...(existing?.metadata ?? {}),
      ...(registration.metadata ?? {}),
      externalNativeLayer: true,
      nativeLayerIds: registration.nativeLayerIds,
      sourceIds,
      ...(sourceId ? { sourceId } : {}),
    },
    beforeId: registration.beforeId ?? existing?.beforeId,
    geojson: registration.geojson ?? existing?.geojson,
    sourcePath: registration.sourcePath ?? existing?.sourcePath,
  };
}
