import type { FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import { parseGeoRssLayer } from "./georss";
// Light import (types and metadata checks only); the DuckDB engine behind a
// query-layer refresh is loaded dynamically inside sql-query-layer.ts, so this
// module stays importable under the node test runner.
import { isSqlQueryLayer } from "./sql-query-layer";

// Keep in sync with WFS_PROXY_PATH / GPX_PROXY_PATH in vite.config.ts (the dev
// proxy binds them there). The GPX path is a generic feed CORS proxy reused for
// GeoRSS refreshes; the name is historical.
const WFS_PROXY_PATH = "/__geolibre_wfs_proxy";
const GPX_PROXY_PATH = "/__geolibre_gpx_proxy";
const FETCH_TIMEOUT_MS = 30_000;
export const MIN_REFRESH_INTERVAL_MS = 1_000;
const GEORSS_SOURCE_KIND = "georss";
const REFRESHABLE_GEOJSON_SOURCE_KINDS = new Set([
  "wfs-getfeature",
  "geojson-url",
  GEORSS_SOURCE_KIND,
]);

// Add Vector Layer (maplibre-gl-vector) tags its store layers with this
// sourceKind. Canonical source is VECTOR_SOURCE_KIND in
// packages/plugins/src/plugins/vector-layer-sync.ts; kept local (not imported)
// so this module stays dependency-light for the node test runner. If the
// canonical value ever changes, update this copy and the literal in
// AttributeTable.tsx — there is no compile-time link between them.
const VECTOR_CONTROL_SOURCE_KIND = "maplibre-gl-vector";

export interface LayerRefreshConfig {
  enabled: boolean;
  intervalMs: number;
}

// Raised when a GetFeature response is XML rather than the requested GeoJSON.
// Exported so the output-format fallback (fetchWfsGeoJson) can recognize this
// specific failure and retry with a different outputFormat token.
export const WFS_XML_RESPONSE_ERROR =
  "The service returned XML instead of GeoJSON. Check the layer name and output format.";

/**
 * Error thrown when a GetFeature response body is XML instead of GeoJSON.
 * Carries `isHtml` so the output-format fallback can tell a genuine WFS/OWS/GML
 * response (a real format rejection worth retrying with another outputFormat)
 * apart from an HTML error page — a corporate proxy block, a WAF challenge, an
 * auth-redirect login page, or a load-balancer 5xx page — which no outputFormat
 * would fix and which should fail immediately rather than drive pointless
 * retries. The message stays `WFS_XML_RESPONSE_ERROR` for backward compatibility
 * with callers that match on it.
 */
export class WfsXmlResponseError extends Error {
  readonly isHtml: boolean;
  constructor(isHtml: boolean) {
    super(WFS_XML_RESPONSE_ERROR);
    this.name = "WfsXmlResponseError";
    this.isHtml = isHtml;
  }
}

/**
 * True when an XML-ish response looks like an HTML page (a proxy/WAF/auth/error
 * page) rather than a genuine WFS/OWS/GML document. A `text/html` content type
 * is decisive; otherwise the head of the body is sniffed for HTML structure
 * tags, tolerating a leading XML prolog, doctype, comment, or `<head>`-only
 * fragment before the real markup. WFS/OWS/GML responses never contain
 * `<html>`/`<head>`/`<body>`/`<title>`, so this does not misclassify them.
 */
function looksLikeHtmlResponse(text: string, contentType: string | null): boolean {
  if (contentType && /text\/html/i.test(contentType)) return true;
  const head = text.slice(0, 512);
  return /<\s*(?:!doctype\s+html|html[\s>]|head[\s>]|body[\s>]|title[\s>])/i.test(head);
}

// Output-format tokens that commonly yield GeoJSON across WFS implementations.
// GeoServer/MapServer honor "application/json"; ArcGIS Server advertises its
// GeoJSON output as "GEOJSON" (uppercase) and answers "application/json" with a
// GML ExceptionReport instead. Trying these in turn lets an ArcGIS WFS load
// without the user having to know its exact format token.
const WFS_GEOJSON_OUTPUT_FORMATS = [
  "application/json",
  "GEOJSON",
  "json",
  "geojson",
  "application/geo+json",
];

export function createWfsGetFeatureUrl(options: {
  endpoint: string;
  typeName: string;
  version: string;
  outputFormat: string;
  srsName: string;
  maxFeatures?: string;
}): string {
  const isWfs2 = options.version.startsWith("2");
  const params: Array<[string, string]> = [
    ["service", "WFS"],
    ["request", "GetFeature"],
    ["version", options.version],
    [isWfs2 ? "typeNames" : "typeName", options.typeName],
    ["outputFormat", options.outputFormat],
  ];

  if (options.srsName) params.push(["srsName", options.srsName]);
  if (options.maxFeatures) {
    params.push([isWfs2 ? "count" : "maxFeatures", options.maxFeatures]);
  }

  return appendQuery(options.endpoint, params);
}

export async function fetchGeoJsonFeatureCollection(
  url: string,
  options: { useWfsProxy?: boolean; signal?: AbortSignal } = {},
): Promise<FeatureCollection> {
  let response: Response;
  try {
    response = await fetch(options.useWfsProxy ? proxyWfsRequestUrl(url) : url, {
      // Combine signals so a caller-supplied signal does not drop the timeout.
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
        : AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("The request timed out.");
    }
    throw error;
  }
  const text = await response.text();
  if (!response.ok && !/^\s*</.test(text)) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  try {
    return parseGeoJsonFeatureCollection(JSON.parse(text));
  } catch (error) {
    if (/^\s*</.test(text)) {
      throw new WfsXmlResponseError(
        looksLikeHtmlResponse(text, response.headers.get("content-type")),
      );
    }
    throw error;
  }
}

/**
 * Fetches a WFS GetFeature response as GeoJSON, retrying with alternate
 * GeoJSON output-format tokens when the server answers the requested format
 * with XML (a GML `ExceptionReport` or a GML feature dump). ArcGIS Server, for
 * example, does not honor the usual `application/json` and instead advertises
 * its GeoJSON output as `GEOJSON`; a plain fetch of `application/json` returns
 * XML and the layer fails to load. Retrying the known GeoJSON aliases makes
 * such services load transparently.
 *
 * Only a genuine WFS/OWS/GML XML response triggers a retry. A network error,
 * timeout, or malformed JSON body is re-thrown immediately (a different
 * outputFormat would not fix it), and so is an HTML error page (a proxy/WAF/auth
 * page), so a server whose problem is unrelated to the output format is not
 * hammered with the full alias list. The resolved request URL and the output
 * format that succeeded are returned so the caller can persist them (so a later
 * layer refresh reuses the working format rather than the rejected one).
 *
 * All attempts share a single {@link FETCH_TIMEOUT_MS} budget rather than each
 * getting a fresh timeout, so a server that is slow to reject each format cannot
 * stack up N × 30s of hang before the error surfaces. The budget is the same
 * ceiling a single non-fallback fetch already has, so a legitimately large
 * GeoJSON download is not penalized relative to today.
 *
 * @param params - The GetFeature parameters. The requested outputFormat is
 *   tried first, then the remaining GeoJSON aliases; an empty requested format
 *   is skipped so no `outputFormat=` request is issued.
 * @param options - WFS proxy routing and an optional abort signal.
 * @returns The parsed FeatureCollection plus the URL and outputFormat that worked.
 */
export async function fetchWfsGeoJson(
  params: {
    endpoint: string;
    typeName: string;
    version: string;
    outputFormat: string;
    srsName: string;
    maxFeatures?: string;
  },
  options: { useWfsProxy?: boolean; signal?: AbortSignal } = {},
): Promise<{ data: FeatureCollection; url: string; outputFormat: string }> {
  const requested = params.outputFormat.trim();
  // Try the user's requested format first (when non-empty), then the remaining
  // GeoJSON aliases (case-insensitively deduped so a token is not requested
  // twice). An empty requested format is dropped rather than sent as
  // `outputFormat=`.
  const candidates = [
    ...(requested ? [requested] : []),
    ...WFS_GEOJSON_OUTPUT_FORMATS.filter(
      (format) => format.toLowerCase() !== requested.toLowerCase(),
    ),
  ];

  // One deadline shared across every attempt, so N slow rejections cannot stack
  // N separate timeouts. Combined with the caller's signal (if any) and passed
  // down; fetchGeoJsonFeatureCollection ANDs its own per-call timeout on top,
  // but this budget is what bounds the total wall time.
  const budget = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;

  let lastError: unknown;
  for (const outputFormat of candidates) {
    const url = createWfsGetFeatureUrl({ ...params, outputFormat });
    try {
      const data = await fetchGeoJsonFeatureCollection(url, {
        ...options,
        signal,
      });
      return { data, url, outputFormat };
    } catch (error) {
      lastError = error;
      // Keep trying other formats only when the server returned a WFS/OWS/GML
      // XML body (a real format rejection). Any other failure — network,
      // timeout, bad JSON, or an HTML error page — is not fixable by a
      // different outputFormat, so surface it immediately.
      if (!(error instanceof WfsXmlResponseError) || error.isHtml) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new WfsXmlResponseError(false);
}

export async function refreshGeoJsonLayer(
  layer: GeoLibreLayer,
): Promise<{ geojson: FeatureCollection; featureCount: number }> {
  const sourceUrl = refreshSourceUrl(layer);
  if (!sourceUrl) {
    throw new Error("This layer does not have a refreshable GeoJSON URL.");
  }

  // GeoRSS feeds are XML, so re-fetch and re-parse them instead of routing
  // through the GeoJSON fetch path (which would reject the XML response).
  if (isGeoRssLayer(layer)) {
    return refreshGeoRssLayer(sourceUrl);
  }

  const data = await fetchGeoJsonFeatureCollection(sourceUrl, {
    useWfsProxy: isWfsLayer(layer),
  });

  return {
    geojson: data,
    featureCount: data.features.length,
  };
}

async function refreshGeoRssLayer(
  url: string,
): Promise<{ geojson: FeatureCollection; featureCount: number }> {
  let response: Response;
  try {
    response = await fetch(proxyFeedRequestUrl(url), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("The request timed out.");
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  // allowEmpty: a live feed can transiently have no geolocated items, and a
  // refresh should clear the layer rather than raise a recurring error.
  const result = parseGeoRssLayer(await response.text(), { allowEmpty: true });
  return { geojson: result.features, featureCount: result.featureCount };
}

/**
 * True when the layer is an Add Vector Layer (maplibre-gl-vector) layer
 * backed by an HTTP(S) URL. These render through the external control's own
 * native sources, so they refresh via VectorControl.reloadLayer rather than
 * the store-GeoJSON path. Covers both GeoJSON and tile render modes.
 *
 * @param layer - The store layer to test.
 * @returns Whether the layer refreshes through the vector control.
 */
export function isVectorControlRefreshLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.metadata.sourceKind === VECTOR_CONTROL_SOURCE_KIND &&
    layer.metadata.externalNativeLayer === true &&
    layerHttpUrl(layer) !== null
  );
}

export function isRefreshableLayer(layer: GeoLibreLayer): boolean {
  return (
    Boolean(refreshSourceUrl(layer)) ||
    isVectorControlRefreshLayer(layer) ||
    // SQL query layers refresh by re-executing their stored DuckDB statement
    // (see refreshSqlQueryLayer) rather than fetching a URL.
    isSqlQueryLayer(layer)
  );
}

export function getLayerRefreshConfig(layer: GeoLibreLayer): LayerRefreshConfig {
  const refresh = layer.metadata.refresh;
  if (!refresh || typeof refresh !== "object" || Array.isArray(refresh)) {
    return { enabled: false, intervalMs: 0 };
  }

  const candidate = refresh as Partial<LayerRefreshConfig>;
  // Clamp persisted values so a hand-edited project file cannot schedule
  // sub-second refresh intervals.
  const intervalMs =
    typeof candidate.intervalMs === "number" &&
    Number.isFinite(candidate.intervalMs) &&
    candidate.intervalMs > 0
      ? Math.max(MIN_REFRESH_INTERVAL_MS, candidate.intervalMs)
      : 0;

  return {
    enabled: candidate.enabled === true && intervalMs > 0,
    intervalMs,
  };
}

export function setLayerRefreshConfig(
  layer: GeoLibreLayer,
  config: LayerRefreshConfig,
): Partial<GeoLibreLayer> {
  const enabled = config.enabled && config.intervalMs > 0;
  // Omit the refresh key entirely when disabled so saved projects do not
  // accumulate meaningless { enabled: false, intervalMs: 0 } entries.
  const { refresh: _refresh, ...restMetadata } = layer.metadata;
  return {
    metadata: enabled
      ? {
          ...restMetadata,
          refresh: { enabled: true, intervalMs: config.intervalMs },
        }
      : restMetadata,
  };
}

function appendQuery(endpoint: string, params: Array<[string, string]>): string {
  const separator = endpoint.includes("?")
    ? endpoint.endsWith("?") || endpoint.endsWith("&")
      ? ""
      : "&"
    : "?";
  const query = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${endpoint}${separator}${query}`;
}

function parseGeoJsonFeatureCollection(value: unknown): FeatureCollection {
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "FeatureCollection" ||
    !("features" in value) ||
    !Array.isArray(value.features)
  ) {
    throw new Error("The response is not a GeoJSON FeatureCollection.");
  }

  return value as FeatureCollection;
}

function layerHttpUrl(layer: GeoLibreLayer): string | null {
  const sourcePath = typeof layer.sourcePath === "string" ? layer.sourcePath.trim() : "";
  const sourceUrl = typeof layer.source.url === "string" ? layer.source.url.trim() : "";
  const url = sourceUrl || sourcePath;
  return isHttpUrl(url) ? url : null;
}

function refreshSourceUrl(layer: GeoLibreLayer): string | null {
  if (layer.type !== "geojson") return null;

  const url = layerHttpUrl(layer);
  if (!url) return null;

  if (isWfsLayer(layer)) return url;
  if (layer.metadata.externalNativeLayer === true) return null;

  // Layers added before sourceKind existed have no tag; treat any GeoJSON
  // layer with an HTTP URL as refreshable unless it is explicitly tagged
  // with a non-refreshable kind.
  const sourceKind =
    typeof layer.metadata.sourceKind === "string" ? layer.metadata.sourceKind : undefined;
  if (sourceKind && !REFRESHABLE_GEOJSON_SOURCE_KINDS.has(sourceKind)) {
    return null;
  }

  return url;
}

function isWfsLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.metadata.sourceKind === "wfs-getfeature" ||
    layer.metadata.service === "wfs" ||
    layer.source.service === "wfs"
  );
}

function isGeoRssLayer(layer: GeoLibreLayer): boolean {
  return layer.metadata.sourceKind === GEORSS_SOURCE_KIND;
}

function isViteDevServer(): boolean {
  return Boolean(
    (
      import.meta as ImportMeta & {
        env?: { DEV?: boolean };
      }
    ).env?.DEV,
  );
}

function proxyWfsRequestUrl(url: string): string {
  return isViteDevServer() ? `${WFS_PROXY_PATH}?url=${encodeURIComponent(url)}` : url;
}

function proxyFeedRequestUrl(url: string): string {
  return isViteDevServer() ? `${GPX_PROXY_PATH}?url=${encodeURIComponent(url)}` : url;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
