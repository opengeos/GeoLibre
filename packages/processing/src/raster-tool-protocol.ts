// The message protocol of the browser raster tools worker (issue #3701).
//
// The worker (raster-tool.worker.ts) only wires `handleRasterToolRequest` to
// its global scope, so the protocol is tested here without a real Worker.
import {
  runRasterToolClientAsync,
  type ClientToolInputs,
  type ClientToolProgress,
  type ClientToolResult,
  type RasterData,
} from "./raster-client";

/** The one request a raster tool worker handles: a whole tool run. */
export interface RasterToolWorkerRequest {
  toolId: string;
  inputs: ClientToolInputs;
  parameters: Record<string, unknown>;
}

/** What the worker posts back: any number of progress lines, then one result or error. */
export type RasterToolWorkerMessage =
  | { type: "progress"; progress: ClientToolProgress }
  | { type: "result"; result: ClientToolResult }
  | { type: "error"; name: string; message: string };

/** Posts a message, moving the listed buffers instead of copying them. */
export type RasterToolPost = (message: RasterToolWorkerMessage, transfer: ArrayBuffer[]) => void;

/**
 * The distinct `ArrayBuffer`s behind a set of rasters' bands, for a transfer
 * list. A buffer listed twice makes `postMessage` throw, and bands can share
 * one, so they are deduplicated; shared memory cannot be transferred at all.
 *
 * @param rasters - Rasters whose band buffers move with the message.
 * @returns The buffers to transfer.
 */
export function rasterTransferables(rasters: Iterable<RasterData | undefined>): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const raster of rasters) {
    for (const band of raster?.bands ?? []) {
      if (band.buffer instanceof ArrayBuffer && band.buffer.byteLength > 0) {
        buffers.add(band.buffer);
      }
    }
  }
  return [...buffers];
}

/**
 * The buffers a request can move to the worker: every input raster's bands.
 *
 * @param request - The run about to be posted.
 * @returns The buffers to transfer.
 */
export function requestTransferables(request: RasterToolWorkerRequest): ArrayBuffer[] {
  const { raster, rasters } = request.inputs;
  return rasterTransferables([raster, ...Object.values(rasters ?? {})]);
}

/**
 * The buffers a result can move back: the result bands and the encoded
 * GeoTIFF.
 *
 * @param result - The finished run.
 * @returns The buffers to transfer.
 */
export function resultTransferables(result: ClientToolResult): ArrayBuffer[] {
  if (result.kind !== "raster") return [];
  const buffers = rasterTransferables([result.raster]);
  if (result.bytes instanceof ArrayBuffer && !buffers.includes(result.bytes)) {
    buffers.push(result.bytes);
  }
  return buffers;
}

/**
 * Run one request and post its progress, then its result or error.
 *
 * @param request - The tool, inputs and parameters.
 * @param post - Sends a message back to the caller.
 */
export async function handleRasterToolRequest(
  request: RasterToolWorkerRequest,
  post: RasterToolPost,
): Promise<void> {
  try {
    const result = await runRasterToolClientAsync(
      request.toolId,
      request.inputs,
      request.parameters,
      { onProgress: (progress) => post({ type: "progress", progress }, []) },
    );
    post({ type: "result", result }, resultTransferables(result));
  } catch (error) {
    post(
      {
        type: "error",
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
      [],
    );
  }
}
