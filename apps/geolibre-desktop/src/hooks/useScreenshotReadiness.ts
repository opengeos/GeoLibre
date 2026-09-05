import { useEffect, type RefObject } from "react";
import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { getRasterLoadState, getSharedDeckLoadState } from "@geolibre/plugins";
import { inspectScreenshotLayers, screenshotReadinessEnabled } from "../lib/screenshot-readiness";

/** Opt-in DOM contract for browser automation; adds no pixels to the screenshot. */
export function useScreenshotReadiness(
  controller: RefObject<MapController | null>,
  generation: number,
  pluginsReady: boolean,
  projectBusy: boolean,
  loadError: string | null,
  cesium: boolean,
): void {
  useEffect(() => {
    if (!screenshotReadinessEnabled(window.location.search)) return;
    const root = document.documentElement;
    const map = controller.current?.getMap();
    const failures = new Set<string>();
    let settledSince = 0;
    let started = performance.now();
    let frame = 0;
    let checkedAt = 0;
    const publish = (
      state: "loading" | "ready" | "error",
      pending: string[] = [],
      errors: string[] = [],
    ) => {
      const values = {
        geolibreLoadState: state,
        geolibreLoadPending: JSON.stringify(pending),
        geolibreLoadErrors: JSON.stringify(errors),
      };
      for (const [key, value] of Object.entries(values)) {
        if (root.dataset[key] !== value) root.dataset[key] = value;
      }
    };
    const invalidate = () => {
      settledSince = 0;
      if (root.dataset.geolibreLoadState === "ready") started = performance.now();
      publish("loading");
    };
    // A map `error` is not terminal on its own: a single tile 404 during a pan
    // is often resolved by a retry, and `error` IS terminal for consumers (the
    // documented wait is `ready` or `error`). Record it and let `tick` decide --
    // dropped once the map reaches a settled, fully loaded state, reported when
    // it never does.
    const onError = (event: { error: { message: string } }) => {
      failures.add(event.error.message);
    };
    publish("loading");
    map?.on("dataloading", invalidate);
    map?.on("movestart", invalidate);
    map?.on("styledata", invalidate);
    map?.on("error", onError);
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        state.layers !== previous.layers ||
        state.layerGroups !== previous.layerGroups ||
        state.projectGeneration !== previous.projectGeneration
      )
        invalidate();
    });
    const tick = () => {
      frame = requestAnimationFrame(tick);
      // Check on painted frames, but avoid walking every layer at display FPS.
      if (performance.now() - checkedAt < 100) return;
      checkedAt = performance.now();
      const errors: string[] = [];
      if (loadError) errors.push(loadError);
      if (cesium) errors.push("Screenshot readiness is not supported for the Cesium renderer");
      const store = useAppStore.getState();
      const result =
        map && pluginsReady && !projectBusy && !cesium
          ? inspectScreenshotLayers(map, store.layers, store.layerGroups, {
              raster: getRasterLoadState,
              deck: getSharedDeckLoadState,
            })
          : { pending: ["Project and map initialization"], errors: [] };
      errors.push(...result.errors);
      if (errors.length) {
        settledSince = 0;
        publish("error", result.pending, [...failures, ...errors]);
        return;
      }
      const complete =
        map &&
        !projectBusy &&
        pluginsReady &&
        result.pending.length === 0 &&
        map.loaded() &&
        map.areTilesLoaded() &&
        !map.isMoving() &&
        document.fonts.status === "loaded";
      if (!complete) settledSince = 0;
      else settledSince ||= performance.now();
      // Keep the predicates true across painted frames, including raster fade
      // and asynchronous plugin/store updates after the initial map idle.
      if (complete && performance.now() - settledSince >= 500) {
        // Every tile the viewport needs is loaded and the map is idle, so any
        // `error` event recorded along the way was transient.
        failures.clear();
        publish("ready");
      } else if (performance.now() - started > 120_000) {
        publish("error", result.pending, [
          ...failures,
          "Timed out waiting for the visible map to finish loading",
        ]);
      } else publish("loading", result.pending);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      map?.off("dataloading", invalidate);
      map?.off("movestart", invalidate);
      map?.off("styledata", invalidate);
      map?.off("error", onError);
      delete root.dataset.geolibreLoadState;
      delete root.dataset.geolibreLoadPending;
      delete root.dataset.geolibreLoadErrors;
    };
  }, [controller, generation, pluginsReady, projectBusy, loadError, cesium]);
}
