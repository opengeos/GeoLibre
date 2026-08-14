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

import { fetchOgcJson as fetchOgcJsonDocument } from "./ogc-json";

/** Fetches an OGC API JSON document, tagged for the native-HTTP diagnostics log. */
function fetchOgcJson(url: string, signal?: AbortSignal): Promise<unknown> {
  return fetchOgcJsonDocument(url, { signal, context: "OGC vector tiles" });
}

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
  return lower.includes("{z}") && lower.includes("{x}") && lower.includes("{y}");
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

/** Whether a reference already carries a scheme (or is protocol-relative), and
 * so needs no resolution against the document it was read from. */
function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//");
}

/** Non-empty string tile templates from an unknown `tiles` value. */
function asTiles(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tiles = value.filter((tile): tile is string => typeof tile === "string" && tile.length > 0);
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
    const spatial = (collection as { extent?: { spatial?: { crs?: unknown; bbox?: unknown } } })
      ?.extent?.spatial;
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
  for (const [id, source] of Object.entries(style.sources as Record<string, unknown>)) {
    if (source && typeof source === "object" && (source as VectorSourceLike).type === "vector") {
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
    if (typeof sourceLayer === "string" && sourceLayer.length > 0 && !seen.has(sourceLayer)) {
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
      layer && typeof layer === "object" ? (layer as { id?: unknown }).id : undefined,
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
  // An Esri `VectorTileServer` document is TileJSON-shaped enough to read
  // (`name`, `maxzoom`) but lists its tiles relatively — `tile/{z}/{y}/{x}.pbf`.
  // MapLibre would resolve those against the app origin, so when the document
  // carries relative templates, hand it explicit absolute `tiles` instead of the
  // document URL. Absolute templates are left alone so a conforming TileJSON
  // keeps being loaded by MapLibre itself (it re-reads more than is copied here).
  const tiles = asTiles(tilejson.tiles);
  if (tiles?.some((tile) => !isAbsoluteUrl(tile))) {
    config.tiles = tiles.map((tile) =>
      normalizeTilePlaceholders(resolveDocumentUrl(tile, tilejsonUrl)),
    );
    delete config.url;
  }
  const sourceLayers = vectorLayerIds(tilejson);
  if (sourceLayers.length > 0) config.sourceLayers = sourceLayers;
  return config;
}

/** Lowercases `{z}`/`{x}`/`{y}` so MapLibre's case-sensitive tile substitution
 * works: an uppercase-placeholder template would otherwise be requested
 * verbatim and silently fail to load. */
function normalizeTilePlaceholders(url: string): string {
  return url.replace(/\{z\}/gi, "{z}").replace(/\{x\}/gi, "{x}").replace(/\{y\}/gi, "{y}");
}

/**
 * Resolves a reference taken out of a fetched document against that document's
 * own URL.
 *
 * Style and service documents routinely use relative references: every Esri
 * vector tile style declares its tileset as `{"type":"vector","url":"../../"}`,
 * and an Esri `VectorTileServer` document lists `tiles:
 * ["tile/{z}/{y}/{x}.pbf"]`. MapLibre resolves whatever it is handed against
 * the *app* origin rather than the document it came from, so passing such a
 * value through verbatim requests the wrong host entirely — the layer is added
 * and then silently renders nothing (GeoLibre#1639).
 *
 * `URL` percent-encodes the `{`/`}` of a tile template, which would defeat
 * MapLibre's placeholder substitution, so the braces are restored afterwards.
 *
 * @param value - The (possibly relative) reference read from the document.
 * @param baseUrl - The URL the document was fetched from.
 * @returns The absolute URL, or the trimmed input when it cannot be resolved.
 */
export function resolveDocumentUrl(value: string, baseUrl?: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || !baseUrl) return trimmed;
  try {
    return new URL(trimmed, baseUrl).toString().replace(/%7B/gi, "{").replace(/%7D/gi, "}");
  } catch {
    return trimmed;
  }
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
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;

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
      // given. Both forms are resolved against the style URL first: they are
      // routinely relative (see `resolveDocumentUrl`).
      if (!config.url && !config.tiles) {
        if (typeof vector.source.url === "string") {
          const sourceUrl = resolveDocumentUrl(vector.source.url, styleUrl);
          config.url = sourceUrl || undefined;
          // The style only names the tileset; the document it points at holds
          // the tile templates and zoom range. Read it so a non-TileJSON
          // service (Esri's `VectorTileServer`) still yields usable absolute
          // tiles. Best-effort: the style's own metadata below still applies if
          // this fails, so a fetch error must not block adding the layer.
          if (sourceUrl) {
            const tileset = await fetchOgcJson(sourceUrl, signal).catch((error) => {
              if (input.signal?.aborted) throw error;
              return null;
            });
            if (tileset && typeof tileset === "object") {
              // Style-derived source layers and name stay authoritative
              // (manual > style > TileJSON), so the tileset must not clobber
              // them. `url` is assigned rather than spread: `tileJsonConfig`
              // *drops* it when it emits explicit `tiles`, and a spread would
              // leave the stale value behind — a MapLibre vector source given
              // both `url` and `tiles` is invalid.
              const {
                sourceLayers: tilesetLayers,
                name: tilesetName,
                url: tilesetUrl,
                ...tilesetConfig
              } = tileJsonConfig(tileset as Record<string, unknown>, sourceUrl);
              config = {
                ...config,
                ...tilesetConfig,
                url: tilesetUrl,
                name: config.name ?? tilesetName,
                sourceLayers:
                  config.sourceLayers.length > 0 ? config.sourceLayers : (tilesetLayers ?? []),
              };
            }
          }
        } else {
          config.tiles = asTiles(vector.source.tiles)?.map((tile) =>
            normalizeTilePlaceholders(resolveDocumentUrl(tile, styleUrl)),
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
      config.bounds = await fetchOgcCollectionsBounds(reference, signal, input.signal);
    }
  }

  return config;
}
