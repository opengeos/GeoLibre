import {
  DEFAULT_LAYER_STYLE,
  isAdoptedVectorAwaitingFeatures,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { LayerSpecification } from "mapbox-gl";
import { compileMapboxLayer } from "./gl-style-compiler";
import { classifyLayer, type SupportedLayerKinds, unhandledLayerKind } from "./layer-kind";

/**
 * Whether a compiled style layer draws derived or synthetic features (an
 * inverted-fill mask, generator shapes, decorations, aggregated labels) rather
 * than the layer's own, so identify and selection skip it, as MapLibre's
 * layer-sync marks the same layers.
 */
export function isInternalMapboxLayer(spec: LayerSpecification): boolean {
  return (spec.metadata as Record<string, unknown> | undefined)?.["geolibre:internal"] === true;
}

/**
 * What the Mapbox engine's kind dispatch does with each layer kind: the
 * `"native"` kinds compile to Mapbox sources and style layers
 * (`compileMapboxLayer`; an ArcGIS record only as a vector tile service, a
 * tile archive only as a vector PMTiles), and the `"plugin"` kinds are drawn
 * only by a plugin control on the Mapbox map or its deck.gl overlay
 * ({@link isMapboxPluginLayer}). GeoJSON and vector tiles are `"native"` even
 * though some plugins (search footprints, Overture Maps) draw their own.
 */
export const MAPBOX_SUPPORTED_LAYER_KINDS = Object.freeze({
  geojson: "native",
  "raster-tiles": "native",
  "vector-tiles": "native",
  arcgis: "native",
  "tile-archive": "native",
  zarr: "plugin",
  lidar: "plugin",
  "gaussian-splat": "unsupported",
  "3d-tiles": "plugin",
  cog: "plugin",
  "vector-file": "unsupported",
  "duckdb-query": "plugin",
  "deckgl-viz": "plugin",
  video: "native",
  image: "native",
} as const satisfies SupportedLayerKinds);

/**
 * Whether Mapbox can draw a layer through a native plan or a supported plugin.
 * The layer panels use it to badge unsupported layers before the engine's
 * error banner would report them.
 */
export function isMapboxSupportedLayer(layer: GeoLibreLayer): boolean {
  if (isMapboxPluginLayer(layer)) return true;
  const cached = supportedLayerCache.get(layer);
  if (cached !== undefined) return cached;
  let supported = true;
  try {
    compileMapboxLayer(layer);
  } catch {
    supported = false;
  }
  supportedLayerCache.set(layer, supported);
  return supported;
}

/** These plugins own their Mapbox overlays and synchronize the layer store themselves. */
export function isMapboxPluginLayer(layer: GeoLibreLayer): boolean {
  if (isMapboxKindPluginLayer(layer)) return true;
  // An adopted Add Vector layer reopened from a project saved by URL or path
  // has no features until the vector control reads them again. Its `source.url`
  // can name GeoParquet or GeoPackage, so wait for the features rather than
  // compile a GeoJSON source without data.
  if (isAdoptedVectorAwaitingFeatures(layer)) return true;
  if (layer.metadata.externalNativeLayer === true) {
    // On a renderer switch the Add Vector control first mirrors its persisted
    // source, then asynchronously materializes it as GeoJSON for Mapbox. Until
    // that collection arrives, treat the record as control-owned so Mapbox
    // never tries to parse GeoParquet, GeoPackage, or another source URL as
    // GeoJSON. A later store sync carries `layer.geojson` and takes the normal
    // native compiler path below.
    if (layer.metadata.sourceKind === "maplibre-gl-vector" && !layer.geojson) return true;
    // The Time Slider dock and the Timelapse control create their own native
    // sources and layers (registered on the mirror as `nativeLayerIds`) and
    // forward the store's visibility/opacity to whatever adapter drew them;
    // the mirrors themselves carry no tiles (`source: { sourceId }` and
    // `source: { providerId }`), so the engine could not compile them anyway.
    if (layer.metadata.sourceKind === "time-slider" || layer.metadata.sourceKind === "timelapse")
      return true;
  }
  // A layer a plugin registered as its own native output (the host's
  // `registerExternalNativeLayer`: the Mapillary coverage, the Time Slider's
  // and Timelapse's rasters, ...) whose store record carries nothing the
  // engine could draw itself — no GeoJSON, no tile template, no source URL.
  // The plugin adds those style layers to whichever map hosts it, so the
  // engine only mirrors the store's visibility and opacity onto the native ids
  // (as MapLibre's layer-sync does) instead of failing to compile the record.
  // Records that do carry a drawable source (the vector importer's GeoJSON,
  // Esri Wayback's raster URL, the Web Services' tile templates) still go
  // through the compiler, which adopts their native ids.
  const nativeIds = layer.metadata.nativeLayerIds;
  return (
    layer.metadata.externalNativeLayer === true &&
    Array.isArray(nativeIds) &&
    nativeIds.length > 0 &&
    !hasDrawableSource(layer)
  );
}

/**
 * The plugin-owned records tied to one layer kind: a control that draws that
 * kind on the Mapbox map itself, so the store row only mirrors it.
 */
function isMapboxKindPluginLayer(layer: GeoLibreLayer): boolean {
  const external = layer.metadata.externalNativeLayer === true;
  const sourceKind = layer.metadata.sourceKind;
  const kind = classifyLayer(layer);
  switch (kind) {
    // Drawn by the shared deck.gl overlay (deckgl-viz plugin) and the DuckDB
    // control's own deck overlay; both bind to the Mapbox map directly.
    case "deckgl-viz":
      return sourceKind === "deckgl-viz";
    case "duckdb-query":
      return sourceKind === "duckdb-query";
    // Both the shared LiDAR control and the USGS LiDAR plugin stream their
    // point clouds through their own deck.gl overlay.
    case "lidar":
      return external && (sourceKind === "lidar-url" || sourceKind === "usgs-lidar");
    // @carbonplan/zarr-layer is a CustomLayerInterface implementation that
    // targets Mapbox GL as well as MapLibre; the Zarr control adds it to
    // whichever map hosts the control.
    case "zarr":
      return external && sourceKind === "zarr-url";
    // The Overture Maps control adds its PMTiles vector sources and styled
    // layers to whichever map hosts it (mapbox-gl reads the archives through
    // its own tile provider). The store rows only mirror those layers for the
    // Layers panel; their `source.url` names the archive for the record, and
    // compiling it would draw every theme twice.
    case "vector-tiles":
      return external && sourceKind === "overture-maps";
    case "3d-tiles":
      return (
        external &&
        ["3d-tiles-url", "google-photorealistic-3d-tiles", "arcgis-i3s"].includes(
          String(sourceKind),
        )
      );
    case "cog":
      return external && sourceKind === "maplibre-gl-raster";
    // OpenAerialMap's, Satellite Embeddings' and Fields of the World's search
    // footprints carry their GeoJSON (so the Layers panel can zoom to and
    // restyle them) but the plugin draws the fill and outline itself on
    // whichever map hosts it; compiling the record would paint them twice.
    case "geojson":
      return (
        external && typeof sourceKind === "string" && PLUGIN_DRAWN_FOOTPRINT_KINDS.has(sourceKind)
      );
    // No kind-specific Mapbox plugin: the compiler draws (or rejects) the record.
    case "raster-tiles":
    case "arcgis":
    case "tile-archive":
    case "gaussian-splat":
    case "vector-file":
    case "video":
    case "image":
      return false;
    default:
      return unhandledLayerKind(kind, false);
  }
}

/** `metadata.sourceKind` of search footprints a plugin draws itself. */
const PLUGIN_DRAWN_FOOTPRINT_KINDS = new Set([
  "openaerialmap-footprints",
  "satellite-embeddings-footprints",
  "fields-of-the-world-footprints",
  "earthaccess-footprints",
]);

/** Whether the store record alone gives the engine something to draw. */
function hasDrawableSource(layer: GeoLibreLayer): boolean {
  if (layer.geojson) return true;
  const { url, urls, tiles, data } = layer.source as {
    url?: unknown;
    urls?: unknown;
    tiles?: unknown;
    data?: unknown;
  };
  return (
    typeof url === "string" ||
    (Array.isArray(urls) && urls.length > 0) ||
    (Array.isArray(tiles) && tiles.length > 0) ||
    data !== undefined
  );
}

// Store layers are immutable records (every edit creates a new object), so the
// answer is memoized per object: the layer panels ask on every render, and a
// full compile per layer per render would be wasted work.
const supportedLayerCache = new WeakMap<GeoLibreLayer, boolean>();

/**
 * Style settings the Mapbox compiler does not draw yet. The Style panel lists
 * the ones a layer has turned on, so a setting that silently does nothing on
 * this renderer is named instead. Remove an entry once the compiler honors it.
 */
export type MapboxUnsupportedStyleSetting = "blendMode";

/** The {@link MapboxUnsupportedStyleSetting}s this layer's style turns on. */
export function mapboxUnsupportedStyleSettings(
  layer: GeoLibreLayer,
): MapboxUnsupportedStyleSetting[] {
  const blendMode = layer.style.blendMode ?? DEFAULT_LAYER_STYLE.blendMode;
  return blendMode !== DEFAULT_LAYER_STYLE.blendMode ? ["blendMode"] : [];
}
