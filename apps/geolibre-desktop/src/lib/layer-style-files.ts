/**
 * File pickers for layer styles files (Project → Import → Import Layer Styles,
 * and the Startup setting's style file). The format itself lives in
 * `@geolibre/core` (`layer-style-file.ts`).
 */

import { parseLayerStylesFile, type LayerStyleFileEntry } from "@geolibre/core";
import { openLocalDataFileWithFallback } from "./file-io/file-dialogs";

/** A picked and parsed layer styles file. */
export interface PickedLayerStylesFile {
  /** The picked path (desktop) or file name (browser). */
  path: string;
  /** The file's base name, for display. */
  name: string;
  entries: LayerStyleFileEntry[];
}

/**
 * The base name of a picked path, accepting both separators since a desktop
 * path may come from Windows.
 *
 * @param path - A path or bare file name.
 * @returns The last path segment.
 */
export function layerStylesFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Let the user pick a layer styles file and parse it.
 *
 * @returns The parsed file, or null when the picker was cancelled.
 * @throws Error when the picked file is not a usable layer styles file.
 */
export async function pickLayerStylesFile(): Promise<PickedLayerStylesFile | null> {
  const result = await openLocalDataFileWithFallback({
    filters: [{ name: "GeoLibre Layer Styles", extensions: ["json"] }],
    accept: ".json,application/json",
    readText: true,
  });
  if (!result || result.text === undefined) return null;
  return {
    path: result.path,
    name: layerStylesFileName(result.path),
    entries: parseLayerStylesFile(result.text),
  };
}
