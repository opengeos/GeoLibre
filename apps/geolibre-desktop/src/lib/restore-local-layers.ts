import { hasPathTraversal, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  isAbsoluteLocalPath,
  isLoadedVectorLayer,
  isRestorableVectorPath,
  isTauri,
  loadDroppedVectorPaths,
} from "./tauri-io";

/**
 * Detects a plain GeoJSON layer saved as a re-readable local-file reference
 * (its `geojson` was stripped on save, leaving only the absolute `sourcePath`),
 * so its features must be reloaded from disk on reopen. Excludes Add Vector
 * Layer control layers (restored by `restoreVectorLayers`) and other
 * external-native/plugin layers, and any non-local `sourcePath`.
 *
 * @param layer - A store layer.
 * @returns True when the layer needs its features re-read from `sourcePath`.
 */
function needsLocalFileReload(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "geojson" &&
    !layer.geojson &&
    layer.metadata.localFileReloadable === true &&
    typeof layer.sourcePath === "string" &&
    isAbsoluteLocalPath(layer.sourcePath) &&
    // Reject a crafted project's `..` traversal or a non-vector extension
    // before re-reading off disk (mirrors restoreVectorLayers' guard).
    !hasPathTraversal(layer.sourcePath) &&
    isRestorableVectorPath(layer.sourcePath) &&
    layer.metadata.externalNativeLayer !== true &&
    layer.metadata.sourceKind == null
  );
}

/**
 * Re-reads desktop local-file GeoJSON layers (drag-dropped or Add Data imports)
 * from their absolute `sourcePath` when a project is reopened, repopulating the
 * `geojson` that was stripped on save. Each source file is read once; a layer
 * whose file can no longer be read (moved or deleted) is removed with a console
 * notice. A no-op off the desktop host (the web cannot read a filesystem path).
 */
export async function restoreLocalFileLayers(): Promise<void> {
  if (!isTauri()) return;
  const pending = useAppStore.getState().layers.filter(needsLocalFileReload);
  if (pending.length === 0) return;

  // Group by path so a multi-layer file (or repeated path) is read only once.
  const byPath = new Map<string, GeoLibreLayer[]>();
  for (const layer of pending) {
    const path = layer.sourcePath as string;
    const group = byPath.get(path);
    if (group) group.push(layer);
    else byPath.set(path, [layer]);
  }

  await Promise.all(
    Array.from(byPath, async ([path, layers]) => {
      try {
        // A KMZ/KML file can yield image overlays alongside its vector layers;
        // only the vector entries carry the `geojson` these layers reload. Skip
        // the KML `<Model>` (COLLADA→GLB) conversion — including any remote-mesh
        // fetch — since the models are discarded by the filter below anyway.
        const loaded = (await loadDroppedVectorPaths([path], { skipModels: true })).filter(
          isLoadedVectorLayer,
        );
        if (loaded.length === 0) {
          dropLayers(layers, path);
          return;
        }
        for (const layer of layers) {
          // One layer per file is the common case; for a multi-layer file match
          // by the layer's display name, then fall back to the first entry.
          let match = loaded[0];
          if (loaded.length > 1) {
            const named = loaded.find((entry) => entry.name === layer.name);
            if (named) {
              match = named;
            } else {
              console.warn(
                `[GeoLibre] Could not match layer "${layer.name}" to a layer in "${path}" by name; using the first. (Renaming a multi-layer file's layers can break this match.)`,
              );
            }
          }
          useAppStore.getState().updateLayer(layer.id, { geojson: match.data });
        }
      } catch (error) {
        console.warn(`[GeoLibre] Could not reload local layer(s) from "${path}".`, error);
        dropLayers(layers, path);
      }
    }),
  );
}

function dropLayers(layers: GeoLibreLayer[], path: string): void {
  for (const layer of layers) {
    console.info(
      `[GeoLibre] Layer "${layer.name}" could not be re-read from "${path}"; removing it.`,
    );
    useAppStore.getState().removeLayer(layer.id);
  }
}
