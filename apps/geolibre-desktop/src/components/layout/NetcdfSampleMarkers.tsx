import * as maplibregl from "maplibre-gl";
import { type RefObject, useEffect, useSyncExternalStore } from "react";
import type { MapController } from "@geolibre/map";
import { netcdfSeriesColor } from "../../lib/netcdf-profile-series";
import {
  getNetcdfProfileSamples,
  type NetcdfProfileSample,
  subscribeNetcdfProfile,
} from "../../lib/netcdf-profile-store";

/**
 * Builds a sampled point's marker element: a numbered dot in the point's series
 * color, so a line in the spectral profile and the pixel it was read from are
 * matched by both color and number.
 *
 * A custom element rather than MapLibre's default pin because the series colors
 * include `hsl(var(--primary))`, and a CSS variable does not resolve in the
 * `fill` *attribute* the built-in pin sets — only in a CSS property, which is
 * what `style.backgroundColor` writes here.
 *
 * @param sample - The sampled pixel the marker represents.
 * @returns The marker element.
 */
function buildMarkerElement(sample: NetcdfProfileSample): HTMLElement {
  const element = document.createElement("div");
  element.className =
    "flex h-5 w-5 items-center justify-center rounded-full border-2 border-white text-[10px] font-semibold leading-none text-white shadow-md";
  element.style.backgroundColor = netcdfSeriesColor(sample);
  element.textContent = String(sample.order);
  // The profile panel already lists every point as text, and a marker that
  // swallowed clicks would block sampling the pixel underneath it.
  element.style.pointerEvents = "none";
  element.setAttribute("aria-hidden", "true");
  return element;
}

/**
 * Shows where each NetCDF pixel sampled with Identify was read from.
 *
 * Renders no React output: the markers are imperative map objects reconciled
 * against the sample store, so "Clear", the oldest point aging off the cap, and
 * a switch to another layer all clear the map without bookkeeping of their own.
 *
 * Mounted in the map area so its re-renders (one per sample change) stay off
 * the shell.
 *
 * @param props.mapControllerRef - The live map controller.
 * @param props.mapReadyGeneration - Bumped by the shell each time the map
 *   (re)initialises. A ref's `.current` pointing at a new map does not re-run an
 *   effect, so without this the markers would stay on the discarded map and not
 *   reappear on the new one until the next click changed `samples`. The same
 *   signal `useNetcdfIdentify` takes, for the same reason.
 * @returns Nothing.
 */
export function NetcdfSampleMarkers({
  mapControllerRef,
  mapReadyGeneration,
}: {
  mapControllerRef: RefObject<MapController | null>;
  mapReadyGeneration: number;
}) {
  const samples = useSyncExternalStore(
    subscribeNetcdfProfile,
    getNetcdfProfileSamples,
    getNetcdfProfileSamples,
  );

  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    const live = new Map<number, maplibregl.Marker>();
    for (const sample of samples) {
      live.set(
        sample.id,
        new maplibregl.Marker({ element: buildMarkerElement(sample), anchor: "center" })
          .setLngLat([sample.lng, sample.lat])
          .addTo(map),
      );
    }
    // Rebuilding the whole set each time keeps this to one short effect. It runs
    // more often than the markers actually change — every resolved band-axis
    // read replaces the `samples` array too, without moving or recoloring
    // anything — but at MAX_PROFILE_SAMPLES markers that is cheaper than the
    // bookkeeping to reconcile them.
    return () => {
      for (const marker of live.values()) marker.remove();
    };
  }, [samples, mapControllerRef, mapReadyGeneration]);

  return null;
}
