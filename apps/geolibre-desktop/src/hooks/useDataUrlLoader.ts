import { useAppStore } from "@geolibre/core";
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

export type DataUrlLoadState = ProjectUrlLoadState & { layerIds?: string[] };

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
    void Promise.all([
      fetchRemoteData(params.dataUrl, { signal: controller.signal }),
      params.styleUrl ? fetchRemoteStyle(params.styleUrl, { signal: controller.signal }) : null,
    ])
      .then(async ([remote, rawStyle]) => {
        if (controller.signal.aborted) return;
        const store = useAppStore.getState();
        const layerIds: string[] = [];
        let count = 0;
        if (remote.kind === "cog") {
          const rasterStyle = rawStyle === null ? null : parseRasterUrlStyle(rawStyle);
          layerIds.push(
            await addRasterToMap(mapAppAPI, remote.url, {
              name: remote.name,
              defaults: { engine: "maplibre-gl-raster" },
              ...(rasterStyle ? { state: rasterStyle } : {}),
            }),
          );
          count = 1;
        } else if (remote.kind === "pmtiles" || remote.kind === "vector") {
          // Validate the style before invoking a native loader. Those controls
          // assign their own ids, so collect the newly synchronized store
          // layers after the awaited add completes.
          const styleResult = rawStyle === null ? null : parseMapboxStyle(rawStyle);
          if (styleResult && styleResult.matchedLayerCount === 0) {
            throw new Error("The remote style has no supported vector style layers.");
          }
          const previousIds = new Set(store.layers.map((layer) => layer.id));
          const added =
            remote.kind === "pmtiles"
              ? await addPMTilesLayerFromUrl(mapAppAPI, remote.url)
              : await addVectorLayerFromUrl(mapAppAPI, remote.url, {
                  name: remote.name,
                  fitBounds: true,
                });
          if (!added) throw new Error(`Could not add ${remote.name} to the map.`);
          const addedLayers = useAppStore
            .getState()
            .layers.filter((layer) => !previousIds.has(layer.id));
          if (!addedLayers.length) {
            throw new Error(
              `The ${remote.kind === "pmtiles" ? "PMTiles" : "GeoParquet"} loader did not create a layer.`,
            );
          }
          for (const layer of addedLayers) {
            if (remote.kind === "pmtiles" && layer.metadata.tileType === "raster" && styleResult) {
              throw new Error(
                "MapLibre vector styles cannot be applied to a raster PMTiles archive.",
              );
            }
            layerIds.push(layer.id);
            if (styleResult) {
              store.setLayerStyle(layer.id, applyMapboxStyleImport(layer.style, styleResult));
            }
          }
          count = addedLayers.length;
        } else {
          // Resolve and validate every per-file style before mutating the store.
          // This keeps a misspelled source name from producing a partial import.
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
            if (styleResult) {
              const current = useAppStore
                .getState()
                .layers.find((candidate) => candidate.id === id);
              if (current)
                store.setLayerStyle(id, applyMapboxStyleImport(current.style, styleResult));
            }
            count += 1;
          }
        }
        setState({
          error: null,
          layerIds,
          message: `Loaded ${count} layer${count === 1 ? "" : "s"} from URL`,
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
