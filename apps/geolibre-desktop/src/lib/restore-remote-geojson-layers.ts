import {
  rememberFetchedGeoJson,
  remoteGeoJsonUrl,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import i18next from "i18next";
import { fetchGeoJsonFeatureCollection } from "./data-url";
import { notify } from "./notify";

/**
 * Layer sources already fetched, being fetched, or failed. Keyed by the
 * `source` object rather than the layer id, so reopening a project (which
 * builds new layer records) tries again, while a map re-init or renderer swap
 * that re-runs restore over the same records does not refetch or re-warn.
 */
const attemptedSources = new WeakSet<object>();

/**
 * The URL root-relative layer sources resolve against: the page the app runs
 * from, so `/data/farm.geojson` reads from the same origin as the app.
 */
function pageUrl(): string {
  return typeof window === "undefined" ? "http://localhost/" : window.location.href;
}

/**
 * Fetch the features of plain GeoJSON layers that reference their data by URL
 * (`source.data` or `source.url`) instead of carrying it inline, so a project
 * file written that way renders instead of listing layers that draw nothing
 * (GeoLibre#3508). Each fetched collection is remembered as such, so saving
 * the project keeps the URL reference rather than embedding the download.
 *
 * A layer whose data cannot be fetched stays in the project, empty, with a
 * warning naming it: unlike a moved local file, a remote URL may be back on
 * the next open, and dropping the layer would lose it from the file on save.
 */
export async function restoreRemoteGeoJsonLayers(): Promise<void> {
  const base = pageUrl();
  const pending = useAppStore.getState().layers.flatMap((layer) => {
    const url = remoteGeoJsonUrl(layer, base);
    return url !== null && !attemptedSources.has(layer.source) ? [{ layer, url }] : [];
  });
  if (pending.length === 0) return;
  for (const { layer } of pending) attemptedSources.add(layer.source);

  await Promise.all(
    pending.map(async ({ layer, url }) => {
      try {
        const geojson = await fetchGeoJsonFeatureCollection(url);
        if (!isStillWaiting(layer)) return;
        useAppStore.getState().updateLayer(layer.id, { geojson: rememberFetchedGeoJson(geojson) });
      } catch (error) {
        // A request from a project that has since been replaced, or for a
        // layer removed meanwhile, has no one left to warn.
        if (!isStillWaiting(layer)) return;
        console.warn(`[GeoLibre] Could not fetch GeoJSON for layer "${layer.name}".`, error);
        notify.warning(
          i18next.t("notifications.remoteGeoJsonFetchFailed", {
            layer: layer.name,
            error: error instanceof Error ? error.message : String(error),
          }),
          { durationMs: null, dedupeKey: `remote-geojson-failed:${layer.id}` },
        );
      }
    }),
  );
}

/**
 * Whether a layer is still the record a fetch was started for: present, with
 * the same `source` object, and still without features. It may have been
 * removed, replaced by another project's, or given features some other way
 * while the request was in flight.
 *
 * @param layer - The layer record the fetch was started for.
 * @returns True when the fetch result still belongs to the live layer.
 */
function isStillWaiting(layer: GeoLibreLayer): boolean {
  const current = useAppStore.getState().layers.find((entry) => entry.id === layer.id);
  return current !== undefined && current.source === layer.source && !current.geojson;
}

/**
 * Fill a layer that references its GeoJSON by URL with the fetched features
 * before it is added to the store — the embed `addLayer` path, which reports
 * a failed fetch to the host instead of adding a layer that draws nothing.
 *
 * @param layer - The layer about to be added.
 * @param options - Optional abort signal.
 * @returns The layer with `geojson` filled in, or the layer unchanged when it
 *   needs no fetch.
 * @throws When the referenced data cannot be fetched or is not GeoJSON.
 */
export async function withFetchedRemoteGeoJson<T extends Parameters<typeof remoteGeoJsonUrl>[0]>(
  layer: T,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const url = remoteGeoJsonUrl(layer, pageUrl());
  if (!url) return layer;
  const geojson = await fetchGeoJsonFeatureCollection(url, options);
  return { ...layer, geojson: rememberFetchedGeoJson(geojson) };
}
