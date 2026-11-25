import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { abortReason } from "./abortable";
import type { MbtilesMetadata } from "./mbtiles-sqljs";
import type { NativeOfflinePackage } from "./native-offline-packages";
import type { ProtomapsFlavor } from "@geolibre/map";

export interface NativeMbtilesAreaOptions {
  bbox: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
}

export interface NativeExtractionProgress {
  jobId: string;
  phase: "copying" | "complete";
  tileCount: number;
  payloadBytes: number;
}

export interface NativeMbtilesExtraction {
  package: NativeOfflinePackage;
  tileCount: number;
  payloadBytes: number;
  tileFormat: string;
  sourceLayers: string[];
}

/** Reserve cancellation before native dispatch and release every preparation,
 * listener, and abort subscription even when setup or the worker fails. */
async function withExtractionJob<T>(
  signal: AbortSignal,
  run: (jobId: string) => Promise<T>,
  onProgress?: (progress: NativeExtractionProgress) => void,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  let jobId: string | undefined;
  let unlisten: UnlistenFn | undefined;
  const cancel = () => {
    if (jobId)
      void invoke("cancel_native_offline_extraction", { jobId }).catch((error: unknown) => {
        console.warn("[GeoLibre] Could not cancel native extraction", error);
      });
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    jobId = await invoke<string>("prepare_native_offline_extraction");
    if (signal.aborted) throw abortReason(signal);
    if (onProgress)
      unlisten = await listen<NativeExtractionProgress>(
        "native-offline-extraction-progress",
        ({ payload }) => {
          if (payload.jobId === jobId && !signal.aborted) onProgress(payload);
        },
      );
    if (signal.aborted) throw abortReason(signal);
    // A committed package remains a successful result even if cancellation
    // arrives after native publication. The caller fences stale application.
    return await run(jobId);
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    try {
      void Promise.resolve(unlisten?.()).catch((error: unknown) => {
        console.warn("[GeoLibre] Could not release extraction listener", error);
      });
    } catch (error) {
      console.warn("[GeoLibre] Could not release extraction listener", error);
    }
    cancel();
  }
}

/** Inspect a selected local source through bounded, cancellable native SQLite. */
export function inspectNativeMbtilesSource(
  path: string,
  signal: AbortSignal,
): Promise<MbtilesMetadata> {
  return withExtractionJob(signal, (jobId) =>
    invoke<MbtilesMetadata>("inspect_native_mbtiles_source", { jobId, path }),
  );
}

/** Extract and publish entirely in native storage, without WebView archive bytes. */
export function extractNativeMbtilesPackage(
  path: string,
  name: string,
  options: NativeMbtilesAreaOptions,
  flavor: ProtomapsFlavor | null,
  signal: AbortSignal,
  onProgress?: (progress: NativeExtractionProgress) => void,
): Promise<NativeMbtilesExtraction> {
  return withExtractionJob(
    signal,
    (jobId) =>
      invoke<NativeMbtilesExtraction>("extract_native_mbtiles_package", {
        jobId,
        path,
        name: Array.from(name.replace(/\p{Cc}/gu, " ").trim() || "Offline MBTiles")
          .slice(0, 128)
          .join(""),
        options,
        flavor,
      }),
    onProgress,
  );
}
