import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { getLayerBounds } from "@geolibre/map";
import { useEffect, type RefObject } from "react";
import type { DataUrlLoadState } from "../useDataUrlLoader";

/**
 * Fits the map to every layer a `?data=` deep link added once it has loaded.
 *
 * @param dataUrlLoadState - Load state of the `?data=` deep link, if any.
 * @param mapControllerRef - The primary map engine.
 */
export function useDataUrlFit(
  dataUrlLoadState: DataUrlLoadState | undefined,
  mapControllerRef: RefObject<MapEngine | null>,
): void {
  // Frame layers a `?data=` deep link added. Single non-GeoJSON datasets move
  // the camera in their format-specific loader; a repeated `data` batch lists
  // every added layer here so their stored extents are combined into one fit.
  useEffect(() => {
    const fitLayerIds = dataUrlLoadState?.fitLayerIds;
    if (dataUrlLoadState?.status !== "loaded" || !fitLayerIds?.length) return;
    const controller = mapControllerRef.current;
    if (!controller) return;
    const bounds = useAppStore
      .getState()
      .layers.filter((layer) => fitLayerIds.includes(layer.id))
      .map(getLayerBounds)
      .filter((value) => value !== null);
    if (!bounds.length) return;
    controller.fitBounds([
      Math.min(...bounds.map((value) => value[0])),
      Math.min(...bounds.map((value) => value[1])),
      Math.max(...bounds.map((value) => value[2])),
      Math.max(...bounds.map((value) => value[3])),
    ]);
  }, [dataUrlLoadState?.fitLayerIds, dataUrlLoadState?.status, mapControllerRef]);
}
