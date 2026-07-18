import type { FeatureCollection } from "geojson";

const LOCAL_SIDECAR_URL = "http://127.0.0.1:8765";

/** Build-time override, e.g. `VITE_SIDECAR_URL=http://127.0.0.1:9000`. */
function explicitSidecarUrl(): string | undefined {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    const value = env?.VITE_SIDECAR_URL;
    return value && value.trim() ? value.trim().replace(/\/$/, "") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the sidecar base URL for the current runtime.
 *
 * - An explicit `VITE_SIDECAR_URL` always wins (useful for non-standard dev
 *   ports such as `vite --port 3000`).
 * - Desktop (Tauri) and the default Vite dev server (port 5173) talk to a local
 *   sidecar directly at {@link LOCAL_SIDECAR_URL}.
 * - When the app is served from any other http(s) origin (e.g. the combined
 *   Docker image), the sidecar is reached through a same-origin `/sidecar`
 *   reverse proxy, which sidesteps CORS entirely.
 */
function resolveSidecarBaseUrl(): string {
  const override = explicitSidecarUrl();
  if (override) return override;
  if (typeof window === "undefined" || !window.location) {
    return LOCAL_SIDECAR_URL;
  }
  const { protocol, hostname, port, origin } = window.location;
  const isTauri = protocol === "tauri:" || hostname === "tauri.localhost";
  // 5173 is Vite's default dev port (vite.config.ts pins strictPort). For other
  // ports set VITE_SIDECAR_URL explicitly.
  const isViteDev = port === "5173";
  if (!isTauri && !isViteDev && (protocol === "http:" || protocol === "https:")) {
    return `${origin}/sidecar`;
  }
  return LOCAL_SIDECAR_URL;
}

const DEFAULT_SIDECAR_URL = resolveSidecarBaseUrl();

/**
 * Per-launch sidecar auth token. The desktop shell mints it when it spawns the
 * sidecar and hands it back through `start_geolibre_sidecar`; {@link
 * setSidecarAuthToken} stashes it here so {@link sidecarFetch} can attach it to
 * every request. Null in the browser/Docker build, where the same-origin nginx
 * proxy injects the token instead and the sidecar is unreachable directly.
 */
let sidecarAuthToken: string | null = null;

/**
 * Record (or clear) the sidecar auth token. Call after `startGeoLibreSidecar()`
 * returns. Passing an empty/nullish value clears it.
 *
 * @param token - The per-launch token from the desktop backend, or null.
 */
export function setSidecarAuthToken(token: string | null | undefined): void {
  sidecarAuthToken = token && token.trim() ? token.trim() : null;
}

/**
 * `fetch` wrapper for sidecar requests that attaches the per-launch auth token
 * (as `X-GeoLibre-Token`) when one is set. Used for every sidecar endpoint call;
 * external fetches (e.g. the Whitebox catalog snapshot on GitHub) use plain
 * `fetch` so the token is never sent off-host.
 *
 * @param input - The sidecar request URL.
 * @param init - Optional fetch init; its headers are preserved.
 * @returns The fetch response promise.
 */
function sidecarFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!sidecarAuthToken) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set("X-GeoLibre-Token", sidecarAuthToken);
  return fetch(input, { ...init, headers });
}

const WHITEBOX_CATALOG_SNAPSHOT_URL =
  "https://raw.githubusercontent.com/opengeos/Whitebox-Next-Gen-ArcGIS/main/WNG/data/catalog_snapshot.json";

let remoteWhiteboxCatalogPromise: Promise<WhiteboxTool[]> | null = null;

export interface SidecarHealth {
  status: string;
}

export interface SidecarAlgorithm {
  id: string;
  name: string;
  description: string;
}

export type WhiteboxParameterKind =
  | "raster_in"
  | "raster_out"
  | "vector_in"
  | "vector_out"
  | "lidar_in"
  | "lidar_out"
  | "file_in"
  | "file_out"
  | "bool"
  | "int"
  | "double"
  | "enum"
  | "string"
  | string;

export interface WhiteboxToolParameter {
  name: string;
  description?: string;
  type?: string;
  data_kind?: string;
  io_role?: string;
  required?: boolean;
  default?: unknown;
  options?: string[];
  kind?: WhiteboxParameterKind;
  schema?: unknown;
}

export interface WhiteboxTool {
  id: string;
  display_name?: string;
  summary?: string;
  category?: string;
  taxonomy_category?: string;
  taxonomy_subcategory?: string;
  license_tier?: string;
  locked?: boolean;
  locked_reason?: string | null;
  params?: WhiteboxToolParameter[];
  return_type?: string;
  /** Tool provenance: "geolibre" for GeoLibre-authored WASM tools, else unset (Whitebox). */
  source?: "geolibre";
}

export interface WhiteboxStatus {
  available: boolean;
  message: string;
  capabilities?: unknown;
  python?: string | null;
}

export interface WhiteboxJob {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed" | string;
  tool_id: string;
  created_at: string;
  updated_at: string;
  messages: string[];
  outputs: Record<string, unknown>;
  result?: unknown;
  error?: string | null;
}

export interface WhiteboxLayerInput {
  name: string;
  kind: string;
  geojson?: FeatureCollection;
  /** Raw bytes for non-vector inputs (e.g. a GeoTIFF for a raster_in); used by
   *  the in-browser WASM runner, ignored by the sidecar. */
  bytes?: Uint8Array;
}

/**
 * Output format for the in-browser WASM runner's `vector_out` parameters.
 * `"geojson"` (the default) is reprojected to WGS84 (RFC 7946) and returned as a
 * `FeatureCollection` for a map layer; the other formats preserve the tool's
 * target-CRS coordinates and CRS metadata and are returned as bytes to download
 * (a reprojection result would otherwise lose its projection, since GeoLibre and
 * MapLibre only render EPSG:4326). Ignored by the Python sidecar.
 */
export type VectorOutputFormat = "geojson" | "geoparquet" | "flatgeobuf" | "shapefile";

/** Every valid {@link VectorOutputFormat}, for validating untrusted values. */
export const VECTOR_OUTPUT_FORMATS: readonly VectorOutputFormat[] = [
  "geojson",
  "geoparquet",
  "flatgeobuf",
  "shapefile",
];

/**
 * Coerce an arbitrary value to a {@link VectorOutputFormat}, falling back to
 * `"geojson"`. Guards against a stale `vector_out` value: in sidecar mode the
 * param holds a free-text output path, which persists in the form state after
 * toggling "Run locally (WASM)" (the form only resets on tool change). Without
 * this, that path string would be force-cast to a format and produce a broken
 * output filename such as `..._output.undefined`.
 *
 * @param value - An arbitrary value that may or may not be a known format.
 * @returns The value if it is a known format, otherwise `"geojson"`.
 */
export function normalizeVectorOutputFormat(value: unknown): VectorOutputFormat {
  return typeof value === "string" && (VECTOR_OUTPUT_FORMATS as readonly string[]).includes(value)
    ? (value as VectorOutputFormat)
    : "geojson";
}

export interface RunWhiteboxToolRequest {
  tool_id: string;
  parameters: Record<string, unknown>;
  tool?: WhiteboxTool;
  layer_inputs?: Record<string, WhiteboxLayerInput>;
  include_pro?: boolean;
  tier?: string;
  /** WASM runner only: format for `vector_out` outputs (default `"geojson"`). */
  vector_output_format?: VectorOutputFormat;
}

interface WhiteboxCatalogResponse {
  tools: WhiteboxTool[];
  tool_count: number;
}

interface WhiteboxCatalogSnapshot {
  tools?: WhiteboxTool[];
  tool_count?: number;
}

/** Optional Python processing sidecar client. UI works without it. */
export async function checkSidecarHealth(
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<SidecarHealth | null> {
  try {
    const res = await sidecarFetch(`${baseUrl}/health`);
    if (!res.ok) return null;
    return (await res.json()) as SidecarHealth;
  } catch {
    return null;
  }
}

export async function fetchSidecarAlgorithms(
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<SidecarAlgorithm[]> {
  try {
    const res = await sidecarFetch(`${baseUrl}/algorithms`);
    if (!res.ok) return [];
    const data = (await res.json()) as { algorithms: SidecarAlgorithm[] };
    return data.algorithms ?? [];
  } catch {
    return [];
  }
}

// TODO(v0.5): POST /run with algorithm id and parameters

export async function fetchWhiteboxStatus(baseUrl = DEFAULT_SIDECAR_URL): Promise<WhiteboxStatus> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/whitebox/status`);
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(`Whitebox status failed: HTTP ${res.status}`);
  }
  return (await res.json()) as WhiteboxStatus;
}

export async function fetchWhiteboxTools(baseUrl = DEFAULT_SIDECAR_URL): Promise<WhiteboxTool[]> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/whitebox/tools`);
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not load Whitebox tools"));
  }
  const data = (await res.json()) as WhiteboxCatalogResponse;
  return data.tools ?? [];
}

// File name of the snapshot bundled into the app's static assets
// (apps/geolibre-desktop/public/, written by scripts/gen-whitebox-menu-catalog.mjs).
const BUNDLED_CATALOG_SNAPSHOT_FILE = "whitebox-catalog-snapshot.json";

/**
 * URL of the app-bundled catalog snapshot, resolved against the document base so
 * it works under any deploy base path (web, Tauri, Jupyter embed). Returns null
 * outside a browser (e.g. unit tests), where only the remote URL applies.
 */
function bundledCatalogSnapshotUrl(): string | null {
  if (typeof document === "undefined" || !document.baseURI) return null;
  try {
    return new URL(BUNDLED_CATALOG_SNAPSHOT_FILE, document.baseURI).href;
  } catch {
    return null;
  }
}

async function loadCatalogSnapshot(remoteUrl: string): Promise<WhiteboxTool[]> {
  // Prefer the app-bundled copy so restricted/offline environments never depend
  // on GitHub; fall back to the upstream URL only if the bundled file is absent.
  const sources = [bundledCatalogSnapshotUrl(), remoteUrl].filter((value): value is string =>
    Boolean(value),
  );
  let lastError: unknown = new Error("No catalog snapshot source available");
  for (const source of sources) {
    try {
      const response = await fetch(source, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as WhiteboxCatalogSnapshot;
      return data.tools ?? [];
    } catch (error) {
      lastError = error;
    }
  }
  remoteWhiteboxCatalogPromise = null; // allow retry on next call
  throw new Error(
    `Could not load Whitebox catalog snapshot: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function fetchRemoteWhiteboxCatalogSnapshot(
  url = WHITEBOX_CATALOG_SNAPSHOT_URL,
): Promise<WhiteboxTool[]> {
  remoteWhiteboxCatalogPromise ??= loadCatalogSnapshot(url);
  return remoteWhiteboxCatalogPromise;
}

export function clearRemoteWhiteboxCatalogSnapshotCache(): void {
  remoteWhiteboxCatalogPromise = null;
}

export const WHITEBOX_CATALOG_URL = WHITEBOX_CATALOG_SNAPSHOT_URL;

export async function fetchWhiteboxTool(
  toolId: string,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<unknown> {
  const res = await sidecarFetch(`${baseUrl}/whitebox/tools/${encodeURIComponent(toolId)}`);
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not load Whitebox tool"));
  }
  return res.json();
}

export async function runWhiteboxTool(
  request: RunWhiteboxToolRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<WhiteboxJob> {
  const res = await sidecarFetch(`${baseUrl}/whitebox/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not start Whitebox tool"));
  }
  return (await res.json()) as WhiteboxJob;
}

export async function fetchWhiteboxJob(
  jobId: string,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<WhiteboxJob> {
  const res = await sidecarFetch(`${baseUrl}/whitebox/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not load Whitebox job"));
  }
  return (await res.json()) as WhiteboxJob;
}

export async function fetchWhiteboxJsonOutput(
  path: string,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<unknown> {
  const res = await sidecarFetch(`${baseUrl}/whitebox/output?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not load Whitebox output"));
  }
  return res.json();
}

export interface ConversionStatus {
  available: boolean;
  message: string;
}

export interface ConversionJob {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed" | string;
  tool_id: string;
  created_at: string;
  updated_at: string;
  messages: string[];
  outputs: Record<string, unknown>;
  result?: unknown;
  error?: string | null;
}

export interface VectorToVectorRequest {
  input_path: string;
  /**
   * Output file path. Its extension selects the output format (`.gpkg`, `.fgb`,
   * `.shp`/`.zip`, `.geojson`, `.kml`, `.parquet`, ...); the backend maps it to
   * the matching DuckDB spatial driver.
   */
  output_path: string;
  /**
   * Layer to read from a multi-layer input (a File Geodatabase or GeoPackage).
   * Omitted, the first layer is read.
   */
  input_layer?: string;
  /**
   * Reproject the geometry to this CRS (e.g. `"EPSG:4326"`) before writing.
   * The backend rejects the request when the input declares no CRS and no
   * `source_srs` is supplied.
   */
  target_srs?: string;
  /**
   * CRS to reproject *from*, overriding (or standing in for) the CRS the
   * dataset declares — for layers whose spatial reference GDAL cannot resolve
   * to an authority code. Only meaningful together with `target_srs`.
   */
  source_srs?: string;
}

export interface VectorLayersRequest {
  /** Dataset path: a file, a `.gdb` directory, or a zipped dataset. */
  input_path: string;
}

/** One layer of a multi-layer vector dataset, as listed by the sidecar. */
export interface VectorDatasetLayer {
  name: string;
  feature_count: number | null;
  /** OGR geometry type (e.g. "Point"); null for non-spatial tables. */
  geometry_type: string | null;
  /** `AUTHORITY:CODE` (e.g. "EPSG:4326"), or null when undeclared. */
  crs: string | null;
}

export interface VectorToGeoParquetRequest {
  input_path: string;
  output_path: string;
  /** Parquet compression codec. Defaults to `"zstd"` when omitted. */
  compression?: string;
  /**
   * Parquet row group size. Must be a positive integer; the backend rejects
   * values <= 0. Defaults to 30000 when omitted.
   */
  row_group_size?: number;
}

export interface VectorToFlatGeobufRequest {
  input_path: string;
  output_path: string;
}

export interface VectorToShapefileRequest {
  input_path: string;
  output_path: string;
}

export interface VectorToGeoPackageRequest {
  input_path: string;
  output_path: string;
}

export interface CsvToGeoParquetRequest {
  input_path: string;
  output_path: string;
  lon_column: string;
  lat_column: string;
  /** Parquet compression codec. Defaults to `"zstd"` when omitted. */
  compression?: string;
  /** Parquet row group size. Positive integer; defaults to 30000. */
  row_group_size?: number;
}

export interface VectorToPmtilesRequest {
  input_path: string;
  output_path: string;
  /** Tile layer name. Defaults to `"data"` when omitted. */
  layer_name?: string;
  /** Minimum zoom level. Defaults to 0. */
  min_zoom?: number;
  /** Maximum zoom level. Defaults to 14. */
  max_zoom?: number;
}

export interface RasterToCogRequest {
  input_path: string;
  output_path: string;
  /** COG compression profile. Defaults to `"deflate"` when omitted. */
  compression?: string;
}

export async function fetchConversionStatus(
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionStatus> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/conversion/status`);
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(`Conversion status failed: HTTP ${res.status}`);
  }
  return (await res.json()) as ConversionStatus;
}

export async function runVectorToVector(
  request: VectorToVectorRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(`${baseUrl}/conversion/vector-to-vector`, request, baseUrl);
}

/**
 * Start a job listing the layers of a multi-layer vector dataset (a File
 * Geodatabase directory, a zipped dataset, or a GeoPackage). Poll the returned
 * job with {@link fetchConversionJob}; on success its `result` carries
 * `{ layers: VectorDatasetLayer[] }`.
 */
export async function runVectorLayers(
  request: VectorLayersRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(`${baseUrl}/conversion/vector-layers`, request, baseUrl);
}

export async function runVectorToGeoParquet(
  request: VectorToGeoParquetRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(`${baseUrl}/conversion/vector-to-geoparquet`, request, baseUrl);
}

export async function runVectorToFlatGeobuf(
  request: VectorToFlatGeobufRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(`${baseUrl}/conversion/vector-to-flatgeobuf`, request, baseUrl);
}

export async function runVectorToShapefile(
  request: VectorToShapefileRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(`${baseUrl}/conversion/vector-to-shapefile`, request, baseUrl);
}

export async function runVectorToGeoPackage(
  request: VectorToGeoPackageRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(`${baseUrl}/conversion/vector-to-geopackage`, request, baseUrl);
}

export async function runCsvToGeoParquet(
  request: CsvToGeoParquetRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(`${baseUrl}/conversion/csv-to-geoparquet`, request, baseUrl);
}

export async function runVectorToPmtiles(
  request: VectorToPmtilesRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(`${baseUrl}/conversion/vector-to-pmtiles`, request, baseUrl);
}

export async function runRasterToCog(
  request: RasterToCogRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(`${baseUrl}/conversion/raster-to-cog`, request, baseUrl);
}

export interface RasterStatus {
  available: boolean;
  message: string;
}

export interface RasterToolRequest {
  tool_id: string;
  input_path: string;
  output_path: string;
  /** Tool parameters (azimuth, dst_crs, interval, ...). */
  parameters?: Record<string, unknown>;
}

/** Return raster-processing (rasterio) runtime availability. */
export async function fetchRasterStatus(baseUrl = DEFAULT_SIDECAR_URL): Promise<RasterStatus> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/raster/status`);
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(`Raster status failed: HTTP ${res.status}`);
  }
  return (await res.json()) as RasterStatus;
}

/**
 * Start a raster processing job. Raster jobs share the conversion job store,
 * so callers poll the result with `fetchConversionJob`.
 */
export async function runRasterTool(
  request: RasterToolRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(`${baseUrl}/raster/run`, request, baseUrl);
}

type ConversionRequest =
  | VectorToVectorRequest
  | VectorLayersRequest
  | VectorToGeoParquetRequest
  | VectorToFlatGeobufRequest
  | VectorToShapefileRequest
  | VectorToGeoPackageRequest
  | CsvToGeoParquetRequest
  | VectorToPmtilesRequest
  | RasterToCogRequest
  | RasterToolRequest;

async function startConversion(
  url: string,
  request: ConversionRequest,
  baseUrl: string,
): Promise<ConversionJob> {
  let res: Response;
  try {
    res = await sidecarFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not start conversion"));
  }
  return (await res.json()) as ConversionJob;
}

export async function fetchConversionJob(
  jobId: string,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/conversion/jobs/${encodeURIComponent(jobId)}`);
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not load conversion job"));
  }
  return (await res.json()) as ConversionJob;
}

export interface VectorStatus {
  available: boolean;
  message: string;
}

export interface VectorToolRequest {
  tool_id: string;
  /** Primary input layer as a GeoJSON FeatureCollection. */
  geojson: unknown;
  /** Optional second layer for overlay operations (clip/intersection/etc.). */
  overlay?: unknown;
  /** Tool parameters (distance, units, tolerance, field, ...). */
  parameters?: Record<string, unknown>;
}

export interface VectorToolResult {
  /** Resulting GeoJSON FeatureCollection. */
  geojson: unknown;
  /** Human-readable log lines describing what ran. */
  messages: string[];
}

export async function fetchVectorStatus(baseUrl = DEFAULT_SIDECAR_URL): Promise<VectorStatus> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/vector/status`);
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(`Vector status failed: HTTP ${res.status}`);
  }
  return (await res.json()) as VectorStatus;
}

export async function runVectorTool(
  request: VectorToolRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<VectorToolResult> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/vector/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not run vector tool"));
  }
  return (await res.json()) as VectorToolResult;
}

export interface WriteVectorToSourceRequest {
  /** Absolute local path of the source file to overwrite (`.gpkg`/`.geojson`). */
  path: string;
  /** The edited layer as a GeoJSON FeatureCollection (WGS84). */
  geojson: FeatureCollection;
  /** Target table within a multi-layer GeoPackage; omit for single-layer files. */
  layer?: string;
}

export interface WriteVectorToSourceResult {
  /** The resolved path that was written. */
  path: string;
  /** The GeoPackage table that was written, or null for single-layer formats. */
  layer: string | null;
  /** Number of features committed. */
  feature_count: number;
  /** Human-readable log lines describing what was saved. */
  messages: string[];
}

/**
 * Commit an edited layer back to its local source file via the sidecar.
 *
 * Overwrites the original GeoPackage or GeoJSON file in place (CRS- and
 * sibling-table-preserving, atomic). Desktop only: the sidecar needs real
 * filesystem access to the layer's `sourcePath`.
 */
export async function writeVectorToSource(
  request: WriteVectorToSourceRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<WriteVectorToSourceResult> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/vector/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not save edits to source"));
  }
  return (await res.json()) as WriteVectorToSourceResult;
}

// --- PostGIS editable layers (issue #1070 phase 2) --------------------------

export interface PostgisStatus {
  available: boolean;
  message: string;
}

export interface PostgisTableInfo {
  schema: string;
  table: string;
  geometry_column: string;
  srid: number;
  geometry_type: string;
  /** Single-column primary key, or null when the table has none (read-only). */
  primary_key: string | null;
}

export interface ReadPostgisTableRequest {
  /** libpq connection string (URI or keyword/value form). */
  connection: string;
  schema_name?: string;
  table: string;
}

export interface ReadPostgisTableResult {
  /** The table's features as a WGS84 FeatureCollection (pk kept as feature.id). */
  geojson: FeatureCollection;
  schema: string;
  table: string;
  geometry_column: string;
  srid: number;
  primary_key: string | null;
  feature_count: number;
}

export interface WritePostgisTableRequest {
  connection: string;
  schema_name?: string;
  table: string;
  /** The edited layer as a GeoJSON FeatureCollection (WGS84). */
  geojson: FeatureCollection;
  /**
   * Primary-key values the edit session started from. When set, deletions are
   * scoped to these keys so rows inserted concurrently by another session
   * survive the save; when omitted the sidecar diffs the whole table.
   */
  baseline_keys?: Array<string | number>;
}

export interface WritePostgisTableResult {
  schema: string;
  table: string;
  feature_count: number;
  inserted: number;
  updated: number;
  deleted: number;
  messages: string[];
  /** Editor-added fields skipped because no table column matches them. */
  skipped_fields: string[];
}

/** Return PostGIS runtime (psycopg) availability in the sidecar. */
export async function fetchPostgisStatus(baseUrl = DEFAULT_SIDECAR_URL): Promise<PostgisStatus> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/postgis/status`);
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not check PostGIS runtime"));
  }
  return (await res.json()) as PostgisStatus;
}

/** List the spatial tables of a PostGIS database with write-back readiness. */
export async function listPostgisTables(
  connection: string,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<PostgisTableInfo[]> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/postgis/tables`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connection }),
    });
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not list PostGIS tables"));
  }
  const payload = (await res.json()) as { tables: PostgisTableInfo[] };
  return payload.tables;
}

/** Read one PostGIS table as an editable WGS84 GeoJSON FeatureCollection. */
export async function readPostgisTable(
  request: ReadPostgisTableRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ReadPostgisTableResult> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/postgis/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not read PostGIS table"));
  }
  return (await res.json()) as ReadPostgisTableResult;
}

/**
 * Commit edited features back to their source PostGIS table via the sidecar.
 *
 * The sidecar diffs the collection against the table by primary key and issues
 * parameterized INSERT/UPDATE/DELETE statements in one transaction.
 */
export async function writePostgisTable(
  request: WritePostgisTableRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<WritePostgisTableResult> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/postgis/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not save edits to PostGIS"));
  }
  return (await res.json()) as WritePostgisTableResult;
}

// --- AI segmentation (SamGeo / SAM3) ---------------------------------------

export interface MlStatus {
  available: boolean;
  message: string;
  /** Model the UI should default to (e.g. "sam3"). */
  default_model?: string;
  /** Base URL of the resolved samgeo-api server, when one is running. */
  url?: string;
  /** samgeo-api version, when a server is reachable. */
  version?: string;
  /** Available models per version, when a server is reachable. */
  models?: Record<string, string[]>;
}

export type MlSegmentMode = "automatic" | "predict" | "text";

export interface MlSegmentParams {
  /** Model version to use. Defaults to "sam3" (the only supported model). */
  modelVersion?: string;
  /** Output format. Defaults to "geojson". */
  outputFormat?: string;
  /** Minimum mask size in pixels. */
  minSize?: number;
  /** Maximum mask size in pixels. */
  maxSize?: number;
  // text mode
  prompt?: string;
  confidenceThreshold?: number;
  // predict mode
  pointCoords?: number[][];
  pointLabels?: number[];
  boxes?: number[][];
  /** CRS of the point/box prompts (e.g. "EPSG:4326" for map-drawn geometry). */
  pointCrs?: string;
}

/** Return segmentation backend (samgeo-api) availability. */
export async function fetchMlStatus(baseUrl = DEFAULT_SIDECAR_URL): Promise<MlStatus> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/ml/status`);
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(`Segmentation status failed: HTTP ${res.status}`);
  }
  return (await res.json()) as MlStatus;
}

/**
 * Run a segmentation request against the sidecar `/ml/segment/*` proxy.
 *
 * Uploads the image as multipart/form-data alongside the prompt/params and
 * returns the resulting GeoJSON FeatureCollection (georeferenced when the input
 * is a GeoTIFF). The image is a `Blob`/`File`; callers obtain it by reading a
 * local GeoTIFF or fetching a COG URL into bytes.
 */
export async function mlSegment(
  mode: MlSegmentMode,
  image: Blob,
  filename: string,
  params: MlSegmentParams = {},
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<FeatureCollection> {
  const form = new FormData();
  form.append("file", image, filename);
  form.append("model_version", params.modelVersion ?? "sam3");
  form.append("output_format", params.outputFormat ?? "geojson");
  if (params.minSize != null) form.append("min_size", String(params.minSize));
  if (params.maxSize != null) form.append("max_size", String(params.maxSize));

  if (mode === "text") {
    form.append("prompt", params.prompt ?? "");
    if (params.confidenceThreshold != null) {
      form.append("confidence_threshold", String(params.confidenceThreshold));
    }
  }
  if (mode === "predict") {
    if (params.pointCoords) {
      form.append("point_coords", JSON.stringify(params.pointCoords));
    }
    if (params.pointLabels) {
      form.append("point_labels", JSON.stringify(params.pointLabels));
    }
    if (params.boxes) form.append("boxes", JSON.stringify(params.boxes));
    if (params.pointCrs) form.append("point_crs", params.pointCrs);
  }

  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/ml/segment/${mode}`, {
      method: "POST",
      body: form,
    });
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not run segmentation"));
  }
  return (await res.json()) as FeatureCollection;
}

// --- Spatial SQL (Apache Sedona / SedonaDB) --------------------------------

export interface SqlEngineStatus {
  available: boolean;
  message: string;
}

export interface SedonaSqlLayer {
  /** View name the SQL references (a sanitised, SQL-safe identifier). */
  name: string;
  /** Layer geometry + attributes as a GeoJSON FeatureCollection. */
  geojson: unknown;
}

export interface SedonaSqlRequest {
  sql: string;
  layers: SedonaSqlLayer[];
}

export interface SedonaSqlResult {
  /** Column names in select order (geometry rendered as WKT in `rows`). */
  columns: string[];
  /** Result rows keyed by column name. */
  rows: Record<string, unknown>[];
  /** Name of the detected geometry column, or null when there is none. */
  geometry_column: string | null;
  /** Result as a GeoJSON FeatureCollection when a geometry column is present. */
  geojson: FeatureCollection | null;
}

/** Return spatial-SQL (SedonaDB) runtime availability. */
export async function fetchSqlStatus(baseUrl = DEFAULT_SIDECAR_URL): Promise<SqlEngineStatus> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/sql/status`);
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(`SQL status failed: HTTP ${res.status}`);
  }
  return (await res.json()) as SqlEngineStatus;
}

/** Run a single Sedona spatial SQL statement via the SedonaDB sidecar. */
export async function runSedonaSql(
  request: SedonaSqlRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<SedonaSqlResult> {
  let res: Response;
  try {
    res = await sidecarFetch(`${baseUrl}/sql/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not run spatial SQL"));
  }
  return (await res.json()) as SedonaSqlResult;
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { detail?: unknown };
    if (typeof data.detail === "string") return data.detail;
    if (data.detail) return JSON.stringify(data.detail);
  } catch {
    // Use the fallback below when the response is not JSON.
  }
  return `${fallback}: HTTP ${response.status}`;
}

function sidecarConnectionError(baseUrl: string, error: unknown): Error {
  console.debug("GeoLibre sidecar unreachable:", error);
  return new Error(
    `Could not connect to the GeoLibre sidecar at ${baseUrl}. ` +
      "Start the sidecar to run processing tools.",
  );
}
