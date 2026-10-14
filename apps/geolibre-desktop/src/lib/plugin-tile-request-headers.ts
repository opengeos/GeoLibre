import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  clearTileRequestHeaders,
  isScopedTileUrlPrefix,
  setTileRequestHeaders,
  tileUrlPrefix,
} from "@geolibre/map/tile-request-headers";

const LAYER_KEY_PREFIX = "plugin-layer:";
// RFC 9110 token characters.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE_BREAK = /[\r\n\0]/;

/** Layers with headers registered, so they can be dropped with the layer. */
const layersWithHeaders = new Set<string>();
let unsubscribeLayerWatch: (() => void) | null = null;

/**
 * Check a plugin's headers before they reach a request: a plain object of
 * header names to string values with no line breaks, each name given once
 * (names are case-insensitive, and `fetch` would join two spellings' values
 * into one).
 *
 * @param method - The API method, for the error message.
 * @param headers - The plugin's headers.
 * @returns A copy of the headers.
 */
export function validateRequestHeaders(method: string, headers: unknown): Record<string, string> {
  const prototype =
    typeof headers === "object" && headers !== null && !Array.isArray(headers)
      ? Object.getPrototypeOf(headers)
      : undefined;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${method}: headers must be a plain object of header names to values.`);
  }
  const validated: Record<string, string> = {};
  const seenNames = new Set<string>();
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (!HEADER_NAME.test(name) || typeof value !== "string" || HEADER_VALUE_BREAK.test(value)) {
      throw new Error(`${method}: header "${name}" must be a valid name with a string value.`);
    }
    const caseInsensitiveName = name.toLowerCase();
    if (seenNames.has(caseInsensitiveName)) {
      throw new Error(`${method}: header "${name}" is given more than once.`);
    }
    seenNames.add(caseInsensitiveName);
    validated[name] = value;
  }
  return validated;
}

/**
 * The URL prefixes a tile layer's requests start with: its tile templates and
 * its TileJSON URL.
 *
 * @param layer - A store layer.
 * @returns The prefixes, empty when the layer has no tile endpoint.
 */
export function layerTileUrlPrefixes(layer: Pick<GeoLibreLayer, "source">): string[] {
  const tiles = Array.isArray(layer.source.tiles) ? layer.source.tiles : [];
  const urls = [...tiles, layer.source.url].filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  );
  return [...new Set(urls.map(tileUrlPrefix))];
}

// Headers belong to their layer in the open project. They are dropped when the
// layer leaves the store, however it went (the Layers panel, undo, a plugin),
// and when another project opens, so credentials don't stay registered for a
// URL nothing on the map draws. A layer that comes back needs them set again.
function dropHeadersWithTheirLayers(): void {
  if (unsubscribeLayerWatch) return;
  let generation = useAppStore.getState().projectGeneration;
  unsubscribeLayerWatch = useAppStore.subscribe((state, previous) => {
    const projectChanged = state.projectGeneration !== generation;
    generation = state.projectGeneration;
    if (!projectChanged && state.layers === previous.layers) return;
    const presentLayerIds = new Set(state.layers.map((layer) => layer.id));
    for (const layerId of [...layersWithHeaders]) {
      if (projectChanged || !presentLayerIds.has(layerId)) clearLayerRequestHeaders(layerId);
    }
  });
}

/**
 * Send `headers` with a layer's tile and TileJSON requests, replacing any set
 * before; null or `{}` stops sending them.
 *
 * @param method - The API method, for the error message.
 * @param layer - The layer whose tile URLs to match.
 * @param headers - Validated headers, or null to clear.
 * @returns False when the layer has no tile endpoint.
 */
export function registerLayerRequestHeaders(
  method: string,
  layer: Pick<GeoLibreLayer, "id" | "source">,
  headers: Record<string, string> | null,
): boolean {
  const prefixes = layerTileUrlPrefixes(layer);
  if (prefixes.length === 0) return false;
  if (!headers || Object.keys(headers).length === 0) {
    clearLayerRequestHeaders(layer.id);
    return true;
  }
  if (!prefixes.every(isScopedTileUrlPrefix)) {
    throw new Error(
      `${method}: the layer's tile URL needs a fixed host and path before its first placeholder, or its headers could reach other servers.`,
    );
  }
  dropHeadersWithTheirLayers();
  setTileRequestHeaders(`${LAYER_KEY_PREFIX}${layer.id}`, prefixes, headers);
  layersWithHeaders.add(layer.id);
  return true;
}

/**
 * Stop sending a layer's headers.
 *
 * @param layerId - The layer's id.
 */
export function clearLayerRequestHeaders(layerId: string): void {
  clearTileRequestHeaders(`${LAYER_KEY_PREFIX}${layerId}`);
  layersWithHeaders.delete(layerId);
}

/**
 * The plugin API's `setLayerRequestHeaders`.
 *
 * @param layerId - A tile layer in the store.
 * @param headers - The headers to send, or null to stop.
 * @returns False when there is no such layer or it has no tile endpoint.
 */
export function setPluginLayerRequestHeaders(
  layerId: string,
  headers: Record<string, string> | null,
): boolean {
  const validated =
    headers === null ? null : validateRequestHeaders("setLayerRequestHeaders", headers);
  const layer = useAppStore.getState().layers.find((candidate) => candidate.id === layerId);
  return layer ? registerLayerRequestHeaders("setLayerRequestHeaders", layer, validated) : false;
}
