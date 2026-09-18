/**
 * Helpers for following a story-map presentation's layer fades outside the
 * MapLibre paint model.
 *
 * Story playback fades layers by writing MapLibre paint properties directly
 * (see `MapController.setStoryLayerOpacity`) and records the applied values in
 * `ui.storymapLayerOpacity`. Anything that renders a layer some other way, such
 * as deck.gl feature diagrams and 3D Z-value geometry, or that lists layers
 * for the reader, such as the on-map Legend, reads that record through these
 * helpers so a faded-out layer disappears everywhere at once.
 */
import type { GeoLibreLayer } from "./types";

/** The clamped opacity recorded for a layer, or undefined when untouched. */
function recordedStoryOpacity(
  opacities: Record<string, number> | undefined,
  layerId: string,
): number | undefined {
  const value = opacities?.[layerId];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/**
 * The opacity a story presentation has applied to a layer.
 *
 * @param opacities The store's `ui.storymapLayerOpacity` record.
 * @param layerId Store layer id.
 * @returns The recorded opacity in `[0, 1]`, or `1` when the presentation has
 *   not touched the layer (or nothing is presenting).
 */
export function storyLayerOpacityFactor(
  opacities: Record<string, number> | undefined,
  layerId: string,
): number {
  return recordedStoryOpacity(opacities, layerId) ?? 1;
}

/**
 * A layer whose opacity reflects the story presentation's fade.
 *
 * A chapter's opacity *replaces* the layer's own opacity rather than scaling
 * it, matching `MapController.setStoryLayerOpacity`, which writes the chapter
 * value as the absolute paint opacity; otherwise a layer set to 0.7 in the
 * Layers panel and faded to 0.4 by a chapter would draw its diagrams at 0.28
 * while its MapLibre layers draw at 0.4.
 *
 * Returns the same object when the presentation has not touched the layer (or
 * recorded the opacity it already has), so identity-keyed caches downstream
 * keep hitting.
 *
 * @param layer Store layer.
 * @param opacities The store's `ui.storymapLayerOpacity` record.
 */
export function applyStoryLayerOpacity(
  layer: GeoLibreLayer,
  opacities: Record<string, number> | undefined,
): GeoLibreLayer {
  const opacity = recordedStoryOpacity(opacities, layer.id);
  if (opacity === undefined || opacity === layer.opacity) return layer;
  return { ...layer, opacity };
}

/**
 * Whether a story presentation has faded a layer fully out.
 *
 * @param opacities The store's `ui.storymapLayerOpacity` record.
 * @param layerId Store layer id.
 */
export function isStoryHiddenLayer(
  opacities: Record<string, number> | undefined,
  layerId: string,
): boolean {
  return storyLayerOpacityFactor(opacities, layerId) === 0;
}

/**
 * The layers a reader can currently see during a story presentation: the
 * input minus those the active chapter has faded fully out. Outside a
 * presentation the input is returned as-is (same array identity).
 *
 * @param layers Store layers in panel order.
 * @param presenting The store's `ui.storymapPresenting` flag.
 * @param opacities The store's `ui.storymapLayerOpacity` record.
 */
export function storyVisibleLayers(
  layers: GeoLibreLayer[],
  presenting: boolean,
  opacities: Record<string, number> | undefined,
): GeoLibreLayer[] {
  if (!presenting) return layers;
  if (!layers.some((layer) => isStoryHiddenLayer(opacities, layer.id))) return layers;
  return layers.filter((layer) => !isStoryHiddenLayer(opacities, layer.id));
}
