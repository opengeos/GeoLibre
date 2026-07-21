import type { FeatureCollection, Geometry } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import type { HitFeature, ScreenPoint } from "./types";

/** Private attribute used only to reconnect an SDK hit to its store feature. */
export const ARC_GIS_FEATURE_INDEX = "__geolibre_arcgis_feature_index";

export interface ArcGISQueryableLayer {
  readonly id: string;
}

export interface ArcGISHitTestView {
  hitTest(
    point: ScreenPoint,
    options?: { readonly include?: readonly ArcGISQueryableLayer[] },
  ): Promise<{
    readonly results?: readonly {
      readonly type?: string;
      readonly layer?: ArcGISQueryableLayer;
      readonly graphic?: {
        readonly attributes?: Readonly<Record<string, unknown>> | null;
      };
    }[];
  }>;
}

/** Add a deterministic native attribute without changing the store snapshot. */
export function withArcGISFeatureIndices(collection: FeatureCollection): FeatureCollection {
  return {
    ...collection,
    features: collection.features.map((feature, index) => ({
      ...feature,
      properties: {
        ...(feature.properties ?? {}),
        [ARC_GIS_FEATURE_INDEX]: index,
      },
    })),
  };
}

function storeLayerId(nativeLayerId: string): string | null {
  return nativeLayerId.startsWith("geolibre-")
    ? nativeLayerId.slice("geolibre-".length)
    : null;
}

function featureIndex(attributes: Readonly<Record<string, unknown>> | null | undefined): number | null {
  const value = attributes?.[ARC_GIS_FEATURE_INDEX];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Convert ArcGIS graphic hits into seam-native DTOs. Geometry and properties
 * come from the authoritative store snapshot, never from an SDK object.
 */
export function toArcGISHitFeatures(
  result: Awaited<ReturnType<ArcGISHitTestView["hitTest"]>>,
  layers: readonly GeoLibreLayer[],
  restrictToLayerId?: string,
): readonly HitFeature[] {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const hits: HitFeature[] = [];
  for (const resultItem of result.results ?? []) {
    if (resultItem.type !== "graphic" || !resultItem.layer) continue;
    const layerId = storeLayerId(resultItem.layer.id);
    if (!layerId || (restrictToLayerId && layerId !== restrictToLayerId)) continue;
    const layer = byId.get(layerId);
    if (!layer?.geojson) continue;
    const index = featureIndex(resultItem.graphic?.attributes);
    const feature = index === null ? undefined : layer.geojson.features[index];
    if (!feature) continue;
    hits.push({
      layerId,
      featureId: String(feature.id ?? index),
      properties: { ...(feature.properties ?? {}) },
      geometry: feature.geometry as Geometry | null,
    });
  }
  return hits;
}
