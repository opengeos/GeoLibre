/**
 * Decides when a map-engine error (a failed tile, a style source that would not
 * load) is worth a toast rather than only a Diagnostics entry (issue #2858),
 * and which toast.
 *
 * Only failures of a user's own layer qualify. A missing *tile* (HTTP 404) is
 * not a failure on its own: sparse tile sets answer 404 for every empty tile by
 * design, so a toast there would fire on ordinary panning. It becomes one when
 * the layer has loaded no tile at all after several requests (a wrong URL
 * template). A 404 for a whole-file source (GeoJSON, PMTiles, a style) still
 * counts at once, and so does a 401/403, which no sparse tile set answers with.
 * A 429 is the server throttling a burst of requests, not a broken layer, so it
 * gets its own warning rather than "failed to load".
 */
import type { GeoLibreLayer } from "@geolibre/core";
import { mapboxSourceId, sourceId } from "@geolibre/map/style-layer-ids";
import type { MapDiagnosticEvent } from "@geolibre/map";

/** HTTP statuses that mean "no data here" for a tile rather than a failure. */
export const EMPTY_TILE_STATUSES: ReadonlySet<number> = new Set([204, 404]);

/** HTTP statuses that mean the server refused the request (a bad or missing key). */
const ACCESS_DENIED_STATUSES = new Set([401, 403]);

/** HTTP status a server answers when it is throttling requests. */
const RATE_LIMITED_STATUS = 429;

/**
 * The Diagnostics level for a map-engine error. A 429 is the server throttling
 * a burst of tile requests: the layer still works and it is not a GeoLibre bug,
 * so it is a warning (no "Report issue"), not one error per throttled tile.
 *
 * @param event - The engine's error event.
 * @returns The level to record the event at.
 */
export function mapDiagnosticLevel(event: MapDiagnosticEvent): "error" | "warning" {
  return event.status === RATE_LIMITED_STATUS ? "warning" : "error";
}

/**
 * Failed tile requests, with none loaded, after which a tile layer reads as
 * broken rather than sparse. High enough that one screen of a sparse set over
 * open ocean does not trip it before any populated tile has loaded.
 */
export const MISSING_TILES_THRESHOLD = 12;

/**
 * What a layer's failure should be reported as.
 *
 * - `failed`: it did not load (an error toast).
 * - `accessDenied`: the server refused it, typically a bad API key (a warning).
 * - `tilesMissing`: every tile so far was "not found" (a warning).
 * - `rateLimited`: the server throttled requests (HTTP 429); the layer works,
 *   but some tiles may be missing until it lets requests through (a warning).
 */
export type LayerFailureKind = "failed" | "accessDenied" | "tilesMissing" | "rateLimited";

/** A layer to tell the user about, and how. */
export interface LayerFailureNotice {
  layer: GeoLibreLayer;
  kind: LayerFailureKind;
  /** The HTTP status behind an `accessDenied` notice, when known. */
  status?: number;
}

/**
 * Finds the store layer a map source belongs to.
 *
 * @param source - The engine's source id from the error event.
 * @param layers - The store's layers.
 * @returns The owning layer, or `null` for basemap/plugin/unknown sources.
 */
export function layerForMapSource(
  source: string | undefined,
  layers: readonly GeoLibreLayer[],
): GeoLibreLayer | null {
  if (!source) return null;
  return (
    layers.find((layer) => sourceId(layer.id) === source || mapboxSourceId(layer.id) === source) ??
    null
  );
}

/**
 * Whether a map error event describes a failed tile rather than a whole source.
 * The engine records the tile coordinates in the event detail when it has them.
 */
function isTileFailure(event: MapDiagnosticEvent): boolean {
  if (event.tiles) return true;
  if (typeof event.detail !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(event.detail);
    return typeof parsed === "object" && parsed !== null && "tile" in parsed;
  } catch {
    return false;
  }
}

/**
 * Whether a layer's tile tallies say it is broken rather than sparse: enough
 * requests failed and not one tile loaded.
 *
 * @param tiles - Loaded and failed tile counts so far.
 * @returns True once the layer has only ever failed, {@link MISSING_TILES_THRESHOLD} times.
 */
export function tilesLookBroken(tiles: { loaded: number; failed: number }): boolean {
  return tiles.loaded === 0 && tiles.failed >= MISSING_TILES_THRESHOLD;
}

/**
 * Classifies a map error event for the notification layer.
 *
 * @param event - The engine's error event.
 * @param layers - The store's layers.
 * @returns The layer and the kind of notice, or `null` when the error stays in
 *   Diagnostics only (not a user layer, an empty tile, or a tile failure that
 *   does not yet look like a broken layer).
 */
export function mapErrorNotice(
  event: MapDiagnosticEvent,
  layers: readonly GeoLibreLayer[],
): LayerFailureNotice | null {
  const layer =
    (event.layerId ? layers.find((candidate) => candidate.id === event.layerId) : undefined) ??
    layerForMapSource(event.source, layers);
  if (!layer) return null;
  const { status } = event;
  if (status !== undefined && ACCESS_DENIED_STATUSES.has(status)) {
    return { layer, kind: "accessDenied", status };
  }
  if (status === RATE_LIMITED_STATUS) return { layer, kind: "rateLimited", status };
  // An engine that counts tiles (Cesium) passes the tallies. It often cannot
  // see the HTTP status at all (an <img> load), so a missing status may be an
  // empty tile too, and only the tallies can tell.
  if (event.tiles && (status === undefined || EMPTY_TILE_STATUSES.has(status))) {
    if (!tilesLookBroken(event.tiles)) return null;
    return { layer, kind: status === undefined ? "failed" : "tilesMissing" };
  }
  if (
    status !== undefined &&
    EMPTY_TILE_STATUSES.has(status) &&
    (isTileFailure(event) || hasTileTemplates(layer))
  ) {
    return null;
  }
  return { layer, kind: "failed" };
}

/**
 * Picks the layer a map error should be surfaced for, if any.
 *
 * @param event - The engine's error event.
 * @param layers - The store's layers.
 * @returns The layer to notify about, or `null` when the error stays in
 *   Diagnostics only (not a user layer, or an empty tile).
 */
export function layerToNotifyForMapError(
  event: MapDiagnosticEvent,
  layers: readonly GeoLibreLayer[],
): GeoLibreLayer | null {
  return mapErrorNotice(event, layers)?.layer ?? null;
}

/** The layer's tile URL templates, if its source is a tile template set. */
export function tileTemplatesOf(layer: GeoLibreLayer): string[] {
  const tiles = (layer.source as { tiles?: unknown } | undefined)?.tiles;
  return Array.isArray(tiles)
    ? tiles.filter((tile): tile is string => typeof tile === "string" && tile.length > 0)
    : [];
}

/**
 * Whether the layer's source is a tile template set. The Mapbox engine's error
 * detail carries no tile coordinates, so for those layers a 404 is read as an
 * empty tile from the layer record instead.
 */
function hasTileTemplates(layer: GeoLibreLayer): boolean {
  return tileTemplatesOf(layer).length > 0;
}

const templatePatterns = new Map<string, RegExp | null>();

/**
 * Compiles a tile URL template into a pattern that matches the URLs the engine
 * requests from it: every `{placeholder}` stands for any run of characters
 * other than a path or query separator, and a query string the engine appends
 * (a cache buster, a token) is allowed after it.
 */
function templatePattern(template: string): RegExp | null {
  const cached = templatePatterns.get(template);
  if (cached !== undefined) return cached;
  let pattern: RegExp | null = null;
  // Only an http(s) template is fetched under its own URL; a custom protocol
  // (pmtiles://, a Tauri bridge) is not what the network capture sees.
  if (/^https?:\/\//i.test(template) && /\{[^}]+\}/.test(template)) {
    const source = template
      .split(/(\{[^}]+\})/)
      .map((part) =>
        /^\{[^}]+\}$/.test(part) ? "[^/?&#]*" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("");
    pattern = new RegExp(`^${source}(?:[?&#].*)?$`, "i");
  }
  templatePatterns.set(template, pattern);
  return pattern;
}

/**
 * Finds the tile-template layer a requested URL belongs to.
 *
 * @param url - The URL the engine fetched.
 * @param layers - The store's layers.
 * @returns The first layer whose tile template matches, or `null`.
 */
export function layerForTileUrl(
  url: string,
  layers: readonly GeoLibreLayer[],
): GeoLibreLayer | null {
  for (const layer of layers) {
    for (const template of tileTemplatesOf(layer)) {
      if (templatePattern(template)?.test(url)) return layer;
    }
  }
  return null;
}
