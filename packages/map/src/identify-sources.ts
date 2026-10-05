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
// application/geojson is what ArcGIS (and some MapServer) WMS servers answer in
// JSON; it follows application/json so a server offering only that one, like
// GeoServer, is not charged an extra round trip on every click (#2945).
const WMS_IDENTIFY_INFO_FORMATS = [
  "application/json",
  "application/geojson",
  "text/html",
  "text/plain",
];

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

/**
 * Whether a WMS layer answers GetFeatureInfo. Only `source.queryable: false`,
 * written when the capabilities mark every requested layer `queryable="0"`,
 * says no; a layer without the information (added by URL, an older project) is
 * queried as before (#2887).
 */
export function isWmsQueryable(layer: GeoLibreLayer): boolean {
  return layer.source.queryable !== false;
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

function wmsIdentifyBbox3857(lngLat: [number, number], zoom: number): number[] {
  const [centerX, centerY] = lngLatToWebMercator(lngLat[0], lngLat[1]);
  const halfSpan = (WMS_IDENTIFY_QUERY_SIZE * wmsIdentifyResolution(zoom)) / 2;
  return [centerX - halfSpan, centerY - halfSpan, centerX + halfSpan, centerY + halfSpan];
}

function webMercatorToLngLat(x: number, y: number): [number, number] {
  const lng = (x / WEB_MERCATOR_EARTH_RADIUS) * (180 / Math.PI);
  const lat = Math.atan(Math.sinh(y / WEB_MERCATOR_EARTH_RADIUS)) * (180 / Math.PI);
  return [lng, lat];
}

/** A WMS layer's CRS, as the identify query box needs it. */
export interface WmsIdentifyProjection {
  /**
   * Longitude/latitude to easting/northing (or longitude/latitude) in the
   * layer's CRS, always east first: the EPSG axis order is `northFirst`'s job.
   */
  forward: (lngLat: [number, number]) => [number, number];
  /** Whether the EPSG axis order is north first: WMS 1.3.0 writes the BBOX that way. */
  northFirst: boolean;
}

/** Resolves an `EPSG:<code>` CRS, or null when it is unknown. */
export type WmsIdentifyProjectionResolver = (crs: string) => Promise<WmsIdentifyProjection | null>;

let wmsIdentifyProjectionResolver: WmsIdentifyProjectionResolver | null = null;

/**
 * Lets GetFeatureInfo reach a WMS layer drawn in a projected CRS. The desktop
 * tile protocol reprojects such layers with its bundled EPSG tables, which this
 * package does not carry, so the desktop installs the same lookup here.
 *
 * @param resolver The resolver to use, or null to remove it.
 */
export function setWmsIdentifyProjectionResolver(
  resolver: WmsIdentifyProjectionResolver | null,
): void {
  wmsIdentifyProjectionResolver = resolver;
}

// Mirrors GEOGRAPHIC_WMS_CRS in the desktop's wms-geographic.ts: the CRSs whose
// tiles the desktop requests in degrees without the EPSG tables.
const GEOGRAPHIC_WMS_CRS = new Set(["EPSG:4326", "EPSG:4258", "EPSG:6706", "CRS:84"]);
const WEB_MERCATOR_CRS = new Set(["EPSG:3857", "EPSG:900913"]);

/**
 * The CRS the layer's GetMap tiles are requested in: `source.crs`, or else the
 * CRS/SRS of the tile template, where Python's `wms_layer` and the MCP tools
 * write it. The desktop wraps the template as `geolibre-wms://tile?url=...`.
 */
function wmsLayerCrs(layer: GeoLibreLayer): string | undefined {
  const crs = stringSource(layer.source.crs);
  if (crs) return crs;
  const tiles = layer.source.tiles;
  const template = Array.isArray(tiles) ? stringSource(tiles[0]) : undefined;
  if (!template) return undefined;
  try {
    const url = new URL(template);
    const wrapped = url.protocol === "geolibre-wms:" ? url.searchParams.get("url") : null;
    const params = wrapped ? new URL(wrapped).searchParams : url.searchParams;
    for (const [key, value] of params) {
      if (key.toLowerCase() === "crs" || key.toLowerCase() === "srs") return stringSource(value);
    }
  } catch {
    // Not an absolute URL: no CRS to read.
  }
  return undefined;
}

/** The installed resolver's projection for `crs`, or null without one. */
async function resolveWmsIdentifyProjection(crs: string): Promise<WmsIdentifyProjection | null> {
  try {
    return (await wmsIdentifyProjectionResolver?.(crs)) ?? null;
  } catch {
    // A resolver that throws, or rejects, is a CRS it cannot resolve.
    return null;
  }
}

/**
 * The CRS and BBOX of the identify query, in the CRS the layer's tiles are
 * requested in (see wmsLayerCrs): a server that offers no EPSG:3857 rejects
 * GetFeatureInfo in it as it rejects GetMap (#2886). The box keeps the click at
 * its center pixel and covers about the same ground as the Web Mercator one.
 * Without a CRS, or with one that cannot be resolved, the query stays in
 * EPSG:3857, as before.
 */
async function wmsIdentifyQueryBox(
  layer: GeoLibreLayer,
  lngLat: [number, number],
  zoom: number,
  isV13: boolean,
): Promise<{ crs: string; bbox: number[] }> {
  const mercator = wmsIdentifyBbox3857(lngLat, zoom);
  const crs = wmsLayerCrs(layer)?.trim().toUpperCase();
  if (!crs || WEB_MERCATOR_CRS.has(crs)) return { crs: "EPSG:3857", bbox: mercator };

  // WMS 1.3.0 follows the EPSG axis order, latitude first, except for CRS:84.
  const projection: WmsIdentifyProjection | null = GEOGRAPHIC_WMS_CRS.has(crs)
    ? { forward: (point) => point, northFirst: crs !== "CRS:84" }
    : await resolveWmsIdentifyProjection(crs);
  if (!projection) return { crs: "EPSG:3857", bbox: mercator };

  const [minX, minY, maxX, maxY] = mercator;
  let bbox: number[];
  try {
    const corners = [
      [minX, minY],
      [minX, maxY],
      [maxX, minY],
      [maxX, maxY],
    ].map(([x, y]) => projection.forward(webMercatorToLngLat(x, y)));
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    const halfX = (Math.max(...xs) - Math.min(...xs)) / 2;
    const halfY = (Math.max(...ys) - Math.min(...ys)) / 2;
    const [x, y] = projection.forward(lngLat);
    bbox =
      isV13 && projection.northFirst
        ? [y - halfY, x - halfX, y + halfY, x + halfX]
        : [x - halfX, y - halfY, x + halfX, y + halfY];
  } catch {
    // A click the projection cannot convert (outside its domain): ask in Web Mercator.
    return { crs: "EPSG:3857", bbox: mercator };
  }
  // A conversion that does not throw can still give NaN or Infinity.
  if (!bbox.every(Number.isFinite)) return { crs: "EPSG:3857", bbox: mercator };
  return { crs, bbox };
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
 * Fetches one GetFeatureInfo URL outside the webview. The desktop app installs
 * one backed by its native HTTP client, which ignores CORS and follows
 * cross-scheme redirects the way tile requests already do.
 */
export type WmsIdentifyFetcher = (url: string, signal: AbortSignal) => Promise<Response>;

let wmsIdentifyFetcher: WmsIdentifyFetcher | null = null;

/**
 * Routes WMS GetFeatureInfo requests through `fetcher` instead of the webview's
 * `fetch`. Desktop webviews do enforce CORS (WebView2 serves the app from
 * `http://tauri.localhost`), so a server without `Access-Control-Allow-Origin`,
 * or one that redirects without it, fails there (#2712).
 *
 * @param fetcher The fetcher to use, or null to restore the webview `fetch`.
 */
export function setWmsIdentifyFetcher(fetcher: WmsIdentifyFetcher | null): void {
  wmsIdentifyFetcher = fetcher;
}

// Without an installed fetcher, only the Vite dev server proxies GetFeatureInfo
// requests (to dodge CORS in the browser). A hosted web build uses the raw URL,
// so a WMS server lacking CORS headers needs the deployment's own proxy.
function proxyWmsRequestUrl(url: string): string {
  return isViteDevServer() ? `${WMS_PROXY_PATH}?url=${encodeURIComponent(url)}` : url;
}

function fetchWmsIdentifyResponse(url: string, signal: AbortSignal): Promise<Response> {
  return wmsIdentifyFetcher
    ? wmsIdentifyFetcher(url, signal)
    : fetch(proxyWmsRequestUrl(url), { signal });
}

/**
 * The GetFeatureInfo URL for each INFO_FORMAT probed, or null when the layer
 * has no endpoint or layer names. The query box is resolved once per click.
 */
async function createWmsGetFeatureInfoUrl(
  layer: GeoLibreLayer,
  lngLat: [number, number],
  zoom: number,
): Promise<((infoFormat: string) => string) | null> {
  const endpoint = stringSource(layer.source.url) ?? layer.sourcePath;
  const layers = stringSource(layer.source.layers);
  if (!endpoint || !layers) return null;

  const styles = stringSource(layer.source.styles) ?? "";
  const format = stringSource(layer.source.format) ?? "image/png";
  // WMS 1.3.0 renames the SRS parameter to CRS and the pixel coordinates from
  // X/Y to I/J; wmsIdentifyQueryBox writes the BBOX in that version's axis order.
  const version = stringSource(layer.source.version) ?? "1.1.1";
  const isV13 = version.startsWith("1.3");
  const crsParam = isV13 ? "CRS" : "SRS";
  const query = await wmsIdentifyQueryBox(layer, lngLat, zoom, isV13);
  // Treat a deliberate featureCount of 0 ("all features" on some servers) as
  // intentional; only fall back to 1 when it is unset (null/undefined), blank,
  // or non-numeric. Number(null) and Number("") are both 0, so guard those.
  const featureCount =
    layer.source.featureCount != null && layer.source.featureCount !== ""
      ? Number(layer.source.featureCount)
      : NaN;

  return (infoFormat) =>
    appendWmsQuery(endpoint, [
      ["SERVICE", "WMS"],
      ["REQUEST", "GetFeatureInfo"],
      ["VERSION", version],
      ["LAYERS", layers],
      ["QUERY_LAYERS", layers],
      ["STYLES", styles],
      ["FORMAT", format],
      ["TRANSPARENT", layer.source.transparent === false ? "FALSE" : "TRUE"],
      [crsParam, query.crs],
      ["BBOX", query.bbox.join(",")],
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

function cellText(cell: Element): string {
  return normalizeText(cell.textContent ?? "");
}

/**
 * Sets `name` on `target`, as `name (2)`, `name (3)`... when it is already
 * taken. Own keys only, and defined rather than assigned, so a field named
 * `constructor` or `__proto__` keeps its name and its value.
 */
function addProperty(target: Record<string, string>, name: string, value: string): void {
  let key = name;
  for (let copy = 2; Object.hasOwn(target, key); copy += 1) key = `${name} (${copy})`;
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isRowOf(cells: Element[], tag: "th" | "td"): boolean {
  return cells.length > 0 && cells.every((cell) => cell.localName === tag);
}

/**
 * The attributes in one HTML table: one property per `<th>name</th><td>value</td>`
 * row or, for a table with a column header, the header naming the cells of the
 * first data row: the first all-`<td>` row right below an all-`<th>` row of the
 * same length, at least two cells wide (a lone `<th>` over a lone `<td>` reads
 * as a title over free text, not as a field). Rows of any other shape, such as
 * a title spanning the table, are skipped, and so are the rows of a table
 * nested in a cell. Null when the table has neither shape.
 */
function tableProperties(table: Element): Record<string, string> | null {
  const rows = Array.from(table.querySelectorAll("tr"))
    .filter((row) => row.closest("table") === table)
    .map((row) =>
      Array.from(row.children).filter((cell) => cell.localName === "th" || cell.localName === "td"),
    );

  const pairs: Record<string, string> = {};
  for (const cells of rows) {
    if (cells.length !== 2 || cells[0].localName !== "th" || cells[1].localName !== "td") continue;
    const name = cellText(cells[0]);
    if (name) addProperty(pairs, name, cellText(cells[1]));
  }
  if (Object.keys(pairs).length > 0) return pairs;

  const valuesIndex = rows.findIndex(
    (cells, index) =>
      index > 0 &&
      cells.length > 1 &&
      isRowOf(cells, "td") &&
      rows[index - 1].length === cells.length &&
      isRowOf(rows[index - 1], "th"),
  );
  if (valuesIndex < 0) return null;
  const header = rows[valuesIndex - 1];
  const values = rows[valuesIndex];
  const columns: Record<string, string> = {};
  header.forEach((cell, index) => {
    const name = cellText(cell);
    if (name) addProperty(columns, name, cellText(values[index]));
  });
  return Object.keys(columns).length > 0 ? columns : null;
}

/**
 * The attributes of an HTML GetFeatureInfo answer read from its tables (#2888),
 * see tableProperties. A request for several layers can get one table per
 * layer: the first `layerCount` tables with a shape are merged, a name already
 * taken getting a ` (2)`, ` (3)` suffix, as within one table. With one layer
 * only the first is read, as the JSON branch reads the first feature: a server
 * may give one table per feature. Null when no table has either shape.
 */
function propertiesFromHtmlTables(
  document: Document,
  layerCount: number,
): Record<string, string> | null {
  const merged: Record<string, string> = {};
  // A table nested in a cell belongs to that cell's value, not to the answer.
  const tables = Array.from(document.querySelectorAll("table")).filter(
    (table) => !table.parentElement?.closest("table"),
  );
  let read = 0;
  for (const table of tables) {
    if (read >= layerCount) break;
    const properties = tableProperties(table);
    if (!properties) continue;
    read += 1;
    for (const [name, value] of Object.entries(properties)) addProperty(merged, name, value);
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function isWmsExceptionResponse(value: string): boolean {
  return /<([\w:]+)?(ServiceException|ExceptionReport)\b/i.test(value);
}

/** The text of a WMS/OWS exception report, without its XML and CDATA wrapping. */
function wmsExceptionMessage(value: string): string {
  const match =
    /<(?:[\w-]+:)?(ServiceException|ExceptionText)\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?\1>/i.exec(
      value,
    );
  const inner = match?.[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return normalizeText(inner ?? "") || normalizeText(value);
}

/**
 * A short reason for a failed GetFeatureInfo request: the status, plus the
 * error page's title or a plain-text body. An HTML page without a title adds
 * nothing, since its body text would carry its markup and styles along.
 */
function wmsHttpErrorMessage(response: Response, text: string): string {
  const status = normalizeText(`HTTP ${response.status} ${response.statusText}`);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];
  let detail = normalizeText(title ?? (/<[a-z!?]/i.test(text) ? "" : text));
  if (detail.length > 200) detail = `${detail.slice(0, 200)}…`;
  return detail ? `${status} (${detail})` : status;
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
 * @returns The first feature's id and properties, a text result, or null
 *   (also, without a request, for a layer that is not queryable).
 * @throws Error when every format probed came back as a WMS exception or an
 *   HTTP error, naming the exception text or the status.
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
  if (!isWmsQueryable(layer)) return null;
  let fallbackText = "";
  // A WMS exception is the server refusing the request, not the feature's data:
  // kept apart so it surfaces as an error when no format gave anything else.
  let exceptionText = "";
  // Likewise a failed request (often an HTML error page), so the page is
  // reported as an error rather than shown as a `result` attribute (#2945).
  let httpErrorText = "";

  // Honor an explicitly configured INFO_FORMAT so we issue a single request
  // instead of probing JSON/HTML/plain-text in sequence.
  const configuredFormat = stringSource(layer.source.infoFormat);
  const infoFormats = configuredFormat ? [configuredFormat] : WMS_IDENTIFY_INFO_FORMATS;

  const buildUrl = await createWmsGetFeatureInfoUrl(layer, lngLat, zoom);
  if (!buildUrl) return null;

  for (const infoFormat of infoFormats) {
    const targetUrl = buildUrl(infoFormat);
    const response = await fetchWmsIdentifyResponse(targetUrl, signal);
    const contentTypeHeader = response.headers.get("content-type")?.toLowerCase();
    const contentType = contentTypeHeader ?? infoFormat;
    // Response.text() cannot take a signal, so bail out as soon as the read
    // resolves if the request was aborted meanwhile, skipping parsing.
    const text = await response.text();
    if (signal.aborted) return null;
    if (!response.ok) {
      // Some servers send their exception report with an error status too.
      if (isWmsExceptionResponse(text)) exceptionText = wmsExceptionMessage(text);
      else httpErrorText = wmsHttpErrorMessage(response, text);
      continue;
    }

    const trimmed = text.trim();
    // The desktop's native fetcher returns no headers, so contentType is just
    // the format we asked for; tell an HTML body apart by its markup, or it
    // would be misparsed as JSON or reach the popup with its tags.
    const headerlessHtml = !contentTypeHeader && /^<(!doctype\s+html|html|body)\b/i.test(trimmed);
    const looksLikeJson =
      !headerlessHtml &&
      (contentType.includes("json") ||
        infoFormat.includes("json") ||
        trimmed.startsWith("{") ||
        trimmed.startsWith("["));

    // Only run the XML exception check on bodies that are not JSON, so a JSON
    // response that merely mentions "ServiceException" is not misread as one.
    if (!looksLikeJson && isWmsExceptionResponse(text)) {
      exceptionText = wmsExceptionMessage(text);
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
        // A JSON probe often gets the server's XML exception back.
        if (isWmsExceptionResponse(text)) exceptionText = wmsExceptionMessage(text);
        else fallbackText = normalizeText(text);
      }
      continue;
    }

    if (headerlessHtml || contentType.includes("html")) {
      const document = new DOMParser().parseFromString(text, "text/html");
      const resultText = normalizeText(document.body.textContent ?? "");
      if (!resultText) continue;
      // HTML we did not ask for (often a server error page) is kept as a
      // fallback so the remaining info formats are still tried.
      if (!headerlessHtml || infoFormat.includes("html")) {
        const layerCount = Math.max(
          1,
          (stringSource(layer.source.layers) ?? "").split(",").filter((name) => name.trim()).length,
        );
        return {
          properties: propertiesFromHtmlTables(document, layerCount) ?? { result: resultText },
        };
      }
      fallbackText = fallbackText || resultText;
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

  if (fallbackText) return { properties: { result: fallbackText } };
  if (exceptionText) throw new Error(`WMS GetFeatureInfo returned an error: ${exceptionText}`);
  // Never "No attributes" for a request that failed: name the status instead.
  if (httpErrorText) throw new Error(`WMS GetFeatureInfo failed: ${httpErrorText}`);
  return null;
}

export function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
}
