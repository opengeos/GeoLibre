import { formatPixelValue, type GeoLibreLayer } from "@geolibre/core";

// Identify sources other than rendered vector features: WMS GetFeatureInfo,
// the DuckDB and Time Slider plugin bridges, and pixel readings. Engine-neutral
// (a clicked lngLat, the camera zoom, a screen point), so the MapLibre and
// Mapbox canvases identify the same layers the same way.

const WMS_PROXY_PATH = "/__geolibre_wms_proxy";
const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;
const WEB_MERCATOR_EARTH_RADIUS = 6378137;
const WEB_MERCATOR_WORLD_SIZE = 2 * Math.PI * WEB_MERCATOR_EARTH_RADIUS;
const MAPLIBRE_TILE_SIZE = 512;
const WMS_IDENTIFY_QUERY_SIZE = 101;
const WMS_IDENTIFY_QUERY_CENTER = Math.floor(WMS_IDENTIFY_QUERY_SIZE / 2);
const WMS_IDENTIFY_INFO_FORMATS = ["application/json", "text/html", "text/plain"];

export interface DuckDBIdentifyBridgeResult {
  coordinate: [number, number] | null;
  featureId: string;
  properties: Record<string, unknown>;
}

export interface GeoLibreDuckDBBridge {
  getFeatureBounds?: (
    layerId: string,
    featureId: string,
  ) => [number, number, number, number] | null;
  identifyLayerAtPoint?: (
    layerId: string,
    point: { x: number; y: number },
  ) => DuckDBIdentifyBridgeResult | null;
  setSelectedFeature?: (layerId: string, featureId: string | null) => void;
}

/** One band's value at an identified pixel, from the Time Slider bridge. */
export interface TimeSliderBandReading {
  index: number;
  name: string | null;
  value: number;
  isNodata: boolean;
}

export interface TimeSliderPixelIdentifyBridgeResult {
  sourceId: string;
  date: string;
  url: string;
  bands: TimeSliderBandReading[];
}

export interface GeoLibreTimeSliderBridge {
  identifyPixelAt?: (
    sourceId: string,
    lngLat: [number, number],
    options?: { signal?: AbortSignal },
  ) => Promise<TimeSliderPixelIdentifyBridgeResult | null>;
}

export function isWmsLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "wms";
}

export function duckDBBridge(): GeoLibreDuckDBBridge | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as Window & { __GEOLIBRE_DUCKDB__?: GeoLibreDuckDBBridge }).__GEOLIBRE_DUCKDB__;
}

export function timeSliderBridge(): GeoLibreTimeSliderBridge | undefined {
  return typeof window === "undefined"
    ? undefined
    : (
        window as Window & {
          __GEOLIBRE_TIME_SLIDER__?: GeoLibreTimeSliderBridge;
        }
      ).__GEOLIBRE_TIME_SLIDER__;
}

/**
 * Whether Identify should read source pixel values for this layer rather than
 * query vector features. Set by the Time Slider for its COG/mosaic sources,
 * which resolve to a different file per timeline date.
 */
export function isPixelIdentifyLayer(layer: GeoLibreLayer): boolean {
  return layer.metadata.pixelIdentify === true;
}

/** Turn a pixel reading into the flat key/value rows the identify popup shows. */
export function pixelIdentifyProperties(
  result: TimeSliderPixelIdentifyBridgeResult,
): Record<string, unknown> {
  const properties: Record<string, unknown> = { Date: result.date };
  for (const band of result.bands) {
    // Prefer the COG's own band name, falling back to the 1-based index so
    // unnamed bands still get a stable, distinct row label.
    const key = band.name ?? `Band ${band.index}`;
    const formatted = formatPixelValue(band.value);
    properties[key] = band.isNodata ? `${formatted} (nodata)` : formatted;
  }
  return properties;
}

function stringSource(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function appendWmsQuery(endpoint: string, params: Array<[string, string]>): string {
  // Prefer URL parsing so our control parameters override any duplicates the
  // endpoint already carries (e.g. a pasted GetMap URL) and land before any
  // fragment, which the browser would otherwise strip along with the query.
  try {
    const url = new URL(endpoint);
    const controlKeys = new Set(params.map(([key]) => key.toLowerCase()));
    for (const existing of [...url.searchParams.keys()]) {
      if (controlKeys.has(existing.toLowerCase())) {
        url.searchParams.delete(existing);
      }
    }
    for (const [key, value] of params) {
      url.searchParams.append(key, value);
    }
    return url.toString();
  } catch {
    // Fall back to plain concatenation for non-absolute endpoints.
    const fragIdx = endpoint.indexOf("#");
    const base = fragIdx >= 0 ? endpoint.slice(0, fragIdx) : endpoint;
    const separator = base.includes("?")
      ? base.endsWith("?") || base.endsWith("&")
        ? ""
        : "&"
      : "?";
    const query = params
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    return `${base}${separator}${query}`;
  }
}

function lngLatToWebMercator(lng: number, lat: number): [number, number] {
  const clampedLat = Math.max(-WEB_MERCATOR_MAX_LATITUDE, Math.min(WEB_MERCATOR_MAX_LATITUDE, lat));
  const x = (WEB_MERCATOR_EARTH_RADIUS * (lng * Math.PI)) / 180;
  const y =
    WEB_MERCATOR_EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI) / 360));
  return [x, y];
}

function wmsIdentifyResolution(zoom: number): number {
  const normalizedZoom = Number.isFinite(zoom) ? Math.max(0, zoom) : 0;
  return WEB_MERCATOR_WORLD_SIZE / (MAPLIBRE_TILE_SIZE * 2 ** normalizedZoom);
}

function wmsIdentifyBbox3857(lngLat: [number, number], zoom: number): string {
  const [centerX, centerY] = lngLatToWebMercator(lngLat[0], lngLat[1]);
  const halfSpan = (WMS_IDENTIFY_QUERY_SIZE * wmsIdentifyResolution(zoom)) / 2;
  return [centerX - halfSpan, centerY - halfSpan, centerX + halfSpan, centerY + halfSpan].join(",");
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

// Only the Vite dev server proxies GetFeatureInfo requests (to dodge CORS in
// the browser). Production builds target the Tauri webview, which does not
// enforce same-origin restrictions, so the raw URL is used directly. A WMS
// server lacking CORS headers would fail if this app were ever hosted as a
// plain web page; such a deployment would need its own proxy.
function proxyWmsRequestUrl(url: string): string {
  return isViteDevServer() ? `${WMS_PROXY_PATH}?url=${encodeURIComponent(url)}` : url;
}

function createWmsGetFeatureInfoUrl(
  layer: GeoLibreLayer,
  lngLat: [number, number],
  zoom: number,
  infoFormat: string,
): string | null {
  const endpoint = stringSource(layer.source.url) ?? layer.sourcePath;
  const layers = stringSource(layer.source.layers);
  if (!endpoint || !layers) return null;

  const styles = stringSource(layer.source.styles) ?? "";
  const format = stringSource(layer.source.format) ?? "image/png";
  // WMS 1.3.0 renames the SRS parameter to CRS and the pixel coordinates from
  // X/Y to I/J. EPSG:3857 keeps easting/northing axis order across both
  // versions, so the BBOX layout is unchanged.
  const version = stringSource(layer.source.version) ?? "1.1.1";
  const isV13 = version.startsWith("1.3");
  const crsParam = isV13 ? "CRS" : "SRS";
  // Treat a deliberate featureCount of 0 ("all features" on some servers) as
  // intentional; only fall back to 1 when it is unset (null/undefined), blank,
  // or non-numeric. Number(null) and Number("") are both 0, so guard those.
  const featureCount =
    layer.source.featureCount != null && layer.source.featureCount !== ""
      ? Number(layer.source.featureCount)
      : NaN;

  return appendWmsQuery(endpoint, [
    ["SERVICE", "WMS"],
    ["REQUEST", "GetFeatureInfo"],
    ["VERSION", version],
    ["LAYERS", layers],
    ["QUERY_LAYERS", layers],
    ["STYLES", styles],
    ["FORMAT", format],
    ["TRANSPARENT", layer.source.transparent === false ? "FALSE" : "TRUE"],
    [crsParam, "EPSG:3857"],
    ["BBOX", wmsIdentifyBbox3857(lngLat, zoom)],
    ["WIDTH", String(WMS_IDENTIFY_QUERY_SIZE)],
    ["HEIGHT", String(WMS_IDENTIFY_QUERY_SIZE)],
    [isV13 ? "I" : "X", String(WMS_IDENTIFY_QUERY_CENTER)],
    [isV13 ? "J" : "Y", String(WMS_IDENTIFY_QUERY_CENTER)],
    ["INFO_FORMAT", infoFormat],
    ["FEATURE_COUNT", String(Number.isFinite(featureCount) ? featureCount : 1)],
  ]);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function textFromHtml(value: string): string {
  const document = new DOMParser().parseFromString(value, "text/html");
  return normalizeText(document.body.textContent ?? "");
}

function isWmsExceptionResponse(value: string): boolean {
  return /<([\w:]+)?(ServiceException|ExceptionReport)\b/i.test(value);
}

function parseWmsJsonProperties(value: unknown): {
  featureId?: string | number;
  properties: Record<string, unknown>;
} | null {
  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    // Some servers return a bare array of features instead of a FeatureCollection.
    if (value.length === 0) return { properties: {} };
    const first = value[0];
    // A plain property bag (no "properties"/"features" key) is not a GeoJSON
    // Feature; delegate so the catch-all below returns its own keys rather than
    // wrapping it into a feature whose properties resolve to {}.
    if (
      first &&
      typeof first === "object" &&
      !Array.isArray(first) &&
      !("properties" in first) &&
      !("features" in first && Array.isArray((first as Record<string, unknown>).features))
    ) {
      return parseWmsJsonProperties(first);
    }
    return parseWmsJsonProperties({
      type: "FeatureCollection",
      features: [first],
    });
  }

  if ("features" in value && Array.isArray(value.features)) {
    // An empty collection is the standard "no hit" response: report success
    // with no properties rather than null, so we don't probe other formats.
    if (value.features.length === 0) return { properties: {} };
    const [feature] = value.features;
    if (!feature || typeof feature !== "object") return null;
    const properties =
      "properties" in feature &&
      feature.properties &&
      typeof feature.properties === "object" &&
      !Array.isArray(feature.properties)
        ? (feature.properties as Record<string, unknown>)
        : {};
    const featureId =
      "id" in feature && (typeof feature.id === "string" || typeof feature.id === "number")
        ? feature.id
        : undefined;
    return { featureId, properties };
  }

  return { properties: value as Record<string, unknown> };
}

/**
 * WMS GetFeatureInfo at a point, as the identify popup's properties. The query
 * box is sized from the zoom alone, so any engine can call it with the clicked
 * position and its camera zoom.
 *
 * @param layer The WMS layer to query.
 * @param lngLat The clicked position.
 * @param zoom The map zoom, which sets the query box's resolution.
 * @param signal Aborts the request when a newer click supersedes it.
 * @returns The first feature's id and properties, a text result, or null.
 */
export async function fetchWmsIdentifyProperties(
  layer: GeoLibreLayer,
  lngLat: [number, number],
  zoom: number,
  signal: AbortSignal,
): Promise<{
  featureId?: string | number;
  properties: Record<string, unknown>;
} | null> {
  let fallbackText = "";

  // Honor an explicitly configured INFO_FORMAT so we issue a single request
  // instead of probing JSON/HTML/plain-text in sequence.
  const configuredFormat = stringSource(layer.source.infoFormat);
  const infoFormats = configuredFormat ? [configuredFormat] : WMS_IDENTIFY_INFO_FORMATS;

  for (const infoFormat of infoFormats) {
    const targetUrl = createWmsGetFeatureInfoUrl(layer, lngLat, zoom, infoFormat);
    if (!targetUrl) return null;

    const response = await fetch(proxyWmsRequestUrl(targetUrl), { signal });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? infoFormat;
    // Response.text() cannot take a signal, so bail out as soon as the read
    // resolves if the request was aborted meanwhile, skipping parsing.
    const text = await response.text();
    if (signal.aborted) return null;
    if (!response.ok) {
      // HTTP/2 drops the reason phrase, so statusText is often "". Fall back to
      // the status code so a failed request never surfaces as "No attributes".
      fallbackText = normalizeText(text) || response.statusText || `HTTP ${response.status}`;
      continue;
    }

    const trimmed = text.trim();
    const looksLikeJson =
      contentType.includes("json") ||
      infoFormat.includes("json") ||
      trimmed.startsWith("{") ||
      trimmed.startsWith("[");

    // Only run the XML exception check on bodies that are not JSON, so a JSON
    // response that merely mentions "ServiceException" is not misread as one.
    if (!looksLikeJson && isWmsExceptionResponse(text)) {
      fallbackText = normalizeText(text);
      continue;
    }

    if (looksLikeJson) {
      try {
        const parsed = parseWmsJsonProperties(JSON.parse(text));
        if (parsed) return parsed;
        // Valid JSON the parser couldn't map: keep the raw text as a fallback
        // so an unrecognized-but-real response isn't silently discarded.
        fallbackText = fallbackText || normalizeText(text);
      } catch {
        fallbackText = normalizeText(text);
      }
      continue;
    }

    if (contentType.includes("html")) {
      const resultText = textFromHtml(text);
      if (resultText) return { properties: { result: resultText } };
      continue;
    }

    const resultText = normalizeText(text);
    if (!resultText) continue;
    // Only treat plain text as the final answer when we actually probed a
    // text format; a body that arrived in an unexpected format is stashed as
    // a fallback so the remaining info formats are still tried.
    if (infoFormat.includes("plain")) return { properties: { result: resultText } };
    fallbackText = resultText;
  }

  return fallbackText ? { properties: { result: fallbackText } } : null;
}

export function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
}
