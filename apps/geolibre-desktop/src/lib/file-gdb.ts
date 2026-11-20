import {
  fetchConversionJob,
  runVectorLayers,
  runVectorToVector,
  type ConversionJob,
  type VectorDatasetLayer,
} from "@geolibre/processing";
import { join, tempDir } from "@tauri-apps/api/path";
import { remove } from "@tauri-apps/plugin-fs";
import type { FeatureCollection } from "geojson";
import i18next from "i18next";
import { readLocalFileBytes } from "./tauri-io";

/**
 * Desktop-only File Geodatabase reads. Neither MapLibre nor DuckDB-WASM can
 * open a `.gdb` (the WASM spatial build lacks the OpenFileGDB driver), so the
 * layer list and the read both go through the Python sidecar's native GDAL.
 * Callers start the sidecar first.
 */

const POLL_INTERVAL_MS = 1000;
// Reading a File Geodatabase layer is a local disk read plus a GeoJSON write,
// but the sidecar's managed runtime may bootstrap itself (download DuckDB) on
// the very first conversion, so the ceiling is generous.
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Poll a sidecar conversion job until it leaves the pending/running states.
 * Resolves with the finished job (whatever its outcome); the caller decides
 * how to surface a failure.
 */
async function waitForConversionJob(initial: ConversionJob): Promise<ConversionJob> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let job = initial;
  while (job.status === "pending" || job.status === "running") {
    if (Date.now() > deadline) throw new Error(i18next.t("addData.gdb.errorTimeout"));
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    job = await fetchConversionJob(job.id);
  }
  return job;
}

/**
 * List a geodatabase's feature classes that carry geometry; attribute-only
 * tables cannot become map layers.
 *
 * @throws When the geodatabase cannot be read (moved, deleted, not a .gdb).
 */
export async function listFileGeodatabaseLayers(gdbPath: string): Promise<VectorDatasetLayer[]> {
  const job = await waitForConversionJob(await runVectorLayers({ input_path: gdbPath }));
  if (job.status !== "succeeded") {
    throw new Error(job.error || i18next.t("addData.gdb.readError"));
  }
  const result = job.result as { layers?: VectorDatasetLayer[] } | undefined;
  return (result?.layers ?? []).filter((layer) => layer.geometry_type);
}

/**
 * Read one feature class as WGS84 GeoJSON.
 *
 * @param sourceCrs - Only sent when the layer itself declares no CRS; the
 *   sidecar otherwise reads it from the dataset.
 */
export async function readFileGeodatabaseLayer(
  gdbPath: string,
  featureClass: string,
  sourceCrs?: string,
): Promise<FeatureCollection> {
  // The sidecar writes the converted layer into the OS temp directory; the
  // file only serves this one read and is removed afterwards.
  const outputPath = await join(
    await tempDir(),
    `geolibre-gdb-${Date.now()}-${Math.random().toString(36).slice(2)}.geojson`,
  );
  // Set once the job is known to have finished on the sidecar; cleanup is
  // gated on it because after a poll timeout (or a mid-poll network error)
  // the job may still be running and writing outputPath — removing it then
  // would unlink the file out from under the write. In that rare case the
  // file is left for the OS temp cleaner instead.
  let jobFinished = false;
  try {
    const job = await waitForConversionJob(
      await runVectorToVector({
        input_path: gdbPath,
        output_path: outputPath,
        input_layer: featureClass,
        target_srs: "EPSG:4326",
        ...(sourceCrs ? { source_srs: sourceCrs } : {}),
      }),
    );
    jobFinished = true;
    if (job.status !== "succeeded") {
      throw new Error(job.error || i18next.t("addData.gdb.convertError"));
    }
    const bytes = await readLocalFileBytes(outputPath);
    return JSON.parse(new TextDecoder("utf-8").decode(bytes)) as FeatureCollection;
  } finally {
    // Best-effort cleanup so repeated imports cannot pile up in temp (the
    // capability grants remove for exactly this filename pattern). A failed
    // conversion already unlinked its partial output server-side, so a
    // missing file here is the normal failure-path outcome.
    if (jobFinished) await remove(outputPath).catch(() => undefined);
  }
}
