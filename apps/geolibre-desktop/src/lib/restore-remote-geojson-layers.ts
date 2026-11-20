import {
  geoJsonSourceReferences,
  rememberFetchedGeoJson,
  remoteGeoJsonUrl,
  useAppStore,
  withoutHistory,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import i18next from "i18next";
import { fetchGeoJsonFeatureCollection } from "./data-url";
import type { AddLayerSpec } from "@geolibre/embed";
import { assertLayerIdAvailable, buildEmbedLayer } from "./embed-api";
import { isTauri } from "./is-tauri";
import { notify } from "./notify";

/**
 * Layer sources already fetched, being fetched, or failed. Keyed by the
 * `source` object rather than the layer id, so reopening a project (which
 * builds new layer records) tries again, while a map re-init or renderer swap
 * that re-runs restore over the same records does not refetch or re-warn.
 */
const attemptedSources = new WeakSet<object>();

/** How many layer downloads restore runs at once, bounding peak memory. */
const RESTORE_CONCURRENCY = 4;

/**
 * How long one layer download may take before it is abandoned, so a host
 * that never finishes a response cannot hold a worker and starve the queue.
 */
const RESTORE_TIMEOUT_MS = 60_000;

/**
 * The URL root-relative layer sources resolve against: the page the app runs
 * from, so `/data/farm.geojson` reads from the same origin as the app. Null
 * on the desktop, where a leading `/` is a filesystem path, not a URL.
 */
function pageUrl(): string | null {
  if (isTauri()) return null;
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
  const pending: { layer: GeoLibreLayer; url: string }[] = [];
  for (const layer of useAppStore.getState().layers) {
    if (attemptedSources.has(layer.source)) continue;
    const references = geoJsonSourceReferences(layer);
    if (references.length === 0) continue;
    attemptedSources.add(layer.source);
    const url = remoteGeoJsonUrl(layer, base);
    if (url) pending.push({ layer, url });
    // A reference this app cannot fetch (a relative path, `//host/…`, or a
    // `/path` on the desktop) would otherwise leave the layer silently empty.
    else warnNoData(layer, unfetchableReferenceMessage(references[0]));
  }
  if (pending.length === 0) return;

  const restoreOne = async ({ layer, url }: (typeof pending)[number]): Promise<void> => {
    // Skip a queued layer removed or replaced before its turn came.
    if (!isStillWaiting(layer)) return;
    try {
      const geojson = await fetchGeoJsonFeatureCollection(url, {
        signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS),
      });
      if (!isStillWaiting(layer)) return;
      // Loading what the file references is part of opening it: not an undo
      // step, and not an unsaved change (as in fetchStartupLayerFeatures).
      withoutHistory(() => {
        const wasDirty = useAppStore.getState().isDirty;
        useAppStore.getState().updateLayer(layer.id, { geojson: rememberFetchedGeoJson(geojson) });
        if (!wasDirty) useAppStore.setState({ isDirty: false });
      });
      rememberDerivedGeoJson(layer.id, geojson);
    } catch (error) {
      // A request from a project that has since been replaced, or for a
      // layer removed meanwhile, has no one left to warn.
      if (!isStillWaiting(layer)) return;
      console.warn(`[GeoLibre] Could not fetch GeoJSON for layer "${layer.name}".`, error);
      warnNoData(layer, error instanceof Error ? error.message : String(error));
    }
  };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pending.length) await restoreOne(pending[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(RESTORE_CONCURRENCY, pending.length) }, worker));
}

/**
 * Keep a layer counted as fetched after the store re-derives its features.
 *
 * Writing `geojson` re-applies a layer's joins and virtual fields, which
 * yields a new collection. That collection is still just the download plus
 * derived columns (rebuilt on every open), so it is marked too; otherwise the
 * next save would embed it and drop the URL reference.
 *
 * @param layerId - The layer just written.
 * @param fetched - The collection that was written.
 */
function rememberDerivedGeoJson(layerId: string, fetched: FeatureCollection): void {
  const current = useAppStore.getState().layers.find((entry) => entry.id === layerId)?.geojson;
  if (current && current !== fetched) rememberFetchedGeoJson(current);
}

/**
 * Why a layer's data reference was not fetched.
 *
 * @param reference - The layer's first `source.data` / `source.url` string.
 * @returns A message naming the reference and the accepted forms.
 */
function unfetchableReferenceMessage(reference: string): string {
  return isTauri()
    ? `${reference} is not an http(s) URL.`
    : `${reference} is not an http(s) URL or a path starting with "/".`;
}

/**
 * Warn that a layer was left without data.
 *
 * @param layer - The layer that stays empty.
 * @param reason - What went wrong, shown after the layer name.
 */
function warnNoData(layer: GeoLibreLayer, reason: string): void {
  notify.warning(
    i18next.t("notifications.remoteGeoJsonFetchFailed", { layer: layer.name, error: reason }),
    {
      durationMs: null,
      dedupeKey: `remote-geojson-failed:${layer.id}`,
    },
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
 * @throws When the referenced data cannot be fetched or is not GeoJSON, or
 *   the layer names its data by a reference this app cannot fetch.
 */
export async function withFetchedRemoteGeoJson<T extends Parameters<typeof remoteGeoJsonUrl>[0]>(
  layer: T,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const url = remoteGeoJsonUrl(layer, pageUrl());
  if (!url) {
    const [reference] = geoJsonSourceReferences(layer);
    if (reference !== undefined) throw new Error(unfetchableReferenceMessage(reference));
    return layer;
  }
  const geojson = await fetchGeoJsonFeatureCollection(url, options);
  return { ...layer, geojson: rememberFetchedGeoJson(geojson) };
}

/**
 * Run an embed `addLayer` command: build the layer, fetch a URL-referenced
 * GeoJSON source first (#3508) so a bad URL fails the call instead of acking a
 * layer that draws nothing, then add it to the store.
 *
 * @param spec - The validated `addLayer` spec from the host.
 * @param signal - Aborted when the embed is torn down.
 * @returns The new layer's id.
 * @throws When the capability is missing, the id is taken, the fetch fails or
 *   is aborted, or a project load replaced the layers while it ran.
 */
export async function addEmbedLayer(spec: AddLayerSpec, signal?: AbortSignal): Promise<string> {
  const state = useAppStore.getState();
  if (!state.deploymentCapabilities.has("data:add")) {
    throw new Error("Missing data:add capability");
  }
  const layer = await withFetchedRemoteGeoJson(buildEmbedLayer(spec, state.layers), { signal });
  signal?.throwIfAborted();
  // A project load replaces every layer; one fetched for the previous project
  // must not land in the new one.
  if (useAppStore.getState().projectGeneration !== state.projectGeneration) {
    throw new Error("The project changed while the layer was loading");
  }
  // The fetch yields, so another command may have taken the id meanwhile.
  assertLayerIdAvailable(layer.id, useAppStore.getState().layers);
  useAppStore.getState().addLayer(layer, spec.beforeId);
  return layer.id;
}
