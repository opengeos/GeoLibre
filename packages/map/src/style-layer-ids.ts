/**
 * The MapLibre source and style layer ids `syncLayers` derives for a store layer.
 *
 * Kept apart from `geojson-loader` (and so from the package index, which pulls in
 * MapLibre and its stylesheet) so the plugins package and the frontend test suite
 * can import the id scheme on its own -- the same reason `pmtiles-layer` is split
 * out. `geojson-loader` re-exports everything here, so every existing import path
 * still resolves.
 */

export function sourceId(layerId: string): string {
  return `source-${layerId}`;
}

/**
 * The prefix every MapLibre style layer id `syncLayers` derives for a store
 * layer shares (`layer-<id>-…`), across GeoJSON, raster, vector-tile, and
 * MBTiles layers alike.
 *
 * Use it to find a store layer's style layers on a live map when the exact set
 * is not known ahead of time: a GeoJSON layer draws through several style
 * layers, and vector-tile/MBTiles ids append an encoded source-layer name, so
 * no single derived id stands for the layer. `tests/swipe-layer-ids.test.ts`
 * asserts the id builders below still start with it.
 */
export function nativeLayerIdPrefix(layerId: string): string {
  return `layer-${layerId}-`;
}

export function fillLayerId(layerId: string): string {
  return `layer-${layerId}-fill`;
}

export function fillExtrusionLayerId(layerId: string): string {
  return `layer-${layerId}-extrusion`;
}

export function lineLayerId(layerId: string): string {
  return `layer-${layerId}-line`;
}

export function circleLayerId(layerId: string): string {
  return `layer-${layerId}-circle`;
}

export function heatmapLayerId(layerId: string): string {
  return `layer-${layerId}-heatmap`;
}

export function clusterLayerId(layerId: string): string {
  return `layer-${layerId}-cluster`;
}

export function clusterCountLayerId(layerId: string): string {
  return `layer-${layerId}-cluster-count`;
}

export function textLayerId(layerId: string): string {
  return `layer-${layerId}-text`;
}

export function markerLayerId(layerId: string): string {
  return `layer-${layerId}-marker`;
}

export function labelLayerId(layerId: string): string {
  return `layer-${layerId}-label`;
}

/**
 * Source id for the optional deduplicated label features (see
 * {@link LabelStyle.dedupe}). Separate from the layer's main source so the
 * symbol layer can read aggregated one-per-point labels without altering the
 * data the fill/line/circle layers render.
 */
export function labelSourceId(layerId: string): string {
  return `source-${layerId}-label`;
}

/**
 * Source id for the inverted-fill mask (see
 * {@link LayerStyle.invertedFillEnabled}). The mask is a derived polygon, so
 * it lives in its own GeoJSON source beside the layer's main source.
 */
export function invertedSourceId(layerId: string): string {
  return `source-${layerId}-inverted`;
}

export function invertedFillLayerId(layerId: string): string {
  return `layer-${layerId}-inverted-fill`;
}

/** Symbol layer that repeats decoration icons along line features. */
export function lineDecorationLayerId(layerId: string): string {
  return `layer-${layerId}-line-decoration`;
}

/**
 * Source id for the geometry generator's derived features (see
 * {@link LayerStyle.geometryGenerator}).
 */
export function generatorSourceId(layerId: string): string {
  return `source-${layerId}-generator`;
}

export function generatorFillLayerId(layerId: string): string {
  return `layer-${layerId}-generator-fill`;
}

export function generatorLineLayerId(layerId: string): string {
  return `layer-${layerId}-generator-line`;
}

export function generatorCircleLayerId(layerId: string): string {
  return `layer-${layerId}-generator-circle`;
}

export function highlightSourceId(): string {
  return "geolibre-highlight-source";
}

export function highlightFillLayerId(): string {
  return "geolibre-highlight-fill";
}

export function highlightLineLayerId(): string {
  return "geolibre-highlight-line";
}

export function highlightCircleLayerId(): string {
  return "geolibre-highlight-circle";
}
