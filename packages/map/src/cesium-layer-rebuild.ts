// Decides whether a layer change can be applied in place on the globe or needs the entry rebuilt.

import { cesiumKmlSource, cesiumIonAssetId, czmlSource, type GeoLibreLayer } from "@geolibre/core";
import { cogRenderSignature } from "./cesium-cog-imagery";
import { zarrOpenSignature } from "./cesium-zarr-imagery";
import {
  isZarrLayer,
  isCogLayer,
  ARCGIS_MAP_SERVICE_KIND,
  pointCloudUrl,
  str,
  firstTile,
  tilesetUrl,
  arcgisToken,
  imageBounds,
  videoUrls,
  videoCorners,
} from "./cesium-layer-records";
import { entryKind } from "./cesium-layer-entry";

/**
 * Style fields re-applied in place by `CesiumLayerSync.applyGeoJsonStyle`
 * rather than by reloading the data source. Everything else in the style —
 * colours, classification stops and rules, expressions, widths, marker shape
 * and size, patterns, decorations, extrusion, elevation, labels, the zoom
 * range — bakes into the entities at load, so a change to any of them rebuilds.
 * Opacity is the hot path (a slider drag), and the fill opacity is a resolver
 * channel the in-place pass re-reads, so neither forces a reload.
 */
const IN_PLACE_STYLE_KEYS: ReadonlySet<string> = new Set(["fillOpacity", "extrusionOpacity"]);

/**
 * Style keys the globe never reads: the 2D map's blend mode, heatmap, diagram,
 * inverted fill, geometry generator, and line-decoration detail settings.
 * Editing one must not tear down and reload the data source. Anything not
 * listed here or in {@link IN_PLACE_STYLE_KEYS} rebuilds when it changes.
 */
const GLOBE_IGNORED_STYLE_KEYS: ReadonlySet<string> = new Set([
  "blendMode",
  // `pointRenderer`, `clusterRadius`, and `clusterMaxZoom` are read by the
  // clustering path (issue #2282) and so still rebuild.
  "heatmapRadius",
  "heatmapIntensity",
  "heatmapColorRamp",
  "heatmapWeightProperty",
  "diagramType",
  "diagramFields",
  "diagramSizeMode",
  "diagramSize",
  "diagramSizeProperty",
  "diagramMinZoom",
  "diagramDeclutter",
  "invertedFillEnabled",
  "lineDecorationColor",
  "lineDecorationSize",
  "lineDecorationSpacing",
  "geometryGenerator",
  "geometryGeneratorBufferDistance",
  "geometryGeneratorBufferProperty",
  "geometryGeneratorFillColor",
  "geometryGeneratorStrokeColor",
  "geometryGeneratorStrokeWidth",
  "geometryGeneratorOpacity",
  "geometryGeneratorCircleRadius",
  "geometryGeneratorSizeProperty",
  "geometryGeneratorSizeMinValue",
  "geometryGeneratorSizeMaxValue",
  "geometryGeneratorSizeMinRadius",
  "geometryGeneratorSizeMaxRadius",
]);

export function styleSignature(layer: GeoLibreLayer): string {
  const style = (layer.style ?? {}) as unknown as Record<string, unknown>;
  const entries = Object.entries(style)
    .filter(
      ([key, value]) =>
        !IN_PLACE_STYLE_KEYS.has(key) && !GLOBE_IGNORED_STYLE_KEYS.has(key) && value !== undefined,
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Whether the Cesium object must be rebuilt (vs. just re-styled) for the change
 * from `prev` to `next`. Live-settable appearance (visibility, imagery alpha) is
 * excluded; only source/data/geometry changes force a rebuild. The GeoJSON
 * FeatureCollection is compared by reference (the store swaps it on edit) and
 * its fill/stroke colours bake into the Cesium colours at load, so a colour
 * change rebuilds; opacity is restyled in place (see styleSignature).
 */
export function needsRebuild(prev: GeoLibreLayer, next: GeoLibreLayer): boolean {
  if (prev.type !== next.type) return true;
  const kind = entryKind(next);
  // Crossing the batching threshold, or switching clustering on, changes the
  // Cesium object kind outright.
  if (entryKind(prev) !== kind) return true;
  switch (kind) {
    case "geojson":
    case "points":
      return prev.geojson !== next.geojson || styleSignature(prev) !== styleSignature(next);
    case "imagery":
      return (
        cesiumIonAssetId(prev) !== cesiumIonAssetId(next) ||
        (isCogLayer(next) && cogRenderSignature(prev) !== cogRenderSignature(next)) ||
        // Selector, colour limits and ramp are applied to the live provider in
        // sync(); only what the store is opened with rebuilds it.
        (isZarrLayer(next) && zarrOpenSignature(prev) !== zarrOpenSignature(next)) ||
        str(prev.metadata?.tileType) !== str(next.metadata?.tileType) ||
        // The Y-axis convention and the coverage rectangle bake into the
        // bridged provider.
        str(prev.source.scheme) !== str(next.source.scheme) ||
        JSON.stringify(prev.source.bounds ?? null) !== JSON.stringify(next.source.bounds ?? null) ||
        prev.source.tileSize !== next.source.tileSize ||
        firstTile(prev) !== firstTile(next) ||
        // min/maxzoom bake into UrlTemplateImageryProvider's min/maximumLevel.
        prev.source.maxzoom !== next.source.maxzoom ||
        prev.source.minzoom !== next.source.minzoom ||
        str(prev.source.url) !== str(next.source.url) ||
        // Provider credits are fixed at construction.
        str(prev.source.attribution) !== str(next.source.attribution) ||
        str(prev.metadata?.sourceKind) !== str(next.metadata?.sourceKind) ||
        str(prev.sourcePath) !== str(next.sourcePath) ||
        str(prev.metadata?.arcgisSublayers) !== str(next.metadata?.arcgisSublayers) ||
        // Only the ArcGIS branch reads a token, and only the image branch reads
        // bounds. Gate both on the kind that consumes them: `metadata.bounds` is
        // set broadly (raster/time-slider layers too), and any tile URL can carry
        // an unrelated `token=` param, so diffing them for every imagery kind
        // would both waste work and force spurious rebuilds.
        (next.metadata?.sourceKind === ARCGIS_MAP_SERVICE_KIND &&
          arcgisToken(prev) !== arcgisToken(next)) ||
        str(prev.source.layers) !== str(next.source.layers) ||
        str(prev.source.layer) !== str(next.source.layer) ||
        str(prev.source.styles) !== str(next.source.styles) ||
        str(prev.source.style) !== str(next.source.style) ||
        str(prev.source.tileMatrixSetID) !== str(next.source.tileMatrixSetID) ||
        str(prev.source.tileMatrixSet) !== str(next.source.tileMatrixSet) ||
        str(prev.source.tilingScheme) !== str(next.source.tilingScheme) ||
        JSON.stringify(prev.source.tileMatrixLabels ?? null) !==
          JSON.stringify(next.source.tileMatrixLabels ?? null) ||
        // WMS/WMTS params baked into the provider at creation; a change must
        // rebuild it so the globe doesn't keep the stale provider.
        str(prev.source.format) !== str(next.source.format) ||
        str(prev.source.version) !== str(next.source.version) ||
        prev.source.transparent !== next.source.transparent ||
        (next.type === "image" &&
          JSON.stringify(imageBounds(prev)) !== JSON.stringify(imageBounds(next))) ||
        JSON.stringify(prev.source.requestHeaders ?? null) !==
          JSON.stringify(next.source.requestHeaders ?? null)
      );
    case "pointcloud":
      return (
        pointCloudUrl(prev) !== pointCloudUrl(next) ||
        // The offset bakes into every point's position.
        prev.source.altitudeOffset !== next.source.altitudeOffset
      );
    case "3dtiles":
      return (
        tilesetUrl(prev) !== tilesetUrl(next) ||
        cesiumIonAssetId(prev) !== cesiumIonAssetId(next) ||
        str(prev.metadata?.sourceKind) !== str(next.metadata?.sourceKind) ||
        JSON.stringify(prev.source.requestHeaders ?? null) !==
          JSON.stringify(next.source.requestHeaders ?? null)
        // No `altitudeOffset` here: the offset is a model matrix applied in
        // place by `applyTilesetAltitude`, so the Style panel's height field
        // moves the tileset without re-downloading it (#3107).
      );
    case "kml":
      return cesiumKmlSource(prev) !== cesiumKmlSource(next);
    case "czml":
      return (
        czmlSource(prev)?.url !== czmlSource(next)?.url ||
        // The raw store value, not `czmlSource().data`: that wraps a bare
        // packet in a fresh array per call, which would read as a change.
        prev.source.czmlData !== next.source.czmlData ||
        str(prev.source.attribution) !== str(next.source.attribution) ||
        str(prev.sourcePath) !== str(next.sourcePath)
      );
    case "video":
      return (
        JSON.stringify(videoUrls(prev)) !== JSON.stringify(videoUrls(next)) ||
        JSON.stringify(videoCorners(prev)) !== JSON.stringify(videoCorners(next))
      );
  }
}
