import { localFileName } from "@geolibre/core";
import i18n from "../../i18n";
import type { LargeVectorDataset } from "../../lib/duckdb-vector-guard";
import type { loadDroppedVectorFiles } from "../../lib/tauri-io";

/**
 * Confirm loading a vector source whose feature count tripped the loader's
 * large-dataset guard. Mirrors the OSM PBF drop guard's blocking
 * `window.confirm` (see the handlers below): a `false` return aborts that one
 * file's load without affecting the rest of a multi-file drop.
 */
export function confirmLargeVectorDataset({ name, featureCount }: LargeVectorDataset) {
  return window.confirm(
    i18n.t("toolbar.item.largeVectorDesc", {
      name,
      count: featureCount.toLocaleString(),
    }),
  );
}

export function fileNameFromPath(path: string): string {
  return localFileName(path);
}

export function layerNameFromPath(path: string): string {
  return fileNameFromPath(path).replace(/\.[^.]+$/, "") || "Vector Layer";
}

export type ImportedVectorLayer = Awaited<ReturnType<typeof loadDroppedVectorFiles>>[number];
