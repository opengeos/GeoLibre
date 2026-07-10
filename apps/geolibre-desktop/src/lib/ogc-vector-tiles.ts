/**
 * Helpers for adding an OGC API - Tiles (vector) source as a MapLibre vector
 * layer. The user points at either a TileJSON metadata document or a
 * `{z}/{y}/{x}` MVT tile template, and optionally a Mapbox/MapLibre style
 * document that names the tileset's source layers.
 *
 * A MapLibre vector source can only be drawn once its `source-layer` names are
 * known, but an OGC API TileJSON commonly omits `vector_layers`. So the source
 * layers are resolved in priority order: an explicit manual list, then the
 * distinct `source-layer` values referenced by the style document, then the
 * TileJSON's `vector_layers` ids.
 */

import { isTauri } from "./is-tauri";

/** Dev-server CORS proxy path; kept in sync with GPX_PROXY_PATH in vite.config.ts. */
const OGC_PROXY_PATH = "/__geolibre_gpx_proxy";

/** The resolved configuration for an OGC API vector tiles layer. */
export interface OgcVectorTilesConfig {
  /** A suggested layer name from the tileset/style metadata, if any. */
  name?: string;
  /** A TileJSON URL for MapLibre to load the source from. */
  url?: string;
  /** Explicit `{z}/{x}/{y}` tile templates, used when no TileJSON URL applies. */
  tiles?: string[];
  minzoom?: number;
  maxzoom?: number;
  bounds?: [number, number, number, number];
  center?: number[];
  /** The vector source layers to draw. */
  sourceLayers: string[];
}

interface StyleLike {
  name?: unknown;
  sources?: unknown;
  layers?: unknown;
}

interface VectorSourceLike {
  type?: unknown;
  url?: unknown;
  tiles?: unknown;
  minzoom?: unknown;
  maxzoom?: unknown;
  bounds?: unknown;
}

/**
 * Whether a URL is a directly usable MapLibre tile template (has `{z}`, `{x}`,
 * and `{y}` placeholders) rather than a TileJSON metadata URL. OGC API
 * templates that use `{tileMatrix}/{tileRow}/{tileCol}` are not MapLibre
 * compatible and are treated as metadata URLs (a fetch that then fails clearly).
 */
export function hasTilePlaceholders(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("{z}") && lower.includes("{x}") && lower.includes("{y}")
  );
}

/** A `[west, south, east, north]` tuple, if `value` looks like one. */
function asBounds(value: unknown): [number, number, number, number] | undefined {
  if (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    return value as [number, number, number, number];
  }
  return undefined;
}

/** Non-empty string tile templates from an unknown `tiles` value. */
function asTiles(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tiles = value.filter(
    (tile): tile is string => typeof tile === "string" && tile.length > 0,
  );
  return tiles.length > 0 ? tiles : undefined;
}

/** Whether an OGC `extent.spatial.crs` is lon/lat (CRS84/EPSG:4326). The OGC API
 * default when the field is absent is CRS84, so undefined counts as lon/lat. */
function isLonLatCrs(crs: unknown): boolean {
  if (crs === undefined || crs === null) return true;
  return typeof crs === "string" && /CRS84|4326/i.test(crs);
}

/**
 * The `[west, south, east, north]` union of an OGC API collections list, using
 * each collection's `extent.spatial.bbox` (only when advertised in lon/lat).
 *
 * @param collections - The `collections` array from an OGC API document, or a
 *   single collection wrapped in an array.
 * @returns The union bounds, or undefined when none are usable.
 */
export function unionCollectionBounds(
  collections: unknown,
): [number, number, number, number] | undefined {
  if (!Array.isArray(collections)) return undefined;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let found = false;
  for (const collection of collections) {
    const spatial = (
      collection as { extent?: { spatial?: { crs?: unknown; bbox?: unknown } } }
    )?.extent?.spatial;
    if (!spatial || !isLonLatCrs(spatial.crs)) continue;
    // `bbox` is an array of boxes; the first is the overall extent. A box that
    // crosses the antimeridian (west > east) is not handled: the plain min/max
    // union below would widen it the wrong way, so skip it rather than produce
    // a bogus world-spanning extent.
    const box = Array.isArray(spatial.bbox) ? spatial.bbox[0] : undefined;
    const bounds = asBounds(box);
    if (!bounds || bounds[0] > bounds[2]) continue;
    west = Math.min(west, bounds[0]);
    south = Math.min(south, bounds[1]);
    east = Math.max(east, bounds[2]);
    north = Math.max(north, bounds[3]);
    found = true;
  }
  return found ? [west, south, east, north] : undefined;
}

/**
 * Best-effort discovery of a tileset's geographic extent from the OGC API
 * collections metadata, used for zoom-to-layer when the TileJSON advertises no
 * `bounds`. Derives the API base by stripping the `/tiles/...` suffix from the
 * tiles URL, then reads the collection(s) extent. Never throws; returns
 * undefined on any failure so it cannot block adding the layer.
 *
 * @param tilesUrl - A tiles URL or template that contains `/tiles/`.
 * @param signal - The abort signal (caller + overall deadline) for the request.
 * @param callerSignal - The caller's own signal; a caller abort is rethrown so a
 *   cancelled add-data request cannot still add the layer, while network and
 *   timeout failures are swallowed (bounds are best-effort).
 */
async function fetchOgcCollectionsBounds(
  tilesUrl: string,
  signal?: AbortSignal,
  callerSignal?: AbortSignal,
): Promise<[number, number, number, number] | undefined> {
  const withoutQuery = tilesUrl.split("?")[0];
  const marker = "/tiles/";
  const index = withoutQuery.indexOf(marker);
  if (index === -1) return undefined;
  const base = withoutQuery.slice(0, index);
  try {
    // Single-collection tileset (.../collections/{id}/tiles/...): the collection
    // resource itself carries the extent. Otherwise it is a multi-collection
    // (map) tileset, whose sibling /collections lists every collection.
    if (/\/collections\/[^/]+$/.test(base)) {
      const collection = await fetchOgcJson(`${base}?f=json`, signal);
      return unionCollectionBounds([collection]);
    }
    const doc = (await fetchOgcJson(`${base}/collections?f=json`, signal)) as {
      collections?: unknown;
    };
    return unionCollectionBounds(doc?.collections);
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    return undefined;
  }
}

/**
 * The first `type: "vector"` source in a style document, with its id.
 *
 * Heuristic: OGC API styles usually declare a single vector source (the
 * tileset), so the first one is it. A style that bundles several vector sources
 * (e.g. a basemap alongside the tileset) cannot be disambiguated here; the
 * user can then enter the source layers manually to override.
 *
 * @param style - A parsed Mapbox/MapLibre style document.
 * @returns The source and its key, or null when the style has no vector source.
 */
export function firstVectorSource(
  style: StyleLike,
): { id: string; source: VectorSourceLike } | null {
  if (!style.sources || typeof style.sources !== "object") return null;
  for (const [id, source] of Object.entries(
    style.sources as Record<string, unknown>,
  )) {
    if (
      source &&
      typeof source === "object" &&
      (source as VectorSourceLike).type === "vector"
    ) {
      return { id, source: source as VectorSourceLike };
    }
  }
  return null;
}

/**
 * The distinct, non-empty `source-layer` values referenced by a style's layers,
 * in first-seen order.
 *
 * @param style - A parsed Mapbox/MapLibre style document.
 * @param sourceId - When given, only layers bound to this source are considered.
 * @returns The referenced source-layer names.
 */
export function styleSourceLayers(style: StyleLike, sourceId?: string): string[] {
  if (!Array.isArray(style.layers)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const layer of style.layers) {
    if (!layer || typeof layer !== "object") continue;
    const entry = layer as { "source-layer"?: unknown; source?: unknown };
    if (sourceId !== undefined && entry.source !== sourceId) continue;
    const sourceLayer = entry["source-layer"];
    if (
      typeof sourceLayer === "string" &&
      sourceLayer.length > 0 &&
      !seen.has(sourceLayer)
    ) {
      seen.add(sourceLayer);
      result.push(sourceLayer);
    }
  }
  return result;
}

/** The `id` strings from a TileJSON `vector_layers`/`vectorLayers` array. */
function vectorLayerIds(tilejson: Record<string, unknown>): string[] {
  const layers = tilejson.vector_layers ?? tilejson.vectorLayers;
  if (!Array.isArray(layers)) return [];
  return layers
    .map((layer) =>
      layer && typeof layer === "object"
        ? (layer as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Builds a partial config from a parsed TileJSON document. MapLibre is handed
 * the TileJSON URL directly (it re-reads `tiles`/zoom), so `url` is set to the
 * metadata URL rather than the inner tile templates.
 *
 * @param tilejson - The parsed TileJSON document.
 * @param tilejsonUrl - The URL the document was fetched from.
 */
export function tileJsonConfig(
  tilejson: Record<string, unknown>,
  tilejsonUrl: string,
): Partial<OgcVectorTilesConfig> {
  const config: Partial<OgcVectorTilesConfig> = { url: tilejsonUrl };
  if (typeof tilejson.name === "string") config.name = tilejson.name;
  if (typeof tilejson.minzoom === "number") config.minzoom = tilejson.minzoom;
  if (typeof tilejson.maxzoom === "number") config.maxzoom = tilejson.maxzoom;
  const bounds = asBounds(tilejson.bounds);
  if (bounds) config.bounds = bounds;
  // A TileJSON `center` is `[lng, lat]` or `[lng, lat, zoom]`; reject anything
  // else so non-finite or malformed values never reach the layer metadata.
  const center = tilejson.center;
  if (
    Array.isArray(center) &&
    (center.length === 2 || center.length === 3) &&
    center.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    config.center = center as number[];
  }
  const sourceLayers = vectorLayerIds(tilejson);
  if (sourceLayers.length > 0) config.sourceLayers = sourceLayers;
  return config;
}

/** Lowercases `{z}`/`{x}`/`{y}` so MapLibre's case-sensitive tile substitution
 * works: an uppercase-placeholder template would otherwise be requested
 * verbatim and silently fail to load. */
function normalizeTilePlaceholders(url: string): string {
  return url
    .replace(/\{z\}/gi, "{z}")
    .replace(/\{x\}/gi, "{x}")
    .replace(/\{y\}/gi, "{y}");
}

/** A promise that rejects when the signal aborts, with its abort reason. Used to
 * race an uncancellable Tauri invoke against the caller's abort and a timeout. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** Converts opaque fetch/abort failures into a clear, user-facing Error so the
 * Add Data dialog surfaces the real cause instead of a generic fallback. */
function normalizeFetchError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new Error("The request timed out.");
  }
  // A CORS/network rejection surfaces as a bare TypeError with no status.
  if (error instanceof TypeError) {
    return new Error(
      "Could not reach the service. It may not allow cross-origin requests from the browser; try the desktop app.",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Fetches and parses a remote JSON document, working around cross-origin limits.
 * The Tauri path uses the Rust `fetch_url_bytes` command (not subject to browser
 * CORS); the dev server routes through the same-origin proxy; the hosted web
 * build fetches directly. When the caller passes a `signal` it owns the deadline
 * (see `resolveOgcVectorTiles`, which shares one across its requests); otherwise
 * a 30s timeout is applied so an unresponsive endpoint cannot hang forever.
 */
async function fetchOgcJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const abort = signal ?? AbortSignal.timeout(30_000);
  if (isTauri()) {
    // `fetch_url_bytes` cannot be cancelled mid-flight, so race it against the
    // abort/timeout to still return promptly on a slow or hung host.
    const { fetchUrlBytes } = await import("./native-http");
    const bytesPromise = fetchUrlBytes(url, { context: "OGC vector tiles" });
    // If the abort/timeout wins the race, the invoke promise is left unobserved;
    // swallow a later rejection so it does not surface as an unhandled rejection.
    bytesPromise.catch(() => {});
    try {
      const bytes = await Promise.race([bytesPromise, rejectOnAbort(abort)]);
      const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      return JSON.parse(new TextDecoder().decode(array));
    } catch (error) {
      throw normalizeFetchError(error);
    }
  }
  const isDev = Boolean(
    (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV,
  );
  const fetchUrl = isDev
    ? `${OGC_PROXY_PATH}?url=${encodeURIComponent(url)}`
    : url;
  let response: Response;
  try {
    response = await fetch(fetchUrl, { signal: abort });
  } catch (error) {
    throw normalizeFetchError(error);
  }
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response.json();
}

/**
 * Resolves the configuration for an OGC API vector tiles layer from the URLs the
 * user provided, fetching the TileJSON and/or style document as needed.
 *
 * @param input.tilesUrl - A TileJSON metadata URL or a `{z}/{x}/{y}` template.
 * @param input.styleUrl - An optional Mapbox/MapLibre style URL, used to derive
 *   the tileset (when `tilesUrl` is blank) and its source layers.
 * @param input.sourceLayers - An optional manual list of source layers that
 *   overrides whatever the documents advertise.
 * @param input.signal - An optional abort signal for the network requests.
 * @returns The resolved source config to build a `vector-tiles` layer from.
 */
export async function resolveOgcVectorTiles(input: {
  tilesUrl: string;
  styleUrl?: string;
  sourceLayers?: string[];
  signal?: AbortSignal;
}): Promise<OgcVectorTilesConfig> {
  const tilesUrl = input.tilesUrl.trim();
  const styleUrl = input.styleUrl?.trim();
  let config: OgcVectorTilesConfig = { sourceLayers: [] };

  // One overall deadline shared across every request (the TileJSON, the style,
  // and the best-effort collections lookup) so a merely-slow host cannot make
  // the sequential lookups add up to several times the intended 30s.
  const deadline = AbortSignal.timeout(30_000);
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadline])
    : deadline;

  // The TileJSON and style documents are independent, so fetch them together
  // rather than back to back (the built-in sample fills in both). A raw tile
  // template needs no fetch.
  const isTemplate = tilesUrl !== "" && hasTilePlaceholders(tilesUrl);
  const [tilejsonDoc, styleDoc] = await Promise.all([
    tilesUrl && !isTemplate ? fetchOgcJson(tilesUrl, signal) : Promise.resolve(null),
    styleUrl ? fetchOgcJson(styleUrl, signal) : Promise.resolve(null),
  ]);

  if (isTemplate) {
    config.tiles = [normalizeTilePlaceholders(tilesUrl)];
  } else if (tilejsonDoc) {
    config = {
      ...config,
      ...tileJsonConfig(tilejsonDoc as Record<string, unknown>, tilesUrl),
    };
  }

  if (styleDoc) {
    const style = styleDoc as StyleLike;
    const vector = firstVectorSource(style);
    // A provided style is authoritative for the layers it references, so its
    // source layers take precedence over the TileJSON's `vector_layers` (the
    // documented manual > style > TileJSON order). An explicit manual list
    // still wins below. When the style references none, keep what the TileJSON
    // advertised rather than blanking the layer.
    const layerNames = styleSourceLayers(style, vector?.id);
    if (layerNames.length > 0) config.sourceLayers = layerNames;
    if (!config.name && typeof style.name === "string") {
      config.name = style.name;
    }
    if (vector) {
      // Fall back to the style's own vector source only when no tiles input was
      // given...
      if (!config.url && !config.tiles) {
        if (typeof vector.source.url === "string") {
          config.url = vector.source.url;
        } else {
          config.tiles = asTiles(vector.source.tiles)?.map(
            normalizeTilePlaceholders,
          );
        }
      }
      // ...but always fill a missing zoom range / bounds from the style, even
      // when the tiles came from a raw template that carries none, so MapLibre
      // does not request tiles outside the levels the endpoint serves.
      if (config.minzoom === undefined && typeof vector.source.minzoom === "number") {
        config.minzoom = vector.source.minzoom;
      }
      if (config.maxzoom === undefined && typeof vector.source.maxzoom === "number") {
        config.maxzoom = vector.source.maxzoom;
      }
      const bounds = asBounds(vector.source.bounds);
      if (!config.bounds && bounds) config.bounds = bounds;
    }
  }

  if (input.sourceLayers && input.sourceLayers.length > 0) {
    config.sourceLayers = input.sourceLayers;
  }
  // Defensive: `sourceLayers` is always an array above, but guarantee it so the
  // dialog can safely read `.length` on the "no source layers" path.
  if (!Array.isArray(config.sourceLayers)) config.sourceLayers = [];

  // An OGC API TileJSON frequently omits `bounds`, which leaves zoom-to-layer
  // with nothing to fit. Fall back to the collections extent so the layer can
  // still be framed. Only attempt it for a metadata-style URL (no `{z}/{x}/{y}`
  // placeholders): a raw XYZ template that merely contains `/tiles/` is very
  // unlikely to be an OGC API service, so probing `/collections` would just be
  // a wasted request to a third-party host.
  if (!config.bounds) {
    const reference = tilesUrl || config.url || config.tiles?.[0];
    if (reference && !hasTilePlaceholders(reference) && reference.includes("/tiles/")) {
      config.bounds = await fetchOgcCollectionsBounds(
        reference,
        signal,
        input.signal,
      );
    }
  }

  return config;
}
