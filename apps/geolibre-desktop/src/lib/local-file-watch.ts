import { hasPathTraversal, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  isAbsoluteLocalPath,
  isLoadedVectorLayer,
  isRestorableVectorPath,
  loadDroppedVectorPaths,
} from "./tauri-io";

/**
 * Per-layer "watch this local file for changes" configuration, persisted under
 * `layer.metadata.watch`. Only `enabled` is stored for now; the object shape
 * leaves room to grow (e.g. a debounce interval) without a schema migration.
 */
export interface LayerWatchConfig {
  enabled: boolean;
}

/**
 * True when a layer is a plain local-file vector layer whose features can be
 * re-read from disk (the desktop drag-drop / Add Data import path). These carry
 * their absolute source path in `sourcePath` and hold their features inline as
 * GeoJSON, so a reload re-runs the same on-disk conversion and swaps `geojson`.
 *
 * The predicate mirrors `restore-local-layers`' `needsLocalFileReload` guard
 * (absolute local path, no traversal, a restorable vector extension, not an
 * external-native/plugin layer, no `sourceKind`) but does NOT require the
 * `localFileReloadable` save flag or an empty `geojson` — a freshly imported
 * layer that still holds its features is exactly what we want to be able to
 * reload and watch. HTTP(S) URL layers are excluded here and refresh through
 * the URL path in `layer-refresh.ts` instead.
 *
 * Being on the desktop host is a separate, runtime concern the caller gates
 * with `isTauri()`; this stays a pure, testable predicate.
 *
 * @param layer - A store layer.
 * @returns Whether the layer's features can be reloaded from `sourcePath`.
 */
export function isLocalFileLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "geojson" &&
    typeof layer.sourcePath === "string" &&
    isAbsoluteLocalPath(layer.sourcePath) &&
    !hasPathTraversal(layer.sourcePath) &&
    isRestorableVectorPath(layer.sourcePath) &&
    layer.metadata.externalNativeLayer !== true &&
    layer.metadata.sourceKind == null
  );
}

/**
 * Reads the persisted watch config off a layer's metadata, tolerating both the
 * current `{ enabled: true }` object form and a bare `true` (in case a
 * hand-edited project uses the shorthand).
 *
 * @param layer - A store layer.
 * @returns The normalized watch config.
 */
export function getLayerWatchConfig(layer: GeoLibreLayer): LayerWatchConfig {
  const watch = layer.metadata.watch;
  if (watch === true) return { enabled: true };
  if (watch && typeof watch === "object" && !Array.isArray(watch)) {
    return { enabled: (watch as Partial<LayerWatchConfig>).enabled === true };
  }
  return { enabled: false };
}

/**
 * Returns a metadata patch that enables or disables watch mode for a layer.
 * Disabling omits the `watch` key entirely so saved projects do not accumulate
 * meaningless `{ enabled: false }` entries (matching `setLayerRefreshConfig`).
 *
 * @param layer - The layer whose metadata to patch.
 * @param enabled - Whether watch mode should be on.
 * @returns A `Partial<GeoLibreLayer>` suitable for `updateLayer`.
 */
export function setLayerWatchConfig(
  layer: GeoLibreLayer,
  enabled: boolean,
): Partial<GeoLibreLayer> {
  const { watch: _watch, ...restMetadata } = layer.metadata;
  return {
    metadata: enabled ? { ...restMetadata, watch: { enabled: true } } : restMetadata,
  };
}

/**
 * Re-reads a local-file vector layer's features from disk. Runs the same
 * conversion pipeline as the original import (`loadDroppedVectorPaths`), so
 * every supported vector format reloads the same way it first loaded.
 *
 * A single-layer file (the common case, and every GeoJSON) reloads
 * unconditionally. For a multi-layer file (e.g. a GPX with Waypoints/Tracks/
 * Routes) the entry is matched back to the layer by display name; unlike the
 * once-on-reopen `restoreLocalFileLayers`, this backs the interactive Reload /
 * Watch actions, which can run *after* the user renamed the layer. Rather than
 * silently swapping in the wrong sub-layer's geometry when the name no longer
 * matches, this throws so the mismatch surfaces instead of corrupting the layer.
 *
 * Note: `onLargeDataset` is intentionally omitted, so a large file materializes
 * without prompting. A prompt would be wrong for the automatic Watch path (it
 * would pop on every debounced disk write); the manual Reload is an explicit
 * user action on a file they already imported, so the original import's prompt
 * has already been answered.
 *
 * @param layer - A layer for which {@link isLocalFileLayer} is true.
 * @returns The refreshed GeoJSON and its feature count.
 * @throws If the file yields no vector layers (moved, deleted, or now empty),
 *   or if a multi-layer file no longer has an entry matching the layer's name.
 */
export async function reloadLocalFileLayer(
  layer: GeoLibreLayer,
): Promise<{ geojson: FeatureCollection; featureCount: number }> {
  const path = layer.sourcePath;
  if (typeof path !== "string" || !path) {
    throw new Error("This layer has no local file to reload.");
  }

  const loaded = (await loadDroppedVectorPaths([path], { skipModels: true })).filter(
    isLoadedVectorLayer,
  );
  if (loaded.length === 0) {
    throw new Error("This file no longer contains any readable vector data.");
  }

  let match = loaded[0];
  if (loaded.length > 1) {
    const named = loaded.find((entry) => entry.name === layer.name);
    if (!named) {
      throw new Error(
        `Could not match "${layer.name}" to a layer in this file. Renaming a layer from a multi-layer file breaks its link to the source; re-add the file to reload it.`,
      );
    }
    match = named;
  }

  return { geojson: match.data, featureCount: match.data.features.length };
}
