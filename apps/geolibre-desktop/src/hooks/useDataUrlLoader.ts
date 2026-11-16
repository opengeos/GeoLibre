import { useAppStore } from "@geolibre/core";
import { applyMapboxStyleImport, parseMapboxStyle } from "@geolibre/map";
import {
  addLidarLayerFromUrl,
  addPMTilesLayerFromUrl,
  addRasterToMap,
  addVectorLayerFromUrl,
  findFileHandlerByDataType,
  isRecoverableNonTiledRasterError,
  listFileHandlers,
  routeKmlFileSelection,
} from "@geolibre/plugins";
import i18next from "i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  dataUrlParameters,
  type DataTypeHint,
  fetchRemoteData,
  fetchRemoteStyle,
  layerPointsAt,
  loadDataUrlBatch,
  mapboxStyleForDataLayer,
  parseRasterUrlStyle,
} from "../lib/data-url";
import { deepLinkCogDefaults } from "../lib/cog-render-engine";
import { queueDataLoad } from "../lib/data-load-queue";
import {
  discardHandledLayers,
  fetchStyleUnlessHandlerHint,
  finishHandledLoad,
  trackHandlerLayers,
  urlFileHandlers,
} from "../lib/data-url-file-handlers";
import { notify } from "../lib/notify";
import { isViewerLayout } from "./useLayoutOptions";
import { type createAppAPI, whenPluginsSettled } from "./usePlugins";
import type { ProjectUrlLoadState } from "./useProjectUrlLoader";

/** `fitLayerIds` carries the layers the shell still has to frame. */
export type DataUrlLoadState = ProjectUrlLoadState & { fitLayerIds?: string[] };

export interface DataUrlLoadResult {
  layerIds: string[];
  fitLayerIds: string[];
}

/**
 * The plugin file handlers a URL load may use, or undefined where the drop path
 * is closed too: the read-only viewer and a deployment without `data:add`. Plugin
 * activation is awaited (bounded) before the first offer, since `?data=` loads at
 * startup while plugins register their handlers asynchronously.
 */
function fileHandlersForLoad() {
  return urlFileHandlers({
    isViewer: () => typeof window !== "undefined" && isViewerLayout(window.location.search),
    canAddData: () => useAppStore.getState().deploymentCapabilities.has("data:add"),
    source: {
      list: listFileHandlers,
      forDataType: findFileHandlerByDataType,
      ready: whenPluginsSettled,
    },
  });
}

/** Load one URL through the same remote-data pipeline used by the `?data=` deep link. */
export async function loadDataUrl(
  mapAppAPI: ReturnType<typeof createAppAPI>,
  dataUrl: string,
  options: {
    styleUrl?: string | null;
    dataType?: DataTypeHint | null;
    signal?: AbortSignal;
    fit?: boolean;
  } = {},
): Promise<DataUrlLoadResult> {
  const fit = options.fit ?? true;
  const layerStore = {
    layerIds: () => useAppStore.getState().layers.map((layer) => layer.id),
    removeLayer: (id: string) => useAppStore.getState().removeLayer(id),
  };
  // Only the layers added while a handler's `open` runs are the handler's.
  const gated = fileHandlersForLoad();
  const tracking = gated ? trackHandlerLayers(gated, layerStore) : null;
  // One failing request ends the other at once, so its error shows without
  // waiting for a download that can no longer be used.
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (options.signal?.aborted) stop();
  else options.signal?.addEventListener("abort", stop, { once: true });
  const remotePromise = fetchRemoteData(dataUrl, {
    signal: controller.signal,
    dataType: options.dataType,
    fileHandlers: tracking?.source,
    hasStyle: Boolean(options.styleUrl),
  });
  const stylePromise = options.styleUrl
    ? fetchStyleUnlessHandlerHint({
        handlers: tracking?.source,
        dataType: options.dataType,
        fetchStyle: () => fetchRemoteStyle(options.styleUrl!, { signal: controller.signal }),
        signal: controller.signal,
      })
    : Promise.resolve(null);
  remotePromise.catch(stop);
  stylePromise.catch(stop);
  let remote: Awaited<typeof remotePromise>;
  let rawStyle: Awaited<ReturnType<typeof fetchRemoteStyle>> | null;
  try {
    [remote, rawStyle] = await Promise.all([remotePromise, stylePromise]);
  } catch (error) {
    // The style failed after a handler already ran: take its layers back.
    const handled = await remotePromise.catch(() => null);
    if (handled?.kind === "handled") discardHandledLayers(layerStore, tracking?.added ?? []);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", stop);
  }
  if (remote.kind === "handled") {
    const layerIds = finishHandledLoad({
      remote,
      hasStyle: rawStyle !== null,
      added: tracking?.added ?? new Set(),
      store: layerStore,
      signal: options.signal,
    });
    // Framed like the built-in GeoJSON path: the shell fits the set once.
    return { layerIds, fitLayerIds: layerIds };
  }
  if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  const store = useAppStore.getState();
  const layerIds: string[] = [];
  const fitLayerIds: string[] = [];
  if (remote.kind === "cog") {
    const rasterStyle = rawStyle === null ? null : parseRasterUrlStyle(rawStyle);
    let id: string;
    try {
      id = await addRasterToMap(mapAppAPI, remote.url, {
        name: remote.name,
        // A URL loader starts an empty workspace, whose raster control defaults
        // to the native, globe-compatible WASM renderer. Do not override the
        // control-wide engine when adding this layer.
        defaults: deepLinkCogDefaults(),
        zoomTo: fit,
        ...(rasterStyle ? { state: rasterStyle } : {}),
      });
    } catch (error) {
      // A striped GeoTIFF is not a failure: the raster control hands it to the
      // convert-to-COG offer, which owns the layer from here (it adds the
      // converted raster or, when declined, removes the striped one).
      if (isRecoverableNonTiledRasterError(error)) {
        if (options.signal?.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        return { layerIds, fitLayerIds };
      }
      throw error;
    }
    if (options.signal?.aborted) {
      store.removeLayer(id);
      throw new DOMException("The operation was aborted", "AbortError");
    }
    layerIds.push(id);
  } else if (remote.kind === "lidar") {
    if (rawStyle !== null) {
      throw new Error("A style cannot be applied to a LiDAR point cloud.");
    }
    const id = await addLidarLayerFromUrl(mapAppAPI, remote.url, { fit });
    if (!id) throw new Error(`Could not add ${remote.name} to the map.`);
    if (options.signal?.aborted) {
      store.removeLayer(id);
      throw new DOMException("The operation was aborted", "AbortError");
    }
    layerIds.push(id);
  } else if (remote.kind === "kml") {
    if (rawStyle !== null) throw new Error(i18next.t("kml.dataUrlStyleUnsupported"));
    const previousIds = new Set(store.layers.map((layer) => layer.id));
    // The host importer frames the import itself (honouring the zoom-to-new-layers
    // preference) and reports its own failures, so an empty result is the only
    // signal here that nothing was added.
    if (!(await routeKmlFileSelection([{ file: remote.file }]))) {
      throw new Error(i18next.t("kml.dataUrlNoImporter", { name: remote.name }));
    }
    const added = useAppStore
      .getState()
      .layers.filter((layer) => !previousIds.has(layer.id))
      .map((layer) => layer.id);
    if (!added.length) throw new Error(i18next.t("kml.dataUrlAddFailed", { name: remote.name }));
    if (options.signal?.aborted) {
      for (const id of added) store.removeLayer(id);
      throw new DOMException("The operation was aborted", "AbortError");
    }
    layerIds.push(...added);
  } else if (remote.kind === "pmtiles" || remote.kind === "vector") {
    const styleResult = rawStyle === null ? null : parseMapboxStyle(rawStyle);
    if (styleResult && styleResult.matchedLayerCount === 0) {
      throw new Error("The remote style has no supported vector style layers.");
    }
    const previousIds = new Set(store.layers.map((layer) => layer.id));
    const added =
      remote.kind === "pmtiles"
        ? await addPMTilesLayerFromUrl(mapAppAPI, remote.url, { fit })
        : await addVectorLayerFromUrl(mapAppAPI, remote.url, {
            name: remote.name,
            fitBounds: fit,
          });
    if (!added) throw new Error(`Could not add ${remote.name} to the map.`);
    const addedLayers = useAppStore
      .getState()
      .layers.filter((layer) => !previousIds.has(layer.id) && layerPointsAt(layer, remote.url));
    if (!addedLayers.length) {
      throw new Error(
        `The ${remote.kind === "pmtiles" ? "PMTiles" : "GeoParquet"} loader did not create a layer for ${remote.url}.`,
      );
    }
    if (options.signal?.aborted) {
      for (const layer of addedLayers) store.removeLayer(layer.id);
      throw new DOMException("The operation was aborted", "AbortError");
    }
    if (styleResult && addedLayers.some((layer) => layer.metadata.tileType === "raster")) {
      for (const layer of addedLayers) store.removeLayer(layer.id);
      throw new Error("MapLibre vector styles cannot be applied to a raster PMTiles archive.");
    }
    if (styleResult) {
      for (const layer of addedLayers) {
        store.setLayerStyle(layer.id, applyMapboxStyleImport(layer.style, styleResult));
      }
    }
    layerIds.push(...addedLayers.map((layer) => layer.id));
  } else {
    const imports = remote.layers.map((layer) => {
      if (rawStyle === null) return { layer, styleResult: null };
      const styleResult = parseMapboxStyle(mapboxStyleForDataLayer(rawStyle, layer.name));
      if (styleResult.matchedLayerCount === 0) {
        throw new Error(
          `The remote style has no supported layers for "${layer.name}.geojson". ` +
            `Set each style layer's source to the matching filename stem (for example, "${layer.name}").`,
        );
      }
      return { layer, styleResult };
    });
    for (const { layer, styleResult } of imports) {
      const id = store.addGeoJsonLayer(layer.name, layer.data, layer.sourcePath);
      layerIds.push(id);
      fitLayerIds.push(id);
      if (styleResult) {
        const current = useAppStore.getState().layers.find((candidate) => candidate.id === id);
        if (current) store.setLayerStyle(id, applyMapboxStyleImport(current.style, styleResult));
      }
    }
  }
  return { layerIds, fitLayerIds };
}

export function useDataUrlLoader(
  mapAppAPI: ReturnType<typeof createAppAPI> | null,
): DataUrlLoadState {
  const params = useMemo(
    () => (typeof window === "undefined" ? null : dataUrlParameters(window.location.search)),
    [],
  );
  const timeoutRef = useRef<number | null>(null);
  const [state, setState] = useState<DataUrlLoadState>({
    error: null,
    message: null,
    status: "idle",
  });

  useEffect(() => {
    if (!params || !mapAppAPI) return;
    const controller = new AbortController();
    setState({ error: null, message: "Loading data from URL…", status: "loading" });
    const load = async () => {
      // Preserve the established one-dataset behavior. For a batch, prevent
      // each format-specific loader from moving the camera and let the shell
      // frame the complete set once all entries have finished.
      if (params.length === 1) {
        const [entry] = params;
        return loadDataUrl(mapAppAPI, entry.dataUrl, {
          styleUrl: entry.styleUrl,
          dataType: entry.dataType,
          signal: controller.signal,
        });
      }
      // One entry that fails (an unreachable host, an unsupported file) must
      // not take the rest of the link down with it: load every entry that can
      // be loaded, report each failure, and fail the link only when nothing
      // loaded at all.
      const layerIds = await loadDataUrlBatch(
        params,
        async (entry) =>
          (
            await loadDataUrl(mapAppAPI, entry.dataUrl, {
              styleUrl: entry.styleUrl,
              dataType: entry.dataType,
              signal: controller.signal,
              fit: false,
            })
          ).layerIds,
        {
          removeLayer: (id) => useAppStore.getState().removeLayer(id),
          onEntryError: (error) => {
            const message =
              error instanceof Error ? error.message : i18next.t("notifications.dataUrlLoadFailed");
            notify.error(message, { dedupeKey: `url-load:data:${message}` });
          },
        },
      );
      return { layerIds, fitLayerIds: layerIds };
    };
    void queueDataLoad(load)
      .then(({ layerIds, fitLayerIds }) => {
        if (controller.signal.aborted) return;
        setState({
          error: null,
          fitLayerIds,
          message: `Loaded ${layerIds.length} layer${layerIds.length === 1 ? "" : "s"} from URL`,
          status: "loaded",
        });
        timeoutRef.current = window.setTimeout(() => {
          timeoutRef.current = null;
          setState({ error: null, message: null, status: "idle" });
        }, 4000);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            error: error instanceof Error ? error.message : "Could not load the data URL.",
            message: null,
            status: "error",
          });
      });
    return () => {
      controller.abort();
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, [mapAppAPI, params]);
  return state;
}
