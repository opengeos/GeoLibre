import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { GeoLibreExternalNativeLayerRegistration } from "@geolibre/plugins";

/**
 * Build the store layer record for an external plugin's native GeoJSON layer.
 *
 * Plugins typically create the rendered layer first with `addGeoJsonLayer`
 * (which seeds it with `DEFAULT_LAYER_STYLE`) and then call
 * `registerExternalNativeLayer` to attach their own style and metadata. The
 * registration's style must therefore win over the existing layer's style:
 * `existing.style` already carries the full default style, so merging it last
 * would silently clobber the plugin's colors with GeoLibre's default blue and
 * reset the rendered paint on the next visibility/layer-control change.
 *
 * @param registration - The plugin-supplied native layer registration.
 * @param existing - The current store layer for this id, if one already exists.
 * @returns The reconciled `GeoLibreLayer` record to add to or update in the store.
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
    source: {
      ...(registration.source ?? { type: "geojson" }),
      ...(sourceId ? { sourceId } : {}),
    },
    visible: existing?.visible ?? true,
    opacity: existing?.opacity ?? registration.opacity ?? 1,
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
