import { useAppStore } from "@geolibre/core";
import type { GeoLibreVectorTileLayerOptions } from "@geolibre/plugins";
import { createBaseLayer } from "../components/layout/add-data/helpers";
import { pluginLayerMetadata } from "./plugin-layer-metadata";

const METHOD = "addVectorTileLayer";
const TILE_TEMPLATE_PLACEHOLDER = "{z}";

function validateUrl(value: unknown): string {
  const url = typeof value === "string" ? value.trim() : "";
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
  return url;
}

function validateSourceLayers(value: unknown): string[] {
  const sourceLayers = Array.isArray(value)
    ? value.filter(
        (sourceLayer): sourceLayer is string =>
          typeof sourceLayer === "string" && sourceLayer.trim() !== "",
      )
    : [];
  if (sourceLayers.length === 0 || sourceLayers.length !== (value as unknown[]).length) {
    throw new Error(`${METHOD}: options.sourceLayers must list one or more source layer names.`);
  }
  return sourceLayers.map((sourceLayer) => sourceLayer.trim());
}

function validateBounds(value: unknown): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) {
    throw new Error(`${METHOD}: options.bounds must be a WGS84 [west, south, east, north] extent.`);
  }
}

function validateZoomRange(minzoom: unknown, maxzoom: unknown): void {
  for (const [name, zoom] of [
    ["minzoom", minzoom],
    ["maxzoom", maxzoom],
  ] as const) {
    if (zoom !== undefined && (typeof zoom !== "number" || zoom < 0 || zoom > 24)) {
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
  const tileUrl = validateUrl(url);
  const sourceLayers = validateSourceLayers(options?.sourceLayers);
  const { bounds, minzoom, maxzoom, visible, opacity, beforeLayerId } = options;
  validateBounds(bounds);
  validateZoomRange(minzoom, maxzoom);
  const metadata = pluginLayerMetadata(METHOD, options.metadata);

  const isTemplate = tileUrl.includes(TILE_TEMPLATE_PLACEHOLDER);
  const layer = createBaseLayer(
    name,
    "vector-tiles",
    {
      type: "vector",
      ...(isTemplate ? { tiles: [tileUrl] } : { url: tileUrl }),
      sourceLayer: sourceLayers[0],
      sourceLayers,
      ...(bounds ? { bounds } : {}),
      ...(minzoom !== undefined ? { minzoom } : {}),
      ...(maxzoom !== undefined ? { maxzoom } : {}),
    },
    {
      ...metadata,
      ...(bounds ? { bounds } : {}),
      ...(minzoom !== undefined ? { minzoom } : {}),
      ...(maxzoom !== undefined ? { maxzoom } : {}),
      sourceLayers,
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
