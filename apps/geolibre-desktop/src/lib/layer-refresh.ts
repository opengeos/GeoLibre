import type { FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import { parseGeoRssLayer } from "./georss";
import { looksLikeGmlFeatureCollection } from "./gml";
import { parseGmlWithReprojection } from "./gml-projection";
import { classifyFetchFailure } from "./fetch-error";
import { isTauri } from "./is-tauri";
import {
  arcGisAxisCheckRequest,
  axisOrderIsAmbiguous,
  coordinateExtent,
  shouldSwapAxes,
  swapAxes,
  wgs84BoundingBox,
  type ArcGisWfsRequest,
} from "./wfs-axis-order";
import { charsetFromContentType, decodeXmlBytes } from "./xml-decode";
// Light import (types and metadata checks only); the DuckDB engine behind a
// query-layer refresh is loaded dynamically inside sql-query-layer.ts, so this
// module stays importable under the node test runner.
import { isSqlQueryLayer } from "./sql-query-layer";
// Same reasoning: `iceberg.ts` is the pure half of the Iceberg support, so the
// metadata check imports cleanly here; its DuckDB engine is behind a dynamic
// import inside `refreshIcebergLayer`.
import { isIcebergLayer } from "./iceberg";

// Keep in sync with WFS_PROXY_PATH / GPX_PROXY_PATH in vite.config.ts (the dev
// proxy binds them there). The GPX path is a generic feed CORS proxy reused for
// GeoRSS refreshes; the name is historical.
const WFS_PROXY_PATH = "/__geolibre_wfs_proxy";
const GPX_PROXY_PATH = "/__geolibre_gpx_proxy";
const CSW_PROXY_PATH = "/__geolibre_csw_proxy";
// Add Data tags a layer built from a CSW record's GeoJSON resource with this
// sourceKind. Canonical copy is CSW_SOURCE_KIND-equivalent literal in
// components/layout/add-data/sources/CswSource.tsx; kept local for the same
// reason as the WFS/GPX proxy paths above.
const CSW_SOURCE_KIND = "csw";
const FETCH_TIMEOUT_MS = 30_000;
// Largest WFS response the desktop's native client reads. GML runs several
// times larger than GeoJSON (8.5 MB for 16 Polish voivodeships), but the body
// also crosses the Tauri IPC boundary as a JSON number array, so an unbounded
// one could exhaust the app's memory. Same ceiling as a WCS coverage.
const WFS_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
// Feature cap for refreshing an OGC API - Features layer whose stored request
// carries no `maxFeatures` (added before it was persisted, or hand-edited).
// Mirrors DEFAULT_OGC_FEATURES_MAX_FEATURES in lib/ogc-api-features.ts.
const DEFAULT_OGC_FEATURES_REFRESH_MAX = 1000;
export const MIN_REFRESH_INTERVAL_MS = 1_000;
const GEORSS_SOURCE_KIND = "georss";
// Local copy of OGC_FEATURES_SOURCE_KIND (lib/ogc-api-features.ts), kept here so
// this module's metadata checks stay free of that module's import graph; the
// paged fetch itself is imported dynamically in the refresh branch below.
const OGC_FEATURES_SOURCE_KIND = "ogc-features-items";
// Local copy of ARCGIS_FEATURE_SOURCE_KIND (@geolibre/plugins), kept here for
// the same reason as the OGC one above; the paged fetch is imported dynamically
// in the refresh branch below.
const ARCGIS_FEATURE_SOURCE_KIND = "arcgis-feature-query";
const REFRESHABLE_GEOJSON_SOURCE_KINDS = new Set([
  "wfs-getfeature",
  "geojson-url",
  GEORSS_SOURCE_KIND,
  OGC_FEATURES_SOURCE_KIND,
  ARCGIS_FEATURE_SOURCE_KIND,
  CSW_SOURCE_KIND,
]);

// Add Vector Layer (maplibre-gl-vector) tags its store layers with this
// sourceKind. Canonical source is VECTOR_SOURCE_KIND in
// packages/plugins/src/plugins/vector-layer-sync.ts; kept local (not imported)
// so this module stays dependency-light for the node test runner. If the
// canonical value ever changes, update this copy and the literal in
// AttributeTable.tsx — there is no compile-time link between them.
const VECTOR_CONTROL_SOURCE_KIND = "maplibre-gl-vector";
// An Add Vector Layer layer GeoLibre adopted into the store (canonical source:
// ADOPTED_VECTOR_SOURCE_KIND next to VECTOR_SOURCE_KIND). It refreshes through
// the control too, which re-reads the URL and hands the new features back.
const ADOPTED_VECTOR_SOURCE_KIND = "maplibre-gl-vector-adopted";

export interface LayerRefreshConfig {
  enabled: boolean;
  intervalMs: number;
}

// Raised when a GetFeature response is XML but neither GeoJSON nor a GML feature
// collection (typically an OWS ExceptionReport rejecting the outputFormat).
// Exported so the output-format fallback (fetchWfsGeoJson) can recognize this
// specific failure and retry with a different outputFormat token.
export const WFS_XML_RESPONSE_ERROR =
  "The service returned an XML error instead of features. Check the layer name and output format.";

/**
 * Error thrown when a GetFeature response body is XML that is not a GML feature
 * collection.
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

// The GML format each WFS version names as its GetFeature default, tried after
// every GeoJSON alias so a GML-only server (MapServer without OGR output, most
// INSPIRE services) still loads (issue #2746). Naming it, rather than only
// omitting outputFormat, gives the caller a token to persist and reuse.
const WFS_DEFAULT_GML_OUTPUT_FORMATS: Record<string, string> = {
  "2": "application/gml+xml; version=3.2",
  "1.1": "text/xml; subtype=gml/3.1.1",
  "1.0": "GML2",
};

function defaultGmlOutputFormat(version: string): string {
  const key = Object.keys(WFS_DEFAULT_GML_OUTPUT_FORMATS).find((prefix) =>
    version.startsWith(prefix),
  );
  return key ? WFS_DEFAULT_GML_OUTPUT_FORMATS[key] : "";
}

export function createWfsGetFeatureUrl(options: {
  endpoint: string;
  typeName: string;
  version: string;
  outputFormat: string;
  srsName: string;
  maxFeatures?: string;
  bbox?: [number, number, number, number];
}): string {
  const isWfs2 = options.version.startsWith("2");
  const params: Array<[string, string]> = [
    ["service", "WFS"],
    ["request", "GetFeature"],
    ["version", options.version],
    [isWfs2 ? "typeNames" : "typeName", options.typeName],
  ];

  // An empty format is omitted, which asks the server for its default (GML).
  if (options.outputFormat) params.push(["outputFormat", options.outputFormat]);

  if (options.srsName) params.push(["srsName", options.srsName]);
  if (options.maxFeatures) {
    params.push([isWfs2 ? "count" : "maxFeatures", options.maxFeatures]);
  }
  if (options.bbox) {
    const [west, south, east, north] = options.bbox;
    const bbox = options.version.startsWith("1.0")
      ? `${west},${south},${east},${north},EPSG:4326`
      : `${south},${west},${north},${east},urn:ogc:def:crs:EPSG::4326`;
    params.push(["bbox", bbox]);
  }

  return appendQuery(options.endpoint, params);
}

/** A fetched body plus the parts of the response the parsers need. */
interface FetchedText {
  ok: boolean;
  status: number;
  contentType: string | null;
  text: string;
}

/**
 * @param url - The GeoJSON (or WFS GetFeature) URL.
 * @param options - `useWfsProxy` marks a WFS request that must get past CORS:
 *   under the Vite dev server it goes through the dev proxy, and in the
 *   desktop app through the native HTTP client (WFS servers, MapServer and
 *   INSPIRE services especially, often send no CORS headers).
 *   `useCswProxy` routes a CSW resource through its dev proxy.
 * @returns The features, from GeoJSON or a GML feature collection.
 */
export async function fetchGeoJsonFeatureCollection(
  url: string,
  options: {
    useWfsProxy?: boolean;
    useCswProxy?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<FeatureCollection> {
  // Combine signals so a caller-supplied signal does not drop the timeout.
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let response: FetchedText;
  try {
    response = await fetchText(url, options, signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("The request timed out.");
    }
    throw error;
  }
  const { text } = response;
  if (!response.ok && !/^\s*</.test(text)) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  if (/^\s*</.test(text)) {
    const isHtml = looksLikeHtmlResponse(text, response.contentType);
    // A GML feature collection is features, whatever outputFormat was asked
    // for (some servers ignore it). Its CRS comes from the document, falling
    // back to the srsName the request asked for, and any EPSG CRS is
    // reprojected (MapServer's WFS 1.0.0 ignores srsName and answers in its
    // native grid).
    if (!isHtml && looksLikeGmlFeatureCollection(text)) {
      // Attribute-only features keep a null geometry, exactly as they arrive
      // from a GeoJSON response (parseGeoJsonFeatureCollection passes those
      // through too), so both formats reach the layer the same way.
      return (await parseGmlWithReprojection(text, {
        defaultSrsName: requestSrsName(url),
      })) as FeatureCollection;
    }
    throw new WfsXmlResponseError(isHtml);
  }
  const collection = parseGeoJsonFeatureCollection(JSON.parse(text));
  const arcGis = options.useWfsProxy ? arcGisAxisCheckRequest(url) : null;
  return arcGis ? repairArcGisAxisOrder(collection, arcGis, options, signal) : collection;
}

type FetchRouting = {
  useWfsProxy?: boolean;
  useCswProxy?: boolean;
};

// The transport for a request: the native client for a WFS request on desktop,
// otherwise the browser fetch (through the dev proxy under Vite).
function fetchText(url: string, options: FetchRouting, signal: AbortSignal): Promise<FetchedText> {
  if (options.useWfsProxy && isTauri() && isHttpUrl(url)) {
    return fetchNativeText(url, signal);
  }
  return fetchBrowserText(
    options.useWfsProxy
      ? proxyWfsRequestUrl(url)
      : options.useCswProxy
        ? proxyCswRequestUrl(url)
        : url,
    signal,
  );
}

// Capabilities documents fetched for the ArcGIS axis check, per URL, so a
// refresh interval does not re-download them every tick. A failure is dropped
// from the cache (the next load retries) and leaves the data as written.
const capabilitiesCache = new Map<string, Promise<string | null>>();

// An ArcGIS WFSServer may answer GeoJSON in lat/lon (see wfs-axis-order.ts).
// Coordinates valid only one way round decide it on their own; otherwise the
// feature type's WGS84BoundingBox from GetCapabilities does.
async function repairArcGisAxisOrder(
  collection: FeatureCollection,
  request: ArcGisWfsRequest,
  options: FetchRouting,
  signal: AbortSignal,
): Promise<FeatureCollection> {
  const extent = coordinateExtent(collection);
  if (!extent) return collection;
  let bbox = null;
  if (axisOrderIsAmbiguous(extent)) {
    let capabilities = capabilitiesCache.get(request.capabilitiesUrl);
    if (!capabilities) {
      const url = request.capabilitiesUrl;
      capabilities = fetchText(url, options, signal).then(
        (response) => {
          if (response.ok) return response.text;
          capabilitiesCache.delete(url);
          return null;
        },
        () => {
          capabilitiesCache.delete(url);
          return null;
        },
      );
      capabilitiesCache.set(request.capabilitiesUrl, capabilities);
    }
    const text = await capabilities;
    bbox = text ? wgs84BoundingBox(text, request.typeName) : null;
  }
  return shouldSwapAxes(extent, bbox) ? swapAxes(collection) : collection;
}

async function fetchBrowserText(requestUrl: string, signal: AbortSignal): Promise<FetchedText> {
  const response = await fetch(requestUrl, { signal });
  const contentType = response.headers.get("content-type");
  return {
    ok: response.ok,
    status: response.status,
    contentType,
    text: decodeBody(new Uint8Array(await response.arrayBuffer()), contentType),
  };
}

// The native client ignores CORS and, unlike fetch_url_bytes, keeps the body of
// a non-2xx answer: a WFS rejects an unsupported outputFormat with an
// ExceptionReport on a 400, and the format fallback has to read it. The Rust
// call cannot be cancelled mid-flight, so it is raced against the signal.
async function fetchNativeText(url: string, signal: AbortSignal): Promise<FetchedText> {
  const { fetchUrlResponse } = await import("./native-http");
  const pending = fetchUrlResponse(url, {
    context: "WFS GetFeature",
    timeoutSecs: Math.ceil(FETCH_TIMEOUT_MS / 1000),
    maxBytes: WFS_MAX_RESPONSE_BYTES,
  });
  // If the abort wins the race, the native call is left unobserved; swallow
  // its later rejection (the wrapper still logs it to diagnostics).
  pending.catch(() => {});
  const response = await Promise.race([pending, rejectOnAbort(signal)]);
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    contentType: response.contentType,
    text: decodeBody(response.body, response.contentType),
  };
}

// XML honors a charset declared only in its prolog (legacy Latin-2 GML, say);
// anything else is decoded with the header charset, defaulting to UTF-8.
function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const charset = charsetFromContentType(contentType);
  const head = new TextDecoder("ascii").decode(bytes.subarray(0, 64));
  if (/^\s*</.test(head)) return decodeXmlBytes(bytes, charset);
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

// The srsName query parameter of a GetFeature URL, matched case-insensitively.
function requestSrsName(url: string): string | undefined {
  try {
    for (const [key, value] of new URL(url, "http://localhost").searchParams) {
      if (key.toLowerCase() === "srsname" && value) return value;
    }
  } catch {
    // Not a parseable URL; the document's own srsName still applies.
  }
  return undefined;
}

/**
 * Fetches a WFS GetFeature response as GeoJSON, retrying with alternate
 * output-format tokens when the server answers the requested format with an
 * XML exception. ArcGIS Server, for example, does not honor the usual
 * `application/json` and instead advertises its GeoJSON output as `GEOJSON`;
 * a plain fetch of `application/json` returns XML and the layer fails to load.
 * Retrying the known GeoJSON aliases makes such services load transparently.
 * When no GeoJSON alias works, the version's default GML format is requested
 * and then no outputFormat at all, and the GML is converted in the browser, so
 * a GML-only server loads too. A GML feature collection returned for any
 * request is accepted as-is.
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
 *   tried first, then the remaining GeoJSON aliases, then GML; an empty
 *   requested format is skipped so no `outputFormat=` request is issued ahead
 *   of the aliases.
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
    bbox?: [number, number, number, number];
  },
  options: { useWfsProxy?: boolean; signal?: AbortSignal } = {},
): Promise<{ data: FeatureCollection; url: string; outputFormat: string }> {
  const requested = params.outputFormat.trim();
  // Try the user's requested format first (when non-empty), then the remaining
  // GeoJSON aliases (case-insensitively deduped so a token is not requested
  // twice). An empty requested format is dropped rather than sent as
  // `outputFormat=`.
  const geoJsonPhase = [
    ...(requested ? [requested] : []),
    ...WFS_GEOJSON_OUTPUT_FORMATS.filter(
      (format) => format.toLowerCase() !== requested.toLowerCase(),
    ),
  ];
  // The GML fallbacks come last: the version's default GML token, then no
  // outputFormat at all (the server's default, which is GML).
  const gmlFormat = defaultGmlOutputFormat(params.version);
  const gmlPhase = [
    ...(gmlFormat && gmlFormat.toLowerCase() !== requested.toLowerCase() ? [gmlFormat] : []),
    "",
  ];

  // One deadline shared across every attempt of a phase, so N slow rejections
  // cannot stack N separate timeouts. The GML phase gets a fresh one: GML is
  // several times larger than GeoJSON (the Polish PRG voivodeships are 8.5 MB
  // and take ~27 s), so it must not inherit a budget the rejected GeoJSON
  // attempts already spent. Combined with the caller's signal (if any) and
  // passed down; fetchGeoJsonFeatureCollection ANDs its own per-call timeout on
  // top, but these budgets are what bound the total wall time.
  const phaseSignal = () => {
    const budget = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    return options.signal ? AbortSignal.any([options.signal, budget]) : budget;
  };
  const geoJsonSignal = phaseSignal();
  let gmlSignal: AbortSignal | undefined;
  const candidates = [
    ...geoJsonPhase.map((outputFormat) => ({ outputFormat, gml: false })),
    ...gmlPhase.map((outputFormat) => ({ outputFormat, gml: true })),
  ];

  let lastError: unknown;
  for (const { outputFormat, gml } of candidates) {
    const signal = gml ? (gmlSignal ??= phaseSignal()) : geoJsonSignal;
    const url = createWfsGetFeatureUrl({ ...params, outputFormat });
    const attempt = () => fetchGeoJsonFeatureCollection(url, { ...options, signal });
    try {
      // One retry for a dropped connection: some WFS servers (the Polish PRG
      // service among them) reset a share of connections outright, and the
      // fallback sends up to eight requests in a row.
      const data = await attempt().catch((error: unknown) => {
        if (!isTransientTransportError(error) || signal.aborted) throw error;
        return attempt();
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

/**
 * Whether a request failed at the connection level, where the same request may
 * well succeed a moment later: a network failure as `classifyFetchFailure`
 * defines it (the browser's opaque fetch rejection, a native connection reset),
 * reqwest's generic "error sending request" (its message hides the reset
 * behind it), or a gateway (the dev proxy included) answering 502 / 503 / 504.
 * Timeouts are excluded, since they have already spent the budget, and so is
 * any other TypeError, which is a bug rather than a flaky network.
 *
 * @param error - The failure from one GetFeature attempt.
 * @returns True when one retry is worthwhile.
 */
export function isTransientTransportError(error: unknown): boolean {
  if (classifyFetchFailure(error).kind === "network") return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /error sending request/i.test(message) || /^Request failed with status 50[234]\b/.test(message)
  );
}

/** The reloaded features, plus any layer metadata the refresh itself updates. */
export interface GeoJsonRefreshResult {
  geojson: FeatureCollection;
  featureCount: number;
  /**
   * Metadata keys the refresh recomputed, merged over the layer's existing
   * metadata by the caller. Only the source kinds that carry request state
   * beyond the feature count (currently OGC API - Features, whose
   * `numberMatched`/`truncated` would otherwise stay at the values from when
   * the layer was added) return anything here.
   */
  metadata?: Record<string, unknown>;
}

export async function refreshGeoJsonLayer(layer: GeoLibreLayer): Promise<GeoJsonRefreshResult> {
  const sourceUrl = refreshSourceUrl(layer);
  if (!sourceUrl) {
    throw new Error("This layer does not have a refreshable GeoJSON URL.");
  }

  // GeoRSS feeds are XML, so re-fetch and re-parse them instead of routing
  // through the GeoJSON fetch path (which would reject the XML response).
  if (isGeoRssLayer(layer)) {
    return refreshGeoRssLayer(sourceUrl);
  }

  // An OGC API - Features layer was loaded by walking the service's `next`
  // links, so re-fetching the stored URL alone would silently shrink it to the
  // first page. Replay the same paged request instead.
  if (isOgcFeaturesLayer(layer)) {
    return refreshOgcFeaturesLayer(layer);
  }

  // Same story for an ArcGIS feature layer: its stored URL is the unbounded
  // `where=1=1` query, which truncates at the service's record limit (or fails
  // outright on a large layer). Replay the paged download.
  if (isArcGISFeatureLayer(layer)) {
    return refreshArcGISLayer(layer);
  }

  const data = await fetchGeoJsonFeatureCollection(sourceUrl, {
    useWfsProxy: isWfsLayer(layer),
    // A catalog's GeoJSON resource is usually a third-party host with no CORS
    // headers, the same reason the CSW source fetches it through the proxy.
    useCswProxy: layer.metadata.sourceKind === CSW_SOURCE_KIND,
  });

  return {
    geojson: data,
    featureCount: data.features.length,
  };
}

/**
 * Re-runs an OGC API - Features layer's paged items request from the parameters
 * stored on its source, so a refresh reloads the whole slice the layer was
 * added with.
 *
 * A layer saved before these parameters existed (or hand-edited) may carry only
 * the items URL; that case falls back to a plain single-page fetch of it, which
 * is still better than failing the refresh outright.
 *
 * @param layer - The OGC API - Features layer to reload.
 * @returns The reloaded features, their count, and the refreshed paging metadata.
 */
async function refreshOgcFeaturesLayer(layer: GeoLibreLayer): Promise<GeoJsonRefreshResult> {
  const source = layer.source as {
    url?: unknown;
    baseUrl?: unknown;
    collectionId?: unknown;
    maxFeatures?: unknown;
    bbox?: unknown;
    datetime?: unknown;
    extraQuery?: unknown;
  };
  const baseUrl = typeof source.baseUrl === "string" ? source.baseUrl : "";
  const collectionId = typeof source.collectionId === "string" ? source.collectionId : "";
  if (!baseUrl || !collectionId) {
    const url = layerHttpUrl(layer);
    if (!url) throw new Error("This layer does not have a refreshable GeoJSON URL.");
    const data = await fetchGeoJsonFeatureCollection(url);
    // No metadata patch: this path reads a single page with no `numberMatched`
    // to compare against, so it cannot say whether the collection is truncated.
    // Leaving the stored values alone beats overwriting them with a guess.
    return { geojson: data, featureCount: data.features.length };
  }
  // Imported here rather than at module scope so this module stays light for
  // the callers that only read refresh metadata.
  const { fetchOgcFeatureItems } = await import("./ogc-api-features");
  const maxFeatures =
    typeof source.maxFeatures === "number" && Number.isFinite(source.maxFeatures)
      ? source.maxFeatures
      : DEFAULT_OGC_FEATURES_REFRESH_MAX;
  const result = await fetchOgcFeatureItems({
    baseUrl,
    collectionId,
    extraQuery: typeof source.extraQuery === "string" ? source.extraQuery : undefined,
    maxFeatures,
    bbox: typeof source.bbox === "string" ? source.bbox : undefined,
    datetime: typeof source.datetime === "string" ? source.datetime : undefined,
  });
  return {
    geojson: result.data,
    featureCount: result.data.features.length,
    // Both are always written, `numberMatched` even when the service stopped
    // advertising one, so the layer reports this fetch rather than the counts
    // it was originally added with.
    metadata: { numberMatched: result.numberMatched, truncated: result.truncated },
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
 * the store-GeoJSON path. Covers both GeoJSON and tile render modes, and the
 * layers GeoLibre adopted from the control: the control reads any format the
 * panel loads (GeoParquet, FlatGeobuf, ...), which the plain GeoJSON fetch
 * cannot.
 *
 * @param layer - The store layer to test.
 * @returns Whether the layer refreshes through the vector control.
 */
export function isVectorControlRefreshLayer(layer: GeoLibreLayer): boolean {
  const kind = layer.metadata.sourceKind;
  return (
    ((kind === VECTOR_CONTROL_SOURCE_KIND && layer.metadata.externalNativeLayer === true) ||
      kind === ADOPTED_VECTOR_SOURCE_KIND) &&
    layerHttpUrl(layer) !== null
  );
}

/**
 * True when the "clear the layer on refresh failure" policy can actually be
 * honored for this layer. Clearing works by writing an empty FeatureCollection
 * into `layer.geojson`, which vector-control layers never populate — their
 * features live in the external control's own sources and are mirrored into the
 * store only as metadata. Offering the option there would silently do nothing,
 * so the refresh-settings dialog hides it for those layers.
 *
 * @param layer - The store layer to test.
 * @returns Whether a failure policy other than "keep-last" takes effect.
 */
export function supportsRefreshFailurePolicy(layer: GeoLibreLayer): boolean {
  // An adopted layer holds its features in `geojson`, so clearing works there.
  return (
    !isVectorControlRefreshLayer(layer) || layer.metadata.sourceKind === ADOPTED_VECTOR_SOURCE_KIND
  );
}

/** Whether clear-on-failure applies; MSSQL recovery reads keep local features. */
function shouldClearGeoJsonOnRefreshFailure(
  layer: {
    connection?: { onFailure?: string };
    geojson?: FeatureCollection | null;
  },
  mssqlRecoveryRefresh: boolean,
  hasPendingEdits: boolean,
): boolean {
  return (
    !mssqlRecoveryRefresh &&
    layer.connection?.onFailure === "clear" &&
    Boolean(layer.geojson) &&
    !hasPendingEdits
  );
}

export function isRefreshableLayer(layer: GeoLibreLayer): boolean {
  return (
    Boolean(refreshSourceUrl(layer)) ||
    isVectorControlRefreshLayer(layer) ||
    // A SQL Server write whose outcome or generated keys are unknown needs manual recovery.
    layer.mssqlWritebackPending === true ||
    // SQL query layers refresh by re-executing their stored DuckDB statement
    // (see refreshSqlQueryLayer) rather than fetching a URL.
    isSqlQueryLayer(layer) ||
    // Iceberg layers refresh by re-running their stored scan (see
    // refreshIcebergLayer) — on demand only, see supportsAutoRefresh.
    isIcebergLayer(layer)
  );
}

/**
 * Whether a refreshable layer may also be refreshed on a *timer*.
 *
 * Everything refreshable qualifies except Iceberg layers: an Iceberg scan reads
 * a table whose size is the whole reason the load is row-capped in the first
 * place, so re-running it every N seconds would re-download and re-render a
 * large dataset behind the user's back. Those layers keep the manual Refresh
 * action and lose only the interval. Callers must gate both the scheduling and
 * the auto-refresh settings UI on this, not just default the interval to off.
 *
 * @param layer The store layer to test.
 * @returns Whether an automatic refresh interval may be scheduled for it.
 */
export function supportsAutoRefresh(layer: GeoLibreLayer): boolean {
  return !isIcebergLayer(layer) && layer.mssqlWritebackPending !== true;
}

export function getLayerRefreshConfig(layer: GeoLibreLayer): LayerRefreshConfig {
  if (layer.connection) {
    const seconds = layer.connection.interval;
    const converted =
      typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
    const intervalMs =
      converted > 0 && Number.isFinite(converted)
        ? Math.max(MIN_REFRESH_INTERVAL_MS, converted)
        : 0;
    return { enabled: intervalMs > 0, intervalMs };
  }
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
    connection: {
      layerId: layer.id,
      interval: enabled ? config.intervalMs / 1000 : null,
      lastSyncedAt: layer.connection?.lastSyncedAt ?? null,
      lastError: layer.connection?.lastError ?? null,
      onFailure: layer.connection?.onFailure ?? "keep-last",
    },
    metadata: enabled
      ? {
          ...restMetadata,
          refresh: { enabled: true, intervalMs: config.intervalMs },
        }
      : restMetadata,
  };
}

/** Return a layer patch that records the outcome of a synchronization. */
export function setLayerConnectionResult(
  layer: GeoLibreLayer,
  result: { syncedAt?: string; error?: string | null },
): Partial<GeoLibreLayer> {
  const config = getLayerRefreshConfig(layer);
  return {
    connection: {
      layerId: layer.id,
      interval: config.enabled ? config.intervalMs / 1000 : null,
      lastSyncedAt: result.syncedAt ?? layer.connection?.lastSyncedAt ?? null,
      lastError: result.error === undefined ? (layer.connection?.lastError ?? null) : result.error,
      onFailure: layer.connection?.onFailure ?? "keep-last",
    },
  };
}

/** Build the layer patch for a failed refresh, preserving recovery data when required. */
export function getRefreshFailureLayerPatch(
  layer: GeoLibreLayer,
  error: string,
  mssqlRecoveryRefresh: boolean,
  hasPendingEdits: boolean,
): Partial<GeoLibreLayer> {
  return {
    ...setLayerConnectionResult(layer, { error }),
    ...(shouldClearGeoJsonOnRefreshFailure(layer, mssqlRecoveryRefresh, hasPendingEdits)
      ? { geojson: { type: "FeatureCollection" as const, features: [] } }
      : {}),
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

/**
 * The http(s) URL a GeoJSON layer's features can be fetched again from, or null
 * when the layer has none or is a kind that refreshes another way.
 *
 * @param layer - A store layer.
 * @returns The URL to re-fetch, or null.
 */
export function refreshSourceUrl(layer: GeoLibreLayer): string | null {
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

/**
 * Re-runs an ArcGIS feature layer's paged query from the parameters stored on
 * its source, so a refresh reloads every feature the layer was added with
 * rather than the first page the unbounded query happens to return.
 *
 * A layer saved before those parameters existed carries only the query URL;
 * that case derives the endpoint from the stored URL, which is the same
 * `/query` path with the unbounded parameters that get replaced anyway.
 *
 * A layer that is loading by viewport is the exception: it only ever holds the
 * current extent, so replaying the unbounded download here would swap the whole
 * service in behind the user's back until the next `moveend` — the very cost
 * viewport loading avoids. Those refresh by re-running the bounded query.
 *
 * @param layer - The ArcGIS feature layer to reload.
 * @returns The reloaded features and their count.
 */
async function refreshArcGISLayer(layer: GeoLibreLayer): Promise<GeoJsonRefreshResult> {
  const source = layer.source as {
    arcgisQueryUrl?: unknown;
    maxFeatures?: unknown;
    pageSize?: unknown;
  };
  // Imported here rather than at module scope so this module stays light for
  // the callers that only read refresh metadata.
  const { refreshArcGISFeatureLayer, reloadArcGISViewportLayer } =
    await import("@geolibre/plugins");
  if (layer.metadata.viewportLoading === true) {
    const viewport = reloadArcGISViewportLayer(layer.id);
    // No loader at all: the layer is in a host with no map (`restoreArcGISViewportLayers`
    // registers one synchronously wherever there is one). Falling through to
    // the unbounded replay below would download the entire service — the cost
    // this layer is loaded by viewport to avoid — so say so instead.
    if (!viewport) {
      throw new Error("This layer is not bound to a map viewport, so it cannot be refreshed.");
    }
    const bounded = await viewport;
    return { geojson: bounded, featureCount: bounded.features.length };
  }

  const stored = typeof source.arcgisQueryUrl === "string" ? source.arcgisQueryUrl.trim() : "";
  // Fall back to the layer's own URL, stripped of its query string: it is the
  // `/query` endpoint the paged fetch wants, just with the parameters attached.
  const queryUrl = stored || (layerHttpUrl(layer) ?? "").split("?")[0];
  if (!queryUrl) throw new Error("This layer does not have a refreshable GeoJSON URL.");

  const data = await refreshArcGISFeatureLayer({
    layerId: layer.id,
    maxFeatures: typeof source.maxFeatures === "number" ? source.maxFeatures : undefined,
    pageSize: typeof source.pageSize === "number" ? source.pageSize : undefined,
    queryUrl,
  });
  return { geojson: data, featureCount: data.features.length };
}

function isArcGISFeatureLayer(layer: GeoLibreLayer): boolean {
  return layer.metadata.sourceKind === ARCGIS_FEATURE_SOURCE_KIND;
}

function isGeoRssLayer(layer: GeoLibreLayer): boolean {
  return layer.metadata.sourceKind === GEORSS_SOURCE_KIND;
}

function isOgcFeaturesLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.metadata.sourceKind === OGC_FEATURES_SOURCE_KIND ||
    layer.metadata.service === "ogc-features" ||
    layer.source.service === "ogc-features"
  );
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
  // Relative endpoints already target the app's origin; the CORS proxy only
  // accepts absolute HTTP(S) targets.
  return isViteDevServer() && isHttpUrl(url)
    ? `${WFS_PROXY_PATH}?url=${encodeURIComponent(url)}`
    : url;
}

function proxyCswRequestUrl(url: string): string {
  return isViteDevServer() ? `${CSW_PROXY_PATH}?url=${encodeURIComponent(url)}` : url;
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
