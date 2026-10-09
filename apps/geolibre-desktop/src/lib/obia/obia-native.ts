import type { GeoLibreLayer } from "@geolibre/core";
import {
  cancelObiaNativeJob,
  fetchConversionJob,
  fetchObiaNativeFile,
  fetchObiaNativeStatus,
  nativeFeatureTable,
  startObiaNativeMeasure,
  startObiaNativeSegment,
  type ConversionJob,
  type ObiaFeatureOptions,
  type ObiaFeatureTable,
  type ObiaNativeSegmentation,
  type ObiaReadArea,
  type ObiaRunOptions,
  type ObiaToolCall,
} from "@geolibre/processing";
import { isTauri } from "@tauri-apps/api/core";
import type { FeatureCollection } from "geojson";
import { IS_MAS_BUILD } from "../build-flags";
import { startGeoLibreSidecar } from "../sidecar";

/**
 * How the workbench segments: seeded region growing in the browser, or a
 * scikit-image method run natively by the desktop app's sidecar.
 */
export type ObiaMethod = "region-growing" | "slic" | "felzenszwalb";

/** Parameters of the native methods. */
export interface ObiaNativeParams {
  slic: { size: number; compactness: number };
  felzenszwalb: { scale: number; sigma: number; minSize: number };
}

export const DEFAULT_OBIA_NATIVE_PARAMS: ObiaNativeParams = {
  slic: { size: 400, compactness: 0.1 },
  felzenszwalb: { scale: 100, sigma: 0.5, minSize: 50 },
};

/** Whether a method runs natively in the sidecar. */
export const isNativeMethod = (method: ObiaMethod | undefined): method is "slic" | "felzenszwalb" =>
  method === "slic" || method === "felzenszwalb";

/**
 * The local file a layer was loaded from, which the sidecar can read; null
 * for a layer added by URL or from a file the browser holds only in memory.
 */
export function obiaLocalPath(layer: GeoLibreLayer): string | null {
  const path = layer.sourcePath;
  if (!path || /^[a-z][\w+.-]*:\/\//i.test(path) || path.startsWith("blob:")) return null;
  return /\.tiff?$/i.test(path) ? path : null;
}

/** Native availability and each native method's pixel limit. */
export interface ObiaNativeStatus {
  available: boolean;
  maxPixels: Record<"slic" | "felzenszwalb", number>;
}

let statusPromise: Promise<ObiaNativeStatus | null> | null = null;

/**
 * Whether native segmentation is available: a reachable sidecar (the desktop
 * app's, which this starts, or a deployment's server-side one) with
 * scikit-image in its runtime. The first check installs scikit-image, which
 * can take a minute. The Mac App Store build has no sidecar.
 *
 * @returns The availability and native pixel limit, or null when there is no
 *   sidecar to ask.
 */
export function obiaNativeStatus(): Promise<ObiaNativeStatus | null> {
  if (IS_MAS_BUILD) return Promise.resolve(null);
  statusPromise ??= (async () => {
    if (isTauri()) await startGeoLibreSidecar();
    const status = await fetchObiaNativeStatus();
    return {
      available: status.available,
      maxPixels: {
        slic: status.max_pixels?.slic ?? 0,
        felzenszwalb: status.max_pixels?.felzenszwalb ?? 0,
      },
    };
  })().catch(() => {
    // No sidecar (a plain web build): ask again next time, it may start later.
    statusPromise = null;
    return null;
  });
  return statusPromise;
}

/** The native request for a segmentation. */
export function nativeSegmentation(
  path: string,
  bandIndexes: readonly number[],
  area: ObiaReadArea | undefined,
  method: "slic" | "felzenszwalb",
  params: ObiaNativeParams,
): ObiaNativeSegmentation {
  return {
    input_path: path,
    bands: [...bandIndexes],
    area: area ? { level: area.level, window: [...area.window] } : null,
    method,
    slic: method === "slic" ? { ...params.slic } : null,
    felzenszwalb:
      method === "felzenszwalb"
        ? {
            scale: params.felzenszwalb.scale,
            sigma: params.felzenszwalb.sigma,
            min_size: params.felzenszwalb.minSize,
          }
        : null,
  };
}

/** A native call as a provenance entry: the endpoint and its JSON body. */
function callOf(tool: string, body: object): ObiaToolCall {
  return { tool, args: [JSON.stringify(body)] };
}

/**
 * Wait for a sidecar job to finish, reporting its progress lines as steps and
 * cancelling it when the run is cancelled.
 */
async function waitForJob(job: ConversionJob, run: ObiaRunOptions): Promise<ConversionJob> {
  let current = job;
  const cancel = () => void cancelObiaNativeJob(job.id);
  run.onStep?.(job.tool_id);
  run.signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (current.status === "pending" || current.status === "running") {
      if (run.signal?.aborted) {
        cancel();
        throw new DOMException(`${job.tool_id} was cancelled.`, "AbortError");
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      current = await fetchConversionJob(job.id);
    }
  } finally {
    run.signal?.removeEventListener("abort", cancel);
  }
  if (current.status === "cancelled" || run.signal?.aborted) {
    throw new DOMException(`${job.tool_id} was cancelled.`, "AbortError");
  }
  if (current.status !== "succeeded") throw new Error(current.error || `${job.tool_id} failed.`);
  return current;
}

/** Refuse to start a job for a run that is already cancelled. */
function throwIfAborted(run: ObiaRunOptions, tool: string): void {
  if (run.signal?.aborted) throw new DOMException(`${tool} was cancelled.`, "AbortError");
}

/** A finished native segmentation. */
export interface ObiaNativeSegmentResult {
  labels: Uint8Array;
  objects: FeatureCollection;
  objectCount: number;
  width: number;
  height: number;
  pixelSize: number;
  jobId: string;
  call: ObiaToolCall;
}

/**
 * Segment and polygonize natively in the sidecar, and download the label
 * raster and objects.
 *
 * @param request The native segmentation.
 * @param run Cancellation and progress.
 */
export async function runNativeSegmentation(
  request: ObiaNativeSegmentation,
  run: ObiaRunOptions = {},
): Promise<ObiaNativeSegmentResult> {
  throwIfAborted(run, "obia-segment");
  const job = await waitForJob(await startObiaNativeSegment(request), run);
  const result = (job.result ?? {}) as Record<string, number>;
  const [labels, objects] = await Promise.all([
    fetchObiaNativeFile(job.id, "segments.tif"),
    fetchObiaNativeFile(job.id, "objects.geojson"),
  ]);
  return {
    labels,
    objects: JSON.parse(new TextDecoder().decode(objects)) as FeatureCollection,
    objectCount: Number(result.object_count ?? 0),
    width: Number(result.width ?? 0),
    height: Number(result.height ?? 0),
    pixelSize: Number(result.pixel_size ?? 0),
    jobId: job.id,
    call: callOf("obia/segment", { ...request, input_path: undefined }),
  };
}

/**
 * Measure a native segmentation's objects in the sidecar.
 *
 * @param request The segmentation the objects came from.
 * @param options Feature options; texture is not available natively.
 * @param segmentJobId The segmentation's job, whose labels the sidecar reuses
 *   while it keeps them.
 * @param run Cancellation and progress.
 */
export async function runNativeMeasure(
  request: ObiaNativeSegmentation,
  options: ObiaFeatureOptions,
  segmentJobId: string | null,
  run: ObiaRunOptions = {},
): Promise<{ table: ObiaFeatureTable; call: ObiaToolCall }> {
  throwIfAborted(run, "obia-measure");
  const native = { spectral: options.spectral, shape: options.shape, context: options.context };
  const job = await waitForJob(await startObiaNativeMeasure(request, native, segmentJobId), run);
  const csv = new TextDecoder().decode(await fetchObiaNativeFile(job.id, "features.csv"));
  return {
    table: nativeFeatureTable(csv, request.bands, options.spectral ? options.indices : undefined),
    call: callOf("obia/measure", { options: native }),
  };
}
