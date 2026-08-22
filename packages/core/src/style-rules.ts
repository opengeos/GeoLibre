// The colours a control gave an archive's source layers.
//
// A control assigns one per source layer when it adds an archive and records them all, but a layer
// carries a single style — so every part drew in the first one's colour. Where an archive is still
// one layer (the STAC panel, an offline extract), this is what tells each source layer apart.
//
// An archive added through the PMTiles control is expanded into a layer per source layer instead,
// each with its own colour already in its style, and never reaches this.

import type { GeoLibreLayer, LayerStyle } from "./types";

/** The source layers an archive holds, wherever the layer records them. */
export function layerSourceLayers(layer: GeoLibreLayer): string[] {
  // A raster archive draws one image per tile; its source layers, if it records any, paint nothing.
  if (layer.metadata?.tileType === "raster" || layer.source?.type === "raster") return [];
  const raw = layer.source?.sourceLayers ?? layer.metadata?.sourceLayers;
  if (!Array.isArray(raw)) return [];
  return raw.filter((name): name is string => typeof name === "string" && name.length > 0);
}

/**
 * The colour a control gave one source layer when it added the archive, or undefined.
 *
 * A user restyling the layer takes it back: the layer's `fillColor` is seeded from the *first*
 * source layer's colour when the archive is added, so while those still agree nobody has touched
 * the Style panel. Once they differ the user's colour is the whole archive's.
 *
 * That comparison needs a seed to compare against. A layer that records colours but declares no
 * source layers has none, so a restyle cannot be detected and the assignment stands.
 */
export function assignedSourceLayerColor(
  layer: GeoLibreLayer,
  sourceLayer: string,
): string | undefined {
  const raw = layer.metadata?.sourceLayerColors;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const colors = raw as Record<string, unknown>;
  const assigned = colors[sourceLayer];
  if (typeof assigned !== "string") return undefined;
  const first = layerSourceLayers(layer)[0];
  const seeded = first ? colors[first] : undefined;
  if (typeof seeded === "string" && layer.style.fillColor !== seeded) return undefined;
  return assigned;
}

/**
 * How one source layer of an archive should be painted.
 *
 * @param layer - The layer being rendered.
 * @param sourceLayer - The source layer about to be drawn, or undefined for a layer that is one.
 * @returns The style to paint it with.
 */
export function styleForSourceLayer(layer: GeoLibreLayer, sourceLayer?: string): LayerStyle {
  if (!sourceLayer) return layer.style;
  const assigned = assignedSourceLayerColor(layer, sourceLayer);
  return assigned ? { ...layer.style, fillColor: assigned, strokeColor: assigned } : layer.style;
}
