/** Temporary inverted-fill mask for the active Print Layout atlas feature. */
import { buildInvertedMask } from "@geolibre/map/derived-geometry";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";

const SOURCE_ID = "geolibre-print-atlas-mask";
const FILL_LAYER_ID = "geolibre-print-atlas-mask-fill";
const featureCollections = new WeakMap<
  Feature<Polygon | MultiPolygon>,
  FeatureCollection<Polygon | MultiPolygon>
>();

/** Remove the atlas mask source and layer, if present. */
export function clearAtlasFeatureMask(map: MapLibreMap): void {
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

/**
 * Show a translucent inverted fill around one polygon atlas feature.
 *
 * @param map - MapLibre map used by the Print Layout capture.
 * @param feature - Current coverage feature.
 * @param beforeLayerId - Optional label layer that should remain above the mask.
 * @returns Whether a polygon mask could be rendered.
 */
export function showAtlasFeatureMask(
  map: MapLibreMap,
  feature: Feature | undefined,
  beforeLayerId?: string,
): boolean {
  if (feature?.geometry?.type !== "Polygon" && feature?.geometry?.type !== "MultiPolygon") {
    clearAtlasFeatureMask(map);
    return false;
  }
  const polygonFeature = feature as Feature<Polygon | MultiPolygon>;
  let collection = featureCollections.get(polygonFeature);
  if (!collection) {
    collection = {
      type: "FeatureCollection",
      features: [polygonFeature],
    };
    featureCollections.set(polygonFeature, collection);
  }
  const mask = buildInvertedMask(collection);
  if (!mask) {
    clearAtlasFeatureMask(map);
    return false;
  }
  const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
  if (source) source.setData(mask);
  else map.addSource(SOURCE_ID, { type: "geojson", data: mask });
  const fillLayer = map.getLayer(FILL_LAYER_ID);
  const targetLayerId =
    beforeLayerId && beforeLayerId !== FILL_LAYER_ID && map.getLayer(beforeLayerId)
      ? beforeLayerId
      : undefined;
  if (!fillLayer) {
    map.addLayer(
      {
        id: FILL_LAYER_ID,
        type: "fill",
        source: SOURCE_ID,
        metadata: { "geolibre:internal": true },
        paint: {
          "fill-color": "#ffffff",
          "fill-opacity": 0.7,
          "fill-outline-color": "rgba(0, 0, 0, 0)",
        },
      },
      targetLayerId,
    );
  } else if (targetLayerId) {
    map.moveLayer(FILL_LAYER_ID, targetLayerId);
  }
  return true;
}
