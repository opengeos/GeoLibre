import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { getLayerBounds } from "@geolibre/map";
import { useEffect, useRef, type RefObject } from "react";
import { dataUrlFitBounds } from "../../lib/data-url";
import type { DataUrlLoadState } from "../useDataUrlLoader";

/**
 * How long to wait for a layer whose extent is only known once it renders (a
 * COG reports its bounds after its first tiles) before framing without it.
 */
const BOUNDS_WAIT_MS = 30_000;

/**
 * Fits the map to every layer a `?data=` deep link added once it has loaded.
 * A layer whose extent arrives after it is added (a COG learns its bounds from
 * its header as it first renders) is waited for, up to {@link BOUNDS_WAIT_MS},
 * so a link of several rasters still frames them.
 *
 * @param dataUrlLoadState - Load state of the `?data=` deep link, if any.
 * @param mapControllerRef - The primary map engine.
 */
export function useDataUrlFit(
  dataUrlLoadState: DataUrlLoadState | undefined,
  mapControllerRef: RefObject<MapEngine | null>,
): void {
  // Outlives the effect run that started it: the load state drops back to idle
  // a few seconds after loading, which must not cancel a wait still running.
  const stopWaitRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopWaitRef.current?.(), []);
  // Frame layers a `?data=` deep link added. Single non-GeoJSON datasets move
  // the camera in their format-specific loader; a repeated `data` batch lists
  // every added layer here so their stored extents are combined into one fit.
  useEffect(() => {
    const fitLayerIds = dataUrlLoadState?.fitLayerIds;
    if (dataUrlLoadState?.status !== "loaded" || !fitLayerIds?.length) return;
    stopWaitRef.current?.();
    let done = false;
    let unsubscribe: (() => void) | null = null;
    let timer: number | null = null;
    const stop = () => {
      done = true;
      unsubscribe?.();
      if (timer !== null) window.clearTimeout(timer);
      if (stopWaitRef.current === stop) stopWaitRef.current = null;
    };
    const tryFit = (waitForAll: boolean) => {
      if (done) return;
      const bounds = dataUrlFitBounds(
        useAppStore.getState().layers,
        fitLayerIds,
        waitForAll,
        getLayerBounds,
      );
      if (bounds === "pending") return;
      stop();
      if (bounds) mapControllerRef.current?.fitBounds(bounds);
    };
    stopWaitRef.current = stop;
    tryFit(true);
    if (done) return;
    unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.layers !== previous.layers) tryFit(true);
    });
    timer = window.setTimeout(() => tryFit(false), BOUNDS_WAIT_MS);
  }, [dataUrlLoadState?.fitLayerIds, dataUrlLoadState?.status, mapControllerRef]);
}
