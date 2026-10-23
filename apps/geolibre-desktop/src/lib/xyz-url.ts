import type { GeoLibreLayer, GeoLibreProject } from "@geolibre/core";
import { invoke } from "@tauri-apps/api/core";
import { addProtocol, type RequestParameters } from "maplibre-gl";
import { fetchUrlBytes, resolveUrlRedirect } from "./native-http";
import { isHttpWmsUrl, nativeWmsTileUrl, WMS_TILE_PROTOCOL } from "./native-wms-url";
import { geographicTileToMercator, geographicWmsRequest } from "./wms-geographic";
import { projectedTileToMercator, projectedWmsRequest } from "./wms-projected";
import { sanitizeAttributionHtml } from "./sanitize-html";
import { fetchTileWithRetry } from "./tile-retry";
import { isTauri } from "./tauri-io";

const XYZ_TILE_PROTOCOL = "geolibre-xyz";

/** The source options {@link parseXyzTileJson} derives from a TileJSON document. */
const TILEJSON_SOURCE_KEYS = ["bounds", "minzoom", "maxzoom", "scheme", "attribution"] as const;

let protocolRegistered = false;

export interface ResolvedXyzTileUrl {
  originalUrl: string;
  redirected: boolean;
  renderUrl: string;
  url: string;
  tilejson?: XyzTileJsonSource;
}

export interface XyzTileJsonSource {
  tiles: string[];
  bounds?: [number, number, number, number];
  minzoom?: number;
  maxzoom?: number;
  scheme?: "xyz" | "tms";
  attribution?: string;
}

export function normalizeTileUrlTemplate(url: string): string {
  return url
    .replace(/%7B([xyz])%7D/gi, (_, placeholder: string) => {
      return `{${placeholder.toLowerCase()}}`;
    })
    .replace(/\{([xyz])\}/gi, (_, placeholder: string) => {
      return `{${placeholder.toLowerCase()}}`;
    });
}

export function hasXyzTilePlaceholders(url: string): boolean {
  return ["x", "y", "z"].every((placeholder) => url.includes(`{${placeholder}}`));
}

export function createXyzTileUrlTemplate(url: string): ResolvedXyzTileUrl {
  const originalUrl = normalizeTileUrlTemplate(url.trim());
  if (!hasXyzTilePlaceholders(originalUrl)) {
    throw new Error("Enter an XYZ tile URL template with {z}, {x}, and {y} placeholders.");
  }

  return {
    originalUrl,
    redirected: false,
    renderUrl: originalUrl,
    url: originalUrl,
  };
}

export async function resolveXyzTileUrlTemplate(
  url: string,
  signal?: AbortSignal,
): Promise<ResolvedXyzTileUrl> {
  signal?.throwIfAborted();
  const originalUrl = normalizeTileUrlTemplate(url.trim());
  if (hasXyzTilePlaceholders(originalUrl)) {
    return {
      originalUrl,
      redirected: false,
      renderUrl: renderableXyzTileUrl(originalUrl),
      url: originalUrl,
    };
  }

  return resolveShortXyzUrl(originalUrl, signal);
}

export function registerXyzTileProtocol(): void {
  if (protocolRegistered || !isTauri()) return;

  addProtocol(XYZ_TILE_PROTOCOL, async (request, abortController) =>
    fetchNativeTile(parseXyzTileRequest(request), abortController.signal),
  );
  addProtocol(WMS_TILE_PROTOCOL, async (request, abortController) =>
    fetchNativeWmsTile(parseWmsTileRequest(request), abortController.signal),
  );
  protocolRegistered = true;
}

async function fetchNativeWmsTile(
  url: string,
  signal: AbortSignal,
): Promise<{ data: ArrayBuffer }> {
  // A WMS without EPSG:3857 is stored with a geographic SRS/CRS: fetch the
  // tile's lon/lat extent in that CRS and redraw it into Web Mercator.
  const geographic = geographicWmsRequest(url);
  if (geographic) {
    const { data } = await fetchNativeTile(geographic.url, signal);
    return { data: await geographicTileToMercator(data, geographic) };
  }
  // A projected CRS (UTM, a national grid) is requested over an extent that
  // covers the tile and warped into Web Mercator.
  const projected = await projectedWmsRequest(url);
  // Every EPSG:3857 tile takes this path. One in another CRS that cannot be
  // converted (an unknown EPSG code, a degenerate BBOX) is sent as is, so the
  // server's own exception reaches the diagnostics panel instead of a
  // client-side guess.
  if (!projected) return fetchNativeTile(url, signal);
  const { data } = await fetchNativeTile(projected.url, signal);
  return { data: await projectedTileToMercator(data, projected) };
}

async function fetchNativeTile(url: string, signal: AbortSignal): Promise<{ data: ArrayBuffer }> {
  // This handler runs once per tile, so — unlike the one-shot native calls
  // routed through native-http — it deliberately calls `invoke` directly and
  // is NOT recorded in diagnostics: a fast pan over a tile server's coverage
  // edge returns 404s in bulk, and recording each would re-render the panel
  // per tile and evict more relevant entries from the 500-record ring buffer.
  // A transient 5xx or 429 is retried: MapLibre would not ask for the tile
  // again until the view changes.
  const bytes = await fetchTileWithRetry(
    () => invoke<number[] | Uint8Array>("fetch_url_bytes", { url }),
    { signal },
  );
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return { data: array.slice().buffer };
}

export async function resolveProjectXyzLayers(
  project: GeoLibreProject,
  signal?: AbortSignal,
): Promise<GeoLibreProject> {
  const results = await Promise.allSettled(
    project.layers.map((layer) => resolveProjectXyzLayer(layer, signal)),
  );
  const layers = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    if (!signal?.aborted) {
      console.warn("Could not resolve XYZ layer URL", result.reason);
    }
    return project.layers[index];
  });
  return { ...project, layers };
}

async function resolveProjectXyzLayer(
  layer: GeoLibreLayer,
  signal?: AbortSignal,
): Promise<GeoLibreLayer> {
  if (layer.type === "wms") return routeWmsLayerThroughNativeProtocol(layer);
  if (layer.type !== "xyz") return layer;

  const url = getSavedXyzUrl(layer);
  if (!url) {
    return layer;
  }

  const hasShortUrlMetadata =
    typeof layer.metadata.originalUrl === "string" && layer.metadata.originalUrl.trim().length > 0;
  const normalizedUrl = normalizeTileUrlTemplate(url);
  const tileUrl =
    hasShortUrlMetadata || !hasXyzTilePlaceholders(normalizedUrl)
      ? await resolveXyzTileUrlTemplate(url, signal)
      : createXyzTileUrlTemplate(url);
  // A saved TileJSON layer re-reads its document on every open, so the spreads
  // below must not keep fields the refreshed document dropped — a stale
  // `bounds` or zoom limit would go on clipping the layer invisibly. Drop the
  // TileJSON-derived options first and let the new document reinstate them.
  const source = { ...layer.source };
  const metadata = { ...layer.metadata };
  if (tileUrl.tilejson || typeof metadata.tilejsonUrl === "string") {
    for (const key of TILEJSON_SOURCE_KEYS) delete source[key];
    delete metadata.tilejsonUrl;
  }
  return {
    ...layer,
    source: {
      ...source,
      ...(tileUrl.tilejson ?? {}),
      tiles: tileUrl.tilejson?.tiles ?? [tileUrl.renderUrl],
      url: tileUrl.originalUrl,
    },
    metadata: {
      ...metadata,
      originalUrl:
        tileUrl.redirected || layer.metadata.originalUrl ? tileUrl.originalUrl : undefined,
      resolvedUrl: tileUrl.redirected ? tileUrl.url : undefined,
      sourceKind: layer.metadata.sourceKind ?? "xyz-url",
      ...(tileUrl.tilejson ? { tilejsonUrl: tileUrl.originalUrl } : {}),
    },
  };
}

/** Route a WMS layer through Tauri's CORS-exempt HTTP client on desktop. */
export function routeWmsLayerThroughNativeProtocol(layer: GeoLibreLayer): GeoLibreLayer {
  if (!isTauri() || layer.type !== "wms" || !Array.isArray(layer.source.tiles)) return layer;
  return {
    ...layer,
    source: {
      ...layer.source,
      tiles: layer.source.tiles.map((tile) =>
        typeof tile === "string" ? nativeWmsTileUrl(tile) : tile,
      ),
    },
  };
}

function getSavedXyzUrl(layer: GeoLibreLayer): string | null {
  const originalUrl = layer.metadata.originalUrl;
  if (typeof originalUrl === "string" && originalUrl.trim()) {
    return originalUrl;
  }

  const sourceUrl = layer.source.url;
  if (typeof sourceUrl === "string" && sourceUrl.trim()) {
    return sourceUrl;
  }

  const tiles = layer.source.tiles;
  if (Array.isArray(tiles) && typeof tiles[0] === "string") {
    return tiles[0];
  }

  return null;
}

function renderableXyzTileUrl(url: string): string {
  // Tauri allows HTTPS image tiles via CSP, so keep the browser/WebView tile
  // path. Routing every XYZ tile through IPC makes slow tile servers affect
  // desktop responsiveness.
  return url;
}

function parseXyzTileRequest(request: RequestParameters): string {
  const url = new URL(request.url);
  const template = url.searchParams.get("url");
  if (!template) {
    throw new Error("Invalid XYZ tile URL.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3) {
    throw new Error("Invalid XYZ tile coordinates.");
  }

  return template
    .replace(/\{z\}/g, parts[0])
    .replace(/\{x\}/g, parts[1])
    .replace(/\{y\}/g, parts[2]);
}

function parseWmsTileRequest(request: RequestParameters): string {
  const url = new URL(request.url).searchParams.get("url");
  if (!url || !isHttpWmsUrl(url)) {
    throw new Error("Invalid WMS tile URL.");
  }
  return url;
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

async function resolveShortXyzUrl(url: string, signal?: AbortSignal): Promise<ResolvedXyzTileUrl> {
  if (!isHttpUrl(url)) return createXyzTileUrlTemplate(url);
  signal?.throwIfAborted();
  try {
    return await resolveShortXyzUrlWithFetch(url, signal);
  } catch (error) {
    // Only transport/CORS failures need the native client. Invalid documents
    // and HTTP errors must keep their useful error message.
    if (!isTauri() || isAbortError(error) || !(error instanceof TypeError)) throw error;
  }
  // The native short-URL resolver extracts tiles[0] from JSON, discarding the
  // extent. Read the document first so desktop CORS fallback keeps TileJSON.
  const bytes = await fetchUrlBytes(url, { context: "XYZ TileJSON" });
  signal?.throwIfAborted();
  const text = new TextDecoder().decode(new Uint8Array(bytes)).trim();
  if (text.startsWith("{") || text.startsWith("[") || text.startsWith('"') || isHttpUrl(text)) {
    // `fetch_url_bytes` follows redirects internally but returns only bytes, so
    // the document URL is unknowable here and `url` stands in for it. A TileJSON
    // reached through this fallback therefore reports `redirected: false` and
    // leaves `metadata.resolvedUrl` unset even if the request did redirect —
    // cosmetic, since the tile templates come from the document itself.
    return resolvedXyzBody(text, url, url);
  }
  // An image response can still be a short URL redirecting to a template.
  const resolvedUrl = normalizeTileUrlTemplate(
    await resolveUrlRedirect(url, { context: "XYZ URL resolve" }),
  );
  signal?.throwIfAborted();
  return resolvedXyzUrl(url, resolvedUrl);
}

async function resolveShortXyzUrlWithFetch(
  url: string,
  signal?: AbortSignal,
): Promise<ResolvedXyzTileUrl> {
  const response = await fetch(url, {
    headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.8" },
    redirect: "follow",
    signal,
  });
  if (!response.ok) throw new Error(`Could not load XYZ / TileJSON URL (HTTP ${response.status}).`);
  const resolvedUrl = urlFromResolverResponse(response);
  if (resolvedUrl) return resolvedXyzUrl(url, resolvedUrl);

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return resolvedXyzBody(await response.text(), url, response.url || url);
  }
  throw new Error("Enter an XYZ tile URL template or a raster TileJSON URL.");
}

function resolvedXyzUrl(originalUrl: string, url: string): ResolvedXyzTileUrl {
  const resolved = createXyzTileUrlTemplate(url);
  return { ...resolved, originalUrl, redirected: url !== originalUrl };
}

function resolvedXyzBody(
  text: string,
  originalUrl: string,
  documentUrl: string,
): ResolvedXyzTileUrl {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = text.trim();
  }
  if (value && typeof value === "object" && "tilejson" in value) {
    const tilejson = parseXyzTileJson(value);
    return {
      ...resolvedXyzUrl(originalUrl, tilejson.tiles[0]),
      url: documentUrl,
      redirected: documentUrl !== originalUrl,
      tilejson,
    };
  }
  const url = urlFromJsonValue(value);
  if (url) return resolvedXyzUrl(originalUrl, normalizeTileUrlTemplate(url));
  throw new Error("Enter an XYZ tile URL template or a raster TileJSON URL.");
}

/** Validate raster TileJSON and keep the source options used by MapLibre. */
export function parseXyzTileJson(value: unknown): XyzTileJsonSource {
  if (!value || typeof value !== "object") throw new Error("Invalid TileJSON document.");
  const record = value as Record<string, unknown>;
  if (typeof record.tilejson !== "string" || !/^\d+\.\d+\.\d+$/.test(record.tilejson)) {
    throw new Error("Invalid TileJSON version.");
  }
  // Esri `VectorTileServer` documents spell this `vectorLayers`; `vectorLayerIds`
  // in ogc-vector-tiles.ts accepts both spellings, so reject both here rather
  // than let a camelCase document through as a raster source and serve protobuf
  // where an image is expected.
  const vectorLayers = record.vector_layers ?? record.vectorLayers;
  if (Array.isArray(vectorLayers) && vectorLayers.length > 0) {
    throw new Error("This TileJSON describes vector tiles. Use a vector tile source instead.");
  }
  if (!Array.isArray(record.tiles) || record.tiles.length === 0) {
    throw new Error("TileJSON must contain at least one raster tile URL.");
  }
  const tiles = record.tiles.map((tile: unknown) => {
    if (typeof tile !== "string") throw new Error("Invalid TileJSON tile URL.");
    const url = normalizeTileUrlTemplate(tile.trim());
    if (!isHttpUrl(url) || !hasXyzTilePlaceholders(url)) {
      throw new Error("TileJSON tile URLs must use HTTP(S) and contain {z}, {x}, and {y}.");
    }
    // Check syntax as well as the protocol prefix.
    try {
      new URL(url);
    } catch {
      throw new Error("Invalid TileJSON tile URL.");
    }
    return url;
  });
  const source: XyzTileJsonSource = { tiles };
  const bounds = record.bounds;
  if (
    Array.isArray(bounds) &&
    bounds.length === 4 &&
    bounds.every((value) => typeof value === "number" && Number.isFinite(value)) &&
    bounds[0] >= -180 &&
    bounds[2] <= 180 &&
    bounds[0] <= bounds[2] &&
    bounds[1] >= -90 &&
    bounds[3] <= 90 &&
    bounds[1] <= bounds[3]
  )
    source.bounds = bounds as [number, number, number, number];
  const validZoom = (zoom: unknown): zoom is number =>
    typeof zoom === "number" && Number.isInteger(zoom) && zoom >= 0 && zoom <= 30;
  if (validZoom(record.minzoom)) source.minzoom = record.minzoom;
  if (validZoom(record.maxzoom)) source.maxzoom = record.maxzoom;
  if ((source.minzoom ?? 0) > (source.maxzoom ?? 30)) {
    delete source.minzoom;
    delete source.maxzoom;
  }
  if (record.scheme === "xyz" || record.scheme === "tms") source.scheme = record.scheme;
  if (typeof record.attribution === "string") {
    source.attribution = sanitizeAttributionHtml(record.attribution);
  }
  return source;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function urlFromResolverResponse(response: Response): string | null {
  const resolvedUrl = normalizeTileUrlTemplate(response.url);
  return resolvedUrl && hasXyzTilePlaceholders(resolvedUrl) ? resolvedUrl : null;
}

function urlFromJsonValue(value: unknown): string | null {
  if (typeof value === "string" && isHttpUrl(value)) return value;
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  for (const key of ["url", "tileUrl", "tile_url"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && isHttpUrl(candidate)) {
      return candidate;
    }
  }

  const tiles = record.tiles;
  if (Array.isArray(tiles) && typeof tiles[0] === "string" && isHttpUrl(tiles[0])) {
    return tiles[0];
  }

  return null;
}
