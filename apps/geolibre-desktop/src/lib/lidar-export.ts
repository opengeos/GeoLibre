import { type GeoLibreLayer, resolveReadableUrl } from "@geolibre/core";
import type { LidarFileExtension } from "@geolibre/processing";

import { saveBinaryFileWithFallback } from "./tauri-io";
import { fetchableUrl } from "./url-utils";

/** The point cloud formats a LiDAR layer can be exported to. */
export type LidarExportFormat = "las" | "laz" | "copc";

/** The file extension each export format is written with. */
export const LIDAR_EXPORT_EXTENSION: Record<LidarExportFormat, LidarFileExtension> = {
  las: "las",
  laz: "laz",
  copc: "copc.laz",
};

const FORMAT_DESCRIPTION: Record<LidarExportFormat, string> = {
  las: "LAS point cloud",
  laz: "LAZ point cloud",
  copc: "COPC point cloud",
};

/**
 * The URL holding a LiDAR layer's whole point cloud file, or null.
 *
 * Prefers the blob URL retained for a cloud loaded from bytes (a tool output
 * or a file picked in the LiDAR panel), then the layer's own source URL. An
 * Entwine (`ept.json`) source is a tree of many files, not one, so it is not
 * exportable.
 *
 * @param layer - The LiDAR store layer.
 * @returns An `http(s)`, `blob` or `s3` URL, or null.
 */
export function lidarExportUrl(layer: GeoLibreLayer): string | null {
  if (layer.type !== "lidar") return null;
  const local = fetchableUrl(layer.metadata.localBytesUrl);
  if (local) return local;
  const src = (layer.source as { url?: unknown }).url;
  for (const candidate of [src, layer.sourcePath]) {
    if (typeof candidate !== "string") continue;
    if (/\/ept\.json(\?|$)/i.test(candidate)) return null;
    if (/^s3:\/\//i.test(candidate)) return candidate;
    const url = fetchableUrl(candidate);
    if (url) return url;
  }
  return null;
}

/**
 * Whether a layer is a point cloud that can be exported to LAS/LAZ/COPC.
 *
 * @param layer - The layer to test.
 * @returns True for LiDAR layers backed by a single readable file.
 */
export function canExportLidarLayer(layer: GeoLibreLayer): boolean {
  return lidarExportUrl(layer) !== null;
}

/**
 * Read a LiDAR layer's file bytes.
 *
 * @param layer - The LiDAR store layer.
 * @returns The LAS/LAZ/COPC file bytes.
 * @throws If the layer has no single source file, or it cannot be read.
 */
async function readLidarLayerBytes(layer: GeoLibreLayer): Promise<Uint8Array> {
  const url = lidarExportUrl(layer);
  if (!url) throw new Error("This point cloud has no single source file to export.");
  const response = await fetch(await resolveReadableUrl(url));
  if (!response.ok) {
    throw new Error(`Could not read the point cloud for export (HTTP ${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Convert point cloud bytes to another LAS-family encoding with the
 * geolibre-wasm `lidar_convert` tool, run in the browser.
 *
 * @param bytes - The LAS/LAZ/COPC input bytes.
 * @param target - The extension to write, which picks the output format.
 * @returns The converted file bytes.
 * @throws If the conversion fails (e.g. a cloud too large for WebAssembly).
 */
export async function convertLidarBytes(
  bytes: Uint8Array,
  target: LidarFileExtension,
): Promise<Uint8Array> {
  const { runWhiteboxToolWasm } = await import("@geolibre/processing");
  const job = await runWhiteboxToolWasm({
    tool_id: "lidar_convert",
    parameters: { output: `output.${target}` },
    layer_inputs: { input: { name: "input", kind: "lidar_in", bytes } },
    tool: {
      id: "lidar_convert",
      params: [
        { name: "input", kind: "lidar_in", required: true },
        { name: "output", kind: "lidar_out", required: true },
      ],
    },
  });
  const output = job.outputs.output;
  if (job.status !== "succeeded" || !(output instanceof Uint8Array)) {
    throw new Error(job.error || job.messages.slice(-1)[0] || "Point cloud conversion failed.");
  }
  return output;
}

/**
 * Ready a tool's point cloud output for the map. maplibre-gl-lidar reads a
 * whole LAS/LAZ file only up to LAS 1.3, while Whitebox writes LAS 1.4, so a
 * non-COPC output is converted to COPC, which the viewer streams through
 * copc.js whatever its LAS version.
 *
 * @param bytes - The LAS/LAZ/COPC output bytes.
 * @param fileName - The output file name.
 * @returns The bytes and file name to load (`.copc.laz`).
 * @throws If the conversion fails (e.g. a cloud too large for WebAssembly).
 */
export async function lidarOutputForMap(
  bytes: Uint8Array,
  fileName: string,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const { lidarBytesExtension } = await import("@geolibre/processing");
  const copcName = `${fileName.replace(/\.(copc\.)?la[sz]$/i, "")}.copc.laz`;
  if (lidarBytesExtension(bytes) === "copc.laz") return { bytes, fileName: copcName };
  return { bytes: await convertLidarBytes(bytes, "copc.laz"), fileName: copcName };
}

/**
 * Save a LiDAR layer's point cloud as LAS, LAZ or COPC through the native
 * (Tauri) or browser save dialog. A file already in the chosen encoding is
 * saved as-is; otherwise it is converted in the browser first.
 *
 * @param layer - The LiDAR store layer to export.
 * @param format - The output format.
 * @param baseName - A sanitized base file name (without extension).
 * @returns The saved path, or null if the user cancelled the save dialog.
 * @throws If the cloud cannot be read or converted.
 */
export async function exportLidarLayer(
  layer: GeoLibreLayer,
  format: LidarExportFormat,
  baseName: string,
): Promise<string | null> {
  const { isLas, lidarBytesExtension } = await import("@geolibre/processing");
  const bytes = await readLidarLayerBytes(layer);
  if (!isLas(bytes)) {
    throw new Error("Only LAS, LAZ and COPC point clouds can be exported.");
  }
  const target = LIDAR_EXPORT_EXTENSION[format];
  const output =
    lidarBytesExtension(bytes) === target ? bytes : await convertLidarBytes(bytes, target);
  const description = FORMAT_DESCRIPTION[format];
  // Save dialogs filter on the last extension only, so COPC files match `.laz`.
  const extension = format === "las" ? "las" : "laz";
  return saveBinaryFileWithFallback(output, {
    defaultName: `${baseName.replace(/\.(copc\.)?la[sz]$/i, "")}.${target}`,
    filters: [{ name: description, extensions: [extension] }],
    browserTypes: [{ description, accept: { "application/octet-stream": [`.${extension}`] } }],
    mimeType: "application/octet-stream",
  });
}
