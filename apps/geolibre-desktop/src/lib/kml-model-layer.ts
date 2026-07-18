import type { GeoLibreLayer } from "@geolibre/core";
import {
  DEFAULT_DECK_VIZ_STYLE,
  createDeckVizStoreLayer,
  type DeckVizConfig,
} from "@geolibre/plugins";
import { kmlModelBounds, kmlModelDisplayName, kmlModelRow, kmlModelTranslation } from "./kml-model";
import type { LoadedModel } from "./tauri-io";

/**
 * Build the store layer for a KML `<Model>` 3D model: a deck.gl scenegraph
 * layer that renders the model's (self-contained) GLB at its geographic
 * location. Reuses the existing glTF scenegraph path, so the deck.gl overlay
 * (active by default) renders it with no extra wiring.
 *
 * The DAE-derived GLB is in meters, so `sizeScale` is 1 (true size) and the
 * KML `<Scale>` becomes the per-model scale factor. Heading is applied as the
 * model bearing; `<Orientation>` tilt/roll are not yet applied (the scenegraph
 * layer only exposes a single bearing).
 *
 * @param model - A resolved KML model descriptor.
 * @returns The corresponding GeoLibre store layer.
 */
export function buildKmlModelLayer(model: LoadedModel): GeoLibreLayer {
  const config: DeckVizConfig = {
    layerKind: "scenegraph",
    format: "csv-rows",
    fieldMapping: {
      lng: "lng",
      lat: "lat",
      altitude: "altitude",
      bearing: "bearing",
      scale: "scale",
    },
    style: DEFAULT_DECK_VIZ_STYLE,
    scenegraph: {
      modelUrl: model.url,
      sizeScale: 1,
      sizeMinPixels: 0,
      bearing: 0,
      translation: kmlModelTranslation(model),
      altitude: 0,
    },
  };
  return createDeckVizStoreLayer({
    name: kmlModelDisplayName(model),
    config,
    rows: [kmlModelRow(model)],
    sourcePath: model.path,
    bounds: kmlModelBounds(model),
  });
}
