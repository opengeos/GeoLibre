import bbox from "@turf/bbox";
import type { Feature } from "geojson";
import { type GeoLibreLayer, horizontalBbox } from "@geolibre/core";

/**
 * The slice of a MapLibre/Mapbox map this module reads. Both engines expose
 * `querySourceFeatures` with the same shape, so the helper stays engine-neutral;
 * it is optional so a map stand-in without it reads as "nothing loaded".
 */
export interface SourceFeatureQueryable {
  getSource(id: string): unknown;
  querySourceFeatures?(sourceId: string, parameters?: { sourceLayer?: string }): Feature[];
}

/**
 * The vector-tile source layers a layer draws from, read from the store
 * record: `source.sourceLayers`, `source.sourceLayer`, and
 * `metadata.sourceLayers`, de-duplicated.
 *
 * @param layer - The store layer.
 * @returns The source-layer names, possibly empty.
 */
export function layerSourceLayerNames(layer: GeoLibreLayer): string[] {
  const names = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) names.add(value);
  };
  for (const list of [layer.source.sourceLayers, layer.metadata.sourceLayers]) {
    if (Array.isArray(list)) list.forEach(add);
  }
  add(layer.source.sourceLayer);
  return [...names];
}

/**
 * The extent of the features a vector-tile layer has loaded so far, for a layer
 * that advertises no bounds of its own: a bare `{z}/{x}/{y}` MVT template has no
 * TileJSON to carry them. Only the tiles currently loaded are read, so this is
 * the part of the dataset the map has fetched, not necessarily all of it, but
 * it lets "Zoom to layer" frame data the user has already seen instead of doing
 * nothing.
 *
 * @param map - The map, or null before it exists.
 * @param layer - The store layer; only vector-tile layers are considered.
 * @param sourceIds - The native source ids the layer's features live in.
 * @returns `[west, south, east, north]`, or null when no features are loaded.
 */
export function loadedVectorTileFeatureBounds(
  map: SourceFeatureQueryable | null | undefined,
  layer: GeoLibreLayer,
  sourceIds: readonly string[],
): [number, number, number, number] | null {
  if (!map?.querySourceFeatures || layer.source.type !== "vector") return null;
  const sourceLayers = layerSourceLayerNames(layer);
  if (sourceLayers.length === 0) return null;
  const features: Feature[] = [];
  for (const id of sourceIds) {
    if (!map.getSource(id)) continue;
    for (const sourceLayer of sourceLayers) {
      try {
        for (const feature of map.querySourceFeatures(id, { sourceLayer })) {
          if (feature.geometry) {
            features.push({ type: "Feature", geometry: feature.geometry, properties: null });
          }
        }
      } catch {
        // A source removed mid-query or a renderer without the source layer:
        // treat it as having nothing loaded.
      }
    }
  }
  if (features.length === 0) return null;
  return horizontalBbox(bbox({ type: "FeatureCollection", features }));
}
