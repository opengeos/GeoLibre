/**
 * Pure helpers shared by the Add Data dialog sources: layer construction,
 * URL building, parsing/validation, and PostgreSQL connection persistence.
 */

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { TFunction } from "i18next";
import { classifyFetchFailure } from "../../../lib/fetch-error";
import { isTauri } from "../../../lib/is-tauri";
import {
  DELIMITED_TEXT_DELIMITERS,
  EOX_S2CLOUDLESS_ATTRIBUTION,
  GPX_PROXY_PATH,
  WFS_PROXY_PATH,
  WMS_PROXY_PATH,
} from "./constants";
import type { DelimitedTextDelimiter } from "./types";

export function createLayerId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

export function layerNameFromPath(path: string, fallback: string): string {
  return fileNameFromPath(path).replace(/\.[^.]+$/, "") || fallback;
}

export function createBaseLayer(
  name: string,
  type: GeoLibreLayer["type"],
  source: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): GeoLibreLayer {
  return {
    id: createLayerId(),
    name,
    type,
    source,
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata,
  };
}

/**
 * Attribution required for known keyless tile hosts whose license mandates a
 * credit (currently EOX Sentinel-2 cloudless, CC BY 4.0). Returns the
 * attribution string for a recognized host so the tile layer credits its source
 * in MapLibre's attribution control, or `undefined` for unrecognized/invalid
 * URLs.
 */
export function attributionForTileUrl(url: string): string | undefined {
  try {
    const { hostname, href } = new URL(url);
    // Key off the EOX host + Sentinel-2 cloudless layer id rather than one exact
    // hostname, so a pasted URL on another eox.at subdomain still carries the
    // required CC BY 4.0 credit. The `.eox.at` suffix (with the bare-domain
    // case) avoids matching lookalike hosts like `evil-eox.at`.
    const isEoxHost = hostname === "eox.at" || hostname.endsWith(".eox.at");
    if (isEoxHost && href.includes("s2cloudless")) {
      return EOX_S2CLOUDLESS_ATTRIBUTION;
    }
  } catch {
    // Relative or malformed URL — no known attribution to attach.
  }
  return undefined;
}

export function appendQuery(
  endpoint: string,
  params: Array<[string, string]>,
): string {
  const separator = endpoint.includes("?")
    ? endpoint.endsWith("?") || endpoint.endsWith("&")
      ? ""
      : "&"
    : "?";
  const query = params
    .map(([key, value]) => {
      const encodedValue =
        value === "{bbox-epsg-3857}" ? value : encodeURIComponent(value);
      return `${encodeURIComponent(key)}=${encodedValue}`;
    })
    .join("&");
  return `${endpoint}${separator}${query}`;
}

/**
 * Normalizes a WMS version to one of the two protocol variants the GetMap
 * builder emits: anything in the 1.3 line is "1.3.0", everything else (an
 * unset value, or a non-string from an untyped JS plugin) falls back to
 * "1.1.1".
 */
export function normalizeWmsVersion(version: unknown): string {
  return typeof version === "string" && version.trim().startsWith("1.3")
    ? "1.3.0"
    : "1.1.1";
}

export function createWmsTileUrl(options: {
  endpoint: string;
  layers: string;
  styles: string;
  format: string;
  transparent: boolean;
  tileSize: number;
  /** WMS protocol version, "1.1.1" (default) or "1.3.0". */
  version?: string;
}): string {
  // WMS 1.3.0 renames the SRS parameter to CRS; a 1.3.0-only server (e.g. the
  // IGN Géoplateforme raster endpoint) rejects a 1.1.1 request outright with
  // VersionNegotiationFailed. EPSG:3857 keeps easting/northing axis order in
  // both versions, so the BBOX template is unchanged.
  const version = normalizeWmsVersion(options.version);
  return appendQuery(options.endpoint, [
    ["SERVICE", "WMS"],
    ["REQUEST", "GetMap"],
    ["VERSION", version],
    ["LAYERS", options.layers],
    ["STYLES", options.styles],
    ["FORMAT", options.format],
    ["TRANSPARENT", options.transparent ? "TRUE" : "FALSE"],
    [version === "1.3.0" ? "CRS" : "SRS", "EPSG:3857"],
    ["BBOX", "{bbox-epsg-3857}"],
    ["WIDTH", String(options.tileSize)],
    ["HEIGHT", String(options.tileSize)],
  ]);
}

/**
 * Reads the WMS version from a `VERSION` query parameter the user left on a
 * pasted service URL, so the Add Data form can preselect it before the
 * parameter is stripped from the endpoint. Returns null when the URL carries
 * no recognizable version.
 */
export function wmsVersionFromEndpoint(endpoint: string): string | null {
  const match = /[?&]version=([^&#]+)/i.exec(endpoint);
  if (!match) return null;
  let value: string;
  try {
    value = decodeURIComponent(match[1]).trim();
  } catch {
    return null;
  }
  // Recognize any 1.x value so detection agrees with normalizeWmsVersion's
  // bucketing (e.g. a rare VERSION=1.2.0 lands in the 1.1.1 bucket rather
  // than being silently ignored).
  if (!/^1\.\d/.test(value)) return null;
  return normalizeWmsVersion(value);
}

export function parseRequiredNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Enter a numeric ${label}.`);
  }
  return parsed;
}

export function parseOptionalNumber(
  value: string,
  label: string,
): number | undefined {
  if (!value.trim()) return undefined;
  return parseRequiredNumber(value, label);
}

/** Parse a `"longitude, latitude"` corner string into a [lng, lat] pair. */
export function parseVideoCorner(value: string, label: string): [number, number] {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 2) {
    throw new Error(`Enter the ${label} corner as "longitude, latitude".`);
  }
  const lng = parseRequiredNumber(parts[0], `${label} longitude`);
  const lat = parseRequiredNumber(parts[1], `${label} latitude`);
  if (lng < -180 || lng > 180) {
    throw new Error(`${label} longitude must be between -180 and 180.`);
  }
  if (lat < -90 || lat > 90) {
    throw new Error(`${label} latitude must be between -90 and 90.`);
  }
  return [lng, lat];
}

// PostgreSQL connection persistence lives in lib/ (pure data utilities also
// consumed by the PostGIS layer connection registry); re-exported here so the
// Add Data sources keep a single helpers import.
export {
  readSavedPostgresConnections,
  rememberPostgresConnection,
  savedPostgresConnectionLabel,
  uniquePostgresConnections,
} from "../../../lib/saved-postgres-connections";

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

/**
 * Builds a translated, user-facing message for a failed service request in the
 * Add Data forms. A network/TLS/CORS or timeout failure (the ones the browser
 * or native path report opaquely) maps to a localized hint; anything else keeps
 * the error's own message so a service exception or status text still shows
 * through. This routes the fetch-error classification through `t()` so the form
 * does not surface an untranslated string next to its localized labels.
 */
export function serviceRequestErrorMessage(
  error: unknown,
  t: TFunction,
  fallback: string,
): string {
  const { kind } = classifyFetchFailure(error);
  if (kind === "network") return t("addData.common.networkFailure");
  if (kind === "timeout") return t("addData.common.requestTimedOut");
  return errorMessage(error, fallback);
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

/**
 * Routes a feed request through the dev-server CORS proxy when running under
 * Vite (so a `fetch()` for a remote GPX/GeoRSS file is not blocked by the
 * feed host's missing CORS headers). In production builds the URL is returned
 * unchanged. The proxy is generic; the `GPX_PROXY_PATH` name is historical.
 */
export function proxyFeedRequestUrl(url: string): string {
  return isViteDevServer()
    ? `${GPX_PROXY_PATH}?url=${encodeURIComponent(url)}`
    : url;
}

/**
 * Fetches an OGC service capabilities document as text, working around the
 * cross-origin restrictions that block a plain browser fetch of a WMS/WFS host
 * that omits CORS headers:
 * - Desktop (Tauri): fetched natively through the `fetch_url_bytes` command,
 *   which runs in Rust and is not subject to browser CORS, so any service works.
 * - Dev server (Vite): routed through the same-origin dev proxy.
 * - Hosted web build: a direct fetch, which only succeeds when the service
 *   sends `Access-Control-Allow-Origin`.
 *
 * @param requestUrl - The absolute GetCapabilities request URL.
 * @param devProxyPath - The dev-server proxy path to use under Vite.
 * @param signal - Optional abort signal.
 * @returns The response ok flag, status, and body text.
 */
async function fetchCapabilitiesText(
  requestUrl: string,
  devProxyPath: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; text: string }> {
  if (isTauri()) {
    // `fetch_url_bytes` rejects on a non-2xx status, so a resolved value is OK.
    // The Rust command has its own timeout and cannot be cancelled mid-flight,
    // but race it against the caller's abort + a 30s cap so this call still
    // returns promptly (matching the browser fetch branch below) rather than
    // hanging on a slow host or a superseded request.
    const { fetchUrlBytes } = await import("../../../lib/native-http");
    const timeout = AbortSignal.timeout(30_000);
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const bytesPromise = fetchUrlBytes(requestUrl, {
      context: "OGC GetCapabilities",
    });
    // If the abort/timeout wins the race, the native call is left unobserved;
    // swallow its later rejection so it does not surface as an unhandled
    // rejection (it is still recorded in diagnostics by the native-http wrapper).
    bytesPromise.catch(() => {});
    try {
      const bytes = await Promise.race([bytesPromise, rejectOnAbort(abort)]);
      const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      return { ok: true, status: 200, text: decodeXmlBytes(array) };
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error("The request timed out.");
      }
      throw error;
    }
  }
  const fetchUrl = isViteDevServer()
    ? `${devProxyPath}?url=${encodeURIComponent(requestUrl)}`
    : requestUrl;
  let response: Response;
  try {
    response = await fetch(fetchUrl, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("The request timed out.");
    }
    // A CORS rejection surfaces as a bare TypeError with no status. Point the
    // user at the workarounds instead of a cryptic "Failed to fetch".
    if (error instanceof TypeError) {
      throw new Error(
        "Could not reach the service. It may not allow cross-origin requests from the browser; try the desktop app or enter the layer name manually.",
      );
    }
    throw error;
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  const charset = charsetFromContentType(response.headers.get("content-type"));
  return {
    ok: response.ok,
    status: response.status,
    text: decodeXmlBytes(buffer, charset),
  };
}

/**
 * A promise that never resolves and rejects when the signal aborts (with its
 * abort reason, e.g. a `TimeoutError`). Used to race an uncancellable call
 * against a caller abort / timeout.
 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

/**
 * Decodes capabilities bytes to text, honoring a non-UTF-8 charset. The HTTP
 * `Content-Type` charset (when present) wins; otherwise the charset declared in
 * the XML prolog (`<?xml … encoding="ISO-8859-1"?>`) is used, defaulting to
 * UTF-8. `Response.text()` only honors the HTTP header, so both the browser and
 * the Tauri byte paths run through this to avoid mojibake from a legacy Latin-1
 * service that declares its charset only in the prolog.
 */
function decodeXmlBytes(bytes: Uint8Array, httpCharset?: string): string {
  // The prolog is ASCII, so decode a short head to read the declared charset.
  const head = new TextDecoder("ascii").decode(bytes.subarray(0, 256));
  const prologCharset = head.match(/encoding=["']([\w-]+)["']/i)?.[1];
  const label = httpCharset || prologCharset || "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Extracts the `charset` from a `Content-Type` header value, if any. */
function charsetFromContentType(contentType: string | null): string | undefined {
  return contentType?.match(/charset=["']?([\w-]+)/i)?.[1];
}

/**
 * Rewrites an endpoint's query string: removes the given operation parameters
 * and sets `extra`, leaving the path form untouched — absolute, root-relative,
 * route-relative (`geoserver/wms`), and protocol-relative (`//host/wms`) all
 * round-trip unchanged. Drops the `?` entirely when nothing remains.
 */
function rewriteEndpointQuery(
  endpoint: string,
  operationParams: ReadonlySet<string>,
  extra: Array<[string, string]>,
): string {
  const hashIndex = endpoint.indexOf("#");
  const withoutHash = hashIndex === -1 ? endpoint : endpoint.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : endpoint.slice(hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  const path = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1);

  const params = new URLSearchParams(rawQuery);
  for (const key of Array.from(params.keys())) {
    if (operationParams.has(key.toLowerCase())) params.delete(key);
  }
  for (const [key, value] of extra) params.set(key, value);
  const query = params.toString();
  return query ? `${path}?${query}${hash}` : `${path}${hash}`;
}

/**
 * Builds an OGC `GetCapabilities` request URL, stripping any operation
 * parameters already on the endpoint (e.g. a copied `REQUEST=GetMap`) so they
 * cannot collide with the ones added here.
 */
function buildCapabilitiesUrl(
  endpoint: string,
  service: "WMS" | "WFS",
  operationParams: ReadonlySet<string>,
  version?: string,
): string {
  const extra: Array<[string, string]> = [
    ["SERVICE", service],
    ["REQUEST", "GetCapabilities"],
  ];
  if (version) extra.push(["VERSION", version]);
  return rewriteEndpointQuery(endpoint, operationParams, extra);
}

/**
 * Strips the OGC operation parameters (SERVICE / REQUEST / VERSION / LAYERS /
 * typeName / outputFormat / BBOX / …) from a service endpoint, leaving a clean
 * base URL. A user commonly pastes a full `…?REQUEST=GetCapabilities` URL; these
 * leftover params must be removed before a GetMap / GetFeature URL is built on
 * top, or the duplicated (and conflicting) `REQUEST` makes the server answer the
 * wrong operation (e.g. returning capabilities XML instead of features).
 *
 * @param endpoint - The service endpoint as entered by the user.
 * @param service - Which operation-parameter set to strip.
 * @returns The endpoint with its OGC operation parameters removed.
 */
export function stripOgcOperationParams(
  endpoint: string,
  service: "WMS" | "WFS",
): string {
  const operationParams =
    service === "WMS" ? WMS_OPERATION_PARAMS : WFS_OPERATION_PARAMS;
  return rewriteEndpointQuery(endpoint, operationParams, []);
}

/** A single requestable (named) layer advertised by a WMS GetCapabilities. */
export interface WmsLayerOption {
  /** The layer's `<Name>` — the value passed as the WMS `LAYERS` parameter. */
  name: string;
  /** The layer's human-readable `<Title>`; falls back to the name if absent. */
  title: string;
}

/**
 * Builds a WMS `GetCapabilities` request URL from a service endpoint. Any WMS
 * operation parameters already present on the endpoint (e.g. a `REQUEST=GetMap`
 * left over from a copied GetMap URL) are stripped first so they cannot collide
 * with the `SERVICE`/`REQUEST` parameters this adds.
 *
 * @param endpoint - The WMS service base URL, with or without a query string.
 * @returns The GetCapabilities request URL.
 */
const WMS_OPERATION_PARAMS: ReadonlySet<string> = new Set([
  "service",
  "request",
  "version",
  "layers",
  "styles",
  "format",
  "transparent",
  "bbox",
  "width",
  "height",
  "srs",
  "crs",
]);

export function createWmsGetCapabilitiesUrl(endpoint: string): string {
  return buildCapabilitiesUrl(endpoint, "WMS", WMS_OPERATION_PARAMS);
}

/** The parts of a WMS GetCapabilities document the Add Data dialog uses. */
export interface WmsCapabilities {
  /** The named layers in document order, deduplicated by name. */
  layers: WmsLayerOption[];
  /**
   * The service's negotiated WMS version (the root element's `version`
   * attribute), or null when the document does not carry one. A 1.3.0-only
   * server reports it here, letting the form switch the GetMap version.
   */
  version: string | null;
}

/**
 * Extracts the requestable (named) layers and the negotiated version from a
 * WMS GetCapabilities document. Only `<Layer>` elements that carry their own
 * `<Name>` are requestable; the container layers that merely group others (a
 * `<Title>` but no `<Name>`) are skipped. Traversal is namespace-agnostic so
 * it handles both WMS 1.1.1 (`WMT_MS_Capabilities`) and 1.3.0
 * (`WMS_Capabilities`, default namespace).
 *
 * @param xmlText - The raw GetCapabilities XML response body.
 * @returns The named layers plus the document's version attribute.
 */
export function parseWmsCapabilities(xmlText: string): WmsCapabilities {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Could not parse the WMS capabilities document.");
  }
  // Validate the root element rather than trusting any XML that parses: an OWS
  // ServiceException or an HTML/proxy error page also parses, and returning its
  // (empty) layer list would mislead the UI into "No layers were found".
  const root = doc.documentElement;
  const rootName = root?.localName;
  if (rootName !== "WMS_Capabilities" && rootName !== "WMT_MS_Capabilities") {
    throw new Error(capabilitiesRootError(root, "WMS"));
  }

  const layers: WmsLayerOption[] = [];
  const seen = new Set<string>();
  // Every <Layer> in the document, at any nesting depth. Reading each one's own
  // direct <Name>/<Title> and deduplicating by name means the container layers
  // (which have no <Name>) are skipped without tracking the tree ourselves. The
  // "*" namespace wildcard covers both WMS 1.1.1 (no namespace) and 1.3.0
  // (default `http://www.opengis.net/wms` namespace).
  const layerElements = root.getElementsByTagNameNS("*", "Layer");
  for (let i = 0; i < layerElements.length; i += 1) {
    const layer = layerElements[i];
    const name = directChildText(layer, "Name");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    layers.push({ name, title: directChildText(layer, "Title") || name });
  }
  return { layers, version: root.getAttribute("version") };
}

/**
 * Reads the direct-child element with the given local name and returns its
 * trimmed text. Restricting to direct children keeps a `<Layer>`'s own `<Name>`
 * / `<Title>` from being confused with those nested inside its `<Style>` or
 * child `<Layer>` elements.
 */
function directChildText(element: Element, localName: string): string {
  for (const child of Array.from(element.children)) {
    if (child.localName === localName) return (child.textContent ?? "").trim();
  }
  return "";
}

/**
 * Builds an error message for a capabilities document whose root is not the
 * expected element. An OWS/OGC exception root carries a human-readable reason,
 * so surface it; anything else (e.g. an HTML error page) gets a generic note.
 */
function capabilitiesRootError(
  root: Element | null,
  service: "WMS" | "WFS",
): string {
  const rootName = root?.localName;
  const isException =
    rootName === "ServiceExceptionReport" ||
    rootName === "ServiceException" ||
    rootName === "ExceptionReport";
  if (isException) {
    // Cap the length: a service's exception body is rendered straight into the
    // error paragraph, and a misbehaving one could return a huge payload.
    const message = root?.textContent?.replace(/\s+/g, " ").trim().slice(0, 500);
    return message || `The ${service} service returned an error.`;
  }
  return `The response is not a ${service} capabilities document.`;
}

/**
 * Fetches a WMS service's GetCapabilities document and returns its requestable
 * layers plus the negotiated version. Works cross-origin in the desktop app
 * and dev server; in the hosted web build it relies on the service's own CORS
 * headers.
 *
 * @param endpoint - The WMS service base URL.
 * @param options - Optional abort signal.
 * @returns The named layers and version advertised by the service.
 */
export async function fetchWmsCapabilities(
  endpoint: string,
  options: { signal?: AbortSignal } = {},
): Promise<WmsCapabilities> {
  const requestUrl = createWmsGetCapabilitiesUrl(endpoint.trim());
  const { ok, status, text } = await fetchCapabilitiesText(
    requestUrl,
    WMS_PROXY_PATH,
    options.signal,
  );
  // A well-formed error body is still XML, so only treat a non-2xx as fatal
  // when the payload is not XML we can parse for a ServiceException message.
  if (!ok && !/^\s*</.test(text)) {
    throw new Error(`Request failed with status ${status}`);
  }
  return parseWmsCapabilities(text);
}

/** A single feature type advertised by a WFS GetCapabilities. */
export interface WfsFeatureTypeOption {
  /** The type's `<Name>` — the value passed as the WFS `typeName(s)` param. */
  name: string;
  /** The type's human-readable `<Title>`; falls back to the name if absent. */
  title: string;
}

/**
 * Builds a WFS `GetCapabilities` request URL from a service endpoint. Any WFS
 * operation parameters already present on the endpoint (e.g. a leftover
 * `REQUEST=GetFeature`) are stripped first so they cannot collide with the
 * `SERVICE`/`REQUEST` parameters this adds.
 *
 * @param endpoint - The WFS service base URL, with or without a query string.
 * @param version - Optional WFS version to request (e.g. "2.0.0").
 * @returns The GetCapabilities request URL.
 */
const WFS_OPERATION_PARAMS: ReadonlySet<string> = new Set([
  "service",
  "request",
  "version",
  "typename",
  "typenames",
  "outputformat",
  "srsname",
  "bbox",
  "count",
  "maxfeatures",
  "resulttype",
]);

export function createWfsGetCapabilitiesUrl(
  endpoint: string,
  version?: string,
): string {
  return buildCapabilitiesUrl(endpoint, "WFS", WFS_OPERATION_PARAMS, version);
}

/**
 * Extracts the advertised feature types from a WFS GetCapabilities document.
 * Reads each `<FeatureType>`'s own `<Name>`/`<Title>`. Traversal is
 * namespace-agnostic so WFS 1.0.0/1.1.0/2.0.0 all work.
 *
 * @param xmlText - The raw GetCapabilities XML response body.
 * @returns The feature types in document order, deduplicated by name.
 */
export function parseWfsCapabilitiesFeatureTypes(
  xmlText: string,
): WfsFeatureTypeOption[] {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Could not parse the WFS capabilities document.");
  }
  // Validate the root element (see parseWmsCapabilities) so an exception
  // or HTML error page surfaces an error instead of an empty type list.
  const root = doc.documentElement;
  if (root?.localName !== "WFS_Capabilities") {
    throw new Error(capabilitiesRootError(root, "WFS"));
  }

  const featureTypes: WfsFeatureTypeOption[] = [];
  const seen = new Set<string>();
  const elements = root.getElementsByTagNameNS("*", "FeatureType");
  for (let i = 0; i < elements.length; i += 1) {
    const element = elements[i];
    const name = directChildText(element, "Name");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    featureTypes.push({ name, title: directChildText(element, "Title") || name });
  }
  return featureTypes;
}

/**
 * Fetches a WFS service's GetCapabilities document and returns its feature
 * types. Works cross-origin in the desktop app and dev server; in the hosted
 * web build it relies on the service's own CORS headers.
 *
 * @param endpoint - The WFS service base URL.
 * @param options - Optional WFS version and abort signal.
 * @returns The feature types advertised by the service.
 */
export async function fetchWfsFeatureTypes(
  endpoint: string,
  options: { version?: string; signal?: AbortSignal } = {},
): Promise<WfsFeatureTypeOption[]> {
  const requestUrl = createWfsGetCapabilitiesUrl(endpoint.trim(), options.version);
  const { ok, status, text } = await fetchCapabilitiesText(
    requestUrl,
    WFS_PROXY_PATH,
    options.signal,
  );
  if (!ok && !/^\s*</.test(text)) {
    throw new Error(`Request failed with status ${status}`);
  }
  return parseWfsCapabilitiesFeatureTypes(text);
}

export function resolveDelimitedTextDelimiter(
  delimiter: DelimitedTextDelimiter,
  customDelimiter: string,
): string {
  if (delimiter !== "custom") return DELIMITED_TEXT_DELIMITERS[delimiter];
  return customDelimiter;
}

/** Recursively finds the first `[lng, lat]` pair in a GeoJSON coordinate array. */
function firstCoordinate(coords: unknown): [number, number] | null {
  if (!Array.isArray(coords)) return null;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") {
    return [coords[0], coords[1]];
  }
  for (const child of coords) {
    const found = firstCoordinate(child);
    if (found) return found;
  }
  return null;
}

/**
 * Flattens a GeoJSON FeatureCollection into `{ lng, lat, ...properties }` rows
 * so the 3D-model (scenegraph) layer can place a model at each feature. The
 * lon/lat come from each feature's geometry (its first coordinate), while the
 * properties remain available for the optional altitude/bearing/scale columns.
 *
 * @param geojson - The parsed FeatureCollection.
 * @returns One row per feature that has a usable coordinate.
 */
export function geoJsonToPointRows(
  geojson: FeatureCollection | undefined,
): Record<string, unknown>[] {
  if (!geojson) return [];
  const rows: Record<string, unknown>[] = [];
  for (const feature of geojson.features) {
    const coord = firstCoordinate(
      (feature.geometry as { coordinates?: unknown } | null)?.coordinates,
    );
    if (!coord) continue;
    rows.push({
      ...(feature.properties ?? {}),
      lng: coord[0],
      lat: coord[1],
    });
  }
  return rows;
}
