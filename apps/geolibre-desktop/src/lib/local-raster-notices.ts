/**
 * In-app notices for local rasters a project file cannot carry (GeoLibre#3120).
 * A raster read from a local file lives behind a session blob URL, which is
 * never saved, so a project reopens it only from a recorded desktop path. These
 * tell the user when a save leaves one out and when a reopen drops one, instead
 * of the layer silently disappearing.
 */

import type { GeoLibreLayer } from "@geolibre/core";
import { isUnsavableLocalRaster } from "@geolibre/plugins";
import i18next from "i18next";
import { notify } from "./notify";
import { isTauri } from "./is-tauri";

/**
 * Joins layer names into a quoted, locale-aware list ("a", "b", and "c").
 *
 * @param names - The layer names.
 * @returns The formatted list.
 */
function formatLayerNames(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  try {
    return new Intl.ListFormat(i18next.language || undefined, { type: "conjunction" }).format(
      quoted,
    );
  } catch {
    return quoted.join(", ");
  }
}

/**
 * Warns, after a save, about local rasters the saved file cannot reload. On the
 * web that is every local raster; on desktop only those without a file path.
 *
 * @param layers - The layers that were saved.
 */
export function notifyUnsavedLocalRasters(layers: readonly GeoLibreLayer[]): void {
  const desktop = isTauri();
  const names = layers
    .filter((layer) => isUnsavableLocalRaster(layer, desktop))
    .map((layer) => layer.name);
  if (names.length === 0) return;
  notify.warning(i18next.t("raster.localRasterNotSaved", { count: names.length }), {
    description: i18next.t(
      desktop ? "raster.localRasterNotSavedDescDesktop" : "raster.localRasterNotSavedDesc",
      { names: formatLayerNames(names) },
    ),
    durationMs: null,
    // Every Save repeats the same warning; collapse it instead of stacking.
    dedupeKey: `local-raster-not-saved:${names.join("\n")}`,
  });
}

/**
 * Tells the user which local rasters a reopened project could not reload.
 * Registered with the raster plugin, which has no notification API.
 *
 * @param names - The dropped layers' names.
 */
export function notifyUnrestorableRasters(names: string[]): void {
  if (names.length === 0) return;
  notify.warning(i18next.t("raster.localRasterNotRestored", { count: names.length }), {
    description: i18next.t("raster.localRasterNotRestoredDesc", {
      names: formatLayerNames(names),
    }),
    durationMs: null,
    // A project replayed again (a renderer swap) reports the same layers;
    // collapse the repeat instead of stacking another toast.
    dedupeKey: `local-raster-not-restored:${names.join("\n")}`,
  });
}
