import { useAppStore } from "@geolibre/core";
import type { GeoLibreVectorTileLayerOptions } from "@geolibre/plugins";
import { createBaseLayer } from "../components/layout/add-data/helpers";
import { pluginLayerMetadata } from "./plugin-layer-metadata";

const METHOD = "addVectorTileLayer";
const TILE_PLACEHOLDERS = ["{z}", "{x}", "{y}"];
/** `metadata.sourceKind` of a vector tile layer a plugin added. */
const PLUGIN_VECTOR_TILES_SOURCE_KIND = "plugin-vector-tiles";
/**
 * Metadata keys the map reads to decide how a layer is drawn (a control-owned
 * or plugin-painted layer, say). Plugin provenance must not set them, or the
 * layer could be routed away from the vector tile path and never drawn.
 */
const RENDER_ROUTING_METADATA_KEYS = [
  "sourceKind",
  "customLayerType",
  "nativeLayerIds",
  "sourceIds",
  "sourceId",
  "externalNativeLayer",
  "externalDeckLayer",
  "controlOwnsPaint",
  "nativeFillExtrusion",
];

/**
 * Check the tile URL: absolute HTTP(S), and either a template with all of
 * `{z}`, `{x}` and `{y}` or a TileJSON URL with none of them.
 *
 * @param value - The plugin's URL.
 * @returns The trimmed URL and whether it is a template.
 */
function validateUrl(value: unknown): { url: string; isTemplate: boolean } {
  const url = typeof value === "string" ? value.trim() : "";
  const placeholderCount = TILE_PLACEHOLDERS.filter((placeholder) =>
    url.includes(placeholder),
  ).length;
  if (placeholderCount > 0 && placeholderCount < TILE_PLACEHOLDERS.length) {
    throw new Error(`${METHOD}: a tile URL template needs all of {z}, {x} and {y}.`);
  }
  let parsedUrl: URL | undefined;
  try {
    // The placeholders are not valid URL characters everywhere, so parse a
    // template with them filled in.
    parsedUrl = new URL(url.replace(/\{[xyz]\}/g, "0"));
  } catch {
    parsedUrl = undefined;
  }
  if (!parsedUrl || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")) {
    throw new Error(
      `${METHOD}: url must be an absolute HTTP(S) tile URL template or TileJSON URL.`,
    );
  }
  return { url, isTemplate: placeholderCount > 0 };
}

/** Require one or more non-blank source layer names, returned trimmed and once each. */
function validateSourceLayers(value: unknown): string[] {
  const requested: unknown[] = Array.isArray(value) ? value : [];
  const sourceLayers = requested.filter(
    (sourceLayer): sourceLayer is string =>
      typeof sourceLayer === "string" && sourceLayer.trim() !== "",
  );
  if (sourceLayers.length === 0 || sourceLayers.length !== requested.length) {
    throw new Error(`${METHOD}: options.sourceLayers must list one or more source layer names.`);
  }
  return [...new Set(sourceLayers.map((sourceLayer) => sourceLayer.trim()))];
}

/**
 * Require a WGS84 `[west, south, east, north]` extent when one is given, not
 * crossing the antimeridian.
 */
function validateBounds(value: unknown): void {
  if (value === undefined) return;
  const isExtent =
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate));
  const [west, south, east, north] = isExtent ? (value as number[]) : [];
  if (
    !isExtent ||
    west < -180 ||
    east > 180 ||
    west > east ||
    south < -90 ||
    north > 90 ||
    south > north
  ) {
    throw new Error(`${METHOD}: options.bounds must be a WGS84 [west, south, east, north] extent.`);
  }
}

/** Require an opacity from 0 to 1 when one is given. */
function validateOpacity(value: unknown): void {
  if (value !== undefined && (typeof value !== "number" || !(value >= 0 && value <= 1))) {
    throw new Error(`${METHOD}: options.opacity must be a number from 0 to 1.`);
  }
}

/** Require zooms from 0 to 24, with minzoom no greater than maxzoom. */
function validateZoomRange(minzoom: unknown, maxzoom: unknown): void {
  for (const [name, zoom] of [
    ["minzoom", minzoom],
    ["maxzoom", maxzoom],
  ] as const) {
    if (zoom !== undefined && (typeof zoom !== "number" || !(zoom >= 0 && zoom <= 24))) {
      throw new Error(`${METHOD}: options.${name} must be a number from 0 to 24.`);
    }
  }
  // MapLibre's addSource throws on an inverted range, which would strand a
  // layer in the store with no rendered source.
  if (typeof minzoom === "number" && typeof maxzoom === "number" && minzoom > maxzoom) {
    throw new Error(`${METHOD}: options.minzoom (${minzoom}) must be <= maxzoom (${maxzoom}).`);
  }
}

/**
 * The plugin's metadata without the keys that route rendering.
 *
 * @param metadata - Validated plugin metadata, if any.
 * @returns A copy without {@link RENDER_ROUTING_METADATA_KEYS}.
 */
function withoutRenderRouting(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const kept = { ...metadata };
  for (const key of RENDER_ROUTING_METADATA_KEYS) delete kept[key];
  return kept;
}

/**
 * Add a vector tile layer for a plugin: the same store record the OGC Vector
 * Tiles Add Data source builds, so the layer renders, styles, and saves like
 * one the user added.
 *
 * @param name - The layer name shown in the Layers panel.
 * @param url - A tile URL template with `{z}`/`{x}`/`{y}`, or a TileJSON URL.
 * @param options - The source layers to draw and the optional extent, zoom
 *   range, visibility, opacity, position, and provenance metadata.
 * @returns The new layer's id.
 */
export function addPluginVectorTileLayer(
  name: string,
  url: string,
  options: GeoLibreVectorTileLayerOptions,
): string {
  // Plugins can be plain JavaScript; the name is the Layers panel label and is
  // saved with the project.
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`${METHOD}: name must be a non-empty string.`);
  }
  const { url: tileUrl, isTemplate } = validateUrl(url);
  // Plugins can be plain JavaScript, so options may be missing altogether.
  const {
    sourceLayers: requestedSourceLayers,
    bounds,
    minzoom,
    maxzoom,
    visible,
    opacity,
    beforeLayerId,
    metadata: requestedMetadata,
  } = options ?? ({} as Partial<GeoLibreVectorTileLayerOptions>);
  const sourceLayers = validateSourceLayers(requestedSourceLayers);
  validateBounds(bounds);
  validateZoomRange(minzoom, maxzoom);
  // MapLibre reads a TileJSON tileset's zoom range from the TileJSON itself.
  if (!isTemplate && (minzoom !== undefined || maxzoom !== undefined)) {
    throw new Error(
      `${METHOD}: options.minzoom and maxzoom apply to a tile URL template; a TileJSON URL sets its own zoom range.`,
    );
  }
  validateOpacity(opacity);
  const metadata = pluginLayerMetadata(METHOD, requestedMetadata);

  // Source and metadata each get their own copies of the arrays: a plugin that
  // changes its array later, or an edit to one of the two, must not reach the
  // other or the stored layer.
  const layer = createBaseLayer(
    name,
    "vector-tiles",
    {
      type: "vector",
      ...(isTemplate ? { tiles: [tileUrl] } : { url: tileUrl }),
      sourceLayer: sourceLayers[0],
      sourceLayers: [...sourceLayers],
      ...(bounds ? { bounds: [...bounds] } : {}),
      ...(minzoom !== undefined ? { minzoom } : {}),
      ...(maxzoom !== undefined ? { maxzoom } : {}),
    },
    {
      ...withoutRenderRouting(metadata),
      sourceKind: PLUGIN_VECTOR_TILES_SOURCE_KIND,
      ...(bounds ? { bounds: [...bounds] } : {}),
      ...(minzoom !== undefined ? { minzoom } : {}),
      ...(maxzoom !== undefined ? { maxzoom } : {}),
      sourceLayers: [...sourceLayers],
      tilesUrl: tileUrl,
    },
  );
  useAppStore.getState().addLayer(
    {
      ...layer,
      visible: visible ?? true,
      opacity: opacity ?? 1,
    },
    beforeLayerId ?? null,
  );
  return layer.id;
}
