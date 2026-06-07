import type { FeatureCollection } from "geojson";

const DEFAULT_SIDECAR_URL = "http://127.0.0.1:8765";
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
}

export interface RunWhiteboxToolRequest {
  tool_id: string;
  parameters: Record<string, unknown>;
  tool?: WhiteboxTool;
  layer_inputs?: Record<string, WhiteboxLayerInput>;
  include_pro?: boolean;
  tier?: string;
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
    const res = await fetch(`${baseUrl}/health`);
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
    const res = await fetch(`${baseUrl}/algorithms`);
    if (!res.ok) return [];
    const data = (await res.json()) as { algorithms: SidecarAlgorithm[] };
    return data.algorithms ?? [];
  } catch {
    return [];
  }
}

// TODO(v0.5): POST /run with algorithm id and parameters

export async function fetchWhiteboxStatus(
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<WhiteboxStatus> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/whitebox/status`);
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(`Whitebox status failed: HTTP ${res.status}`);
  }
  return (await res.json()) as WhiteboxStatus;
}

export async function fetchWhiteboxTools(
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<WhiteboxTool[]> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/whitebox/tools`);
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not load Whitebox tools"));
  }
  const data = (await res.json()) as WhiteboxCatalogResponse;
  return data.tools ?? [];
}

export async function fetchRemoteWhiteboxCatalogSnapshot(
  url = WHITEBOX_CATALOG_SNAPSHOT_URL,
): Promise<WhiteboxTool[]> {
  remoteWhiteboxCatalogPromise ??= fetch(url, {
    headers: { accept: "application/json" },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(
          `Could not load Whitebox catalog snapshot: HTTP ${response.status}`,
        );
      }
      const data = (await response.json()) as WhiteboxCatalogSnapshot;
      return data.tools ?? [];
    })
    .catch((error) => {
      remoteWhiteboxCatalogPromise = null; // allow retry on next call
      throw error;
    });
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
  const res = await fetch(`${baseUrl}/whitebox/tools/${encodeURIComponent(toolId)}`);
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not load Whitebox tool"));
  }
  return res.json();
}

export async function runWhiteboxTool(
  request: RunWhiteboxToolRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<WhiteboxJob> {
  const res = await fetch(`${baseUrl}/whitebox/run`, {
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
  const res = await fetch(`${baseUrl}/whitebox/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not load Whitebox job"));
  }
  return (await res.json()) as WhiteboxJob;
}

export async function fetchWhiteboxJsonOutput(
  path: string,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<unknown> {
  const res = await fetch(
    `${baseUrl}/whitebox/output?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not load Whitebox output"));
  }
  return res.json();
}

export interface ConversionStatus {
  available: boolean;
  message: string;
  python?: string | null;
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
    res = await fetch(`${baseUrl}/conversion/status`);
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(`Conversion status failed: HTTP ${res.status}`);
  }
  return (await res.json()) as ConversionStatus;
}

export async function runVectorToGeoParquet(
  request: VectorToGeoParquetRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(
    `${baseUrl}/conversion/vector-to-geoparquet`,
    request,
    baseUrl,
  );
}

export async function runVectorToFlatGeobuf(
  request: VectorToFlatGeobufRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(
    `${baseUrl}/conversion/vector-to-flatgeobuf`,
    request,
    baseUrl,
  );
}

export async function runCsvToGeoParquet(
  request: CsvToGeoParquetRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(
    `${baseUrl}/conversion/csv-to-geoparquet`,
    request,
    baseUrl,
  );
}

export async function runVectorToPmtiles(
  request: VectorToPmtilesRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(
    `${baseUrl}/conversion/vector-to-pmtiles`,
    request,
    baseUrl,
  );
}

export async function runRasterToCog(
  request: RasterToCogRequest,
  baseUrl = DEFAULT_SIDECAR_URL,
): Promise<ConversionJob> {
  return startConversion(`${baseUrl}/conversion/raster-to-cog`, request, baseUrl);
}

type ConversionRequest =
  | VectorToGeoParquetRequest
  | VectorToFlatGeobufRequest
  | CsvToGeoParquetRequest
  | VectorToPmtilesRequest
  | RasterToCogRequest;

async function startConversion(
  url: string,
  request: ConversionRequest,
  baseUrl: string,
): Promise<ConversionJob> {
  let res: Response;
  try {
    res = await fetch(url, {
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
    res = await fetch(
      `${baseUrl}/conversion/jobs/${encodeURIComponent(jobId)}`,
    );
  } catch (error) {
    throw sidecarConnectionError(baseUrl, error);
  }
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, "Could not load conversion job"));
  }
  return (await res.json()) as ConversionJob;
}

async function responseErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
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
