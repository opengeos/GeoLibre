import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { applyMapboxStyleImport, parseMapboxStyle } from "@geolibre/map";
import { addPMTilesLayerFromUrl, addRasterToMap, addVectorLayerFromUrl } from "@geolibre/plugins";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  dataUrlParameters,
  fetchRemoteData,
  fetchRemoteStyle,
  mapboxStyleForDataLayer,
  parseRasterUrlStyle,
} from "../lib/data-url";
import type { createAppAPI } from "./usePlugins";
import type { ProjectUrlLoadState } from "./useProjectUrlLoader";

/**
 * `fitLayerIds` carries only the layers the shell still has to frame. The COG,
 * PMTiles, and GeoParquet loaders move the camera themselves as part of adding
 * their layer, so listing those here would fit twice and show a visible
 * double-take; a store-added GeoJSON layer moves nothing on its own.
 */
export type DataUrlLoadState = ProjectUrlLoadState & { fitLayerIds?: string[] };

export interface DataUrlLoadResult {
  layerIds: string[];
  fitLayerIds: string[];
}

/** Whether a store layer records the given URL as the data it was loaded from. */
function layerPointsAt(layer: GeoLibreLayer, url: string): boolean {
  if (layer.sourcePath === url) return true;
  const source = layer.source as { url?: unknown };
  return source.url === url;
}

/** Load one URL through the same remote-data pipeline used by the `?data=` deep link. */
export async function loadDataUrl(
  mapAppAPI: ReturnType<typeof createAppAPI>,
  dataUrl: string,
  options: { styleUrl?: string | null; signal?: AbortSignal; fit?: boolean } = {},
): Promise<DataUrlLoadResult> {
  const fit = options.fit ?? true;
  const [remote, rawStyle] = await Promise.all([
    fetchRemoteData(dataUrl, { signal: options.signal }),
    options.styleUrl ? fetchRemoteStyle(options.styleUrl, { signal: options.signal }) : null,
  ]);
  if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  const store = useAppStore.getState();
  const layerIds: string[] = [];
  const fitLayerIds: string[] = [];
  if (remote.kind === "cog") {
    const rasterStyle = rawStyle === null ? null : parseRasterUrlStyle(rawStyle);
    const id = await addRasterToMap(mapAppAPI, remote.url, {
      name: remote.name,
      defaults: { engine: "maplibre-gl-raster" },
      zoomTo: fit,
      ...(rasterStyle ? { state: rasterStyle } : {}),
    });
    if (options.signal?.aborted) {
      store.removeLayer(id);
      throw new DOMException("The operation was aborted", "AbortError");
    }
    layerIds.push(id);
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
    setState({ error: null, message: "Loading data from URL...", status: "loading" });
    void loadDataUrl(mapAppAPI, params.dataUrl, {
      styleUrl: params.styleUrl,
      signal: controller.signal,
    })
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
