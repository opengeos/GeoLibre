import type { GeoLibreLayer } from "@geolibre/core";
import {
  circleLayerId,
  fillExtrusionLayerId,
  fillLayerId,
  lineLayerId,
  markerLayerId,
} from "./geojson-loader";
import {
  externalExtrusionLayerId,
  mbtilesStyleLayerIds,
  vectorTileStyleLayerIds,
} from "./layer-sync";

function nativeIdentifyLayerIds(layer: GeoLibreLayer): string[] {
  const nativeLayerIds = layer.metadata.nativeLayerIds;
  return Array.isArray(nativeLayerIds)
    ? nativeLayerIds.filter((id): id is string => typeof id === "string")
    : [];
}

export function identifyStyleLayerIds(layer: GeoLibreLayer): string[] {
  return [
    ...nativeIdentifyLayerIds(layer),
    ...nativeIdentifyLayerIds(layer).map(externalExtrusionLayerId),
    ...mbtilesStyleLayerIds(layer),
    markerLayerId(layer.id),
    circleLayerId(layer.id),
    lineLayerId(layer.id),
    fillExtrusionLayerId(layer.id),
    fillLayerId(layer.id),
    ...vectorTileStyleLayerIds(layer),
  ];
}
